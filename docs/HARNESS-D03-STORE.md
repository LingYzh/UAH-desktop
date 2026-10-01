# D03 SQLite journal / JSONL outbox 底座

此模块提供权威事件事务与可恢复文件投影。模块本身不安装请求捕获钩子；当前 Gateway / Supervisor 已完成接入，详见请求记录及应用账本文档。默认捕获可由用户关闭额外原始日志，不能仅凭 writer 存在声称某次请求完整。

## 权威事务及 API

`RuntimeStore` schema 从 v2 增量升级至 v3，仅新增 `canonical_events` 和 `journal_exports`，保留原 sessions / runs / approvals / artifacts / events / request_contexts。旧事件不伪造 canonical 事件；旧会话 journal 起点为 0，后续真实记录从 1 开始。未来 schema 明确拒绝打开；没有自动降级或数据回退。新 journal 无 session 外键，允许独立命名空间；当前 TranscriptEvent 仍必须提供 run 身份，application-scoped 流留待后续契约。

- `commit({ ...existingChanges, journal?: TranscriptEvent[] })` 在同一 SQLite transaction 中保存状态和事实。eventId 全库唯一，sessionId + sessionSeq 唯一，每会话从 1 连续；主子运行共用会话序列。任何失败回滚本次全部状态与 journal。
- `nextSessionSeq(sessionId)` 读取当前 durable + 1，不预留序号。唯一同步 Store owner 必须同步读取、组装及 commit，中间不得 await 或并发分配；同一批后续事件直接递增。失败不会消耗序号。
- `readJournal(sessionId, afterSeq = 0, limit = 1000)` 按 sessionSeq 升序分页。
- `journalWatermark(sessionId)` 返回 `{ durableSeq, exportedSeq }`。SQLite WAL + synchronous FULL 提交为 durable；文件 fsync 确认后才可更新 exported。
- `journalBacklog(sessionId)` 返回 `{ events, bytes }`，SQL 统计 seq > exported 的行数及 `length(CAST(data AS BLOB)) + 1`；bytes 是 UTF-8 JSONL 实际落后字节，含每行 LF，不把中文字符数误作字节。owner 可据此实施有界积压准入，底座不硬编码容量策略。
- `markExported(sessionId, seq)` 拒绝超过 durable、倒退及非法整数；只供持有文件 fsync 证据的投影 writer 调用。

最低 envelope 校验拒绝未来 schema、无 run 身份、非法序号。schema v1 中的未知事件 type 仍作为权威数据保留、导出，不把未知 payload 解析为操作。它不替代业务端针对具体事件类型的校验、脱敏或 artifact 落盘确认。后续 D05 已用默认 100000 runs / 2 GiB 逻辑数据库准入配额替换旧 500 条截断，不自动删除旧历史。

## 文件 writer

```ts
const writer = new TranscriptWriter(store, dataDirectory, {
    batchSize: 1000,
    segmentBytes: 8 * 1024 * 1024,
    captureCoverage: 'partial', // 旧会话调用方应明确指定 legacy_partial
    deriveCoverage: false, // 独立 writer 默认为 false；接齐捕获的 RunJournal 可设 true
    legacySessionIds: new Set(), // owner 启动时识别旧 run 缺口，避免升级旧会话
});
const health = writer.flush(sessionId);
// { sessionId, status: 'healthy' | 'degraded', durableSeq, exportedSeq, error?,
//   captureCoverage?, continuationCoverage?, recovery?, redactionPolicyVersion? }
const shutdownHealth = writer.close(); // 必须先于 store.close()
```

文件路径为 `sessions/<SHA256(JSON.stringify(sessionId))>/transcript.jsonl` 与 `manifest.json`。字符串编码及哈希避免 Windows 保留名称、分隔符、冒号、Unicode 与相对路径被解释为路径；manifest 保存原 sessionId。拒绝任何路径组件中的符号链接 / junction，文件打开使用平台可用的 O_NOFOLLOW；数据目录应由应用独占管理，Windows 没有跨全部目录组件的原子 anti-TOCTOU open 保证。SQLite 文件自身安全沿用原 Store 路径规则。

JSONL 精确使用 SQLite 已保存事件的 JSON 序列化、一行一个事件、UTF-8 无 BOM、LF。首次 flush、重启或文件大小 / mtime / ctime / inode 变化时，分批读取 SQLite，逐行比较完整字节，包括 eventId、seq 与内容。文件是有效前缀且不落后于既有 exported 时，先 fsync，再对齐导出游标后继续追加。半行、中间损坏、内容不一致、缺文件或丢失已确认前缀时，从 SQLite 原事件 ID 原子重建整个投影；未知文件内容始终只是待比较的数据。

正常 flush 不重复全库扫描或重写：从 exported 按 batchSize 增量追加，每批 writeAll + fsync 成功后确认游标。写完文件但 SQLite acknowledgement 失败的重启，可核对现有内容并恢复游标，不产生新事件或重复行。文件投影事务不回滚已成功 SQLite commit。

