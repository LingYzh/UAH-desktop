# D00 真实 Electron 性能观察

日期：2026-10-01。执行 `npm run build` 后，运行 `node tests/desktop/harness-performance.mjs`。本轮成功证据：[report.json](../artifacts/harness-desktop-performance-nROWGO/report.json)，含三个原生窗口截图。只有本机 HTTP SSE fixture，没有外部网络或真实 Provider 请求；独立 UAH_DATA_DIR，不接触用户数据库。

## 测试与口径

正文 100,000 字符，5,000 个 20 字符 content SSE frame；正文前另有 20 个 20 字符 reasoning frame。每 10 个正文 frame 使用 setImmediate 让出服务端事件循环；服务端故意快速写完，后续 runtime / IPC / 绘制处理仍属于真实 Electron。通过真实 preload IPC 配置端点、Agent 和会话，再发 start-run；测试不验证模型选择器的填写流程。

观察器只统计事件类型、字符长度、时间与 command.type 数量，不记录授权头、端点 key 或实际请求 body。main IPC handler 包装统计 `uah:command`，健康测量之外仅做一次最终 snapshot 校验；stream 区间的 applicationSnapshotIpcCalls 不含该最终校验。此数字是应用发起的 snapshot IPC 数，不是 worker 内部 RuntimeStore.readSnapshot 函数调用数；后者本测试未插桩，不能由 IPC 数量推断。

时间来自同机各进程的 performance.timeOrigin + performance.now。TTFT 从测试 start-run 意图到 renderer 收到第一个正文 delta，不是供应商模型 TTFT。首次 DOM 由 MutationObserver 识别真正正文；首次 paint proxy 为该 DOM 变化之后的两次 requestAnimationFrame，只表示浏览器绘制机会，不是操作系统屏幕实际扫描完成。DOM 的 UiMarkdown 尾部换行在正文比对时剔除。

last frame 指 fixture 最后正文帧写入批次完成的时间；终态 DOM 需同时看到 completed 和完整 100,000 字符。fixture 的 socket close / [DONE] 不是终态 DOM 的替代证据。正文实际 DOM、展开的 reasoning 活动、最终 IPC run 与 SQLite run / activities 均核对一致；durable / exported 水位从运行 worker 的 journal summary 读取。

## 一次成功样本

| 指标 | 观测值 |
| --- | ---: |
| Renderer 首正文 delta（TTFT） | 224.90 ms |
| 首正文 DOM | 241.90 ms |
| 首 paint proxy | 276.50 ms |
| Fixture 最后正文帧 → 终态 DOM | 909.92 ms |
| Fixture 最后正文帧 → 终态 paint proxy | 918.42 ms |
| start-run → 终态 paint proxy | 1,111.20 ms |
| 应用 snapshot IPC | 2 次 / 5,000 正文 delta |
| Renderer 收到正文 / reasoning delta | 5,000 / 20 |
| Durable / exported | 5,011 / 5,011 |
| Capture / continuation / recovery | complete / native / stopped |
| 活跃 SQLite 主库 / WAL / SHM | 4,022,272 / 5,154,152 / 32,768 bytes |
| Renderer JS used heap（结束时） | 11,727,353 bytes |
| Runtime utility working set / private bytes（结束时） | 196,628 / 115,224 KiB |
| Renderer process working set / private bytes（结束时） | 178,936 / 100,248 KiB |

stream 的 rAF 间隔样本 146 个：p50 6.10 ms，p95 18.10 ms，最大 36.40 ms。p95 是本次 146 个相邻 animation frame 时间差的 nearest-rank 统计，不是 146 次独立请求、重复实验或产品延迟 SLA。内存值是结束阶段采样，不是精准峰值、泄漏结论或完整进程内存归因；Electron app.getAppMetrics 的单位是 KiB，performance.memory 单位是 bytes。

## 500 个已完成 run 长列表

通过真实 RuntimeStore 在隔离 SQLite 一次写入一个会话、500 个 completed runs，再启动独立 Electron 实例。没有 500 次 Provider 调用，不伪造 journal 完整记录；它们是用于历史列表的 legacy fixture。启动后真实页面同时挂载 500 个 `.turn`，可滚动到最后一轮并输入 composer。

