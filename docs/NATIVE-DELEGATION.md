# 原生 Codex 委派与内置技能

状态：2026-10-03。继 D09 后按用户追加要求接入原生父任务调用 UAH 子代理；用户明确选择子代理同时支持 API 与原生 Codex。本文覆盖 HANDOFF/HARNESS-D09 中此前“尚未桥接”的历史说明。

## 使用方式

1. 在「模型与账号」启用原生 Codex；在「Agent → 调度预设」启用子代理。
2. 子代理角色可绑定 API 模型或「Codex 原生」模型；不绑定时按原有规则继承父模型。原生父任务可用临时角色、继承角色或预设角色委派。
3. 原生模型实际收到 `uah_list_agent_presets`、`uah_spawn_agent`、`uah_wait_agents`。`providerId: native:codex` 选择原生子代理，API 端点 ID 选择 API 子代理。API 使用端点额度，原生使用本机账号。未配置的端点和模型不猜测、不自动替换。
4. 子运行进入同一 UAH 任务树，显示角色、状态、工具活动和结果；停止父任务会停止下级任务。子代理报告必须由父代理复核，不作为独立验收证据。

## Provider 目录与可配置调用 ID

「模型与账号」的 Provider ID 是可选调用标识，与名称分开。留空使用自动生成的默认 ID；允许中文等 Unicode 字母、数字、点、下划线和短横线，最多100字符，区分大小写、全库唯一，不能冒用原生保留 ID 或内部端点 ID。修改或清空别名不改变内部标识，已有会话和通过界面保存的角色模型配置继续有效；旧别名不作为永久重定向保留，后续模型调用应重新查询目录。

`uah_list_agent_presets` 同时返回 `profiles` 与 `providers`。API Provider 条目包含 `providerId`、`name`、`models`、`runtimeId`，只返回当前启用且配置了模型的端点；不包含密钥、地址，不额外提供内部数据库 ID 字段，不尝试解密凭据或探测远端。未自定义时调用 ID 本身就是默认内部 ID。`providerCatalogAvailable` 表示 API 目录来源是否接入；原生父任务还列出 `native:codex` 和当前实际模型，不冒充完整原生模型目录。API 父任务不列出它无法委派的原生路由。

每次工具查询读取最新配置。名称只是帮助用户辨认，`spawn_agent.providerId` 必须取目录返回的 ID；真正启动时再次解析、验证启用状态和模型，并将稳定内部 ID 保存在运行中。配置启用不等于认证成功或服务在线，失败不会静默换 Provider。API 模式使用同一目录语义。过大目录明确报错，不静默截断成看似完整的目录。

## 单一控制者与执行权

动态工具仅在 thread/start 注册；thread/resume 不发送协议未支持的注册字段。工具目录及桥版本进入线程指纹，目录改变创建新线程。每个原生子任务创建独立线程，不恢复父线程。角色是 developerInstructions 中的补充，原生基础指令不被 API portable 基座覆盖；未修改的内置 API 基座不当作原生角色注入。

请求绑定活动 threadId/turnId/callId；未注册工具、错误身份和非法参数不得派发。同一调用 ID 的等价参数复用结果，不重复创建子任务；冲突复用拒绝。参数与结果各限128 KiB，超过结果限额明确截断。回调异常不向协议暴露原始异常细节，宿主结果与日志使用凭据脱敏。

原生运行持有现有全局写工具锁（包括只读预设，因为 MCP 可能有外部副作用）。spawn 只创建后台任务；父运行调用 wait 时释放工具锁，在响应模型之前重新取得锁。工作目录租约始终由根任务持有，其他根任务不能借此进入同一目录。原生工具与需要锁的 API 文件操作按实际锁安排串行，不能宣称拥有多写者隔离。父模型提前结束而未读取结果时，宿主先等待子任务，再把终态报告作为后续原生轮次交回父模型。

本机版本 0.156.1 的上游动态工具默认不并行，工具调度器在等待宿主响应时持有独占锁；这为等待期间交接 UAH 执行权提供依据。原生配置强制 `agents.enabled=false`、`features.multi_agent=false`、`features.multi_agent_v2=false`，避免 Codex 自带协作绕过 UAH 树限制；`features.unified_exec=false` 使用一次性命令，不提供可继续在后台运行的终端会话。显式启动的外部后台进程不在动态工具锁的保证范围，宿主说明禁止在交接前留下后台写入；不把线程事件伪装成进程树退出证据。

