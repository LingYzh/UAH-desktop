const titles = { read_file: '读取文件', list_directory: '浏览目录', search_files: '搜索文件', write_file: '编辑文件', run_command: '执行命令', spawn_agent: '启动子代理', wait_agents: '等待子代理', list_agent_presets: '查询子代理角色', enter_plan_mode: '进入规划模式', write_plan: '写入计划文件', read_plan: '读取计划文件', submit_plan: '提交实施计划' };
Object.assign(titles, { git_status: '查看 Git 状态', git_diff: '查看 Git 差异', git_log: '查看近期提交', read_file_range: '分段读取文件', read_artifact_range: '分段读取产物', apply_patch: '应用文件补丁' });
import { filePathKey } from './file-changes.js';

const states = { starting: '正在启动', running: '运行中', approval: '等待审批', completed: '已完成', failed: '失败', stopped: '已中止', stopping: '正在停止' };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value : '';
const state = value => states[value] || '状态未知';
const parse = value => { try { return JSON.parse(value); } catch { return null; } };

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
    if (failed || !['spawn_agent', 'wait_agents', 'list_agent_presets'].includes(name)) return result;
    const parsed = parse(result);
    if (name === 'spawn_agent' && object(parsed)) return `子代理${parsed.agentId ? ` ${text(parsed.agentId)}` : ''}：${state(parsed.status)}${parsed.modelId ? ` · ${text(parsed.modelId)}` : ''}`;
    if (name === 'wait_agents' && Array.isArray(parsed)) return parsed.filter(object).map(item => [
        `子代理 ${text(item.agentId) || '未命名'}：${state(item.status)}`,
        text(item.output), item.error ? `错误：${text(item.error)}` : '', item.stopReason ? `停止理由：${text(item.stopReason)}` : '',
    ].filter(Boolean).join('\n')).join('\n\n') || '没有子代理状态。';
    if (name === 'list_agent_presets' && object(parsed) && Array.isArray(parsed.profiles)) return parsed.profiles.filter(object).map(item => {
        const model = object(item.model) ? [text(item.model.endpointId), text(item.model.modelId)].filter(Boolean).join(' / ') : '';
        return `${text(item.name) || text(item.id) || '未命名角色'}${model ? ` · ${model}` : ' · 继承当前模型'}`;
    }).join('\n') || '没有已启用的子代理角色。';
    return '结果详情不可用。';
}

/** All strings are plain text: escape them, never render file/tool results as Markdown. */
export function presentTool(activity, artifacts = [], context = {}) {
    const metadata = object(activity.tool) && object(activity.tool.arguments) ? activity.tool : legacyToolMetadata(activity);
    const name = metadata?.name;
    if (!metadata || !Object.hasOwn(titles, name)) return { title: '工具操作', usage: '操作详情不可用。', result: '结果详情不可用。' };
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
        case 'list_agent_presets': usage = '查看已启用的子代理角色及其模型'; break;
        case 'enter_plan_mode': usage = '切换到只读调研与规划；文件编辑和命令执行保持禁用，待用户审阅计划。'; break;
        case 'write_plan': usage = '将计划草稿保存为此轮专用的 Markdown 文件，不修改项目文件。'; break;
        case 'read_plan': usage = '读取此轮已保存的计划文件。'; break;
        case 'submit_plan': usage = '保存实施计划供审阅，等待用户批准执行或提出修改意见。'; break;
    }
    const presentation = { title: titles[name], usage, result: resultText(name, text(metadata.result), metadata.isError || activity.status === 'failed') };
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
