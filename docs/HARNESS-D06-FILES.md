# D06 文件范围读取与唯一匹配补丁

`read_file_range` 与 `apply_patch` 是显式工作区内的文件工具。注册列表决定模型当前能调用的能力；提示词上下文使用本轮实际 catalog，不把只读会话描述成可编辑。readonly/plan catalog 不包含 `apply_patch`，伪造调用在分发前拒绝。manual 需要审批，auto/accept-edits 可直接编辑；路径仍经过审批后的再次解析和检查。bypass 允许工作区外路径，但仍必须选择规范的绝对工作目录，并保留链接和文件身份检查。

## `read_file_range`

参数是 `{path, offset?, limit?, expectedHash?}`。offset 默认 0，范围 0–16777216；limit 默认 16000，范围 1–65536。索引与长度都是解码后字符串的 UTF-16 代码单元，不是 UTF-8 字节、行号或 Unicode 字符数量。

返回正文是 JSON：

```json
{"text":"be","offset":0,"offsetUnit":"utf16","nextOffset":2,"totalCharacters":8,"fileHash":"原始字节的64位SHA-256","encoding":"utf8","truncated":true}
```

`nextOffset` 是下一页起点，读到末尾为 null；`truncated` 表示仍有未读尾页。offset 等于总长度返回空文本，大于总长度拒绝。结构化 outcome 的 truncation 则表示本次是否只返回文件的一部分，故非零 offset 即使读到末尾仍属于请求范围。

非零 offset 必须提供首轮得到的 `fileHash` 作为 expectedHash；任何提供了 expectedHash 的调用都核对它，文件漂移时拒绝。hash 包含 BOM 等原始字节。offset 不能指向代理对的低代理代码单元；终点落在代理对内时向前调整。limit 为 1 且起点是 emoji 等代理对时返回完整两个代码单元，最大返回 limit+1，保证分页能继续推进。

文件原始字节最多 16 MiB，仅接受有效 UTF-8 和 UTF-8 BOM。encoding 分别为 `utf8`、`utf8-bom`，返回 text 不包含开头的编码 BOM。无效 UTF-8、带 UTF-16 BOM 的文件明确拒绝；不猜测 GBK 或其他编码。没有编码标记且字节本身是有效 UTF-8 时，按 UTF-8 解码，不能证明文件创建者原先使用的编码。

## `apply_patch`

参数是 `{path, expectedHash, edits:[{oldText,newText}]}`。expectedHash 必填，接受 64 位十六进制原始字节 SHA-256。文件必须已存在，原始字节最多 1 MiB，父目录必须已存在；补丁不创建文件。

edits 为 1–32 项，oldText 非空，所有 oldText/newText 编码为 UTF-8 后的合计最多 1 MiB。每项在前面编辑已应用的累计文本中必须恰好匹配一次，包含重叠匹配的重复情况也拒绝。所有项和最终文件大小都在第一次写入前校验；零匹配、重复匹配、hash 冲突或非法参数不产生写入副作用。最终原始字节仍不能超过 1 MiB。

工具保留 UTF-8 BOM 和所有未编辑的字符，包括 CRLF。它与 `write_file` 共享文件锁、审批后路径复查、打开文件身份检查及写入/截断/sync/close 的故障路径；硬链接文件禁止修改，符号链接和重解析路径禁止访问。进程内同目标写入会串行核对版本，外部编辑者并不受这个进程内锁约束；这不是文件系统可回滚事务。

开始修改后失败的 effectState 为 possible；sync 完成后为 confirmed，即使随后 close 失败也保留效果证据。部分写入和 sync 失败必须先核对实际文件再决定重试。文件已成功写入但快照记录失败时，status 为 succeeded、effectState 为 confirmed、recordingState 为 failed、errorCode 为 RECORDING_FAILED，isError 为 true，retryClass 为 reconcile_first。没有快照 callback 时记录状态保持 pending。

## hash 与兼容迁移

新范围读取和补丁的 outcome.resources 使用 `hashKind: raw_bytes`，beforeHash/afterHash 针对实际原始字节；未观察到的版本仍是 null。文件变更快照沿用旧 ArtifactSnapshot schema：oldContent/newContent 为去掉编码 BOM 的解码文本，快照 hash 是 newContent 的 UTF-8 文本 hash。因此有 BOM 时快照 hash 与资源 raw hash 不同，消费者不能混用。

旧 `read_file`、`write_file` 的参数和成功正文保持兼容。旧读取仅支持 1 MiB，返回纯字符串，UTF-16 切片可能拆代理对；旧整文件写入仍要求完整 expectedContent 或创建时的 null。迁移分页读取时应解析新 JSON，使用 nextOffset 和原始 fileHash；迁移局部编辑时应先获取 raw hash，再给出唯一匹配 edits，不能把旧文本 hash 当成 expectedHash。新补丁不是 diff/行号语法，也不支持自动恢复、编码转换、超限文件或任意二进制编辑。

## 验证范围

`tests/runtime/workspace-tools.test.ts` 覆盖真实文件 UTF-8/BOM、CRLF、多字节、代理对、16 MiB/1 MiB 边界、参数、漂移、唯一匹配、链接、权限、取消、并发锁，以及 partial/sync/close/recording 故障与诊断隐私。

`tests/runtime/workspace-patch-loop.test.ts` 使用本地 SSE 与真实 Supervisor/SQLite/文件 artifact：readonly/plan catalog 和伪造调用防护；manual 审批期间外部修改冲突；auto 补丁快照与 activity 的 artifactId 关联、重新生成阻断；新范围 JSON 在模型续接中保持原字段，并核对 prompt context 的工具事实。等待 durable runtime 事件作为完成条件，没有用 sleep 猜测时序；服务绑定 Fetch 禁用端口列表之外的本地端口，使用独立临时目录并验证清理路径。

这里只验证文件工具和集成权限行为，不构成 UI 视觉验收或任意外部并发写入的原子性保证。

## 公开输出范围读取

`read_artifact_range` 接受 sha256、offset、limit（最多65536）及 utf8/base64 编码，只从当前会话已记录工具结果或分支副本的公开引用查找。拒绝任意路径、其他会话与 restricted 原生块，每页核验完整文件大小和 SHA-256，最多64 MiB。UTF-8 模式按字符边界返回 nextOffset；二进制使用 base64 和原始字节游标。命令结果展示 stdout/stderr 的 hash、字节数和读取提示，原始完整输出仍保存在 artifact 中。

artifact 单元、Supervisor 分支读取和实际70k命令输出合计17项通过。权限目录只开放实际注册的工具；readonly 可读取所属公开证据，不能借此读取受限原生内容。命令已知凭据匹配时，原生 helper 在落盘前等长替换，outputRedacted 明示原始输出未完整保留；此时范围读取/hash对应过滤后字节，不能称原始完整输出。另有两项实际命令隐私回归覆盖两种范围编码与full/share导出。