| 指标 | 观测值 |
| --- | ---: |
| Electron launch → 500 轮 DOM ready | 4,507.93 ms |
| Input dispatch → 第二个 rAF | 122.20 ms |
| 滚动 / 交互样本时间 | 2,409.40 ms |
| Scroll height / client height / 到末尾 top | 157,724 / 683 / 157,041 px |
| Renderer JS used heap | 168,260,561 bytes |
| Renderer process working set / private bytes | 552,556 / 473,736 KiB |

180 个 rAF 回调形成 179 个相邻间隔；其中前 120 帧按进度滚动，随后约 60 帧观察结束状态。间隔 p50 12.10 ms、p95 24.30 ms、最大 127.30 ms；同样只代表单次测试内的 frame 采样，不能称为请求 / 交互 p95。输入指标包含 Vue 响应与两个帧机会，不是实际键盘事件到屏幕扫描时间。

该 D00 基线当时仍有 500 个 run 边界：fixture 随后调用 assertCanCreateRun，确认第 501 个 run 准入被拒绝。本次已经看到大列表约 540 MiB renderer working set 和 4.5 秒启动，不能据此宣称长列表性能问题已解决。后续 D05 已替换此准入限制，见下方独立新样本；旧报告保留为历史观察。

## 一次流式 stop

第二个请求每 10 ms 写入正文，并保持 SSE response 打开。真实点击「停止当前任务」，等待 stopped DOM 与 fixture response.close，不使用 UI 标记代替实际网络关闭。

- click 开始 → stopped DOM：129.96 ms。
- click 开始 → stopped paint proxy：140.36 ms。
- click 开始 → fixture response.close：43.12 ms。

这是模型流传输停止样本，不包含命令 ExecutionBackend / Windows Job Object 取消证据；后者属于独立 D02 验收，不由本测试代替。

## 复现与边界

脚本每次生成自己的 artifacts 目录和两套隔离数据库，保留报告 / 截图，不递归删除既有用户目录。后续执行另外保留 stream-timings.json / list-timings.json 原始帧间隔供审计；本次成功报告已保存统计值、时间戳和口径，但没有保存全部原始 rAF 间隔。脚本使用 Electron 内部 `_invokeHandlers` 仅作测试 IPC 计数，升级 Electron 后需重新验证该测试插桩。

初次试跑目录 `artifacts/harness-desktop-performance-VQKE9p` 因探针把 Markdown DOM 尾部换行计入正文（100,001 vs 100,000），等待条件超时。独立重开该数据目录确认实际 completed、正确 100,000 字符正文；修正观察器后重新运行得上述成功样本。该无效探针试跑不计入任何性能数值，不是应用故障，也没有丢弃其 failure 证据。

本轮一次 stream、一次 stop、一次长列表足以证明当前数据一致性与 IPC 计数路径，不足以给出跨机器性能目标、稳定 p95、强杀 / 磁盘满恢复或真实 Provider 效率结论。所有新增改动只在 desktop 测试与本文，没有业务源文件、UI 样式或视觉决策变动。

## D05：1000 个 run 与按批挂载复测

同日业务源码稳定后再次 `npm run build`，然后运行同一脚本。最终成功报告：[report.json](../artifacts/harness-desktop-performance-exzmo0/report.json)，21 项检查全部通过，包含末轮文件改动与回复动作全局第1000轮标号以及深色加载按钮确实位于可视滚动区域。此轮保存 [stream-timings.json](../artifacts/harness-desktop-performance-exzmo0/stream-timings.json) 与 [list-timings.json](../artifacts/harness-desktop-performance-exzmo0/list-timings.json) 原始帧间隔，仍仅本机 SSE。默认真实 RuntimeStore 一次保存 1000 个 completed runs 后第 1001 个 run 准入通过，没有绕开旧限制或调用 1000 次 Provider。容量报告为 1000 / 100000 runs、679936 / 2147483648 logical SQLite bytes；logical bytes 为 page_count × page_size，不能当作包含 WAL 的总磁盘占用。

