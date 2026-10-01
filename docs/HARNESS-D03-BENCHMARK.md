# D03 SQLite / JSONL 与 Windows Job 新链路实测

2026-10-01 完成独立 fixture 实测，保留旧 [D00 基线](HARNESS-D00-BASELINE.md) 原文。新链路使用真实 `RuntimeStore`、`RunJournal.delta/materialize`、同步 JSONL/manifest 投影和 `WindowsExecutionBackend`，没有使用用户数据库、模型凭据、网络或 Electron。

## 复现与版本证据

在 `D:/UAH` 执行：

```powershell
node --import tsx scripts/benchmark-journal.ts 3
```

参数为文本存储场景重复次数，1–10，默认3。Windows受控命令取消固定测3次；需要已构建的独立 `UAH.ExecutionHelper`。缺失helper会失败，不直接启动PowerShell作为回退。脚本每次创建独立 `artifacts/harness-d03-*` 目录，保留 SQLite、JSONL、manifest、原始命令输出、逐批次 `timings.json` 和 `summary.json`，不删除既有证据。

本次正式证据：`artifacts/harness-d03-dP79OX/summary.json`，UTC开始时间 `2026-10-01T13:35:35.284Z`。早期脚本校验执行的 `harness-d03-05acsj` 也保留，不作为下表来源。正式脚本退出码0，单独strict类型检查退出码0：

```powershell
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --target ES2023 --module ESNext --moduleResolution Bundler --strict --skipLibCheck --types node scripts/benchmark-journal.ts
```

环境：Node v24.19.0、Windows 10.0.26200 x64、AMD Ryzen 7 7840H、16逻辑CPU；Git HEAD `7fcce0096ef2fd460747e9383f58e2565ea4270e`。工作区实现比该HEAD更新，报告保存脚本、存储、journal、writer、backend、native源文件及helper exe/dll的SHA-256，用来识别实际测量版本。

## 100k正文，20字符delta

每次输入100,000个ASCII字符，5,000条20字符delta，同时维护真实Run的 `output` 与text activity重复视图。`journal.delta` 调用 `materialize`，按现有16,384-byte门槛批量提交；此同步密集负载在50ms定时器取得执行机会前结束循环，测到6次阈值flush。初始状态和终态另行直接提交，终态包含最后一批正文。没有修改SQLite WAL或FULL同步策略。

每次均验证5,000条delta的原始连续UTF-16 offset、完整正文及activity、Run快照、JSONL与canonical行逐字一致、数据库完整性，以及 `durableSeq = exportedSeq = 5002`。

字节数为十进制byte，延迟为ms，p95采用nearest-rank；每次store commit有9个样本，阈值flush有6个样本，小样本p95等于该组最大值。

| 重复 | Store.commit事务 | export水位事务 | 合计成功事务 | 记录序列化字节 | canonical序列化字节 | store commit p95 | flush batch p95 | 总耗时 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 9 | 8 | 17 | 893,254 | 3,314,394 | 34.008 | 66.396 | 676.293 |
| 2 | 9 | 8 | 17 | 893,254 | 3,314,394 | 36.064 | 69.031 | 635.958 |
| 3 | 9 | 8 | 17 | 893,254 | 3,314,394 | 35.760 | 62.114 | 663.290 |

每次累计序列化4,207,648 byte，包含被覆盖的Run快照。共9个Run快照，累计 `output.length` 444,400；其中初始两个为空快照，其余为批次及终态。这里没有逐delta写入全文。

| 重复 | close前SQLite | close后SQLite | 采样WAL最大长度 | JSONL | 正文artifact / restricted artifact | 采样RSS峰值 | 采样heapUsed峰值 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 4,030,464 | 5,038,080 | 5,042,912 | 3,319,396 | 0 / 0 | 154,320,896 | 47,038,160 |
| 2 | 4,038,656 | 5,025,792 | 5,051,152 | 3,319,396 | 0 / 0 | 160,202,752 | 54,903,128 |
| 3 | 4,038,656 | 5,017,600 | 5,059,392 | 3,319,396 | 0 / 0 | 219,062,272 | 79,991,672 |

