# 离线 transcript 工具（D04）

`src/runtime/transcript-offline.ts` 只读取本地 manifest、JSONL 与 artifact 原件，提供 validate / stats / trace / replay / export。没有网络请求、真实执行器导入、工具执行、CLI 动作重放或自动运行恢复。命令可以在独立 Node 24 环境中使用，不需要启动 Electron。

## CLI

```powershell
node --import tsx scripts/transcript.ts validate <sessionDirectory>
node --import tsx scripts/transcript.ts stats <sessionDirectory>
node --import tsx scripts/transcript.ts stats <sessionDirectory> csv
node --import tsx scripts/transcript.ts trace <sessionDirectory> <requestId>
node --import tsx scripts/transcript.ts replay <sessionDirectory>
node --import tsx scripts/transcript.ts export <sessionDirectory> <newDestination> full
node --import tsx scripts/transcript.ts export <sessionDirectory> <newDestination> share
```

默认输出 JSON；stats csv 输出按 UTC 日统计的 CSV。输入损坏或导出失败以非零退出码与 stderr 明确报告。目标目录的父目录必须已存在；目标不得已存在，来源和目标不得相同或互相嵌套。

## 宿主可直接调用的同步 API

- `validateTranscript(directory, limits?)` 返回 `{ sessionId, targetSeq, durableSeq, eventCount, artifactCount, presentArtifacts, partial, warnings }`；损坏抛出 Error。
- `statsTranscript(directory, limits?)` 返回 validation、最高 revision 的 usage records、attempts、unknownAttempts、knownSubtotals、byDay。
- `usageCsv(stats)` 将上述按日数据编码为 CSV。
- `traceTranscript(directory, requestId, limits?)` 返回 validation 与该逻辑request的所有attempt关联事件；通过顶层identity/usage/request身份匹配，并沿同run的tool.batch/tool.dispatch invocationId关联审批和tool.result，不把正文中任意嵌套的同名字段当请求身份。日志详情使用同一关联器并限定attemptId。
- `replayTranscript(directory, limits?)` 返回 validation、公开消息、按 run/request/attempt/block 聚合的文本块、run 状态 / parent-root 任务树及 usage。它是公开投影，不代表原生请求续接或完整业务状态恢复。
- `exportTranscript(directory, newDestination, 'full' | 'share', limits?)` 返回验证报告与最终 destination / mode。

UI / IPC 调用方应捕获错误，显示 partial / warnings，并将此操作视为本地文件检查或导出。大量同步文件读取应放在已有隔离 runtime，不阻塞 renderer。

## 校验与安全边界

读取 manifest 时固定 `targetSeq = exportedSeq`。只验证、重建和导出从 1 到该序号的已确认连续事件；JSONL 更晚的尾部不会进入包，报告 ignored_tail_after_target。durable 大于 exported 时报告 jsonl_lags_durable，不能称为完整。保留范围必须覆盖 1 至 targetSeq。支持 manifest 的有序 segments 加活动 transcript.jsonl 尾部：逐片校验路径、SHA-256、完整行、连续序号范围和行数，合并后继续校验事件身份；封闭分片不得越过 targetSeq。字节、事件和文件上限针对所有分片合计，不能通过拆片绕过。

manifest 与事件 envelope 必须是 schemaVersion 1，未来版本拒绝。eventId 全局唯一，sessionSeq 连续，sessionId 一致，run 身份存在；JSONL 使用无 BOM 的 UTF-8 / LF。未知 schema 1 事件原样保留，不执行并报告 unknown_event / partial。具体 replay 能理解的字段另做语义校验，例如 UTF-16 block offset 必须等于现有正文长度，run 身份不得漂移或形成祖先循环。

事件 payload 中递归发现的每个 artifact 引用必须在 manifest 有同一规范化引用。所有 present 引用逐个校验真实文件 hash / byteLength，缺文件或损坏是明确错误；missing / external_reference_only 是 partial，外部句柄不触发请求。manifest 额外列出的引用也受校验，不能仅凭引用清单宣称内容可离线重建。受限原件也先按原始 hash 校验，分享时才移除。

