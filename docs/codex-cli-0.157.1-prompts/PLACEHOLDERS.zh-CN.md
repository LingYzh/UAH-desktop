# 第三方占位符字典

这些槽位由宿主填写；未提供的能力需要明确标成不可用。原文中的小写 `{{connector_id}}` 属于 Codex 自己的示例，不是本包的占位符，也不应对 original/ 批量替换。

| 占位符 | 内容 |
| --- | --- |
| `{{AGENT_ID}}` | 当前代理身份；主代理与子代理应分别赋值。 |
| `{{AGENT_MESSAGE_PROTOCOL}}` | 来自其他代理的消息格式、身份、到达通道及可信来源。 |
| `{{AGENT_NAME}}` | 助手名称，不冒充 Codex 官方客户端。 |
| `{{COLLABORATION_TOOL_PROTOCOL}}` | 创建/唤起代理、发送消息、查询、取消等真实工具及调用入口。 |
| `{{COMMAND_EXECUTION_PROTOCOL}}` | 实际 Shell、参数传递、编码、保留变量和转义方式。 |
| `{{CONCURRENCY_AND_WAIT_POLICY}}` | 并发容量是否含主代理、等待方式、排队及回收规则。 |
| `{{CONNECTOR_CATALOG_AND_ROUTING_PROTOCOL}}` | 连接器目录、已连接状态、发现与调用规则。 |
| `{{CONTEXT_HANDOFF_PROTOCOL}}` | 传递全部历史、部分历史或摘要的实现，及新任务是否继承上下文。 |
| `{{CONTEXT_MANAGEMENT_PROTOCOL}}` | 上下文压缩、历史恢复、检查点的实际机制；不得假定全部历史永远存在。 |
| `{{DELEGATED_TASK_AND_OUTPUT_CONTRACT}}` | 子任务目标、范围、必要上下文、验收及回报格式；仅子代理需要。 |
| `{{DELEGATION_MODE_POLICY}}` | 主动委派、仅显式要求委派或禁用；只填当前生效的一种策略。 |
| `{{ENVIRONMENT_CONTEXT}}` | 工作目录、平台、Shell、当前日期等可靠环境事实。 |
| `{{HARNESS_NAME}}` | 实际宿主应用名称。 |
| `{{LANGUAGE_AND_OUTPUT_PREFERENCES}}` | 例如沿用用户语言、简体中文、报告风格；不改变工具契约。 |
| `{{MAIN_AGENT_COMPLETION_CONTRACT}}` | 主代理汇总、整合、验收及结束条件；仅主代理需要。 |
| `{{MEMORY_AND_TASK_CONTEXT}}` | 宿主确实提供的记忆、任务状态和会话摘要。 |
| `{{MODEL_AND_EFFORT_OVERRIDE_POLICY}}` | 是否允许选择子代理模型/effort，继承与覆盖优先级。 |
| `{{OUTPUT_RENDERING_AND_FILE_REFERENCES}}` | Markdown、代码引用、附件与本地文件链接的实际规则。 |
| `{{PARALLEL_EXECUTION_PROTOCOL}}` | 工具调用能否并行、如何并行及哪些操作必须串行。 |
| `{{PARENT_AGENT_ID}}` | 父代理身份，仅子代理需要。 |
| `{{PERMISSIONS_AND_APPROVALS}}` | 沙箱、网络、写权限、审批规则；不得由提示词自行扩大。 |
| `{{PLUGIN_CATALOG_AND_NAMING_PROTOCOL}}` | 插件提供的能力、命名、出处和实际加载方式。 |
| `{{PROGRESS_CHANNEL}}` | 宿主展示进度的通道或方法；可填写普通文本消息。 |
| `{{PROGRESS_UPDATE_POLICY}}` | 进度更新频率、长度、用户可见性。 |
| `{{PROJECT_INSTRUCTIONS}}` | 经宿主适用性判断后的项目规范；不要假定文件已经自动加载。 |
| `{{RESULT_RETURN_PROTOCOL}}` | 子代理如何把结果真实交还父代理；仅子代理需要。 |
| `{{SHARED_STATE_AND_EDIT_COORDINATION}}` | 共享目录还是隔离 worktree，修改如何同步，读写并发如何协调。 |
| `{{SKILL_CATALOG_AND_ACCESS_PROTOCOL}}` | 实际技能目录、触发规则、路径/资源标识与读取方式。 |
| `{{TEAM_CAPABILITIES_AND_LIMITS}}` | 各代理实际模型、工具、权限、可递归委派情况；不要默认能力相同。 |
| `{{TOOL_CATALOG_AND_CONTRACTS}}` | 本轮实际工具定义；宿主已在独立工具通道提供时说明引用该通道。 |
| `{{TOOL_USAGE_INSTRUCTIONS}}` | 搜索、读取、编辑、执行等工具的偏好和约束，使用真实名称。 |
| `{{USER_INTERACTION_PROTOCOL}}` | 提问、审批、异步输入、最终答复的真实通道及可用性；没有异步机制就明确说明。 |
| `{{WAITING_PROTOCOL}}` | 长任务等待、轮询、超时、进度展示的真实机制。 |
| `{{WORKSPACE_RELATIONSHIP}}` | 助手与用户是否共享工作区，以及用户如何取得文件。 |

完整主代理和完整子代理只需要各自实际出现的槽位。公共字典包含二者的并集；渲染脚本允许多余的键，但不允许所需键缺失或为空。
