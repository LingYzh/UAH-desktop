# UI-first implementation workflow

- For a project with a highly consistent custom visual style and no existing third-party UI library, first derive tokens, shared components and interaction states from its prototype.
- Build the reusable UI library and an interactive preview/documentation HTML page before implementing business/system screens. Examples must use the real library components.
- Complete visual acceptance of component states, typography, icons, spacing, transitions, light/dark themes, keyboard interaction and responsive/zoom layouts before starting system implementation. Record evidence and unresolved items; functional tests alone are not visual acceptance.
- Later shared visual changes belong in the UI library and its demos first, then flow into consuming screens. Preserve this sequence even when a headless dependency is introduced later.
- Root owns visual specifications, component planning and final acceptance. Apply the ongoing model routing requirements below; the earlier one-off documentation assignment is not a standing routing rule.
- UAH retains its own tokens and styles over `@vuetify/v0` headless behavior. Do not add Material themes or bypass Electron isolation to integrate UI libraries.

## 开发前组件盘点与模型分工（持续执行）

- 每次动手实现前，root 先扫描计划中的界面和交互，对照 `D:/UI/src/ui/index.ts`、组件 API、demo 和文档目录，确认是否缺少需要的新组件或已有组件的通用能力。先记录复用项与缺口，再开始实现。
- 若存在缺口，必须先在 `D:/UI` 完成组件、公开 API、真实组件 demo 和对应文档页，调试交互及视觉效果，记录验收结果后，才能在 `D:/UAH` 使用。不得先在 UAH 临时写一套再搬回组件库，也不得用业务 CSS 绕过组件库规范。
- 子代理发现新组件或通用能力缺口时，应将用途、现有组件为何不足、所需接口和影响范围上报 root；暂停依赖该缺口的实现，可继续无依赖的工作。组件规划、视觉规格及验收属于 root 的职责，子代理不得擅自决定新增或另造实现。
- 涉及视觉效果的样式编写、设计调整和视觉 demo 实现由 root 亲自负责，或交给至少 **GPT-6 Sol / medium** 的子代理。不得交给 Luna、Terra 或更低配置；本条是用户明确指定的视觉任务模型下限，优先于一般经济型路由偏好。
- 使用已经验收的组件进行搭积木式页面组装、数据绑定和非视觉业务逻辑，可以交给更低级模型；不得借组装任务修改共享外观。是否需要新组件及最终视觉验收仍由 root 决定。
- UI 唯一实现位于独立 UI 仓库。UAH 从 npm 安装固定版本的 `@lingyzh/ui`，保持 Vue dedupe，不复制组件源码回 UAH；共享组件修改先在 UI 仓库验收、发布新版本，再升级 UAH 依赖。

新会话首先阅读 `docs/HANDOFF.md`，并检查两个仓库的实际状态，不将交接中的历史状态当成当前状态。

## 提示词运行时上下文维护

- 接入或变更目录、Git 状态、记忆、MCP、工具能力时，同时检查 `src/runtime/prompt-context.ts`、`src/shared/claude-harness-prompts.ts` 和 `src/shared/gpt-harness-prompts.ts`，更新上下文提供器、缺省说明及测试；不得让提示词继续声明已接入能力不可用，或虚构未接入能力。
- 动态状态在每次模型请求前解析，不能写回 Agent 配置或历史指令快照。保留用户编辑与不含上下文标记的普通提示词；字段缺失时使用明确未知/未接入说明。详见 `docs/AGENT-PRESETS.md`。
- 原生 Codex 运行时接入先读 `docs/CODEX-RUNTIME.md`。API portable 预设不能直接当作 Codex 的基础覆盖文件；默认由原生运行时按真实模型组装指令，职责和工具各由单一运行时负责。
- API 条件装配入口为 `src/runtime/prompt-assembler.ts`，基座／角色适配在 `src/shared/conditional-prompts.ts`。新工具或能力必须使用实际工具注册结果作为启用依据，并补充模块条件、版本、脱敏诊断和切换测试；不要恢复旧的无条件工具长说明。旧品牌完整绑定文件保留为精确迁移来源，不应随新能力修改而破坏旧默认识别。见 `docs/CONDITIONAL-PROMPTS.md`。
