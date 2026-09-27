# API 与端点接入

2026-09-26 开发盘点：UAH `722b9f7`、UI `010605f`，两个工作区开始时均干净；已有 5173 网页开发服务，保持运行。

## 组件盘点与范围

- 已核对 UI 的 `src/ui/index.ts`、README API、LiveExample 和既有视觉验收记录。
- 复用 UiInput（含原生 password）、UiField、UiSelect、UiSwitch、UiButton、UiCard、UiDialog、SnackbarHost 及布局工具类。现有组件覆盖列表、端点编辑、模型 ID 管理、异步等待与删除确认；无新增通用组件缺口，不修改共享外观。
- 接入 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages：端点增改删、启停、模型目录查询与手动 ID、测试、会话模型选择、文本流式对话、历史上下文、停止与错误处理。
- 新端点默认禁用；稳定端点 ID 与模型 ID 关联，不隐式回退。运行保存非敏感配置快照；在途请求使用启动时配置。
- 本轮能力为文本对话；不宣称文件工具、Shell、附件收发、思考请求配置或高级请求模板已经实现。订阅与官方运行时后续处理。

## 信任边界

- Renderer 仅通过校验 IPC 管理端点；密钥提交后不回传、不进入 localStorage、聊天 SQLite 或事件。
- 主进程使用 Electron safeStorage 系统加密并持久化密钥。API 运行经受信任的内部通道获取一次连接配置；不向网页开放通用 HTTP 代理。
- HTTPS 端点与本机回环 HTTP；禁止 URL 内凭据、查询、片段及重定向。用户明确配置的端点接收对话文本。
- 测试用本地 HTTP fixture 验证真实请求边界，不依赖真实账号或计费 API。

## 协议依据

