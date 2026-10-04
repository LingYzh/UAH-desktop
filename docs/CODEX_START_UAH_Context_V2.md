# Codex 执行入口：UAH Context Engineering V2

请在 `LingYzh/UAH-desktop` 中实施随附 `UAH_Context_Engineering_V2_Plan_2026-10-04.md`。核心问题是用户报告的缓存命中低于 20% 且随对话增长下降。不要把任务缩减成改 UI 百分比、缩短 system prompt 或直接安装 pi-ai。

先读当前 AGENTS.md、现有运行时/日志升级规范及子代理中途消息计划，对比当前 HEAD 与方案基线 `629196a0328e66eba691a0f928a9f8536c990505`。用户可能已有本地更新，保留所有未提交改动；以当前代码事实调整具体文件，不推倒既有安全链路。

## 必须完成

完整执行计划中的 C00–C08：最终请求诊断；CanonicalEntry / active surface / RouteSnapshot；稳定系统规则与语义变化快照；跨 run/重启历史；原生回放来源校验；稳定 tools；缓存旧 frontier 与新推进点；provider-aware usage；统一 token/byte 预算；原子压缩；控制/relay 接入；UI 可解释性；迁移/回滚与回归验收。

C09 引入 pi-ai backend 为可选独立实验，不是前置条件。不能让 pi-agent 接管 UAH 的任务树、权限、工具执行或持久会话权威。

## 必须保留

- 现有 SQLite 为权威，JSONL 按既有 outbox/单写入链路导出，禁止双写第二事实源。
- 工具调用与结果配对、原调用顺序、签名/加密块的兼容隔离、未知副作用核对、用户停止与权限门。
- 所有真实请求和重试逐 attempt 记账；partial/unknown 不补零，流式累计 usage 不双算。
- 原始内容与签名不因重新格式化而变化；编辑、删除、压缩采用显式新版本。
- 未支持的 provider/runtime 能力不得靠品牌名或协议名猜测；官方 CLI 托管模式由 CLI 管理自己的上下文。

## 首先定位的已知路径

检查 `prompt-context.ts` 的 runId/taskTreeBudget/toolProgress，`supervisor.ts` 每轮 `budget.snapshot()` 与 Git 读取，`prompt-assembler.ts` 将动态 sections 拼入 instructions，以及 `api-transport.ts` 将其放在历史之前的真实发送路径。

从最终 prepared body 建立 prefix/source-map fixture。不要仅在请求预览 UI 里将 context.* 分成另一栏，就宣称发送顺序已修复。

缓存计划不能只标系统头，也不能在显式断点路径上仅移动到最新消息：需要保留可用旧历史边界，再安排下一步推进点。key 与 frontier 跨普通 run/重启保持，不使用随机 attemptId 或最新历史 hash 作每轮 cache key。

## 实施顺序

1. C00：不改默认发送行为，形成三协议最终请求的基线和低命中诊断。
2. C01+C02：稳定前缀基础闭环，优先让仅时钟/预算变化的测试通过。
3. C03+C04：历史连续性、回放和真实缓存策略/统计闭环。
4. C05+C06：长期上下文压缩、可解释 UI、steering/relay 贯通。
5. C07+C08：旧会话迁移、删除一致性、回滚、基准和完整回归。

可以并行只读调查；修改同一 supervisor/store/协议核心的任务只允许一个整合写入者，避免互相覆盖。

## 验证与限制

运行适用的现有 typecheck / test / build / desktop smoke；新增测试确保被现有 glob 收录。执行完整矩阵 T01–T66；选择 C09 时再执行 T67–T68。

普通测试、基准与 CI 禁止真实付费 API 调用。提供单独 opt-in live benchmark，但未获明确授权不要执行、不要自动预热、不改变模型、账号、权限或长 TTL 费用选项。

warm 真实缓存读占比 ≥80% 只是计划中受控条件的优化目标，不是无条件保证。离线前缀测试必须严格；真实 provider 结果缺失时报告未运行，不能用模拟 cache usage 宣称实际达到 80% 或 90%。

完成报告包含：批次提交、T 编号覆盖、迁移/回滚、前后最终请求差异、最早破坏位置、input/cache read/cache write/coverage 与用途、性能原始数据和已知限制。明确区分“机制验收”“真实 provider 验证”“生产收益证据”。
