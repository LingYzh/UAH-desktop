const titles = { read_file: '读取文件', list_directory: '浏览目录', search_files: '搜索文件', write_file: '编辑文件', run_command: '执行命令', spawn_agent: '启动子代理', wait_agents: '等待子代理', list_agent_presets: '查询子代理角色', read_skill: '读取技能', enter_plan_mode: '进入规划模式', write_plan: '写入计划文件', read_plan: '读取计划文件', submit_plan: '提交实施计划' };
Object.assign(titles, { git_status: '查看 Git 状态', git_diff: '查看 Git 差异', git_log: '查看近期提交', read_file_range: '分段读取文件', read_artifact_range: '分段读取产物', apply_patch: '应用文件补丁' });
import { filePathKey } from './file-changes.js';

const states = { starting: '正在启动', running: '运行中', approval: '等待审批', completed: '已完成', failed: '失败', stopped: '已中止', stopping: '正在停止' };
const nativeTitles = {
    commandExecution: '原生命令', mcpToolCall: 'MCP 工具', dynamicToolCall: '原生动态工具',
    fileChange: '原生文件变更', approval: 'Codex 原生审批', reasoning: '原生推理摘要',
};
const bridgeToolNames = new Set(['list_agent_presets', 'spawn_agent', 'wait_agents', 'read_skill']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value : '';
const state = value => states[value] || '状态未知';
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const readableJson = value => { try { return JSON.stringify(value, null, 2); } catch { return '原生操作详情不可用。'; } };
const recordedResult = (activity, metadata) => typeof metadata.result === 'string'
    ? metadata.result
    : text(activity.content) || (['running', 'approval'].includes(activity.status) ? '' : '原始记录没有结果。');

function nativeTextItems(value) {
    if (!Array.isArray(value)) return '';
    return value.map(item => object(item) && ['text', 'inputText'].includes(item.type) ? text(item.text) : '').filter(Boolean).join('\n');
}

function nativeFileChanges(changes) {
    if (!Array.isArray(changes)) return '';
    return changes.filter(object).map(change => {
        const path = text(change.path);
        const kind = object(change.kind) ? text(change.kind.type) : text(change.kind);
        const movePath = object(change.kind) ? text(change.kind.move_path) : '';
        return [kind && path ? `${kind} · ${path}${movePath ? ` → ${movePath}` : ''}` : path || kind, text(change.diff)].filter(Boolean).join('\n');
    }).filter(Boolean).join('\n\n');
}

function nativeItemMetadata(item) {
    if (!object(item) || typeof item.type !== 'string') return null;
    const name = `native:${item.type}`;
    if (item.type === 'commandExecution') {
        const output = text(item.aggregatedOutput);
        const exit = typeof item.exitCode === 'number' ? `退出代码：${item.exitCode}` : '';
        return { name, arguments: { command: text(item.command), cwd: text(item.cwd) }, result: [output, exit].filter(Boolean).join('\n'), isError: item.status === 'failed' };
    }
    if (item.type === 'mcpToolCall') {
        const result = object(item.result) ? item.result : {};
        const error = object(item.error) ? text(item.error.message) : '';
        const structured = result.structuredContent;
        return {
            name, arguments: { server: text(item.server), tool: text(item.tool), arguments: object(item.arguments) ? item.arguments : {} },
            result: error || nativeTextItems(result.content) || (structured === undefined ? '' : readableJson(structured)),
            isError: Boolean(error) || item.status === 'failed',
        };
    }
    if (item.type === 'dynamicToolCall') {
        return {
            name, arguments: { tool: text(item.tool), arguments: object(item.arguments) ? item.arguments : {} },
            result: nativeTextItems(item.contentItems), isError: item.success === false || item.status === 'failed',
        };
    }
    if (item.type === 'fileChange') {
        const changes = Array.isArray(item.changes) ? item.changes.filter(object).map(change => ({
            path: text(change.path), kind: object(change.kind) ? { type: text(change.kind.type), ...(typeof change.kind.move_path === 'string' ? { move_path: change.kind.move_path } : {}) } : change.kind,
        })) : [];
        return { name, arguments: { changes }, result: nativeFileChanges(item.changes), isError: item.status === 'failed' };
    }
    const sanitized = { ...item };
    delete sanitized.encrypted_content;
    delete sanitized.internal_chat_message_metadata_passthrough;
    return { name, arguments: { item: sanitized }, result: readableJson(sanitized), isError: item.status === 'failed' };
}

function legacyNativeToolMetadata(activity) {
    if (!text(activity?.id).startsWith('native:')) return null;
    const parsed = parse(text(activity.content));
    return object(parsed) ? nativeItemMetadata(parsed) : null;
}

/** Collapse duplicate protocol reports only with an exact call ID and tool match. */
export function coalesceNativeActivities(activities) {
    const bridges = new Map(activities.filter(item => text(item.id).startsWith('uah:') && text(item.tool?.name).startsWith('uah_'))
        .map(item => [item.id.slice(4), item]));
    return activities.filter(item => {
        if (!text(item.id).startsWith('native:')) return true;
        const bridge = bridges.get(item.id.slice(7));
        if (!bridge || !['completed', 'failed'].includes(bridge.status)) return true;
        const metadata = item.tool || legacyNativeToolMetadata(item);
        return metadata?.name !== 'native:dynamicToolCall' || metadata.arguments?.tool !== bridge.tool.name;
    });
}

/** Reads legacy JSON reasoning activities through their public summary only. */
export function nativeReasoningSummary(activity) {
    const content = text(activity?.content);
    if (!text(activity?.id).startsWith('native:')) return content;
    const parsed = parse(content);
    if (!object(parsed) || parsed.type !== 'reasoning') return content;
    if (!Array.isArray(parsed.summary)) return '公开推理摘要不可用。';
    const summary = parsed.summary.map(part => typeof part === 'string'
        ? part
        : object(part) && (part.type === undefined || part.type === 'summary_text') ? text(part.text) : '').filter(Boolean).join('\n\n');
    return summary || '公开推理摘要不可用。';
}

function presentNativeTool(activity, metadata) {
    const name = metadata.name.slice('native:'.length);
    const args = object(metadata.arguments) ? metadata.arguments : {};
    let usage = '';
    if (name === 'commandExecution') usage = [text(args.command) || '命令详情不可用。', text(args.cwd) ? `目录：${text(args.cwd)}` : ''].filter(Boolean).join('\n');
    else if (name === 'mcpToolCall') usage = [`${text(args.server) || 'MCP'} / ${text(args.tool) || '工具'}`, `参数：${readableJson(args.arguments)}`].join('\n');
    else if (name === 'dynamicToolCall') usage = [`工具：${text(args.tool) || '未知工具'}`, `参数：${readableJson(args.arguments)}`].join('\n');
    else if (name === 'fileChange') usage = (Array.isArray(args.changes) ? args.changes.filter(object).map(change => {
        const kind = object(change.kind) ? text(change.kind.type) : text(change.kind);
        const movePath = object(change.kind) ? text(change.kind.move_path) : '';
        return `${kind ? `${kind} · ` : ''}${text(change.path) || '文件'}${movePath ? ` → ${movePath}` : ''}`;
    }).join('\n') : '') || '原生文件变更';
    else if (name === 'approval') usage = [text(args.summary), text(args.resource) ? `资源：${text(args.resource)}` : ''].filter(Boolean).join('\n');
    else usage = `原生操作 · ${name}`;
    return {
        title: nativeTitles[name] || `原生操作 · ${name}`,
        toolName: name,
        usage,
        result: text(metadata.result),
    };
}

// Find the complete leading JSON object, respecting quoted braces and escapes.
// The following result may itself contain any number of blank lines.
export function legacyToolMetadata(activity) {
    const source = text(activity.content);
    let start = 0; while (/\s/.test(source[start] || '') && start < source.length) start++;
    if (source[start] !== '{') return null;
    let depth = 0; let quoted = false; let escaped = false;
    for (let index = start; index < source.length; index++) {
        const character = source[index];
        if (quoted) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') quoted = false;
            continue;
        }
        if (character === '"') quoted = true;
        else if (character === '{' || character === '[') depth++;
        else if (character === '}' || character === ']') {
            if (--depth !== 0) continue;
            const argumentsObject = parse(source.slice(start, index + 1));
            if (!object(argumentsObject)) return null;
            const remainder = source.slice(index + 1);
            if (remainder && !remainder.startsWith('\n\n')) return null;
            return { name: activity.childRunId ? 'spawn_agent' : activity.title, arguments: argumentsObject, ...(remainder ? { result: remainder.slice(2) } : {}) };
        }
    }
    return null;
}