来源（固定 rust-v0.156.1）：[动态工具处理](https://raw.githubusercontent.com/openai/codex/rust-v0.156.1/codex-rs/core/src/tools/handlers/dynamic.rs)、[独占调度](https://raw.githubusercontent.com/openai/codex/rust-v0.156.1/codex-rs/core/src/tools/parallel.rs)、[默认并行能力](https://raw.githubusercontent.com/openai/codex/rust-v0.156.1/codex-rs/tools/src/tool_executor.rs)、[命令工具选择](https://raw.githubusercontent.com/openai/codex/rust-v0.156.1/codex-rs/core/src/tools/spec_plan.rs)、[原生协作配置](https://raw.githubusercontent.com/openai/codex/rust-v0.156.1/codex-rs/core/src/config/mod.rs)。升级 Codex 时须重新核验，不视为跨版本保证。

## 权限与预算

- 沿用全局启用、角色授权、最大深度、并发数量、子任务超时、直属关系和父任务取消约束。等待仅接受直属子运行 ID；停止、失败和超时不自动重放任务。
- 原生父任务的 readonly/计划模式子任务保持只读；完全访问的原生父任务可启动同权限的原生子任务。对 API 委派上限仍按 manual 计算，不能通过 bypass 启动更宽权限的 API 子任务。API 子任务及其下级不提供 run_command 或外部 MCP，避免把原生 OS 沙箱降为无沙箱命令。文件更改仍使用 UAH 路径边界及逐次审批。
- API 父任务暂不能反向启动原生子代理：两者的命令与文件审批契约不能仅凭同名模式保证权限子集。UI 和错误信息明确此限制；本次交付目标是原生父任务使用两种子代理。
- 原生子任务上下文支持 all/selected/none，但超过64000字符明确拒绝，要求父代理选择或总结；不在明确传递的子任务上下文中静默截断。仅传公开消息，不导出原生隐藏推理或账号凭据。
- API 与原生子树共享宿主预算。每个可见原生 turn 计一次宿主请求准入、桥工具计工具次数，用量只按原生提供的本轮数值结算；自动结果续轮的可见用量累计。无法观察原生内部请求数量和中途 token 消耗，因此不是对原生所有内部请求的精确预算上限。墙钟超时和 UAH 子任务数量/深度约束仍由宿主执行。
- 原生日志仍为 partial；观察到的动态调用、子运行与结果可关联，不伪造未暴露的请求、文件快照或审批。

## 内置技能

资源唯一来源为本会话当前技能副本，保留 SKILL.md、metadata、版本、已有 LICENSE、引用和脚本：

- `resources/builtin-skills/grilling`：`1.2.0-personal.3`。
- `resources/builtin-skills/powershell-windows-cli`：`1.2.0-personal.2`。

构建复制到 `dist/builtin-skills`，运行时不依赖开发者个人目录。固定 ID 为 `builtin:grilling`、`builtin:powershell-windows-cli`。新安装默认启用；用户停用状态保存到独立 builtin_skill_settings 表，重启或应用更新不重新启用。内置项不可卸载，用户安装的同名技能保持独立。读取拒绝路径逃逸、链接和超限内容；资源不被安装到项目目录，也不自动运行辅助脚本。

API 使用实际 read_skill；原生使用实际注册的 uah_read_skill，并且每次读取重新检查启用状态。技能目录按请求/原生轮次提供，正文和引用按需读取。Grilling 保留优先使用宿主提问工具的规则；原生计划模式的 request_user_input 已接入 UAH 提问卡片和回答回传，子代理问题在父会话可见。API 尚无独立交互提问工具时执行技能的文本回退，不宣称不存在的能力。此次开发中的澄清按用户要求通过本会话 harness 提问工具完成。

PowerShell 的 MIT LICENSE 原样保留。Grilling 上游副本只有 MIT frontmatter 声明和来源信息，没有独立 LICENSE 文件；没有编造版权持有人或额外版权声明。两个技能都通过 skill-creator 的 quick_validate（Windows 使用 Python -X utf8），辅助资源逐字节保留；不复制评测目录或缓存。

## UI 盘点与验收

继续使用固定 `@lingyzh/ui@0.2.1`。已对照 UI 导出和既有 demo：UiCard/UiSwitch 展示内置来源与启停，UiSelect 的已有模型组选项支持原生角色绑定，UiDialog 展示边界说明。没有新增通用能力或共享外观缺口，D:/UI 未修改。root 负责页面文案与视觉验收，Luna 只执行已确定规格的协议、打包与测试任务。

验证数字和最终证据见 VALIDATION.md 最新增量。未提交、推送或发布。