读路径拒绝任意祖先目录中的 symlink / junction，拒绝硬链接及非普通文件。引用路径必须可移植且相对，拒绝绝对 / drive / UNC / ADS / 反斜杠 / NUL / `..` / Windows 保留名 / 尾部点与空格。没有解压、外部 URL 抓取或跟随链接行为。读取静态包可验证这些条件；当前没有操作系统目录句柄锁，不能承诺恶意进程在路径检查和读取之间替换目录的竞态隔离。

默认限制：manifest 16 MiB、JSONL 128 MiB、单 artifact 32 MiB、读取总量 256 MiB、10 万事件、1 万引用 / 文件、JSON 深度 64、每次 JSON 解析 200 万节点。超限明确失败，可通过 `Partial<OfflineLimits>` 指定其他正整数限制。先检查文件字节大小，再解析，并限制结构复杂度；不无限解压或扫描非引用文件。

## Usage 统计

attempt 的唯一键是 `(accountNamespace, requestId, attemptId)`，revision 是替换快照。累计 2 → 10 → 15 的有效值是 15；同 revision 同值重复终态不重计，同 revision 不同值明确拒绝。记录父子真实请求各一次；不将父任务聚合、delivery、继承历史或 replay 视为新消耗。

缺失 counter 归一为 null，unknownAttempts 与每字段 knownSubtotals 同时提供。knownSubtotals 的 0 是已知值的求和起点，不表示未知尝试消耗为零；每个 attempt 的 null 保留在 records。最高 revision 若声明 unknown，会替换较早已知快照，不能猜回旧值作为终态。按日统计采用最终 revision 所在事件的 UTC 日期。当前不聚合货币成本、不实施预算或重新估价。

## full / share 导出

导出先验证来源，冻结 manifest targetSeq，并读取所有引用原件；在目标的同级唯一 staging 目录写入 / fsync，再校验 staging 包，最后 rename 为新目标。full 保留受限原件和原始事件 ID，仅导出固定 target 的 JSONL 与已引用文件。来源文件不改写，也不覆盖用户已有目录。

share 将 restricted/ 或 `application/vnd.uah.restricted+json` 原件引用改为 missing / share_redacted，保持已有原 hash / byteLength 作为缺失证据，不复制受限原件。公开 JSON / 文本及事件公开结构使用 `redactJournalValue` 过滤已知敏感 key、带凭据 URL 与敏感 query 参数；公开 artifact 发生改动时重新计算 hash、大小和内容寻址路径，并同步修改事件 / manifest 引用。captureCoverage 必为 partial 或 legacy_partial，continuationCoverage unavailable，不能把修改签名后的内容标为原生可续接。原包受限签名内容保持字节原样。

脱敏不是所有未知秘密的识别保证；任意正文中的自定义秘密、未知二进制格式及非标准协议字段可能需要人工检查。成功返回前对生成包重新执行引用 / hash / 连续事件校验。失败只清理经路径检查的本次唯一 staging 目录，不递归删除用户目标或来源。

宿主的导出与引用清理在同一 runtime 内同步串行执行，清理要求空闲且重新检查指纹，引用闭包包含 manifest 分片。桌面数据目录由单实例锁保护。独立离线 CLI 没有跨进程引用租约；外部来源在读取时改变或丢失文件会可见失败。跨进程发布目标竞态、目录 fsync 的跨平台保证、压缩包、完整业务投影与原生 Runtime 重放不在此版本范围。

full/share 均将分片合并为单个 transcript.jsonl，导出 manifest 的 segments=[]，只保留固定 targetSeq 以内的事件，原 eventId 不变；share 继续执行原有引用重算和受限原件删除。来源分片及原件不修改。分片离线专项 8/8 覆盖平铺等价、导出、损坏、全局限额与 GC 引用保护；轮转专项 10/10，详见维护文档。

## 验证

`npx tsx --test tests/runtime/transcript-offline.test.ts` 19/19 通过；fixture 使用真实 RuntimeStore、TranscriptWriter、JournalArtifacts 及手造 artifact。覆盖公开 replay / UTF-16 offsets、父子任务树、2 → 10 → 15 / duplicate / unknown usage、unknown / future schema、原件不变、share 移除受限内容并重算 hash、固定 target 尾部隔离、缺文件 / hash 错 / JSON 损坏 / 引用遗漏、阶段失败无成功包、路径 / 硬链接 / junction 拒绝、容量界限与五个 CLI 命令。`npm run typecheck` 通过。测试只在经 root 路径检查的隔离临时目录写入和清理。