function resultText(name, result, failed) {
    if (!result) return '';
    if (['git_status', 'git_diff', 'git_log'].includes(name)) {
        const value = parse(result);
        if (!object(value) || !object(value.snapshot)) return failed ? result : 'Git 结果详情不可用。';
        const snapshot = value.snapshot;
        if (snapshot.state !== 'ready') return text(snapshot.message) || 'Git 状态未知。';
        if (name === 'git_diff') return (text(value.diff) || '此范围没有已跟踪文件差异。') + (value.truncated ? '\n（差异已截断）' : '');
        if (name === 'git_log') return (Array.isArray(value.commits) ? value.commits.filter(object).map(commit => `${text(commit.shortHash)} · ${text(commit.date)} · ${text(commit.subject)}`).join('\n') : '') + (value.truncated ? '\n（仅显示近期提交）' : '') || '没有当前目录范围内的提交。';
        const files = Array.isArray(snapshot.files) ? snapshot.files.filter(object).map(file => `${text(file.indexStatus)}${text(file.worktreeStatus)} · ${text(file.path)}${file.untracked ? ' · 未跟踪' : ''}`).join('\n') : '';
        return [text(snapshot.branch) || '分离 HEAD', text(snapshot.head) || '尚无提交', text(snapshot.message), files || '当前目录范围内没有检测到文件改动。', snapshot.truncated ? '（文件列表已截断）' : ''].filter(Boolean).join('\n');
    }
    if (failed) return result;
    if (name === 'read_skill') {
        const skill = parse(result);
        if (!object(skill) || typeof skill.content !== 'string') return result;
        return [`技能：${text(skill.name) || text(skill.id) || '未命名技能'}`, text(skill.source) ? `来源：${text(skill.source)}` : '', skill.content].filter(Boolean).join('\n\n');
    }
    if (!['spawn_agent', 'wait_agents', 'list_agent_presets'].includes(name)) return result;
    const parsed = parse(result);
    if (name === 'spawn_agent' && object(parsed)) return `子代理${parsed.agentId ? ` ${text(parsed.agentId)}` : ''}：${state(parsed.status)}${parsed.modelId ? ` · ${text(parsed.modelId)}` : ''}`;
    if (name === 'wait_agents' && Array.isArray(parsed)) return parsed.filter(object).map(item => [
        `子代理 ${text(item.agentId) || '未命名'}：${state(item.status)}`,
        text(item.output), item.error ? `错误：${text(item.error)}` : '', item.stopReason ? `停止理由：${text(item.stopReason)}` : '',
    ].filter(Boolean).join('\n')).join('\n\n') || '没有子代理状态。';
    if (name === 'list_agent_presets' && object(parsed) && Array.isArray(parsed.profiles)) {
        const roles = parsed.profiles.filter(object).map(item => {
            const model = object(item.model) ? [text(item.model.endpointId), text(item.model.modelId)].filter(Boolean).join(' / ') : '';
            return `${text(item.name) || text(item.id) || '未命名角色'}${model ? ` · ${model}` : ' · 继承当前模型'}`;
        }).join('\n') || '没有已启用的子代理角色。';
        if (!Array.isArray(parsed.providers)) return roles;
        const providers = parsed.providers.filter(object).map(item => `${text(item.name)} · Provider ID：${text(item.providerId)}\n模型：${Array.isArray(item.models) ? item.models.map(text).join('、') : '未上报'}`).join('\n\n');
        return `${roles}\n\nProvider 目录（配置状态，未探测服务在线）：\n${parsed.providerCatalogAvailable === false ? 'API 目录未接入，以下只展示已知路由。\n' : ''}${providers || '没有可用配置。'}`;
    }
    return '结果详情不可用。';
}

