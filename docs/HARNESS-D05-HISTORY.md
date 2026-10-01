# D05 首段：原生模型历史与公开视图

2026-10-01，本页记录 `src/runtime/model-history.ts` 的纯helper契约及定向测试。helper测试12/12通过，TypeScript检查通过。Supervisor保存ModelFrame、跨轮复用、分支复制和应用重启由root另行集成验收；本页不把helper测试当作这些路径已通过的证据。

后续集成更新：`model-history-integration.test.ts` 的6项真实 Supervisor + 本地三协议 SSE 测试通过，覆盖跨轮、重启、原生工具/opaque块、分支后源回复编辑、删除、端点版本改变与 artifact 损坏 fallback。账户命名空间为 endpoint ID + revision；分支复制原生 JSON 到分支自己的 restricted artifact 目录，更新引用的 sessionId，供应商 opaque 内容不改。`history.frame`/`history.branch` canonical 事件保护导出引用，公开 fallback 的工具证据是独立 host 消息，不修改用户编辑后的 assistant 文本。分支公开消息上限 1 MB，含工具证据的 turn 元数据上限 2 MB。

## 记录形状

可编辑的Run公开回复与不可变的原生模型历史分别维护。`RunRecord.modelFrame` 保存ModelFrame引用；`SessionRecord.branchHistory` 保存分支创建时复制的turn公开消息和原生引用。无需新增store表，沿用Run/Session记录和restricted artifacts；原生artifact由既有canonical `response.native` 事件引用。

ModelFrame记录schemaVersion、frameId、sessionId、protocol、modelId、accountNamespace、publicFingerprint、prefixLength、content artifact引用和continuationCoverage。复制分支时保留 frameId，将 sessionId 指向分支，复制 artifact 并保持 opaque 供应商内容不变。读取引用必须由调用方验证artifact存在、字节数和SHA-256；测试使用真实 `JournalArtifacts.read` 验证损坏/删除后的fallback。

## Helper行为

`modelTurnFingerprint(run)` 以用户input、公开displayedReply、history编辑/删除状态、Run状态及计划版本/内容生成SHA-256。已完成Run的原生frame只在指纹匹配且未删除时有效。编辑回复、删除回复、修改input、计划或终态都会使旧引用不再用于原生续接；helper不修改旧frame。

`historyTurns(snapshot, sessionId, options)` 从分支快照和当前会话的可见root运行生成turn。子运行不作为独立对话turn，retry引用隐藏被替代的旧尝试；beforeRunId/throughRunId按snapshot原始插入顺序定位，缺失或跨会话cutoff拒绝。只采集completed/failed/stopped；运行中的partial正文不成为完成事实。limit为0返回空历史，有限窗口只保留最近对应数量的turn；未指定limit保留当前可见turn。

已删除回复保留用户turn，去除assistant内容和原生frame。失败/停止运行只保留用户任务及host生成的中断说明，不把partial assistant输出或私有reasoning作为完成答案。完成turn的公开fallback追加最多32条已记录tool结果，单结果最多2,000字符、整体证据段最多12,000字符，并明确标注历史数据不是操作授权；证据携带可用的状态、资源版本与artifact引用。

`nativeHistory(turns, target, read)` 只在schema、protocol、modelId、accountNamespace匹配，frame continuationCoverage为native，读取对象的captureCoverage为complete且continuationCoverage为native时采用原生历史。prefixLength必须是合法整数并指向当前turn首个user项；读取后仅取这个prefix之后的turn，避免把每份artifact中已有的前轮历史再次拼入。签名、加密reasoning及原生tool调用/result块保持原样，不投影成公开文本。

跨模型、跨协议、跨账户、不可续接、partial、缺失、校验损坏或结构不符时，返回公开消息与已有tool证据，不携带私有reasoning。完整artifact是否可读取由read回调负责，helper捕获读取失败并选择fallback。此行为没有执行或重新授权历史tool。

## 分支隔离

branchHistory是创建分支时的深拷贝turn快照。原会话后续编辑/删除不会变更新分支的公开消息或原生引用；分支自己的新turn只追加在其快照之后。helper返回的分支turn也是独立复制，调用方修改返回值不改变Session存储的branchHistory。窗口和cutoff同时适用于分支快照及该分支的当前turn。