`flush` 文件错误显式返回 degraded / error 及当前水位；即使水位相等，manifest 错误仍是 degraded。失败后下一次 flush 强制重新核对。调用方必须显示此健康状态，不能只用水位相等判断健康。`drain` / `close` 同步处理该 writer 已触及的会话并返回全部结果；未触及会话须由 owner 显式 flush。writer 不拥有 Store，不自动关闭 SQLite。

manifest 记录水位、保留范围与 capture coverage，并递归索引已提交 payload 中的 present / missing / external_reference_only ArtifactReference，按完整规范化引用去重。首次 flush 从 SQLite 重建索引，后续仅扫描新增事件；引用保存实际 sha256、大小、缺失原因或外部句柄。路径使用可移植相对路径约束，拒绝绝对路径、盘符、UNC、ADS、反斜杠、NUL、`.` / `..` 与 Windows 尾部点或空格；不安全引用保留在 DB 作为证据，但 flush degraded，不生成可误用的 manifest。deriveCoverage=false 时 writer 不读取 artifact 原件、不校验原件 hash，也不把 present 声明提升为文件存在确认。

## 可选完整度推导

`deriveCoverage` 默认 false，保持独立 writer 的 partial / legacy_partial 行为。true 时按 session 增量处理 canonical 事实，只在首次 / 重启读取已有范围，后续从索引水位继续；不会每个 delta 扫描整个 journal。至少一个实际 attempt，且所有已观察 requestId + attemptId 必须有完整 request.intent snapshot、completed / partial=false terminal、完整 native continuation 原件。所有参与 run 的最终 run.state 必须终态，所有 tool.dispatch 必须有 durable tool.result；未知事件、recording_failed、needs_reconciliation、missing / external 引用、未完成 attempt、尚无 terminal 的 run 都阻止 complete。

推导会首次核对每个 present artifact 的路径、普通文件 / nlink=1、实际大小与 SHA-256。request snapshot / native JSON 额外读取受限原件，单 JSON 上限 16 MiB，核对同一 attempt 的 snapshot 身份与 coverage，以及 native captureCoverage / continuationCoverage / continuation 数组。解析、链接、缺文件、hash / 大小或容量错误返回 degraded；已提交 SQLite 保留。普通自动flush缓存不可变artifact的校验结果和小型coverage元数据，不保留完整请求body或原生正文。显式journal.project会清除验证缓存并重新检查原件；已有缓存后篡改会降级，修复后重新显式校验可恢复。重启及离线validate也检查原件，不承诺无租约下的实时artifact监控。

只有全部门槛满足才标 complete；零事件标 legacy_partial，只有 local run 而没有实际 request 仍 partial。`legacySessionIds` 在构造时复制，集合内会话始终 legacy_partial / unavailable，owner 应一次识别未留下 message.accepted 的旧 runs，避免新增完整请求覆盖旧缺口。redactionPolicyVersion 从 snapshot 原件已有版本推导，缺失或混合版本保留 unverified，不编造已完成脱敏。

续接 native 只在每个 attempt 都有完整 snapshot / terminal / native 原件且无缺失 / 未知 / 旧历史时成立，失败或部分流为 unavailable。完整 capture 或 native 数据不代表可执行恢复：recovery 从不提升 eligible_for_review；明确 needs_reconciliation 或未确认 dispatch 时为 needs_reconciliation，其余 stopped。flush 成功结果附带与 manifest 相同 coverage 供 UI；失败结果保守降为 partial / legacy_partial 和 unavailable。

当前默认在 8 MiB 阈值按完整行封闭分片，manifest.segments 记录连续范围及 hash，transcript.jsonl 留活动尾部；启动或签名失配可能从 SQLite 完整重建。增量缓存只在 manifest 原子写成功后接受，失败明确 degraded。离线导出合并为平铺包，不请求外部 URL、执行工具或恢复真实动作。桌面单实例锁限制同数据目录 owner；没有独立 CLI 的跨进程引用租约或目录 fsync 跨平台崩溃保证。轮转、GC、升级备份和删除详见 [HARNESS-MAINTENANCE.md](HARNESS-MAINTENANCE.md)。

用户明确关闭原始捕获时，完整必要原生历史允许 partial/native；普通脱敏或损坏不放宽，详见 HARNESS-LOG-POLICY.md。生产 worker 的升级备份先于 Store 写入，schema/索引迁移同事务，并追加 session_purges 表保存删除中断状态；application journal 已使用独立数据库和命名空间，并非仍待接入。

## 验证

`npx tsx --test tests/runtime/transcript-store.test.ts` 32/32 通过，覆盖事务回滚、父子序列、重复 / gap、独立水位、UTF-8 积压字节、逐批追加、UTF-8 / LF、尾部及中间损坏重建、fsync 后 acknowledgement 中断、磁盘 fsync 失败、水位差、目录失败、恶意 sessionId、junction 拒绝、v2 保留迁移、未来 schema 拒绝、未知 type 原样保留、嵌套引用去重 / 重启恢复、七种越界路径、正常 complete、中途 / 失败 / unknown / missing / external / 未结束第二请求 / 未结果 dispatch / reconciliation 的 partial、legacy 保护、仅新范围扫描及受限 JSON 16 MiB 上限。联合 offline 测试共 51/51，`npm run typecheck` 通过；不冒充真实磁盘满、强杀或完整请求捕获的桌面验收。
