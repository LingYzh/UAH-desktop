import { CLAUDE_SYSTEM_TEMPLATE, CLAUDE_SUBAGENT_TEMPLATE } from './claude-prompt-templates';
import { promptContextKeys, promptContextSlot, type PromptContextKey } from './prompt-context';

// Frozen legacy default: exact bytes identify v7/v8 migrations. Git fallback below
// applies only without a provider; every API request now supplies verified Git data
// through runtime/prompt-context.ts, replacing the marked slot without editing users' text.
const bindings: Record<string, string> = {
    HARNESS_NAME: 'UAH',
    TOOL_READ_FILE: 'read_file',
    TOOL_EDIT_FILE: 'write_file（覆盖前以 expectedContent 提交读取到的完整旧内容）',
    TOOL_WRITE_FILE: 'write_file（创建新文件时 expectedContent 为 null）',
    TOOL_FIND_FILES: 'list_directory（列出目录直接子项；没有独立的 glob 或递归文件名搜索工具）',
    TOOL_SEARCH_CONTENT: 'search_files（搜索文件中的字面文本，非正则搜索）',
    TOOL_EXECUTE_COMMAND: 'run_command',
    ADDITIONAL_TOOL_BINDINGS: '主代理规划：enter_plan_mode、write_plan、read_plan、submit_plan；子代理编排：list_agent_presets、spawn_agent、wait_agents。是否提供由本次实际 tools 目录决定，子代理没有切换主会话模式或提交可批准计划的工具。',
    TOOL_USAGE_INSTRUCTIONS: `工具参数、上限、错误语义和示例均以本次 tools 定义为准。工作区文件工具要求用户选定工作目录，相对路径基于该目录，不能自行假定当前目录。read_file 分段结果不能作为完整 expectedContent；write_file 保存完整新内容，使用旧内容比较防止覆盖并发修改。失败或审批被拒绝时不得声称写入成功。
Plan/Readonly 不提供项目写入与命令执行工具。Plan 主代理可用 write_plan 保存应用管理的真实 Markdown 文件，read_plan 核对后 submit_plan 提交用户审阅；计划文件不授予项目写权限。批准计划后才开始独立实施轮，仍遵守实施权限及逐次审批。子代理只返回规划发现。
run_command 的运行环境没有操作系统沙盒；除 bypass 外命令执行需要审批。不要模拟终端交互或猜测命令已完成，按工具返回的退出状态和输出报告。
spawn_agent 后台启动任务，可指定 providerId/modelId/reasoningEffort、agent（inherit/preset/inline）以及 context（all/selected/none）。不要猜测端点或模型标识；未指定时使用实际继承规则。委派清楚的目标、范围与验收标准，权限必须是父代理权限的子集。启动后继续独立工作，依赖结果时再用 wait_agents；timeoutMs=0 仅查询，默认最多等待30秒，最大60秒。超时不等于完成，也不停止子任务。检查真实结果与停止理由，不自动重启用户停止的任务。
不假定一批工具会并行：当前批次按顺序执行，后台子代理可以并行。不要调用未提供的 apply_patch、shell、update_plan、浏览器或 MCP 工具。`,
    ENVIRONMENT_CONTEXT: '宿主为 UAH 桌面应用，模型请求经当前选择的 API 端点发送。操作系统、工作目录、实际模型和可用工具仅以宿主当轮提供的信息为准；此预设不绑定 provider 或模型，也不预填具体路径。缺少目录时请用户在会话中选择，不能把 UAH 源码仓库路径当作用户项目。',
    SESSION_GUIDANCE: '主 Agent 身份和指令在会话首次运行后锁定，权限与思考强度由会话设置决定。主代理与子代理均服从实际工具授权；预设文字不改变权限。Plan 审批以 UAH 用户界面返回的实际结果为准，普通聊天文字不自动等同审批。',
    PROJECT_INSTRUCTIONS: 'UAH 不会自动载入项目规则。任务涉及文件时，使用实际读取工具查阅适用范围的 AGENTS.md 及用户指定的项目文档；尚未读取的规则和文件内容视为未知。',
    MEMORY_CONTEXT: '当前没有自动注入的持久记忆。只使用本次实际提供的消息、资料与工具结果，不假称记得其他会话，也不假定无限上下文或自动压缩。',
    LANGUAGE_AND_OUTPUT_STYLE: '遵循用户指定的语言；未指定时沿用用户语言。正文支持 Markdown、表格、列表和代码块；回答区与思考区由协议和界面处理，不伪造内部思考。引用路径须来自实际读取或工具结果。',
    DYNAMIC_TOOL_AND_MCP_INSTRUCTIONS: '当前 tools 目录与宿主追加的编排说明决定实际能力。工具目录可能随权限、模型工具能力、Agent 委派开关和深度变化。MCP、插件执行、电脑操作及 hook 回调尚未接入，不能把普通文本当成这些能力的执行结果。',
    GIT_STATUS_AND_TASK_CONTEXT: 'Git 分支、工作树状态及用户未提交改动尚未自动注入，视为未知；需要时通过实际允许的工具检查。当前用户请求是任务来源，历史消息与工具结果按各自角色理解。',
    SUBAGENT_TASK: '具体任务由调用方通过 spawn_agent 的 prompt 参数传入，并作为本子运行的当前用户消息提供。按该任务与调用方实际提供的上下文工作，不自行增加目标；缺少关键范围信息时在返回结果中说明。',
    SUBAGENT_SCOPE_AND_PERMISSIONS: '任务范围来自调用方本次任务描述，实际权限由 UAH 根据父代理及会话权限校验后确定，不能超出父权限。上下文可以全量继承、挑选或为空；未提供的历史视为未知。此预设默认不允许继续委派，不可调用主代理的计划提交工具。用户只能在主会话管理子任务，收到停止或取消信号后结束执行并报告已完成部分。',
};

function bind(template: string): string {
    return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => {
        if (!(key in bindings)) throw new Error(`Missing Claude prompt binding: ${key}`);
        return promptContextKeys.includes(key as PromptContextKey) ? promptContextSlot(key as PromptContextKey, bindings[key]) : bindings[key];
    });
}

export const CLAUDE_HARNESS_INSTRUCTIONS = bind(CLAUDE_SYSTEM_TEMPLATE);
export const CLAUDE_SUBAGENT_INSTRUCTIONS = `${CLAUDE_HARNESS_INSTRUCTIONS}\n\n${bind(CLAUDE_SUBAGENT_TEMPLATE)}`;
