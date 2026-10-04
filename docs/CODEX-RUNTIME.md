# GPT 提示词系统与 Codex 运行时

当前权限与指令已更新为三档原生预设、原生 `/plan` 和 `/goal`，保留本机 MCP；模型名称、Provider key 独立保存和客户端中文错误提示见 [NATIVE-CODEX-COMMANDS.md](NATIVE-CODEX-COMMANDS.md)。

最新状态（2026-10-03）：已按 D09 接入 Codex app-server，使用 native-default；实际接口、权限映射、覆盖限制和验收见 [HARNESS-D09.md](HARNESS-D09.md)。下文 2026-09-27 的“尚未接入／设计建议”是保留的来源与历史设计，不代表当前实现。实机核验版本为 0.156.1；不是本资料包的 0.157.1。

绑定配置已支持 Windows 自动扫描、基础启动参数和帮助弹窗，模型通过 model/list 自动获取。启用仅提供新的原生轮次入口，关闭不会停止当前任务。已接入 UAH 动态工具桥：原生父任务可启动 API 或原生 Codex 子代理，共用任务树、取消、角色路由及宿主预算；原生自身协作工具关闭。原生预算仅覆盖宿主可观察的调用。API 父任务暂不能反向启动原生子任务。内置 grilling 与 powershell-windows-cli 随应用提供，详见 [NATIVE-DELEGATION.md](NATIVE-DELEGATION.md)。

状态：2026-09-27。当前 API 提示词已进一步升级为[条件装配](CONDITIONAL-PROMPTS.md)，原生 Codex 运行时尚未接入。下文保留 v7 分层预设的来源与设计依据；v8 的配置与装配行为以上述文档为准。本轮已通过 kiro 验证真实 API 模型调用，但未启动原生 Codex 或接入订阅认证。

## 已阅读资料与来源核验

用户提供的 [资料包](codex-cli-0.157.1-prompts/README.zh-CN.md) 包含原始基础／角色提示词、运行时条件片段、portable 模块、完整组合、占位符定义、示例、导出与渲染脚本、测试、修改 diff 和许可。采用其 portable 模块，保留非占位正文，UAH 只填写自己的宿主契约。它是第三方适配，不是 OpenAI 官方发布或账号实际请求的导出。

上游固定为 `rust-v0.157.1` / `36650394c5b38c2990ccf2a3457165ca3e9d9726`。预制原文来自 `gpt-6-astra` 条目，不代表其他 GPT 模型的实际原生提示词，也不代表账号拥有该模型。当前预设仍不绑定模型。

本轮独立运行资料包测试：18/18 通过；35 个 MANIFEST 项全部匹配。通过其导出器下载固定提交的公开 models.json，Git blob 为 `8fd2c078f857aa9e12ee2b74131e539d3ead520f`，SHA-256 为 `0178d235c589a31abd6ed0ea1e870935dc5819240eb0e813e178d3ebedf534f4`，与包声明的 blob 相符。未读取账号或密钥。

`--verify-pack` **返回 1**：两个角色逐字节相符；基础文件第108行比上游少一个行尾空格，除此无差异。忽略行尾空白后完全一致。包内基础 SHA-256 `5f582b45198c152b05ba1a3695f2722e2b2e25db2a436deaeb9adc49b5a060ab`，上游提取值 `35bd51b5f577cb7b24cd5f4629e49e37cb724ab57754ce6f8f202001635bab8a`。保留用户包原样，不能把此结果称为全部字节核验通过。详细证据在 `artifacts/gpt-source-verification.json`；可用包内脚本重新核验。

## 当前 API 适配的装配方式

```text
portable/shared-base.md
  + portable/main-role.md 或 subagent-role.md（恰好一个）
  + portable/runtime-context.md
  → 34 个已定义宿主槽位的一次性绑定
  → 可编辑的 Agent.instructions（保存配置／首次运行锁定）
  → 每个模型请求前填充 UAH_CONTEXT 区块
  → 现有权限模式、实时委派限制说明
  → API 协议适配器的指令入口与独立工具 schema
```

`scripts/generate-gpt-prompts.mjs` 将四个原模块无损编码成 `src/shared/gpt-prompt-templates.ts`，记录每个 SHA-256；`--check` 检查生成物漂移。应用构建只打包 TypeScript，运行时不读 docs、不联网下载。`gpt-harness-prompts.ts` 单次替换占位符，不递归解释插入内容；共同基座只出现一次，主角色不混入子预设。

