import { GPT_SHARED_TEMPLATE, GPT_MAIN_TEMPLATE, GPT_SUBAGENT_TEMPLATE } from './gpt-prompt-templates';
import { CLAUDE_SYSTEM_TEMPLATE, CLAUDE_SUBAGENT_TEMPLATE } from './claude-prompt-templates';

export type PromptProfile = 'gpt' | 'claude' | 'coding' | 'generic';
const profiles: PromptProfile[] = ['gpt', 'claude', 'coding', 'generic'];

/** Explicit, versioned opt-in, preserved in the locked Agent snapshot and inheritance.
 * Only a leading marker selects a profile; documents/context cannot select instructions.
 * The marker selects writing style/role text, never tools or permissions.
 */
export function managedPrompt(profile: PromptProfile, instructions: string): string {
    return `<!-- UAH_PROMPT_PROFILE:${profile}:v1 -->\n${instructions.trim()}`;
}

export function parsePromptProfile(instructions: string): { profile: PromptProfile; instructions: string } {
    const match = /^<!-- UAH_PROMPT_PROFILE:(gpt|claude|coding|generic):v1 -->\r?\n/.exec(instructions);
    return match ? { profile: match[1] as PromptProfile, instructions: instructions.slice(match[0].length) } : { profile: 'generic', instructions };
}

function bind(template: string, bindings: Record<string, string>): string {
    return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => {
        if (!Object.hasOwn(bindings, key)) throw new Error(`Missing conditional prompt binding: ${key}`);
        return bindings[key];
    }).replace(/\n{3,}/g, '\n\n').trim();
}

// Behavioral source text remains in the original user-supplied templates. Host/tool,
// skills/plugin, role and environment sections are now provided by the assembler.
// Git is a conditional workspace.git module plus a fresh context.git snapshot;
// keep it out of these persisted behavioral bases and legacy migration bindings.
const gptBase = bind(GPT_SHARED_TEMPLATE.split('# Rules for getting work done')[0], {
    AGENT_NAME: 'the configured engineering agent', HARNESS_NAME: 'UAH',
    WORKSPACE_RELATIONSHIP: 'Follow the actual workspace and role supplied in this request. This preset does not bind a provider or determine model identity.',
    USER_INTERACTION_PROTOCOL: 'Use ordinary assistant text for progress, questions and final results. There is no separate callable commentary/final channel or asynchronous question tool. Required answers arrive in a later user turn. Child agents return questions to their caller.',
    CONTEXT_MANAGEMENT_PROTOCOL: 'Use supplied history and task context. Automatic compaction, infinite context and cross-session memory are not guaranteed. Do not assume omitted information is available.',
    PROGRESS_CHANNEL: 'ordinary visible assistant text',
    PROGRESS_UPDATE_POLICY: 'concise updates at meaningful milestones; a blocking tool may delay the next model request',
    OUTPUT_RENDERING_AND_FILE_REFERENCES: 'Markdown, GFM, math and Mermaid are supported. Reference only verified file paths; local-file links are not guaranteed to open. Do not use internal Codex directives or fabricate hidden reasoning.',
});

const claudeBase = CLAUDE_SYSTEM_TEMPLATE
    .replace(/# 工具使用\n[\s\S]*?(?=# 沟通与交付)/, '')
    .split('# 运行时上下文')[0].replaceAll('{{HARNESS_NAME}}', 'UAH').trim();

const codingBase = `# 通用 Coding Agent

你是 UAH 中的编程协作者，为用户交付可维护、可验证的代码。不假定具体模型品牌、语言、框架或操作系统。

先理解目标、读取相关实现和项目规则；区分已知事实、假设和待查问题。只实施完成请求所必需的改动，沿用现有结构与风格，保留用户及其他代理的工作。

对影响实现方向或不可逆后果的关键歧义提出澄清，其余已授权工作持续推进。选择简单完整的方案，检查边界输入、失败路径和并发问题。

执行与改动相称的验证。长任务报告有意义的进展，交付时说明实际更改、验证结果及未解决问题，不编造成功。`;

export function conditionalDefaultInstructions(profile: PromptProfile): string {
    if (!profiles.includes(profile)) throw new Error('Unknown prompt profile');
    return managedPrompt(profile, profile === 'gpt' ? gptBase : profile === 'claude' ? claudeBase : profile === 'coding' ? codingBase : '你是用户的工作协作者。理解目标与约束后完成已授权工作；检查事实、保留用户更改，验证实际结果并如实汇报。使用用户的语言简洁交流。');
}

/** Source role templates with capability slots removed: active capabilities are separate modules. */
export function conditionalRoleInstructions(profile: PromptProfile, child: boolean): string {
    if (profile === 'gpt') {
        const template = child ? GPT_SUBAGENT_TEMPLATE : GPT_MAIN_TEMPLATE;
        const bindings = Object.fromEntries([...template.matchAll(/\{\{([A-Z_]+)\}\}/g)].map(match => [match[1], '']));
        return bind(template, { ...bindings,
            AGENT_ID: 'the current run identified in the environment context',
            PARENT_AGENT_ID: 'the calling run identified by parentRunId',
            DELEGATED_TASK_AND_OUTPUT_CONTRACT: 'The current user message is your assigned task. Work only within its scope, constraints and file ownership; return missing critical context and blockers to the caller.',
            RESULT_RETURN_PROTOCOL: 'End with ordinary assistant text summarizing work, affected paths, validation and blockers. UAH saves this child output for the caller to retrieve. Do not assume a message bus or a new parent request is created by final text.',
            MAIN_AGENT_COMPLETION_CONTRACT: 'Own key decisions, integration and final verification against the original goal. Report real results and remaining limitations. Any child findings must be reviewed before you rely on them.',
        });
    }
    if (profile === 'claude' && child) return bind(CLAUDE_SUBAGENT_TEMPLATE, {
        HARNESS_NAME: 'UAH', SUBAGENT_TASK: '本次当前用户消息是调用方委派的任务。只处理该目标，不假定拥有主会话全部历史。',
        SUBAGENT_SCOPE_AND_PERMISSIONS: '权限以当轮宿主规则为准，不得超过父代理。普通最终回复保存为子运行输出，供调用方读取；没有单独消息总线或直接向最终用户提问的通道。',
    });
    return child ? '# 当前角色：子代理\n只执行当前用户消息中的委派任务。遵守调用方范围与文件分工，权限不得超过父代理。通过普通最终回复返回发现、修改、验证与阻塞，由宿主保存供调用方读取，不直接操作主会话或假设拥有完整历史。'
        : '# 当前角色：主代理\n对用户目标、关键决策、结果整合和最终验收负责。依据实际文件与验证证据交付；使用子代理结果时亲自核验，不仅凭完成声明收尾。';
}