- [OpenAI 流式响应](https://developers.openai.com/api/docs/guides/streaming-responses)
- [Anthropic 流式消息](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)

## 使用与限制

1. 「模型与账号」→「添加端点」，选择协议、填写含版本前缀的基础地址与可选 API Key。
2. 读取模型目录或手动添加服务商模型 ID；测试连接会发送真实生成请求，最多请求 256 个输出 token，可能计费，不自动重试。
3. 保存新端点后再次编辑并启用。在新对话的模型选择器中选择对应模型；旧会话保留其原端点/模型 ID。

API 只发送当前输入与本会话已完成轮次的用户/助手文本。失败或中止轮次不会作为完整历史重发。API 请求最长 60 秒，管理页发现/测试最长 30 秒；上下文请求上限约 1 MB，单次文本输出上限 500,000 字符，模型目录上限 500 项，端点最多 100 个。超限、断流、服务错误和不支持的工具事件均失败，不冒充成功。文本已接收部分保留。HTTP 仅限本机回环；不接受 URL 内查询认证或任意认证模板。

实际实现继续遵守会话/目录并发保护、单次运行配置快照及重启恢复。新增连接通过严格独立 IPC 管理；运行命令只接受端点与模型 ID，不接受 renderer 提供的地址或密钥。

## 验收记录

- `npm test`：48/48；三种协议的实际 HTTP 请求、认证头、中文分片、多行 SSE、协议终态、空输出、截断、工具事件拒绝、错误脱敏、重定向拒绝、取消、模型目录分页与密钥持久化均有覆盖。
- `npm run typecheck`、`npm run build` 通过。本机缺失的 tsc 命令入口通过 `npm rebuild typescript --offline` 恢复，未修改依赖版本。
- 端点桌面专项 8/8：`artifacts/endpoints-OTVWxP/report.json`。真实 Electron IPC、safeStorage 加密密钥重启读取、增改删/启停、目录发现、测试、多轮对话、401、挂起连接停止、未保存草稿保护均通过。
- 原有桌面回归 8/8：`artifacts/desktop-4Pg3Na/report.json`；搜索回归 6/6：`artifacts/search-BhTrvP/report.json`，包括新的模型与账号快捷入口。
- root 直接检查了浅色列表、浅深编辑器顶部与底部、900×800/125% 缩放的深色列表与编辑器。颜色、输入焦点、文本、控件、滚动到底后的操作按钮正常。缩放截图使用 Electron 原生 capturePage；Playwright 的缩放截图存在截取区域差异，不作为最终视觉证据。
- UI 仓库没有实现改动；尚无真实付费服务商账号的外部联调证据。高阶模型参数、工具执行、订阅与官方运行时继续后置。

## 模型目录兼容与能力同步（2026-09-26）

目录格式不依赖所选生成协议。GET 基础地址/models；协议只决定认证头，首次请求不再添加 Anthropic 专属 limit 参数。统一接收顶层数组、data、models、data.models 数组；条目支持字符串或 id/model/name，去除首尾空格、按 ID 去重。无分页标记即为完整页；has_more + last_id 使用 after_id，next_cursor 使用 cursor。不会跟随服务返回的任意 URL。JSON 2 MB、目录 500 个不同 ID、最多 10 页上限仍保留，并明确报错；未知接口路径不会自动探测。

目录读取返回 models 与 modelDetails。仅提取接口明确报告的信息：输入/输出模态、上下文、最大输出 tokens、工具/视觉/推理/流式支持。支持顶层字段、architecture、capabilities（布尔/支持对象/字符串列表）、supported_parameters、limits、top_provider 中的已知字段。明确 false 保留；缺失为未知；不根据模型名猜测，不保留任意原始 metadata。

端点编辑器在每个模型下展示能力，保存后持久化。再次发现会替换该批模型的能力，未报告的旧字段清除；移除模型也移除能力记录；变更基础地址清空旧能力。schema v2 增加 model_details_json，旧 v1 数据事务迁移，原密钥、启用状态、版本号和模型列表不变。能力元数据是服务声明，不等同于应用已实现相应附件或工具能力。

## 手动能力、原生多模态声明与测试结果（2026-09-26）

参考移动端 D:/StudioProjects/AgentApp 的 provider/ModelFetcher.kt、data/model/Models.kt 和 ui/providers/ProvidersScreen.kt。新增 imageInput/pdfInput/audioInput/videoInput 三态信息（true/false/缺失）。解析 capabilities.image_input/pdf_input 的 supported、capabilities.input 的 image/pdf/audio/video，以及 inputModalities/supportedInputModalities/inputTypes/modalities.input 等明确输入声明；输出模态和通用 attachment 标记不会当作原生输入支持。PDF 与通用 file 分开，仅 architecture.input_modalities 的 file 按移动端规则对应原生文档/PDF。

每模型「能力设置」可以使用接口声明、手动支持或不支持；可设输出类型、上下文、最大输出长度。modelOverrides 独立于 modelDetails；effectiveModelDetails 按字段合并，手动值优先。重新发现只更新接口信息，不覆盖手动值；恢复接口声明清除该模型的所有能力和 token 覆盖。修改先应用到端点草稿，再保存端点；取消能力编辑不修改草稿。schema v3 自动迁移 v1/v2，新增 model_overrides_json，不改变密钥及已有端点状态。

连接测试通过后返回实际文本及耗时，固定显示在端点弹窗 header 内（文本显示上限 8192 字符，超出明确标注），运行中有持续状态，失败用固定错误区。更换测试模型、地址、协议或密钥后清除旧结果。测试只验证文本流式通路，不验证全部能力，结果文本不写诊断日志。

移除设置页和模型页的「返回对话」，通过侧栏新对话或历史会话导航；工作面板保留图标关闭入口。多模态附件收发与工具执行尚未接入；本次能力设置不宣称这些传输已经可用。

Provider 新建默认启用，保存至少需要一个模型；卡片开关立即保存，无需进入编辑弹窗。已有停用端点保持原状态。能力列表仅展示明确支持的能力图标，false/未知不显示；悬停可区分输入和输出，完整声明与手动覆盖仍通过能力设置查看。

## 后续模型生成设置（2026-09-27，优先于初版能力说明）

生成参数已从 Agent 中移到对应 provider/model 的「生成设置」。支持 temperature、top P、输出上限、思考强度、Anthropic 思考预算、历史轮数、超时和停止序列，逐项说明用途与协议限制。schema v4 增加 model_parameters_json，迁移保持密钥、能力及启用状态；省略该字段的旧调用保留仍在目录内的设置，显式 [] 清空。正式运行按当前选中模型读取并快照参数，主 Agent 选择不会改变模型。具体映射和限制见 AGENT-SETTINGS.md。连接测试仍采用独立的短输出参数。

## 2026-09-27 工具与思考增量（优先于旧文本范围）
正式对话使用 streamAgentApi，接入三协议 function/tool 调用与原生结果回传、思考文本/摘要、子代理实际执行；连接测试仍使用独立 text-only 短请求。思考强度只来自会话，旧模型页 effort/budget 字段仅存储兼容。明确声明 tools=false 时不提供工具，未知能力可尝试，手动覆盖优先。Responses 可选参数工具显式 strict:false，参见 [function calling](https://developers.openai.com/api/docs/guides/function-calling)。实际工具/权限/新会话快照行为见 AGENT-SETTINGS.md。