/** All strings are plain text: escape them, never render file/tool results as Markdown. */
export function presentTool(activity, artifacts = [], context = {}) {
    let metadata = object(activity.tool) && object(activity.tool.arguments) ? activity.tool : legacyNativeToolMetadata(activity) || legacyToolMetadata(activity);
    if (!metadata) return { title: '工具操作', usage: '操作详情不可用。', result: '结果详情不可用。' };
    const originalToolName = text(metadata.name);
    if (originalToolName === 'native:dynamicToolCall') {
        const wrapper = object(metadata.arguments) ? metadata.arguments : {};
        const wrappedToolName = text(wrapper.tool);
        const wrappedArguments = object(wrapper.arguments) ? wrapper.arguments : {};
        if (bridgeToolNames.has(wrappedToolName.replace(/^uah_/, '')) && wrappedToolName.startsWith('uah_')) {
            const name = wrappedToolName.slice(4);
            const rawResult = recordedResult(activity, metadata);
            const normalizedActivity = { ...activity, tool: { ...metadata, name, arguments: wrappedArguments, result: rawResult, isError: metadata.isError === true } };
            const shown = presentTool(normalizedActivity, artifacts, context);
            const summarized = shown.result;
            return {
                ...shown,
                toolName: name,
                originalToolName: wrappedToolName,
                ...(summarized !== rawResult ? { rawResult } : {}),
            };
        }
        const rawResult = recordedResult(activity, metadata);
        return {
            title: `原生动态工具 · ${wrappedToolName || '未知工具'}`,
            usage: `工具：${wrappedToolName || '未知工具'}\n参数：${readableJson(wrapper.arguments ?? {})}`,
            result: rawResult,
            toolName: wrappedToolName,
            originalToolName: wrappedToolName,
        };
    }
    let bridged = false;
    if (originalToolName.startsWith('uah_') && bridgeToolNames.has(originalToolName.slice(4))) {
        metadata = { ...metadata, name: originalToolName.slice(4) };
        bridged = true;
    }
    const name = metadata.name;
    if (typeof name === 'string' && name.startsWith('native:')) return presentNativeTool(activity, metadata);
    if (!Object.hasOwn(titles, name)) {
        const rawResult = recordedResult(activity, metadata);
        const kind = originalToolName.startsWith('mcp_') ? 'MCP 工具' : '工具';
        return {
            title: `${kind} · ${originalToolName || '未知名称'}`,
            usage: `工具：${originalToolName || '未知名称'}\n参数：${readableJson(metadata.arguments)}`,
            result: rawResult,
            toolName: originalToolName,
            originalToolName,
        };
    }
    const args = metadata.arguments;
    const path = text(args.path) || '.';
    let usage = '';
    switch (name) {
        case 'git_status': usage = '只读查询当前目录的本地 Git 状态'; break;
        case 'git_diff': usage = `查看 ${path} · ${args.staged ? '已暂存（索引对 HEAD）' : '未暂存（工作区对索引）'}`; break;
        case 'git_log': usage = '读取影响当前目录的最近至多 20 条本地提交'; break;
        case 'read_file_range':
        case 'read_file': usage = `读取 ${path} · 第 ${(Number.isInteger(args.offset) ? args.offset : 0) + 1} 个字符起，最多 ${Number.isInteger(args.limit) ? args.limit : 16000} 个字符`; break;
        case 'list_directory': usage = `列出 ${path} 的直接子项`; break;
        case 'search_files': usage = `在 ${path} 搜索字面文本：${text(args.query)}`; break;
        case 'write_file': usage = `${args.expectedContent === null ? '创建' : '替换'} ${path}`; break;
        case 'apply_patch': usage = `核对文件版本后应用 ${Array.isArray(args.edits) ? args.edits.length : 0} 处补丁 · ${path}`; break;
        case 'run_command': usage = text(args.command) || '命令详情不可用。'; break;
        case 'spawn_agent': {
            const agent = object(args.agent) ? args.agent : {};
            const label = text(agent.name) || (agent.type === 'preset' ? `角色 ${text(agent.id)}` : '继承当前角色');
            usage = `${label}\n任务：${text(args.prompt) || '任务详情不可用。'}`; break;
        }
        case 'wait_agents': {
            const count = Array.isArray(args.agentIds) ? args.agentIds.filter(value => typeof value === 'string').length : 0;
            const timeout = Number.isInteger(args.timeoutMs) ? args.timeoutMs : 30000;
            usage = timeout === 0 ? `查询 ${count} 个子代理状态` : `等待 ${count} 个子代理 · 最多 ${timeout / 1000} 秒`; break;
        }
        case 'list_agent_presets': usage = '查看已启用的子代理角色、Provider ID 和模型目录'; break;
        case 'read_skill': usage = `${text(args.id) || '读取技能'}${text(args.path) ? `\n路径：${text(args.path)}` : '\n读取技能说明文件'}`; break;
        case 'enter_plan_mode': usage = '切换到只读调研与规划；文件编辑和命令执行保持禁用，待用户审阅计划。'; break;
        case 'write_plan': usage = '将计划草稿保存为此轮专用的 Markdown 文件，不修改项目文件。'; break;
        case 'read_plan': usage = '读取此轮已保存的计划文件。'; break;
        case 'submit_plan': usage = '保存实施计划供审阅，等待用户批准执行或提出修改意见。'; break;
    }
    const rawResult = recordedResult(activity, metadata);
    const summarizedResult = resultText(name, rawResult, metadata.isError || activity.status === 'failed');
    const presentation = { title: titles[name], usage, result: summarizedResult };
    if (bridged) Object.assign(presentation, { toolName: name, originalToolName });
    if ((bridged || originalToolName === 'native:dynamicToolCall') && summarizedResult !== rawResult) Object.assign(presentation, { rawResult });
    if (['read_file', 'read_file_range', 'write_file', 'apply_patch', 'list_directory', 'search_files'].includes(name)) presentation.path = path;
    if (name === 'run_command') presentation.language = 'powershell';
    if (['write_file', 'apply_patch'].includes(name)) {
        let artifact = typeof metadata.artifactId === 'string' ? artifacts.find(item => item.id === metadata.artifactId) : undefined;
        if (!Object.hasOwn(metadata, 'artifactId') && activity.status === 'completed' && typeof context.runId === 'string'
            && (args.expectedContent === null || typeof args.expectedContent === 'string') && typeof args.content === 'string') {
            const key = filePathKey(text(args.path), context.directory);
            const candidates = key === null ? [] : artifacts.filter(item => item.runId === context.runId
                && filePathKey(item.path) === key && item.oldContent === args.expectedContent && item.newContent === args.content);
            if (candidates.length === 1) artifact = candidates[0];
        }
        if (artifact && (artifact.oldContent === null || typeof artifact.oldContent === 'string') && typeof artifact.newContent === 'string') {
            Object.assign(presentation, { artifactId: artifact.id, before: artifact.oldContent, after: artifact.newContent, path: artifact.path, diffSource: 'artifact' });
        } else if (['running', 'approval'].includes(activity.status) && (args.expectedContent === null || typeof args.expectedContent === 'string') && typeof args.content === 'string') {
            Object.assign(presentation, { before: args.expectedContent, after: args.content, diffSource: 'proposal' });
        }
    }
    return presentation;
}
