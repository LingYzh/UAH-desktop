// COPY SCOPE: fixture/replace for seed projects, models, accounts, sessions, files and runtime mappings.
// Runtime mappings are design assumptions pending real-client verification; keep product enum labels only.
/* All entries are deterministic UI fixtures, not observations of the user's machine or accounts. */
const SOURCE_COMMIT = 'a149f2ef6f0a955cfd5f289601c5e122e533ab56';
const PROJECTS = [
    { id: 'agentapp', name: 'AgentApp', path: 'E:\\Projects\\AgentApp', git: true, branch: 'master' },
    { id: 'uikit', name: 'UAH Design System', path: 'E:\\Projects\\uah-ui', git: true, branch: 'main' },
    { id: 'notes', name: '本地文稿', path: 'E:\\Documents\\Notes', git: false, branch: null },
];
const MODELS = [
    { id: 'sonnet-api', name: 'Sonnet 4.6', wire: 'claude-sonnet-4-6', source: 'api', runtime: 'UAH 自有引擎', provider: 'Anthropic API', efforts: ['low','medium','high','max'], media: '文本 · 图像 · PDF', context: '200K（示例）' },
    { id: 'ds-api', name: 'DeepSeek Chat', wire: 'deepseek-chat', source: 'api', runtime: 'UAH 自有引擎', provider: 'DeepSeek', efforts: [], media: '文本', context: '未声明' },
    { id: 'custom-api', name: '自定义模型', wire: 'custom-model-id', source: 'api', runtime: 'UAH 自有引擎', provider: '自定义模板', efforts: null, media: '能力未声明', context: '未声明' },
    { id: 'codex', name: 'GPT · Codex', wire: 'runtime-selected', source: 'codex', runtime: 'Codex App Server', provider: 'Codex 订阅运行时', efforts: ['low','medium','high','xhigh','max','ultra'], media: '由运行时上报', context: '由运行时上报' },
    { id: 'claude', name: 'Sonnet 5 · Claude Code', wire: 'sonnet', source: 'claude', runtime: 'Claude Code 官方客户端', provider: 'Claude Code 订阅运行时', efforts: ['low','medium','high','xhigh','max','ultra'], media: '由运行时上报', context: '由运行时上报' },
    { id: 'antigravity', name: 'Gemini · Antigravity', wire: 'runtime-selected', source: 'antigravity', runtime: 'Antigravity CLI', provider: 'Google 订阅运行时', efforts: null, media: '由运行时上报', context: '由运行时上报' },
    { id: 'gemini-cli', name: 'Gemini CLI', wire: 'runtime-selected', source: 'gemini-cli', runtime: 'Gemini CLI', provider: 'API Key / 企业认证', efforts: null, media: '待探测', context: '未上报' },
];
const AGENTS = [
    { id: 'general', name: '通用助手', desc: '从一个问题开始。理解上下文，拆解任务，并与你一起完成。', icon: 'spark', model: '跟随会话', tools: '全部可用工具', prompt: '你是 UAH 中的通用助手。先理解项目与用户意图，再选择合适的工具。\n所有写入和外部操作必须遵守当前会话权限。不要伪造工具结果。' },
    { id: 'coder', name: '代码搭档', desc: '阅读本地代码，先计划再修改，让每一次改动都有迹可循。', icon: 'code', model: 'Sonnet 4.6', tools: '文件 · Shell · MCP · 单层委派', prompt: '你是严谨的代码搭档。阅读项目 AGENTS.md 与相关文档后再编辑。\n遵循 4 空格缩进。默认只并发只读任务。汇总真实文件变化与验证结果。' },
    { id: 'reviewer', name: '审查助手', desc: '独立检查实现、权限与边界。只读探索，不改动项目文件。', icon: 'shield', model: '跟随会话', tools: '只读 · 搜索 · 文件', prompt: '独立审查代码和需求的差异。只读探索，不执行写入。\n按严重性说明问题、可复现证据和相关路径，不将推测当成事实。' },
    { id: 'writer', name: '写作伙伴', desc: '整理思路，润色表达，让复杂的信息变成清晰的文稿。', icon: 'book', model: '跟随会话', tools: '文件 · 记忆 · Skills', prompt: '先理解文稿的用途与读者，再组织内容。\n保留作者观点，明确区分事实与假设。写入前遵守项目路径权限。' },
];
const SESSIONS = [
    { id: 's1', project: 'agentapp', title: '重构工具调用的展开交互', state: 'done', model: 'sonnet-api', agent: 'coder', mode: 'accept', kind: 'chat', round: 2, tabs: ['diff','plan'], panel: 'diff', panelOpen: false, pinned: false, created: '今天 10:42' },
    { id: 's2', project: 'agentapp', title: '为运行时接入补充测试', state: 'approval', model: 'codex', agent: 'coder', mode: 'accept', kind: 'approval', round: 1, tabs: ['plan','tasks'], panel: 'plan', panelOpen: false, pinned: false, created: '今天 10:36' },
    { id: 's3', project: 'uikit', title: '完善主题变量与深色模式', state: 'running', model: 'sonnet-api', agent: 'coder', mode: 'accept', kind: 'running', round: 1, tabs: ['plan','agents'], panel: 'plan', panelOpen: false, pinned: false, created: '今天 10:31' },
    { id: 's4', project: 'notes', title: '整理 PC 版功能设计', state: 'done', model: 'sonnet-api', agent: 'writer', mode: 'readonly', kind: 'markdown', round: 1, tabs: ['plan'], panel: 'plan', panelOpen: false, pinned: false, created: '昨天 18:25' },
    { id: 's5', project: 'agentapp', title: '审查权限边界', state: 'stopped', model: 'claude', agent: 'reviewer', mode: 'readonly', kind: 'stopped', round: 1, tabs: ['agents'], panel: 'agents', panelOpen: false, pinned: false, created: '昨天 16:12' },
];
/* Workspace panels are scoped to one conversation. A missing plan means no saved plan file. */
const SESSION_WORKSPACE = {
    s1: {
        planFile: { path: '.uah/plans/inline-tool-refactor.md', saved: '今天 10:42', content: '# 工具交互实施计划\n\n1. 阅读项目规范与现有工具记录。\n2. 改造命令和文件编辑的内联展开。\n3. 保存每轮文件快照，区分历史 Diff 与当前文件。\n4. 验证权限、停止、深色主题与窄窗口。' },
        backgroundTasks: [
            { id: 'test', title: '运行工具交互测试', state: 'done', detail: '7 项测试通过 · 结果已保存', time: '10:44' },
            { id: 'snapshot', title: '保存本轮文件快照', state: 'done', detail: '3 个文件 · 可查看历史 Diff', time: '10:44' },
        ],
        subagents: [
            { id: 'explore', title: '代码探索', state: 'done', model: 'Sonnet 4.6', turns: [
                { role: 'user', text: '只读检查工具记录的生命周期，找出展开状态和文件快照的关联点。' },
                { role: 'assistant', text: '我会先阅读工具行和会话状态的实现，再核对调用 ID 的保存方式。' },
                { role: 'tool', name: '读取文件', text: 'ToolCallRow.ts、useSessionState.ts · 只读调用已完成' },
                { role: 'assistant', text: '展开状态只使用调用 ID 作为键，不同会话可能碰撞。建议使用会话 / 轮次 / 调用 ID。历史 Diff 应继续引用保存的快照。' },
            ] },
            { id: 'security', title: '权限复核', state: 'done', model: 'Sonnet 4.6', turns: [
                { role: 'user', text: '只读检查审批、目录范围和停止是否会传递到工具执行。' },
                { role: 'assistant', text: '先检查审批入口和取消链，再对照子代理可用工具。' },
                { role: 'tool', name: '读取配置', text: '读取权限配置与工具声明 · 未执行写入' },
                { role: 'assistant', text: '查看历史记录不应触发审批或重跑；子代理的授权请求应返回父会话。' },
            ] },
        ],
    },
    s2: {
        planFile: { path: '.uah/plans/runtime-adapter-tests.md', saved: '今天 10:38', content: '# 运行时适配测试计划\n\n1. 采集官方运行时真实模型和模式声明。\n2. 映射工具事件和审批请求。\n3. 验证计划产物必须保存为文件。\n4. 执行前等待当前会话的明确批准。' },
        backgroundTasks: [
            { id: 'approval', title: '等待执行计划的批准', state: 'approval', detail: '用户批准前不修改业务文件', time: '10:39' },
            { id: 'catalog', title: '查询模型能力', state: 'done', detail: '运行时返回模型目录样本', time: '10:37' },
        ],
        subagents: [],
    },
    s3: {
        planFile: null,
        backgroundTasks: [
            { id: 'theme-check', title: '检查深色主题变量', state: 'running', detail: '正在读取主题与组件样式', time: '10:33' },
            { id: 'token-scan', title: '扫描设计 Token', state: 'done', detail: '已列出 18 个语义颜色', time: '10:32' },
        ],
        subagents: [
            { id: 'theme-explore', title: '主题探索', state: 'running', model: 'Sonnet 4.6', turns: [
                { role: 'user', text: '只读检查主题变量与暗色模式覆盖范围。' },
                { role: 'assistant', text: '正在读取设计 Token 和组件样式。' },
                { role: 'tool', name: '读取文件', text: 'design-tokens.json · 读取中' },
            ] },
        ],
    },
    s4: { planFile: null, backgroundTasks: [], subagents: [] },
    s5: { planFile: null, backgroundTasks: [{ id: 'audit', title: '权限边界审查', state: 'stopped', detail: '用户停止 · 已完成记录保留', time: '16:18' }], subagents: [] },
};
const FILES = [
    { id: 'tool', name: 'ToolCallRow.ts', path: 'src/ui/ToolCallRow.ts', type: 'M', add: 16, del: 2, source: '文件工具', hash: 'b7e28d1 → c4f912a', size: '2.4 KB' },
    { id: 'state', name: 'useSessionState.ts', path: 'src/state/useSessionState.ts', type: 'M', add: 7, del: 1, source: '文件工具', hash: '1e38b2a → a61fc02', size: '1.8 KB' },
    { id: 'test', name: 'tool-call.spec.ts', path: 'tests/tool-call.spec.ts', type: 'A', add: 10, del: 0, source: 'Shell / 父任务', hash: '新增 → 32a79e1', size: '1.2 KB' },
    { id: 'uncertain', name: 'tokens.css', path: 'src/styles/tokens.css', type: 'M', add: 2, del: 1, source: '归属不确定', hash: 'bd982ff → 443201c', size: '960 B' },
    { id: 'binary', name: 'app-icon.png', path: 'assets/app-icon.png', type: 'M', add: null, del: null, source: '文件工具', hash: '98ee117 → c0a328a', size: '24.6 KB → 26.1 KB' },
    { id: 'deleted', name: 'legacy-tool.css', path: 'src/styles/legacy-tool.css', type: 'D', add: 0, del: 4, source: '文件工具', hash: 'ed776b4 → 删除', size: '620 B → 0 B' },
    { id: 'renamed', name: 'session-state.ts', path: 'src/state/session-state.ts', old: 'src/state/chat-state.ts', type: 'R', add: 0, del: 0, source: '子代理 / 父任务', hash: '只重命名 · 内容不变', size: '1.3 KB' },
];
FILES.push({ id: 'planfile', name: 'inline-tool-refactor.md', path: '.uah/plans/inline-tool-refactor.md', type: 'A', add: 5, del: 0, source: '计划文件（受限写入）', hash: '新增 → 28de9af', size: '240 B' });
FILES.push({id:'missing',name:'schema.ts',path:'src/generated/schema.ts',type:'M',add:null,del:null,source:'Shell · 快照缺失',hash:'未保存',size:'元数据不完整'},{id:'large',name:'dataset.jsonl',path:'data/dataset.jsonl',type:'M',add:null,del:null,source:'文件工具',hash:'ae12709 → 788da20',size:'128 MB → 136 MB'});
const DIFF_LINES = [
    ['context', 21, 21, 'export function renderToolCall(call: ToolCall) {'],
    ['context', 22, 22, '    const { status, type } = call;'],
    ['context', 23, 23, ''],
    ['remove', 24, '', '    const label = `${call.name}: ${status}`;'],
    ['remove', 25, '', '    return createCard(label, call.result);'],
    ['add', '', 24, '    const label = getToolLabel(type, status);'],
    ['add', '', 25, '    const key = `${call.sessionId}/${call.roundId}/${call.id}`;'],
    ['add', '', 26, ''],
    ['add', '', 27, '    return createInlineDisclosure({'],
    ['add', '', 28, '        key,'],
    ['add', '', 29, '        label,'],
    ['add', '', 30, '        expanded: expansionState.get(key),'],
    ['add', '', 31, '        content: call.savedResult,'],
    ['add', '', 32, '    });'],
    ['context', 26, 33, '}'],
    ['context', 27, 34, ''],
    ['add', '', 35, 'function getToolLabel(type, status) {'],
    ['add', '', 36, '    if (status !== "completed") {'],
    ['add', '', 37, '        return describeActualState(status);'],
    ['add', '', 38, '    }'],
    ['add', '', 39, '    if (type === "shell") return "运行了命令";'],
    ['add', '', 40, '    return describeFileChange(type);'],
    ['add', '', 41, '}'],
];
const PROVIDERS = [
    { id: 'anthropic', name: 'Anthropic API', protocol: 'Anthropic Messages', endpoint: 'https://api.anthropic.com', models: 2, enabled: true },
    { id: 'deepseek', name: 'DeepSeek', protocol: 'OpenAI 兼容', endpoint: 'https://api.deepseek.com', models: 1, enabled: true },
    { id: 'google', name: 'Google AI Studio', protocol: 'Gemini', endpoint: 'https://generativelanguage.googleapis.com', models: 1, enabled: false },
    { id: 'custom', name: '自定义接入', protocol: '自定义模板', endpoint: 'http://127.0.0.1:8080', models: 1, enabled: false },
];
const RUNTIMES = [
    { id: 'codex', name: 'Codex', engine: 'Codex App Server', label: 'ChatGPT / Codex 订阅', icon: 'code', installed: true, logged: true, account: 'demo@example.com', model: 'GPT · 运行时返回的模型' },
    { id: 'claude', name: 'Claude Code', engine: '未修改的官方客户端', label: 'Claude Code 订阅', icon: 'terminal', installed: true, logged: false, account: null, model: '登录后查询' },
    { id: 'antigravity', name: 'Antigravity CLI', engine: '官方 CLI 运行时', label: 'Google AI Pro / Ultra', icon: 'spark', installed: false, logged: false, account: null, model: '连接后查询' },
    { id: 'gemini-cli', name: 'Gemini CLI', engine: 'API Key / 企业认证', label: '独立 CLI 接入 · 非 Google 订阅额度入口', icon: 'terminal', installed: true, logged: false, account: null, model: '连接后查询' },
];
/* Product mapping proposals, not verified connections to local official clients. */
const RUNTIME_ADAPTERS = {
    codex: {
        events: 'App Server 的 item/*、turn/*、审批请求',
        modes: {
            readonly: ['可映射', 'readOnly sandbox；可用工具按实际策略收窄', '以 App Server 返回的有效 sandbox 和审批事件为准'],
            plan: ['可映射', 'collaborationMode: plan；计划事件进入对话', '只有保存成会话计划文件后，右栏计划才显示内容'],
            accept: ['可映射', 'on-request 审批；UAH 响应服务端审批请求', '审批状态由请求与完成事件同步'],
            auto: ['需核对', '使用运行时支持的自动策略', '仍可能要求审批；不得等同于跳过权限'],
        },
    },
    claude: {
        events: '官方 CLI stream-json、权限主机和子代理事件',
        modes: {
            readonly: ['需核对', '限制可用工具并拒绝写入与命令', '不能只靠界面上的“只读”文字保证'],
            plan: ['可映射', '--permission-mode plan', '完成的计划需保存为会话计划文件；原始文字不自动冒充文件'],
            accept: ['有条件', 'Manual/default + 可响应的权限主机', '无权限主机时请求会被拒绝，不能显示可批准按钮'],
            auto: ['有条件', '--permission-mode auto', '运行时可继续请求审批；不可映射为 bypassPermissions'],
        },
    },
    antigravity: {
        events: '官方 CLI stream-json 的 init / step_update / result',
        modes: {
            readonly: ['需核对', '细粒度拒绝规则与工具范围', '先验证真正禁止写入，再允许开始会话'],
            plan: ['有条件', '--mode=plan + 受限权限规则', '计划输出需要另存为会话计划文件；不可把步骤流当作文件'],
            accept: ['暂不可用', 'Headless 模式无法弹出交互审批', '需要官方支持的交互桥接；否则该模式禁用并解释原因'],
            auto: ['需核对', '明确的 permissions.allow 规则', '不使用 --dangerously-skip-permissions 来模拟 UAH 自动模式'],
        },
    },
    'gemini-cli': {
        events: '独立 CLI 接入，按实际认证与事件能力探测',
        modes: {
            readonly: ['需核对', '按实际工具权限配置', '先完成 CLI 接入验证'],
            plan: ['需核对', '按实际计划能力配置', '只有已保存文件进入计划右栏'],
            accept: ['需核对', '按实际审批通道配置', '不能推定拥有 UAH 审批入口'],
            auto: ['需核对', '按实际权限规则配置', '不能跳过运行时授权'],
        },
    },
};
const MCPS = [
    { id: 'filesystem', name: '项目文件系统', transport: 'stdio', desc: '受项目路径约束的文件工具与资源', tools: 8, resources: 3, prompts: 1, status: 'connected', enabled: true, command: 'npx -y @modelcontextprotocol/server-filesystem E:\\Projects' },
    { id: 'github', name: 'GitHub', transport: 'Streamable HTTP', desc: '仓库、议题与拉取请求', tools: 12, resources: 2, prompts: 2, status: 'auth', enabled: false, command: 'https://mcp.example.com/github' },
    { id: 'browser', name: 'UAH Browser', transport: 'stdio', desc: 'UAH 管理的本地浏览器桥接', tools: 6, resources: 1, prompts: 0, status: 'connected', enabled: true, command: 'uah-browser-bridge --stdio' },
    { id: 'notes-mcp', name: '本地知识库', transport: 'stdio', desc: '连接失败：进程启动后异常退出', tools: 0, resources: 0, prompts: 0, status: 'error', enabled: false, command: 'notes-mcp --stdio' },
];
const PLUGINS = [
    { id: 'vue', name: 'Vue 开发规范', slug: 'vue-best-practices', version: '1.0.0', format: 'Agent Plugin', skills: 3, agents: 1, mcp: 0, hooks: 1, enabled: true, icon: 'code' },
    { id: 'powershell', name: 'PowerShell 工具箱', slug: 'powershell-toolkit', version: '1.1.0', format: 'Codex Plugin', skills: 2, agents: 0, mcp: 1, hooks: 0, enabled: false, icon: 'terminal' },
    { id: 'grilling', name: '需求追问', slug: 'grilling', version: '1.0.0', format: 'Agent Plugin', skills: 1, agents: 1, mcp: 0, hooks: 0, enabled: true, icon: 'chat' },
];
const MEMORIES = [
    { id: 'm1', title: '代码风格', scope: '全局', body: '统一使用 4 空格缩进。业务页面优先 JavaScript，稳定复用模块使用 TypeScript。', updated: '今天 09:40' },
    { id: 'm2', title: 'AgentApp 的工具展示', scope: 'AgentApp', body: '命令收起只显示“运行了命令”；文件编辑原地展开 Diff。不要为工具组增加外层卡片。', updated: '昨天 18:16' },
    { id: 'm3', title: '版本交付习惯', scope: '全局', body: '先本地验收，再手动决定是否提交、推送或发布。不要自动操作真实设备。', updated: '9 月 22 日' },
];
const SETTINGS_SECTIONS = [
    ['appearance','外观','sun'], ['computer','电脑控制','monitor'], ['browser','浏览器','globe'], ['search','网络搜索','search'], ['directories','项目目录','folder'], ['data','数据与迁移','database'], ['diagnostics','诊断与关于','info'],
];
const PANEL_INFO = { plan: ['计划','plan'], tasks: ['后台任务','tasks'], agents: ['子代理','subagent'], diff: ['文件 Diff','diff'], browser: ['浏览器','globe'], terminal: ['终端','terminal'] };
const STATE_NAMES = { running: '运行中', approval: '等待审批', done: '已完成', failed: '失败', stopped: '已中止' };
const PERMISSIONS = { readonly: ['只读','eye','只允许读取与观察，不允许写入动作。'], plan: ['计划模式','plan','分析并保存计划，执行前需要你的明确批准。'], accept: ['需审批','shield','写入、命令与电脑动作按当前策略请求确认。'], auto: ['自动模式','spark','仅在已授予的工具、目录和目标范围内自动执行。'] };
