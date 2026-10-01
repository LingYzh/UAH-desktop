# D00 当前 RuntimeStore 性能基线

2026-10-01 在 Windows 本机完成。此项只测现有存储基线，不优化实现、不固定产品配额或 flush 阈值，也不构成完整 D00 性能验收。

## 复现与证据

在 `D:/UAH` 使用已安装的项目依赖执行：

```powershell
node --import tsx scripts/benchmark-harness.ts 3
```

参数为 1–10 次流式场景重复数，默认 3；其余场景各执行一次。每次执行在仓库 `artifacts/harness-d00-*` 下新建独立目录及 SQLite，不读取应用数据目录、不删除旧证据、不调用网络、模型或工具执行器。目录包含每场景数据库、逐次延迟 `timings.json` 和总报告 `summary.json`。生成文件使用显式 UTF-8；脚本通过 `node:sqlite` 使用真实 `RuntimeStore`。

本次证据：`artifacts/harness-d00-Jlpapc/summary.json`。证据目录被 Git 忽略；复现会产生新的目录。源文件 SHA-256、提交 ID、环境与完整未舍入数值均在总报告中。实测环境为 Node v24.19.0、Windows 10.0.26200 x64、AMD Ryzen 7 7840H（16 逻辑 CPU），Git HEAD `7fcce0096ef2fd460747e9383f58e2565ea4270e`。HEAD 不代表工作区清洁，源文件 hash 用于识别实测版本。

脚本独立 strict 类型检查通过：

```powershell
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --target ES2023 --module ESNext --moduleResolution Bundler --strict --skipLibCheck --types node scripts/benchmark-harness.ts
```

实测程序退出码 0；校验包括流式最终文本及 activity 内容、持久快照中的文本、每场景 snapshot 运行数、500/501 创建边界和所有数据库 `PRAGMA integrity_check`。基准不作为项目测试命令自动运行，以避免常规回归引入大量存储 I/O。

## 当前提交形状

- `Supervisor.appendDelta` 的 API 分支会 clone 全部 activities，追加 `output` 与 text activity，并提交完整 Run 和一个仅含增量文本的 delta 事件。100,000 ASCII 字符，每次 20 字符，共 5,000 次；还包括 session、初始状态和结束状态，总计 5,003 次 Store.commit。
- `Supervisor.updateActivity` 将完整 Run 写入 runs 表，并将完整 clone 放入 run-state 事件。合成工具场景使用相同字段形状：8 轮，每轮开始/结果活动更新、64,000 字符结果及一个短文本 delta；`content` 和 `tool.result` 都包含工具结果，符合当前代码。没有测 Provider continuation 或真实工具开销。
- 父子场景保存 1 个父 Run、32 个子 Run，每个子 Run 有 64,000 字符 contextMessages 及 64,000 字符 output，保存父关系并结束运行；只测持久树的写入和 snapshot，没有执行委派或调度。
- 每个 SQLite 都由现有 RuntimeStore 初始化，使用 WAL 和 synchronous FULL；不修改 SQLite PRAGMA、现有 schema、保存频率或业务限制。

## 实测结果

字节数均为十进制 byte。延迟单位为 ms，保留 3 位小数。p50/p95 使用 nearest-rank，流式场景每次有 5,003 个 commit 样本；每场景 snapshot 30 次，不聚合不同场景的百分位。

| 场景 | 提交事务 | 累计序列化字节 | commit p50 / p95 | shape+commit p95 | snapshot p50 / p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100k 文本，第 1 次 | 5,003 | 504,025,143 | 1.869 / 3.861 | 3.921 | 1.767 / 2.601 |
| 100k 文本，第 2 次 | 5,003 | 504,025,143 | 1.866 / 3.878 | 3.916 | 1.819 / 2.776 |
| 100k 文本，第 3 次 | 5,003 | 504,025,143 | 1.867 / 3.860 | 3.899 | 2.017 / 3.197 |
| 8 轮工具大结果 | 27 | 23,131,634 | 5.916 / 16.327 | 16.698 | 1.414 / 4.533 |
| 父 + 32 子 snapshot | 100 | 25,134,907 | 3.071 / 9.862 | 9.908 | 11.071 / 22.547 |
| 500 Run，创建检查路径 | 501 | 1,494,216 | 1.937 / 2.028 | 2.049 | 2.968 / 4.760 |
| 既存 501 Run，直接 fixture commit | 502 | 1,497,217 | 1.960 / 2.057 | 2.082 | 2.781 / 4.744 |