兼容旧Session.branchMessages时，helper将role/content消息分组为公开turn；旧记录没有原生引用，正常走公开fallback。没有猜测或重建历史供应商签名。

## 定向验证

```powershell
node node_modules/tsx/dist/cli.mjs --test tests/runtime/model-history.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

12项测试覆盖：

- 公开回复编辑/删除、用户input、Run状态及计划变更使指纹失效，旧frame身份不变。
- 同目标两turn按prefix切片，无重复前轮历史；有限窗口只保留当前turn片段。
- 单turn多轮tool调用/result保留原生签名与关联ID。
- Chat Completions、Responses、Anthropic各自opaque字段逐项原样保留。
- 真实restricted artifact正常读回；实际改写文件或删除后只返回公开消息。
- 模型/协议/账户切换、partial/unavailable或无效结构fallback保留tool证据，私有reasoning不进入结果。
- 无效prefix与缺失user边界fallback，不放行原生块。
- retry、原始cutoff、子运行排除、运行中partial排除、limit 0及有限窗口。
- 分支快照不受原会话编辑/删除或返回值修改影响，兼容旧branchMessages；failed/stopped只保留host中断证据。

测试只构造局部Snapshot和独立临时artifact目录，不读取用户数据库或调用模型API。临时目录清理前校验其父目录及专用前缀。

## 本阶段边界

helper测试证明选择、切片、fallback和分支视图隔离规则；上述六项本地三协议 Supervisor 集成测试进一步验证 prefix、重启关联及分支持久路径。测试没有使用真实外部 Provider，因此不能推断所有服务商私有扩展都兼容。

分支还复制截止点内可见 root 与所属子任务的公开工具 artifacts，并保存 `branchArtifacts` 及首次分支运行的 canonical 引用；原生和公开副本合计限制128 MiB。两项 artifact-loop 集成测试验证源目录删除后仍能读取分支副本、拒绝截止点之后与其他会话的引用，完整导出经 validate/replay 校验。

历史拼装、分支、重新生成副作用检查和子任务上下文现在使用 `readSessionSnapshot`，SQL只读取所属会话，保留rowid顺序，避免为了本会话请求扫描其他会话。此内部投影不校验artifact；读取原生frame时仍逐件校验，显式snapshot完整性检查保持不变。存储历史8项与journal33项通过，跨轮/压缩/steer/重试/预算/回复/中断历史57项集成通过。

本阶段仍可保存包含前缀历史的完整restricted continuation artifacts，prefix切片避免请求内容重复，不等于artifact存储已去重。SQLite已有游标分页与准入配额，聊天DOM分批挂载50轮；Supervisor内存及IPC仍全量。上下文预算及公开投影事务另见D07，本页不把会话范围查询称为完整长期分页。

## 同日后续：常驻缓存与会话视图

RunCache将普通终态常驻量限制为128条LRU记录；活跃执行及进程内recording_failed视图继续保留，后者可能是权威故障后唯一准确的终态通知。边界按条数而非字节，不保证固定内存MiB。get按ID补读，forSession返回SQLite插入顺序并叠加未flush实时状态，不把完整查询结果放入缓存。historyGuard用单调会话revision检测并发修改，普通读取及LRU驱逐不改变revision。

缓存6项测试验证1000终态、驱逐后重读、实时/失败视图、会话隔离、Plan/子关系/副作用、旧回复编辑、最早Agent锁定；真实Supervisor1000历史启动常驻普通终态为0，全量兼容snapshot不填缓存。545项既有回归通过；100k/1000桌面基准harness-desktop-performance-Hnij4V通过，runtime working set单次约77040KiB，不是稳定SLA。

可选SnapshotView通过main/preload/utility边界校验，限定sessionId或null概览；无参数兼容旧全量接口。范围响应包含当前会话全部运行/审批/文件快照及轻量跨会话root/latest状态与active IDs，不携带其他会话正文或复制的branchHistory。选中会话仍校验file artifact manifest/hash，另一个会话损坏的artifact不会拖入此读取。4项后端/IPC输入测试通过；renderer接入与桌面回归尚在进行。

启动恢复仍临时读取全量并核对未配对dispatch；会话内运行、审批、文件快照仍整组查询，模型历史也仍会话级读取。长期保留/GC、会话内真正分页及恢复扫描优化尚待后续，不把此阶段记为全部长期历史优化完成。

2026-10-02界面迁移已完成：初始化/切换/命令返回均携带view，迟到响应不覆盖新选中会话；后台正文delta不触发全量刷新。侧栏使用root状态、搜索使用latest状态、全局活动数使用active IDs。所选分支需显示的公开branchMessages与锁定Agent保留，其他分支正文及全部原生branchHistory不传renderer。renderer定向30项、全量564项通过；分支投影修复后定向3项/build及turn-actions-N5lO9q通过。性能harness-desktop-performance-GGw2nG21项通过，仍保留当前会话全量历史，不冒称会话内分页。

启动canonical核对现使用SQLite流式身份投影，按session/run/invocation关联dispatch/result并保留事件顺序，不在JavaScript物化完整请求/响应/工具结果正文。缺失身份拒绝恢复；跨会话或跨run的同名调用不再互相抵消。全量565项通过（harness-full-recovery.log）。此查询仍需SQLite读取JSON；基础snapshot和artifact验证仍全量，不声称已消除所有启动扫描。

同日进一步改为readRecoverySnapshot：流式读取并丢弃无关终态正文，保留非终态、pending审批、uncertain候选并保持rowid顺序；逐条artifact/manifest检查保持原完整snapshot的缺失、hash、重复矛盾及坏JSON拒绝语义。日志旧覆盖识别改为MATERIALIZED DISTINCT身份CTE，只扫描canonical一次，不再为每个run反复解析全日志。启动仍全量扫描历史JSON、sessions/approvals及身份索引仍常驻；降低峰值物化量不等于会话内分页或取消完整性检查。13项新测试和Supervisor恢复/历史共24项通过，合并后全量579项通过。

### 2026-10-02 会话尾部窗口

SnapshotView 增加可选 turnLimit；普通聊天初始50，每次加载增加50。readSessionWindow在SQLite按既有rowid轮次语义选可见根，重试前驱在全会话身份范围隐藏，已删除回复仍保留用户轮。递归闭包包含子孙、retry前驱、计划来源、活动祖先、当前计划、最早Agent身份及最近根任务请求上下文；historyWindow.rootIds单独定义聊天成员。只物化选中运行、审批、artifact，并只验证这些文件证据。普通终态resident缓存不会被追加回窗口。

全会话hasFileChanges摘要保留页外副作用约束，renderer同时检查实时窗口证据。旧session/旧窗口/已关闭面板的迟到回包被丢弃；加载使用可见运行身份与屏幕偏移恢复阅读位置。新轮增加时扩大已加载额度以保留原下界。打开历史快照、计划或全部子代理面板才请求旧完整会话视图，并在完整响应之前显示加载状态，关闭后重新缩回窗口。内部模型历史、分支、恢复和修改权限检查仍使用完整权威记录。

边界：turnLimit是聊天轮数，不是返回记录数或字节上限。依赖子树/重试链可能较大；SQLite仍扫描身份及相关副作用JSON，分支继承消息仍全量，三个历史面板在访问后仍全量。这阶段减少默认正文物化与IPC，不声称所有查询成本和面板已恒定化。

验收：全量626/626（harness-window-full.log），窗口store12项、renderer9项及Supervisor缓存边界回归通过，typecheck/build通过。harness-desktop-performance-TlIxXS共22项：1000轮只传50聊天根与首根依赖，加载100/150，滚动锚点0.1875px；100k正文仍仅2次snapshot IPC。root看图验收浅深主题和实际更早加载按钮。Plan桌面DcdUxB、回复/分支8ALVLG通过；tool-chat首次jG6Flf的测试读取最后请求断言失败，持久请求中的停止结果完整，增加失败诊断证据后完整复验F9ebu4六场景通过；未修改生产执行逻辑或放宽停止断言。该单次失败原因尚未确定，不作为产品故障已定位的声明。