绑定明确反映本项目现状：工具调用批次串行，后台子运行可并行；Windows PowerShell 命令需审批且无 OS 沙箱；子代理只有 spawn/list presets/wait，没有消息总线、followup 或模型可调用的停止工具；等待超时不等于完成；父运行等子运行结束不等于父模型已验收结果。Plan 使用真实计划文件与 UI 审批。技能、连接器、MCP、插件和自动压缩不可凭提示词产生。

动态提供器 `src/runtime/prompt-context.ts` 为两个品牌共用，填入 runId、parentRunId、主／子角色、深度、实际模型／provider、平台、目录、权限与当前工具列表。Git／记忆缺失时保留未知说明。资料编码为有界 JSON 并转义区块标记，不作为新任务指令；任务仍位于 user 消息。未来功能必须同步更新提供器、静态说明和测试，详见 AGENTS.md。删除区块标记可以保留自定义静态内容；无标记提示词不变。

新增 `gpt-subagent-default`：模型可选绑定，初始 null；默认启用，默认禁止继续委派。主 GPT 仍默认允许委派。数据库 v7 归档原 v6，仅升级与 `LEGACY_GPT_INSTRUCTIONS` 完全匹配的 GPT 主指令，不覆盖用户修改、名称、描述、停用状态和已删除主项。新增子项按 ID 去重，一次性添加；100 项／1 MiB 不足时跳过而不挤掉数据。历史会话锁定快照不变。

## 原生指令分层：后续适配器必须遵守

依据资料包定位的固定源码：

| 层 | 来源与含义 | UAH 后续处理 |
| --- | --- | --- |
| 模型基础 | models.json 的 model_messages.instructions_template | 使用实际所选模型元数据；该版本解析器按字面量读取，不自行展开 instructions_variables |
| 主／子角色 | model_messages.multi_agent.role.root/subagent | 缺失才回退 bundled；显式空字符串是有效覆盖 |
| 多代理运行时 | prompts/src/multi_agent_instructions.rs | 单独 developer 消息，按共享目录、等待、并发、模型覆盖及委派模式条件追加；不能全量复制片段 |
| 权限／工具／模式／技能／项目规则／环境 | 原生运行时真实配置与注册表 | 由原生运行时维护，不从 UAH portable 描述推断能力 |
| 本次任务 | 用户输入／外部委派任务 | 保持 user 层，不借 stdin 冒充 system 覆盖 |

优先让 Codex 自己组装原生提示词，不设置 `model_instructions_file`。确需基础覆盖时必须明确来源、模型适用性及可回退配置，只覆盖基础层；不能传入 portable main.system.md、main.assembled.md 或单独 subagent-role.md，否则会混入 UAH 工具说明、重复角色或丢失完整基座。模型覆盖中的空值和缺失不可合并处理。

UAH 的「GPT 默认 Agent」是 API 工作流预设，未来选择原生运行时时不能静默把它投射为原生基础指令。建议增加显式指令策略：native-default / explicit-base-override；portable-api 仅用于现有 API 后端。自定义 Agent 跨后端迁移需要提示哪些工具假设不适用，保存原文和策略，不能自动伪造兼容性。

## 运行时边界与接入路径（设计建议，未实现）

现有 Supervisor 负责 API 工具循环、审批、Plan 文件和子代理。原生 Codex 则拥有自己的这些机制。适配器必须明确一次运行由谁执行工具，避免 UAH 和 Codex 对同一个 tool call 各执行一次；原生事件应转换成统一会话活动，而不是回灌为 UAH 工具调用。

可以先验证外部 `codex exec` 执行桥，后续再评估适合长期会话与审批交互的 app-server 协议。后者的版本／握手／事件／审批 API 需在真正接入时单独核验，本资料包不构成对 app-server 的实现验证。

资料中的 `codex exec --sandbox workspace-write --json -o result.md -` 表达三种独立载荷：stdin 是用户任务；stdout 是 JSONL 事件；`-o` 是最终结果文件。外部进程不是原生 spawn_agent 线程：UAH 必须维护自己的 parentRunId/childRunId 与原生 thread/turn/item ID 映射，读取结果、处理退出、取消和超时。不能靠 `/root/...` 文本或假想 send_message 建立通信。示例仅供研究，尚未运行。