初始 DOM 恰好 50 轮、aria-label 为第 951 至 1000 轮；点击「加载更早的对话」后 100 轮，原第 951 轮顶部位置漂移 0.1875 px。原生键盘 focus + Enter 再加载 50 轮，DOM 为第 851 至 1000 轮。后续滚动与输入指标在 150 个已挂载轮次下测量。只限制 DOM，runtime 与 IPC 仍读完整会话；SQLite 分页 API 的单元验证不能替代端到端分页。

| 单次长列表观察 | D00：500 全部挂载 | D05：1000 存储、初始50/测量150挂载 |
| --- | ---: | ---: |
| launch → 初始 DOM ready | 4507.93 ms | 1687.43 ms |
| input dispatch → 第二 rAF | 122.20 ms | 63.60 ms |
| 相邻 rAF 间隔 p95（各179个） | 24.30 ms | 12.10 ms |
| Renderer JS used heap | 168260561 bytes | 68434374 bytes |
| Renderer working set | 552556 KiB | 303000 KiB |

这是不同挂载规模的单次前后观察，不能推导固定改善百分比、跨机器 SLA 或完整虚拟化效果。150 轮滚动样本 p50 6.10 ms、最大 12.40 ms，输入与滚动共 1251.60 ms。可滚至第 1000 轮，scroll height/client/top 为 47383/683/46700 px。更早轮次继续按50扩展后可能再次增加内存；尚未限制 runtime 全量快照与 IPC 大小。

同一成功运行的 100k 正文：TTFT 225.90 ms、首 DOM 245.80 ms、首 paint proxy 283.60 ms；最后 fixture 正文帧到 terminal DOM 947.57 ms、到 terminal paint proxy 960.37 ms，总 elapsed 1156.90 ms。应用 snapshot IPC 2 次；5000 正文 / 20 reasoning delta 全收到；DB 与真实 DOM / 活动一致。durable/exported 5012/5012，complete/native/stopped。stream rAF 150 间隔 p95 18.10 ms。stop 到 terminal DOM 119.45 ms、paint proxy 125.05 ms、fixture response.close 40.37 ms。

浅深截图供 root 最终视觉验收：[浅色初始50轮](../artifacts/harness-desktop-performance-exzmo0/list-1000-light-initial-50.png)、[浅色加载100轮](../artifacts/harness-desktop-performance-exzmo0/list-1000-light-loaded-100.png)、[浅色末尾](../artifacts/harness-desktop-performance-exzmo0/list-1000-light-end.png)、[深色末尾](../artifacts/harness-desktop-performance-exzmo0/list-1000-dark-end.png)、[深色加载按钮](../artifacts/harness-desktop-performance-exzmo0/list-1000-dark-earlier-control.png)。深色通过真实设置 radio、保存设置、回原会话取得；没有修改样式或绕开主题机制。回会话后等待滚动稳定，再真实 wheel 到顶部，按按钮相对滚动视口上下边界验证可见后截图。

较早的 `SZcRXq` 报告19项通过，但其深色顶部截图仍被跟随末尾滚动改变，且在全局文件改动/回复动作序号修复之前；保留该目录供审计，最终验收引用 `exzmo0`。本轮构建早于后续D07集成，不作为D07验收证据。

目录 `artifacts/harness-desktop-performance-fxGFCk` 保留了一次深色截图探针超时：其 stream/stop/1000轮及键盘检查已通过，但测试误认为默认固定 light 会随 emulateMedia 自动变深。修正为真实主题设置后完整重跑得到上述成功证据；该未完成报告不混入成功样本。

## 2026-10-02 会话范围快照复测

`artifacts/harness-desktop-performance-GGw2nG/report.json`的21项检查通过。IPC观测包装器保留command的第二个view参数，测量的是应用真实会话范围请求。10万字符与5000个正文delta完全一致，应用snapshot调用2次，流帧p95为18.2ms，stop到fixture SSE关闭49.61ms、终态DOM155.15ms。1000轮加载50/100/150及第1001轮准入通过，锚点漂移0.1875px，长列表帧p95为12.2ms、启动ready1929.10ms。

报告标记rendererScope=selected_session、sessionHistoryStillFull=true和runtimeTerminalCacheLimit=128：避免其他会话正文传输并限制普通终态常驻条数，但当前会话仍整组读取。上述数字仍为单次本地样本，不代表稳定SLA或同条件改善比例。构建包含分支公开消息投影修复，早于后续启动恢复流式扫描改动。
