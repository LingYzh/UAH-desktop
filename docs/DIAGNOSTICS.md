# API 诊断日志

在「模型与账号」或端点错误弹窗中点击「打开日志目录」。日志位于 Electron userData/logs/runtime.jsonl；UAH_DATA_DIR 可覆盖 userData。无需打开 DevTools。重启桌面端后生效。

每次模型目录读取、连接测试、流式对话都有独立 requestId。错误提示显示中文原因、HTTP 状态、响应类型、原因代码和完整诊断编号；可按编号搜索日志。未收到响应时会明确显示。例：模型目录返回 501 项，当前上限 500 项（HTTP 200；models.count_limit）。这只是测试示例，不代表已经确定用户服务的错误原因。

JSONL 每行一个事件，包含 UTC time、requestId、operation（models/test/stream）、protocol、event、fields。事件包括 request.start、http.send、http.response、body.read、models.schema、models.limit、models.item_invalid、request.complete、request.failed、request.closed。fields 仅允许受控诊断代码和有限数值；记录状态、类型分类、字节数、目录数量、出错数组下标、耗时。不会记录 API Key、认证头、完整 URL、模型 ID、消息、原始请求/响应正文或任意上游错误字符串。

常见原因：

| 代码 | 含义 |
| --- | --- |
| json.decode | 非 UTF-8 JSON，可能错误路径返回 HTML |
| json.object_expected | JSON 顶层不是对象 |
| models.data_array_expected | 缺少 data 数组或类型不符 |
| models.count_limit | 目录或合并分页超过 500 项 |
| models.id_invalid | 指定下标的 id 无效 |
| models.pagination_invalid | Anthropic 分页信息无效或页数超限 |
| body.byte_limit | JSON 正文超过 2,000,000 字节 |
| http.401 / http.404 | 认证失败 / API 路径不存在 |
| sse.json_decode / chat.choices_expected | 流事件不符合当前协议 |
| network.ECONNREFUSED / network.ENOTFOUND | 连接被拒绝 / DNS 失败 |
| cancelled / timeout | 用户或外部取消 / 请求超时 |

runtime.jsonl 达到 2 MiB 自动轮转为 runtime.1.jsonl，最多保留当前文件和 3 个历史文件。日志写入失败不会中断请求，控制台只提示一次固定警告。日志入口只能打开主进程确定的固定目录，renderer 不能指定路径。

本轮针对 API 传输诊断，不是原始网络抓包；IPC 输入校验和端点保存错误仍由既有错误提示处理。复现后可提供完整错误或相同 requestId 的日志行，无需提供密钥。

目录现已通用识别，models.data_array_expected 表示未识别到 data/models/data.models/顶层数组。分页错误细分为 models.pagination.has_more、cursor_invalid、cursor_repeated、page_limit；models.pagination_end 记录结束方式。能力内容不写入日志，只记录目录数量和结构分类。

条件提示词每次请求装配后会写入 `operation: "prompt"`、`event: "prompt.assembled"` 事件，沿用同一本地日志、轮转和写入失败保护。每条事件有独立 `requestId`；`fields.runId`（UUID）和 `fields.round` 关联运行及请求轮次。该编号独立于传输层诊断编号。

`fields` 只包含 `runId`、`round`、`profile`、`totalCharacters` 和 `modules`。`profile` 只接受 gpt/claude/coding/generic；模块最多检查前 32 项，每项只保存 `id`、`version`、`included`、`reason`、`characters`。`id`/`reason` 是最长 100 字符、小写字母开头且只含字母、数字、下划线、点或连字符的受控代码；数值必须有限且非负，`included` 必须为布尔值。无效顶层字段省略，无效模块跳过。不会保存 instructions、模块正文、任务文本、路径、provider/model、密钥或额外对象字段。

排查某次运行时，在当前和三个轮转文件中搜索 UUID，再按 `event === "prompt.assembled"` 和 `fields.round` 筛选。查看各模块 `included` 与 `reason` 可确认当轮哪些条件成立，`version` 标识模块版本，`characters` 和 `totalCharacters` 仅用于长度比较；它们不能还原提示词正文。若某字段缺失，表示该字段未通过诊断校验，不能据此推断其原值。日志只接受运行时生成的受控代码；不要将用户文本或服务错误写入模块代码。