| 场景 | 最终 JSON 数据字节 | close 后主 DB 字节 | 采样 WAL 最大长度 | 采样 RSS 峰值 | 采样 heapUsed 峰值 | 总耗时 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 100k 文本，第 1 次 | 1,590,903 | 2,744,320 | 4,342,512 | 130,723,840 | 40,827,968 | 12,511.351 |
| 100k 文本，第 2 次 | 1,590,903 | 2,744,320 | 4,342,512 | 190,328,832 | 73,520,608 | 12,640.494 |
| 100k 文本，第 3 次 | 1,590,903 | 2,744,320 | 4,342,512 | 191,983,616 | 75,414,552 | 12,513.763 |
| 8 轮工具大结果 | 10,283,962 | 10,371,072 | 5,277,752 | 186,724,352 | 68,253,400 | 345.723 |
| 父 + 32 子 snapshot | 16,781,075 | 16,977,920 | 4,276,592 | 284,856,320 | 156,646,312 | 791.675 |
| 500 Run，创建检查路径 | 1,494,216 | 2,195,456 | 4,144,752 | 288,333,824 | 150,584,152 | 1,164.096 |
| 既存 501 Run，直接 fixture commit | 1,497,217 | 2,211,840 | 4,161,232 | 236,859,392 | 96,748,072 | 1,159.063 |

100k 场景的逻辑输入正文为 100,000 byte，累计 JSON 序列化输入为其约 5,040 倍。这说明当前逐 delta 重写全文的成本；它不是磁盘写放大倍数，也不是改造后的性能承诺。工具/父子场景结果仅为单次样本，不能据此确定稳定产品 SLA。

## 500 / 501 证据

正常创建路径与 Supervisor 一样，每次先调用 `assertCanCreateRun()`。已有 499 条时第 500 条检查成功并提交；已有 500 条时下一次检查失败，原始错误为：

```text
Run history limit reached (500); existing history was preserved
```

失败后 snapshot 仍为 500 条，没有淘汰历史。另一个独立数据库绕过创建 guard，直接 fixture commit 501 条，30 次 snapshot 均读到 501 条。这证明当前上限位于创建检查，commit/schema/readSnapshot 没有自动截断既存记录；不代表正常 `start-run` 可以创建第 501 条。两个历史场景的每条 output 为 1,000 字符；不等同于 500 条大上下文运行。

## 测量边界与未完成项

- commit 延迟包含 RuntimeStore 内部 JSON.stringify、SQL 和事务提交。shape+commit 加上本脚本按真实形状构造/clone 的耗时；没有调用 Supervisor 私有方法，没有计入 deliver clone、IPC、Pinia 或渲染。额外用于字节统计的第二次 JSON.stringify 在延迟样本之外。
- 序列化字节统计现有 serializer 每条 record 的 UTF-8 JSON 输入，包含被覆盖的旧 Run；最终 JSON 数据字节是各表 data 的 BLOB 长度总和。SQL 语句、索引、页写入、IPC 字节不包含在序列化统计中。
- 提交事务数按成功 Store.commit 次数计数，依据现有 commit 内部每次一个 BEGIN IMMEDIATE/COMMIT；各数据库的一个 schema 初始化事务另行排除，没有使用系统级 SQLite trace。
- 主 DB/WAL/SHM 是文件长度，总报告保存 close 前的完整长度。WAL 采样最大长度不是累计 I/O：SQLite 可 checkpoint 并复用 WAL，不能把它当作写入字节总数；没有 ETW 或设备层写入计量。
- 总耗时包含初始化、断言、字节统计、磁盘/内存采样和 30 次 snapshot；它不是纯 Store 工作负载耗时。全场景在同一个 Node 进程顺序执行，没有强制 GC。RSS/heapUsed 是进程采样值，受前一场景与 GC 影响；每 100 个 delta、每轮/子任务/部分历史插入和每次 snapshot 采样，不能声称捕获瞬时最大值或单个 Run 的独立内存。
- root 的较早回归/构建已在基准脚本创建前结束，本会话另有约 2 秒的 typecheck/契约定向测试；没有收集统一开始/结束时间来严格证明两者绝无重叠。本脚本未自行并行调度负载，但机器负载未隔离，也没有排除其他进程竞争。时间数值不能视为严格独占机器基准；缓存、存储设备、同步写策略及系统负载均可改变结果。事务数和序列化字节不依赖并发负载。
- 当前 store 无 durableSeq/exportedSeq/JSONL 导出水位。本次明确记为不可用，没有虚构水位或 durable ack 验证。
- **D00 整体性能矩阵仍缺 Electron 长列表、UI 展示延迟和取消延迟实测**。还未覆盖故障注入、恢复、artifact 完整性大库扫描、真实 API、真实子任务、命令取消及桌面生命周期。存储基线不能代替这些验收。

后续持久化优化可用相同输入与真实组件路径对比，并另补桌面指标。flush 数值、配额及 p95 验收阈值由 root 根据完整证据决策；本报告不设置它们。
