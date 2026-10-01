# D07 公开历史候选投影

`publicHistoryCandidate(turns, continuation, prefixLength)` 是纯函数，只组装候选，不调用模型、不写 journal、不改变权限、不执行工具。它把旧 native 前缀替换为现有 D05 `HistoryTurn.messages` 的完整公开消息，所有历史 user 原文、assistant 内容以及已经生成的 host evidence 消息均保留。模块不识别或执行消息文本中的授权声明，也不重新摘要、截断或编辑这些消息。D05 上游公开投影本身可能已限定工具证据长度；此模块不声称能恢复那些未进入公开消息的内容。

旧 `prefixLength` 必须指向 continuation 中当前轮的 `role: user` 项；该项及后面所有 native 工具、opaque/加密块按完整 JSON 结构与字符串原值保留。返回的新 `prefixLength` 为公开历史消息项数，输入与输出均不共享嵌套引用。版本为完整旧/新 continuation JSON 的 SHA-256，字节数按 UTF-8 JSON 计算；`reduced` 仅当新字节数严格小于旧字节数。

每份 continuation、完整 turns 输入和最终 candidate 均限16 MiB JSON；根深度为0，超过128拒绝。非JSON值、循环、稀疏数组、class/日期/Buffer、符号字段、Proxy、getter/toJSON函数及会被JSON忽略的隐藏字段拒绝。JSON结构允许未知opaque字段，但不会读取其含义或执行它们。版本依赖完整JSON的原字段顺序，不是语义归一化签名。结构克隆保留有限数值（含负零），版本字节遵循JSON.stringify的标准表示。

此公开投影压缩不属于 LLM 摘要，也不保证更小或能适配模型上下文。模块本身没有自动切换、没有删除SQLite事实或 artifact。

Supervisor 已接入一次候选事务：已知容量不足且存在旧历史时，保存 restricted 原窗口、候选窗口和当前指令约束；公开 TaskState 引用这三份 artifact，并记录目标、Plan 版本、当前任务树的动作证据、可能副作用及待消费子结果。它明确属于证据，不能授权工具。canonical candidate 之后重新评估容量；只有窗口严格缩小、容量准入且上述记录未发生脱敏时，才在同一 SQLite 事务写 committed 和 RunRecord.contextState，确认后切换内存窗口与 prefixLength。否则写 rolled_back，保留原窗口并进入 suspended_budget。无法生成合法候选时直接容量暂停；存储异常进入记录失败，不发送模型请求。后续请求仍由宿主重取实际权限和工具。

本阶段没有 LLM 摘要、当前工具批次裁剪、自动预算恢复或崩溃后自动继续。容量未知只施加正文边界，不据此宣称窗口适配。集成验收结果另记于交接，不能以纯函数测试替代。

验证：`node --import tsx --test tests/runtime/context-compaction.test.ts`。覆盖中文、多轮host evidence/用户伪造文本、全部当前opaque批保留、引用隔离、不减少大小、JSON/深度/UTF-8大小/边界拒绝。