每次SHM为32,768 byte，manifest为314 byte。纯文本场景没有request/provider/native/output大对象，因此payload artifact体积为0，不能据此判断大artifact性能。

## 受控PowerShell子树取消

同一backend先完成 `ensureAvailable` 能力确认，预热耗时141.872ms；随后每次启动PowerShell，使用绝对系统PowerShell路径和EncodedCommand启动一个 `Start-Sleep -Seconds 60` 子PowerShell，再让父PowerShell睡眠。取消前须同时看到Job内至少2个活动进程和 `child-started` 输出证据，本次三次均观测到4个Job活动进程。数字包含树内辅助进程，不能将4解释为4个PowerShell。

从调用 `backend.cancel` 前计时，直到取得 `treeExited=true`、`outputDrained=true`、`activeProcesses=0`、`status=cancelled` 的关联execution证据。通过已拥有的backend协议管理生命周期，没有PID搜索或按进程名终止。

| 重复 | cancel到树退出及输出排空 |
| --- | ---: |
| 1 | 20.056 |
| 2 | 14.493 |
| 3 | 14.886 |

三次nearest-rank p50为14.886ms，p95为20.056ms。backend关闭也通过owned shutdown协议完成，耗时18.765ms。三个execution原始输出artifact合计78 byte：每次stdout15 byte、stderr11 byte；stderr是PowerShell的 `#< CLIXML` 前导，本测量没有把它当作命令错误或可见正文。测量不包含helper预热、PowerShell启动/子树准备或UI点击Stop延迟。

## 与D00基线的口径差异

旧100k/20字符场景每次为5,003次Store.commit、累计504,025,143个记录序列化byte；旧链路没有canonical事件、JSONL导出或水位事务。新场景每次为9次Store.commit加8次导出水位更新，记录序列化893,254 byte，并新增3,314,394 byte canonical身份/事件记录。这里直接给出实测值，不把不同口径合成“优化百分比”。

旧commit p95来自5,003个短事务；新commit p95来自9个较大事务，新flush还包括JSONL与manifest同步投影，两者延迟分布不能直接比较。旧总耗时包含30次snapshot；新仅做最终正文/快照校验，并验证完整canonical和JSONL，因此635–676ms与旧约12.5秒也不是相同工作的纯性能倍数。新DB更大，保存完整事件身份和正文增量事实；旧DB只保存最后Run和较薄legacy事件。

## 测量限制

- 事务计数依据成功 `Store.commit` 与成功 `markExported` 调用：前者每调用一个显式事务，后者是单条水位upsert的自动提交；schema初始化事务排除。没有系统SQLite trace。JSONL及manifest文件操作另属文件同步，并非SQLite事务。
- 序列化字节为传入store的记录与canonical事件各自UTF-8 JSON大小，包含被覆盖的快照，排除SQL语句、页、索引、JSONL的LF和manifest。用于计数的第二次JSON.stringify不计入store/flush延迟；总耗时包含计数、初始化、正文/快照/JSONL断言和采样，截止最后一次采样，排除其后的关闭、close后PRAGMA完整性检查和报告写入。
- flush样本覆盖触发批量flush的canonical提交及JSONL/manifest同步投影；直接初始/终态提交不在flush样本内，其SQLite提交计入store样本。没有测IPC、Pinia、渲染和真实Supervisor端到端请求。
- SQLite、WAL、SHM、JSONL和artifact指标均为文件长度。WAL可checkpoint及复用，采样WAL峰值不是累计写入量；没有ETW、设备层统计或物理磁盘I/O证据。
- 每100个delta及结束校验后采样进程内存和文件体积。三个场景顺序运行、没有强制GC，RSS/heap受前次场景影响；采样峰值不是瞬时最大值或每Run独立内存。机器负载没有隔离，本脚本不自行并行工作，不能假设其他进程没有竞争。
- 正文flush及取消仅三次试验，小样本不能确定稳定SLA。命令样本是受控PowerShell子树，不代表每种CLI、网络子进程、交互控制台或最坏存储阻塞。预览截断、记录故障、崩溃恢复另由专项测试覆盖。
- 本包补齐存储新链路与backend取消证据；Electron长列表、UI停止/展示延迟、真实API/委派和大artifact矩阵仍需独立验收。