建议未来契约至少包含：

- 启动输入：运行 ID、选定目录及授权范围、模型／effort、显式指令策略、用户任务、实际权限映射。通过参数数组传递 argv，stdin 直接写入子进程管道；Windows 下不叠套 cmd/PowerShell 拼接命令。
- 能力握手：记录 CLI 版本、支持的协议版本、平台限制和真实可用能力；未知事件可保留有界诊断，不能按猜测完成状态。UAH Agent 名称与原生模型、账号、线程身份分离。
- 事件转换：增量正文、服务提供的思考摘要、工具启动／结果、文件变更、审批、用量、失败与完成。按运行和事件 ID 去重、保序，避免断线恢复后重复执行。没有前后快照时显示未知 diff，不从当前文件伪造历史。
- 生命周期：保存并验证创建时的进程句柄／实例身份、协议握手与生命周期信号；禁止仅根据 PID／进程名终止服务。取消应传播到该实例拥有的任务，验证已终止才报告，无法确认后代退出时明确说明。启动失败、JSONL 截断、仅部分输出、超时不能算成功。
- 结果：退出码、最后事件、最终输出文件分别校验；缺文件或只有部分结果时保留失败/中断状态。UAH 的父模型通过明确结果接口读取，不以子进程退出自动宣称验收。

## 权限、Plan 与上下文不能仅靠文字映射

UAH 的 readonly / manual / accept-edits / auto / bypass / plan 是产品语义，不能直接同名映射成某个 CLI sandbox/approval 参数。需按版本和平台建立能力矩阵：文件读取、工作区写入、外部路径、网络、命令、审批、计划提交分别比较。无法保证父权限子集时拒绝启动该组合或降至用户明确选择的可支持模式；绝不能静默升级。尤其 bypass 不代表无条件传入原生危险开关。

非交互 exec 能否承载所需审批往返必须实测；如果不支持，就不能展示一个虚假的可审批按钮。Plan 文件、批准版本／哈希、进入实施轮及旧审批失效仍需单一权威来源；不得让同一请求同时出现 UAH 和原生两套互不关联的批准。

上下文 all/selected/none 与原生 resume/fork 并非同义。先定义准确映射：none 为全新任务；selected 只传选定且用户有权提供的可见消息；all 也不能擅自导出隐藏推理、密钥或超出上下文限额的私有工具内容。原生线程恢复应使用真实 ID 并校验归属。共享目录不等于共享消息或权限，隔离 worktree 必须是真实创建和授权的状态。

账号认证由原生受支持路径管理。不能读取桌面内部凭据或将密钥写入 prompt、argv、事件日志。诊断需脱敏；不把 API provider 的模型名、密钥和 URL 默认为原生账号配置。本轮不接入订阅或认证。

## 实现前与交付时的验收清单

先用离线假进程验证 JSONL 分片／坏行／未知事件／stdout-stderr分离、启动失败、超时、取消、结果缺失、重复事件及审批关联；再在用户明确选择的已授权运行时下做最小真实验证。每次升级固定版本来源并复核命令／协议，不把 0.157.1 快照当作未来兼容保证。

真实验收需覆盖：中文路径和任务传输、只读越权拒绝、父子权限子集、审批拒绝后无写入、Plan 版本失效、停止不误伤其他进程、断连恢复不重复执行、模型角色选择和空角色覆盖、上下文隔离、最终文本／文件 diff 的真实性、日志脱敏。未通过的能力必须显示不可用，不能只改提示词假装已接入。

## 固定源码索引与许可

- [模型目录](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/models-manager/models.json)
- [基础解析](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/prompts/src/model_instructions.rs)
- [模型角色与回退](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/prompts/src/model_messages/multi_agent.rs)
- [运行时条件组装](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/prompts/src/multi_agent_instructions.rs)

Apache-2.0 许可及上游 NOTICE 保留于资料包与 third-party/codex。新生成模块保留适配声明和来源，修改限于 UAH 槽位绑定。旧 Codex 文本继续用于精确迁移识别，不删旧来源通知。发行时须随应用分发这些许可与修改说明。
