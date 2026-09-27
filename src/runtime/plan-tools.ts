import type { ToolDefinition } from '../shared/tool-protocol';
import { constants } from 'node:fs';
import { lstat, realpath, mkdir, open, rename, unlink, link } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const maximumBytes = 400000;
function validateContent(content: string) {
    if (!content.trim() || content.length > 100000 || Buffer.from(content, 'utf8').toString('utf8') !== content) throw new Error('计划必须是有效 Unicode 的非空正文，最多 100000 字符。');
}
function managedPath(dataDirectory: string, sessionId: string, runId: string, documentId?: string) {
    if (![sessionId, runId, ...(documentId ? [documentId] : [])].every(id => /^[a-zA-Z0-9-]{1,100}$/.test(id))) throw new Error('计划文件标识无效。');
    return path.join(path.resolve(dataDirectory), 'plans', sessionId, ...(documentId ? [documentId] : []), `${runId}.md`);
}
async function inspect(target: string, missingLeaf = false) {
    const root = path.parse(target).root;
    let cursor = root;
    const segments = target.slice(root.length).split(path.sep).filter(Boolean);
    for (let index = 0; index < segments.length; index++) {
        cursor = path.join(cursor, segments[index]);
        let stat;
        try { stat = await lstat(cursor); } catch (error) { if (missingLeaf && index === segments.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('计划路径不可用。'); }
        if (stat.isSymbolicLink() || (index < segments.length - 1 && !stat.isDirectory()) || (index === segments.length - 1 && stat.isFile() && stat.nlink > 1)) throw new Error('计划路径包含不安全链接或无效目录。');
    }
    const resolved = await realpath(target);
    if ((process.platform === 'win32' ? resolved.toLowerCase() !== target.toLowerCase() : resolved !== target)) throw new Error('计划路径不是规范路径。');
}
export async function readPlanFile(dataDirectory: string, sessionId: string, runId: string, documentId?: string): Promise<{ filePath: string; content: string; hash: string }> {
    const filePath = managedPath(dataDirectory, sessionId, runId, documentId);
    await inspect(filePath);
    const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink > 1 || stat.size > maximumBytes) throw new Error('计划文件必须是有界的普通 UTF-8 文件。');
        const buffer = Buffer.alloc(maximumBytes + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > maximumBytes) throw new Error('计划文件超过大小上限。');
        let content: string;
        try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytesRead)); } catch { throw new Error('计划文件不是有效 UTF-8。'); }
        validateContent(content); await inspect(filePath);
        const current = await lstat(filePath); if (current.ino !== stat.ino || current.dev !== stat.dev) throw new Error('计划文件在读取期间发生变化。');
        return { filePath, content, hash: createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex') };
    } finally { await handle.close(); }
}
export async function writePlanFile(dataDirectory: string, sessionId: string, runId: string, content: string, documentId?: string, exclusive = false): Promise<{ filePath: string; content: string; hash: string }> {
    validateContent(content);
    const filePath = managedPath(dataDirectory, sessionId, runId, documentId);
    const base = path.resolve(dataDirectory); await inspect(base);
    for (const directory of [path.join(base, 'plans'), path.join(base, 'plans', sessionId), ...(documentId ? [path.dirname(filePath)] : [])]) {
        await inspect(directory, true);
        await mkdir(directory, { recursive: false }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
        await inspect(directory);
    }
    await inspect(filePath, true);
    const temporary = path.join(path.dirname(filePath), `.${runId}.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx'); const owned = await handle.stat();
    try {
        await handle.writeFile(content, 'utf8'); await handle.sync(); await handle.close();
        await inspect(path.dirname(filePath)); await inspect(filePath, true);
        if (exclusive) { await link(temporary, filePath); await unlink(temporary); } else await rename(temporary, filePath); await inspect(filePath);
        return { filePath, content, hash: createHash('sha256').update(content, 'utf8').digest('hex') };
    } catch (error) {
        await handle.close().catch(() => {});
        try { await inspect(temporary); const current = await lstat(temporary); if (current.ino === owned.ino && current.dev === owned.dev) await unlink(temporary); } catch { /* An unverifiable temporary file is never removed. */ }
        throw error;
    }
}

export const writePlanTool: ToolDefinition = {
    name: 'write_plan', description: '用途：主代理在 Plan 模式把完整计划草稿写入应用管理的真实 .md 文件。先调研代码/类似实现、澄清问题、比较方案，再写具体路径、步骤、依赖与验证。content 必须非空，最多100000字符。路径由应用管理为 plans/会话/任务/draft.md；提交时生成独立版本快照，模型不能指定路径；它不在工作区，不授予 workspace 写权限。连续调用替换同一草稿并保留计划标识；默认接续当前任务，title 可指定标题，newPlan=true 明确开启独立新任务，返回可读保存确认，尚未提交或批准。子代理不能调用，readonly 不能借此写文件。失败先检查错误，不要假称保存成功。提交前可 read_plan 核对，然后 submit_plan({}) 交用户审批。示例：{"content":"目标：修复登录。路径：src/auth。步骤：核对现有校验与测试，再修改并运行回归。风险：兼容旧账号。验收：测试全通过。"}',
    parameters: { type: 'object', properties: { newPlan: { type: 'boolean', description: '明确开启另一个独立任务计划；默认接续当前任务。' }, title: { type: 'string', minLength: 1, maxLength: 200, description: '任务计划标题。' }, content: { type: 'string', minLength: 1, maxLength: 100000, description: '必填，完整非空 Unicode 计划正文，最多100000字符。可用 Markdown，不接受文件路径、权限或实施指令字段。' } }, required: ['content'], additionalProperties: false },
};
export const readPlanTool: ToolDefinition = {
    name: 'read_plan', description: '用途：主代理在任何权限模式从磁盘读取当前任务最新计划，Plan 模式优先读取本轮草稿，返回完整纯文本正文。参数仅空对象 {}，不接受路径；只读当前会话任务计划，不接受其他会话或子代理文件。文件不存在、链接不安全、UTF-8/大小无效时返回错误；请先 write_plan 保存草稿。读取不提交、不批准，不执行实施。示例：{}',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
};

export const submitPlanTool: ToolDefinition = {
    name: 'submit_plan',
    description: '用途：主代理在 Plan 模式从磁盘读取本轮真实 .md 草稿，固定正文与hash为待审批快照。通常先 write_plan 和 read_plan 核对，再调用 {}；也可传 plan 非空正文（最多100000字符），应用先保存真实文件再提交。内容应含范围、具体路径、步骤、依赖、风险和验证，不提交内部推理。成功返回文本确认；本批后续所有工具拒绝执行，已有只读子代理收拢后本轮结束，不会自动继续模型或实施。用户批准时还会校验磁盘内容未改变并显式选择实施权限；用户可通过独立 Revise 入口提供反馈指导 Agent 修订；修订创建同一任务的新规划轮与递增版本，保留稳定 draft.md，提交生成新的不可覆盖版本快照，保留旧版本。子代理和非 Plan 不可调用，不接受权限/自选路径；成功后不要重试。示例：{}',
    parameters: { type: 'object', properties: { plan: { type: 'string', minLength: 1, maxLength: 100000, description: '可选，非空完整计划正文，最多100000个UTF-16代码单元。提供时先写真实草稿；省略读取已写草稿，不存在则报错。不是路径，不授予实施权限。' } }, required: [], additionalProperties: false },
};
export const enterPlanModeTool: ToolDefinition = {
    name: 'enter_plan_mode',
    description: '用途：主代理在实施前需要先分析、规划并等待确认时进入 Plan 模式。仅当前非 readonly、非 Plan 主代理且没有存活直属子代理可调用；子代理不能改变父会话，readonly 不可借此提升权限。参数必须是空对象 {}。成功会立即持久化本运行与会话权限为 Plan，并返回文本确认；从同批下一个调用起禁止项目文件写入和命令执行，下一模型请求提供只读调研、受限子代理编排及 write_plan/read_plan/submit_plan 专用计划工具。此前已经发生的副作用不会回滚。随后提交完整计划，等待用户审阅，不要自行退出或假装已获批准。失败会返回错误，不切换模式；有子代理运行时先收拢结果再调用。示例：{}',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
};
