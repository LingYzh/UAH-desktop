import { constants } from 'node:fs';
import { lstat, realpath, open, opendir, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { permissionDecision, type PermissionMode } from '../shared/permissions.js';
import type { ToolDefinition, ToolCall } from '../shared/tool-protocol.js';

const MAX_FILE = 1024 * 1024;
const MAX_OUTPUT = 64 * 1024;
interface Context {
    directory: string | null;
    permissionMode: PermissionMode;
    signal: AbortSignal;
    approve: (summary: string, path: string) => Promise<boolean>;
    onArtifact?: (change: { path: string; oldContent: string | null; newContent: string }) => void;
}
class ToolFailure extends Error {}
interface WriteWaiter { context: Context; grant: (release: () => void) => void; cancel: () => void; }
const writeLocks = new Map<string, WriteWaiter[]>();
/** User approval is resolved before locking so approval cannot block sibling edits. */
async function acquireWriteLock(target: string, context: Context): Promise<() => void> {
    aborted(context);
    const key = process.platform === 'win32' ? target.toLowerCase() : target;
    const release = () => {
        const queue = writeLocks.get(key);
        const next = queue?.shift();
        if (!next) { writeLocks.delete(key); return; }
        next.context.signal.removeEventListener('abort', next.cancel);
        next.grant(release);
    };
    const queue = writeLocks.get(key);
    if (!queue) { writeLocks.set(key, []); return release; }
    return new Promise((resolve, reject) => {
        const waiter: WriteWaiter = { context, grant: resolve, cancel: () => {
            const index = queue.indexOf(waiter);
            if (index >= 0) queue.splice(index, 1);
            context.signal.removeEventListener('abort', waiter.cancel);
            reject(new ToolFailure('Tool cancelled while waiting for another write.'));
        } };
        queue.push(waiter);
        context.signal.addEventListener('abort', waiter.cancel, { once: true });
        if (context.signal.aborted) waiter.cancel();
    });
}
function safeCode(error: unknown): string { const code = (error as NodeJS.ErrnoException | undefined)?.code; return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? ` (${code})` : ''; }
function fail(message: string): never { throw new ToolFailure(message); }
function aborted(context: Context) { if (context.signal.aborted) fail('Tool cancelled.'); }
const pathDescription = '路径字符串，1–4096 个 UTF-16 代码单元；相对路径基于已选工作目录，也可用绝对路径。禁止 ..、符号链接/重解析路径及不安全 Windows 名称；除 bypass 外必须在工作区内。';
const schemas: Record<string, { fields: string[]; required: string[]; properties: Record<string, unknown> }> = {
    read_file: { fields: ['path', 'offset', 'limit'], required: ['path'], properties: {
        path: { type: 'string', description: `${pathDescription} 必填，目标必须是现有文件。` },
        offset: { type: 'integer', minimum: 0, maximum: MAX_FILE, description: '可选，0–1048576，默认 0。解码后字符串的 UTF-16 起始索引，不是字节或行号；超过结尾返回空字符串。' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_OUTPUT, description: '可选，1–65536，默认 16000；最多返回的 UTF-16 代码单元数。' },
    } },
    list_directory: { fields: ['path'], required: [], properties: {
        path: { type: 'string', description: `${pathDescription} 可选，默认 "."；目标必须是现有目录。` },
    } },
    search_files: { fields: ['path', 'query'], required: ['query'], properties: {
        path: { type: 'string', description: `${pathDescription} 可选，默认 "."；从该现有目录递归搜索。` },
        query: { type: 'string', minLength: 1, maxLength: 1024, description: '必填，1–1024 个 UTF-16 代码单元。区分大小写的字面子串；不是正则表达式或 glob。' },
    } },
    write_file: { fields: ['path', 'content', 'expectedContent'], required: ['path', 'content', 'expectedContent'], properties: {
        path: { type: 'string', description: `${pathDescription} 必填，父目录必须已存在；不能编辑硬链接文件。` },
        content: { type: 'string', description: '必填，新文件的完整 UTF-8 文本，编码后最多 1 MiB；允许空字符串。替换整个文件，不是补丁或追加。' },
        expectedContent: { type: ['string', 'null'], description: '必填。覆盖时传当前文件的完整精确文本（含换行，UTF-8 最多 1 MiB），不能传 read_file 的截断片段；null 仅用于创建不存在的文件。已有空文件应传 ""，不是 null。' },
    } },
    run_command: { fields: ['command', 'timeoutSeconds'], required: ['command'], properties: {
        command: { type: 'string', minLength: 1, maxLength: 16384, description: '必填，非空白 PowerShell 命令，最多 16384 个 UTF-16 代码单元，不得含 NUL。作为 -Command 执行；不是 CMD、Bash 或交互式输入。' },
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: 120, description: '可选，1–120 秒，默认 30。超时仅尝试停止直接启动的 PowerShell，后代进程可能继续运行。' },
    } },
};
const commonDescription = '必须先选择显式、规范的绝对工作目录；无目录会失败，即使 bypass 也不例外。参数必须是 JSON 对象，只允许列出的字段。工具结果正文为下述文本，不额外包裹 JSON 对象；失败正文会说明原因。部分协议另有错误标记，不能只凭有返回值就认定成功。遇到错误先核对路径、权限和结果，不要原样盲目重试。';
const descriptions: Record<string, string> = {
    read_file: `${commonDescription} 用于查看现有 UTF-8 普通文件，整个文件必须有效 UTF-8 且不超过 1 MiB；读取无需审批。返回所选字符串片段，无截断标记；用 offset/limit 分段，注意 UTF-16 切片可能分开代理对。覆盖文件前须取得完整内容，不能把片段作为 expectedContent。示例：{"path":"src/app.ts","offset":0,"limit":16000}`,
    list_directory: `${commonDescription} 用于发现目录中的直接子项，不递归、不保证排序，跳过符号链接，读取无需审批。每行是 "directory 相对路径" 或 "file 相对路径"，相对于所列目录；空目录返回空文本。最多检查 500 项，文本最多 32000 个 UTF-16 代码单元，受限时追加 [Results truncated]；可改列子目录缩小范围。示例：{"path":"src"}`,
    search_files: `${commonDescription} 用于在目录树内查找字面文本，读取无需审批。返回 "相对路径:从1开始的行号: 行文本"，行文本最多 400 个 UTF-16 代码单元；无匹配返回空文本。跳过符号链接及不可读/无效 UTF-8 文件；单文件上限1 MiB，累计检查文件字节上限8 MiB，最多500个目录项、100条匹配，递归进入至第6层，结果文本最多32000个 UTF-16 代码单元。受限时追加 [Results truncated]，缩小 path 或 query 再查；不是全库无遗漏索引。示例：{"path":"src","query":"TODO"}`,
    write_file: `${commonDescription} 用于创建或整文件替换 UTF-8 文本；不创建父目录。manual 要求用户审批，plan/readonly 拒绝，accept-edits/auto/bypass 可直接写。覆盖前核对完整 expectedContent；冲突先重新读取并重新决定修改，不能直接重试旧内容。成功返回 "File written." 并记录变更快照；若提示快照失败，写入已发生，不能自动重写。写入中失败可能部分修改，取消后也须按错误提示检查目标；不是可回滚事务。示例：{"path":"notes.txt","content":"hello\\n","expectedContent":null}`,
    run_command: `${commonDescription} 仅Windows可用，工作目录为已选目录；使用 SystemRoot（默认 C:\\Windows）下 System32/WindowsPowerShell/v1.0/powershell.exe，参数 -NoProfile -NonInteractive -Command；不保证 PowerShell 7。plan/readonly 拒绝；其他模式均须用户审批，唯 bypass 无审批。命令未隔离，可访问工作区外和产生副作用；stdin关闭，不支持交互或依赖控制台的程序。stdout/stderr 合并按到达次序收集，最多64 KiB字节后尝试停止；返回UTF-8解码输出、退出码或取消/超时/启动失败说明，并附未隔离提示。非零退出码或停止事件表示失败。只停止直接PowerShell，后代可能在取消或结束后继续运行；核实副作用后再重试。示例：{"command":"Get-Location","timeoutSeconds":30}`,
};
export function workspaceToolDefinitions(): ToolDefinition[] {
    return Object.entries(schemas).map(([name, schema]) => ({ name, description: descriptions[name], parameters: { type: 'object', properties: schema.properties, required: schema.required, additionalProperties: false } }));
}
function parse(call: ToolCall): Record<string, unknown> {
    if (!Object.hasOwn(schemas, call.name)) fail('Unknown tool.');
    if (typeof call.arguments !== 'string' || Buffer.byteLength(call.arguments) > 3 * MAX_FILE) fail('Tool arguments exceed the limit.');
    let value: unknown;
    try { value = JSON.parse(call.arguments); } catch { fail('Tool arguments must be valid JSON.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Tool arguments must be an object.');
    const args = value as Record<string, unknown>;
    const schema = schemas[call.name];
    if (Object.keys(args).some(key => !schema.fields.includes(key)) || schema.required.some(key => !Object.hasOwn(args, key))) fail('Unknown or missing tool argument.');
    for (const key of ['path', 'query', 'content', 'command']) if (Object.hasOwn(args, key) && typeof args[key] !== 'string') fail('Invalid text argument.');
    if (typeof args.path === 'string' && (!args.path || args.path.length > 4096)) fail('Invalid path.');
    if (Object.hasOwn(args, 'expectedContent') && args.expectedContent !== null && typeof args.expectedContent !== 'string') fail('Invalid expected content.');
    for (const key of ['content', 'expectedContent']) if (typeof args[key] === 'string' && Buffer.byteLength(args[key]) > MAX_FILE) fail('File content exceeds 1 MiB.');
    for (const [key, min, max] of [['offset', 0, MAX_FILE], ['limit', 1, MAX_OUTPUT], ['timeoutSeconds', 1, 120]] as const) if (Object.hasOwn(args, key) && (!Number.isInteger(args[key]) || (args[key] as number) < min || (args[key] as number) > max)) fail('Invalid numeric argument.');
    if (typeof args.query === 'string' && (!args.query || args.query.length > 1024)) fail('Invalid search query.');
    if (typeof args.command === 'string' && (!args.command.trim() || args.command.length > 16384 || args.command.includes('\0'))) fail('Invalid command.');
    return args;
}
function inside(root: string, target: string) { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); }
function validateName(value: string) {
    if (value.includes('\0')) fail('Invalid path.');
    const segments = value.replace(/\\/g, '/').split('/');
    for (const segment of segments) {
        if (segment === '..') fail('Path traversal is not allowed.');
        if (!segment || segment === '.' || /^[A-Za-z]:$/.test(segment)) continue;
        if (/[<>:"|?*]/.test(segment) || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) fail('Unsafe Windows path name.');
    }
}
async function inspect(target: string, missingLeaf = false, write = false) {
    const parsed = path.parse(target);
    let cursor = parsed.root;
    const parts = target.slice(parsed.root.length).split(path.sep).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
        cursor = path.join(cursor, parts[i]);
        let stat;
        try { stat = await lstat(cursor); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT' && missingLeaf && i === parts.length - 1) return;
            fail(`Path is unavailable${safeCode(error)}.`);
        }
        if (stat.isSymbolicLink()) fail('Symbolic links and reparse paths are not allowed.');
        if (i < parts.length - 1 && !stat.isDirectory()) fail('Parent directory is unavailable.');
        if (write && i === parts.length - 1 && stat.nlink > 1) fail('Hard-linked files cannot be edited.');
    }
}
async function resolveTarget(context: Context, input: string, write = false) {
    aborted(context);
    validateName(input);
    if (!context.directory || !path.isAbsolute(context.directory)) fail('An explicit absolute workspace is required.');
    const root = path.resolve(context.directory);
    await inspect(root);
    if (!(await lstat(root)).isDirectory() || path.resolve(await realpath(root)).toLowerCase() !== root.toLowerCase()) fail('Workspace must be a canonical directory.');
    const target = path.resolve(root, input);
    if (context.permissionMode !== 'bypass' && !inside(root, target)) fail('Path is outside the workspace.');
    await inspect(target, write, write);
    return target;
}
async function readText(target: string) {
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try { return await readHandleText(handle); } finally { await handle.close(); }
}
async function readHandleText(handle: FileHandle) {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_FILE) fail('Only text files up to 1 MiB are supported.');
        const buffer = Buffer.alloc(MAX_FILE + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_FILE) fail('File exceeds 1 MiB.');
        try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)); } catch { fail('File is not valid UTF-8 text.'); }
}
async function approval(context: Context, summary: string, target: string): Promise<boolean> {
    aborted(context);
    return new Promise((resolve, reject) => {
        const cancel = () => { context.signal.removeEventListener('abort', cancel); reject(new ToolFailure('Tool cancelled.')); };
        context.signal.addEventListener('abort', cancel, { once: true });
        Promise.resolve().then(() => { aborted(context); return context.approve(summary, target); }).then(value => { context.signal.removeEventListener('abort', cancel); resolve(value); }, error => { context.signal.removeEventListener('abort', cancel); reject(error); });
    });
}
async function authorize(context: Context, action: 'read' | 'edit' | 'execute', target: string, summary: string) {
    const decision = permissionDecision(context.permissionMode, action, true);
    if (decision === 'deny') fail('Permission mode denies this operation.');
    if ((decision === 'ask' || (action === 'execute' && context.permissionMode !== 'bypass')) && !await approval(context, summary, target)) fail('Operation approval denied.');
    aborted(context);
}
async function command(commandText: string, cwd: string, context: Context, timeout: number): Promise<{ content: string; isError?: boolean }> {
    if (process.platform !== 'win32') fail('Command execution requires Windows PowerShell.');
    return new Promise(resolve => {
        const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', commandText], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = Buffer.alloc(0);
        let stopped = '';
        let settled = false;
        const finish = (code: number | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer); clearTimeout(killWait); context.signal.removeEventListener('abort', cancel);
            resolve({ content: `${output.toString('utf8')}\n${stopped || `Exit code: ${code ?? 'unknown'}.`}\nUnsandboxed command: descendants may survive cancellation or completion; console-dependent applications are unsupported.`, isError: !!stopped || code !== 0 });
        };
        let killWait: ReturnType<typeof setTimeout> | undefined;
        const stop = (reason: string) => { if (stopped) return; stopped = reason; child.kill(); killWait = setTimeout(() => finish(null), 2000); };
        const cancel = () => stop('Command cancelled. Only the directly spawned PowerShell process was stopped.');
        const timer = setTimeout(() => stop('Command timeout. Only the directly spawned PowerShell process was stopped.'), timeout * 1000);
        context.signal.addEventListener('abort', cancel, { once: true });
        if (context.signal.aborted) cancel();
        const collect = (chunk: Buffer) => { const room = MAX_OUTPUT - output.length; output = Buffer.concat([output, chunk.subarray(0, Math.max(0, room))]); if (chunk.length > room) stop('Command output exceeded 64 KiB.'); };
        child.stdout.on('data', collect); child.stderr.on('data', collect);
        child.once('error', () => { stopped = 'Command could not start.'; finish(null); });
        child.once('close', finish);
    });
}
export async function executeWorkspaceTool(call: ToolCall, context: Context): Promise<{ content: string; isError?: boolean }> {
    let releaseWriteLock: (() => void) | undefined;
    try {
        const args = parse(call);
        const input = (args.path as string | undefined) ?? '.';
        let target = await resolveTarget(context, input, call.name === 'write_file');
        const action = call.name === 'write_file' ? 'edit' : call.name === 'run_command' ? 'execute' : 'read';
        await authorize(context, action, target, call.name === 'run_command' ? `执行以下未隔离命令（UNSANDBOXED）：可能访问工作区外内容（outside the workspace），也可能启动无法随任务可靠停止的子进程：\n${args.command}` : `${call.name}: ${target}`);
        if (call.name === 'write_file') releaseWriteLock = await acquireWriteLock(target, context);
        target = await resolveTarget(context, input, call.name === 'write_file');
        if (call.name === 'run_command') return await command(args.command as string, target, context, (args.timeoutSeconds as number | undefined) ?? 30);
        if (call.name === 'read_file') return { content: (await readText(target)).slice((args.offset as number | undefined) ?? 0, ((args.offset as number | undefined) ?? 0) + ((args.limit as number | undefined) ?? 16000)) };
        if (call.name === 'write_file') {
            const expected = args.expectedContent as string | null;
            aborted(context);
            const handle = await open(target, expected === null ? 'wx' : 'r+');
            let oldContent: string | null = null;
            let writeStarted = false;
            let failure: unknown;
            let owned: Awaited<ReturnType<FileHandle['stat']>> | undefined;
            try {
                owned = await handle.stat();
                await inspect(target, false, true);
                const stat = await handle.stat(); const current = await lstat(target);
                if (!stat.isFile() || stat.nlink > 1 || stat.size > MAX_FILE || stat.ino !== current.ino || stat.dev !== current.dev) fail('File changed or is unsafe to edit.');
                if (expected !== null) {
                    oldContent = await readHandleText(handle);
                    if (oldContent !== expected) fail('Overwrite conflict: file content changed.');
                }
                aborted(context);
                writeStarted = true;
                await handle.writeFile(args.content as string, 'utf8');
                await handle.truncate(Buffer.byteLength(args.content as string));
                await handle.sync();
            } catch (error) { failure = error; }
            finally { await handle.close(); }
            if (failure) {
                if (!writeStarted && expected === null) {
                    try {
                        await inspect(target, false, true);
                        const current = await lstat(target);
                        if (owned && current.dev === owned.dev && current.ino === owned.ino && current.size === 0 && path.resolve(await realpath(target)).toLowerCase() === target.toLowerCase()) await unlink(target);
                        else fail('An empty file may remain after cancellation; verify it before retrying.');
                    } catch { fail('Write did not start, but owned empty-file cleanup could not be verified. Inspect the target before retrying.'); }
                }
                if (writeStarted) {
                    let snapshotWarning = '';
                    try { context.onArtifact?.({ path: target, oldContent, newContent: await readText(target) }); } catch { snapshotWarning = ' Snapshot persistence also failed.'; }
                    fail(`Write failed${safeCode(failure)} after modification began; the file may be partially changed. Inspect it before retrying.${snapshotWarning}`);
                }
                throw failure;
            }
            try { context.onArtifact?.({ path: target, oldContent, newContent: args.content as string }); }
            catch { return { content: 'File written, but snapshot persistence failed. The edit is already applied; do not retry it automatically.' }; }
            return { content: 'File written.' };
        }
        const lines: string[] = [];
        let files = 0; let bytes = 0; let truncated = false;
        const walk = async (directory: string, depth: number): Promise<void> => {
            const entries = await opendir(directory);
            for await (const entry of entries) {
                aborted(context);
                if (++files > 500 || bytes > 8 * MAX_FILE || lines.join('\n').length >= 32000) { truncated = true; break; }
                const full = path.join(directory, entry.name);
                const relative = path.relative(target, full);
                if (entry.isSymbolicLink()) continue;
                await inspect(full);
                if (call.name === 'list_directory') { lines.push(`${entry.isDirectory() ? 'directory' : 'file'} ${relative}`); continue; }
                if (entry.isDirectory()) { if (depth < 6) await walk(full, depth + 1); else truncated = true; }
                else if (entry.isFile()) {
                    const stat = await lstat(full); bytes += stat.size;
                    if (stat.size > MAX_FILE || bytes > 8 * MAX_FILE) { truncated = true; continue; }
                    let text: string; try { text = await readText(full); } catch { continue; }
                    let number = 0;
                    for (const line of text.split('\n')) { number++; if (line.includes(args.query as string)) lines.push(`${relative}:${number}: ${line.slice(0, 400)}`); if (lines.length >= 100 || lines.join('\n').length >= 32000) { truncated = true; break; } }
                }
                if (lines.length >= 100 && call.name === 'search_files') break;
            }
        };
        await walk(target, 0);
        return { content: lines.join('\n').slice(0, 32000) + (truncated ? '\n[Results truncated]' : '') };
    } catch (error) {
        return { content: error instanceof ToolFailure ? error.message : `${Object.hasOwn(schemas, call.name) ? call.name : 'Tool'} operation failed${safeCode(error)}; no diagnostic file contents are exposed.`, isError: true };
    } finally { releaseWriteLock?.(); }
}
