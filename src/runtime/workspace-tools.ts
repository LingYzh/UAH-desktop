import { constants } from 'node:fs';
import { lstat, realpath, open, opendir, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { pathToFileURL } from 'node:url';
import { decodeFileBytes, encodeFileText, rawFileHash } from './file-codec.js';
import { beginToolOutcome, textHash } from './tool-outcome.js';
import type { ToolOutcome } from '../shared/harness-contracts.js';
import { permissionDecision, type PermissionMode } from '../shared/permissions.js';
import type { ToolDefinition, ToolCall } from '../shared/tool-protocol.js';

const MAX_FILE = 1024 * 1024;
const MAX_OUTPUT = 64 * 1024;
const MAX_RANGE_FILE = 16 * MAX_FILE;
interface Context {
    directory: string | null;
    permissionMode: PermissionMode;
    signal: AbortSignal;
    approve: (summary: string, path: string) => Promise<boolean>;
    /** Host owns the lease until durable result recording; workspace tools never release it. */
    acquireResource?: (mode: 'read' | 'write') => Promise<void>;
    /** Synchronous durable dispatch boundary, after approval and path revalidation. */
    beforeDispatch?: () => void;
    commandRunner?: (command: string, cwd: string, timeoutSeconds: number, outcome: ToolOutcome) => Promise<{ content: string; isError?: boolean }>;
    onArtifact?: (change: { path: string; oldContent: string | null; newContent: string }) => void | Promise<void>;
}
class ToolFailure extends Error {
    constructor(message: string, readonly code = 'TOOL_FAILED', readonly status: ToolOutcome['status'] = 'failed') { super(message); }
}
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
            reject(new ToolFailure('Tool cancelled while waiting for another write.', 'CANCELLED', 'cancelled'));
        } };
        queue.push(waiter);
        context.signal.addEventListener('abort', waiter.cancel, { once: true });
        if (context.signal.aborted) waiter.cancel();
    });
}
function safeCode(error: unknown): string { const code = (error as NodeJS.ErrnoException | undefined)?.code; return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? ` (${code})` : ''; }
function fail(message: string, code = 'TOOL_FAILED', status: ToolOutcome['status'] = 'failed'): never { throw new ToolFailure(message, code, status); }
function aborted(context: Context) { if (context.signal.aborted) fail('Tool cancelled.', 'CANCELLED', 'cancelled'); }
const pathDescription = '路径字符串，1–4096 个 UTF-16 代码单元；相对路径基于已选工作目录，也可用绝对路径。禁止 ..、符号链接/重解析路径及不安全 Windows 名称；除 bypass 外必须在工作区内。';
const schemas: Record<string, { fields: string[]; required: string[]; properties: Record<string, unknown> }> = {
    read_file: { fields: ['path', 'offset', 'limit'], required: ['path'], properties: {
        path: { type: 'string', description: `${pathDescription} 必填，目标必须是现有文件。` },
        offset: { type: 'integer', minimum: 0, maximum: MAX_FILE, description: '可选，0–1048576，默认 0。解码后字符串的 UTF-16 起始索引，不是字节或行号；超过结尾返回空字符串。' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_OUTPUT, description: '可选，1–65536，默认 16000；最多返回的 UTF-16 代码单元数。' },
    } },
    read_file_range: { fields: ['path', 'offset', 'limit', 'expectedHash'], required: ['path'], properties: {
        path: { type: 'string', description: `${pathDescription} 必填，最多16 MiB有效UTF-8或UTF-8 BOM文件；不猜测其他编码。` },
        offset: { type: 'integer', minimum: 0, maximum: MAX_RANGE_FILE, description: '可选，默认0，UTF-16索引，0–16777216；非零必须带expectedHash；不能从低代理代码单元开始。' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_OUTPUT, description: '可选，默认16000，1–65536 UTF-16代码单元；不拆代理对，limit为1遇emoji可返回2个代码单元。' },
        expectedHash: { type: 'string', pattern: '^[a-fA-F0-9]{64}$', description: '可选，原始文件字节SHA-256的64位十六进制；非零offset必填，每次核对，漂移时拒绝。' },
    } },
    apply_patch: { fields: ['path', 'expectedHash', 'edits'], required: ['path', 'expectedHash', 'edits'], properties: {
        path: { type: 'string', description: `${pathDescription} 必填，现有普通文件，不新建文件；禁止硬链接修改。` },
        expectedHash: { type: 'string', pattern: '^[a-fA-F0-9]{64}$', description: '必填，原始字节SHA-256的64位十六进制；锁内核对完整文件，最多1 MiB。' },
        edits: { type: 'array', minItems: 1, maxItems: 32, description: '必填，1–32项顺序替换；oldText非空且在累计文本中恰好匹配一次；所有oldText/newText UTF-8合计最多1 MiB，全部校验后一次写入。', items: { type: 'object', additionalProperties: false, required: ['oldText', 'newText'], properties: { oldText: { type: 'string', minLength: 1 }, newText: { type: 'string' } } } },
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
        command: { type: 'string', minLength: 1, maxLength: 8192, description: '必填，非空白 PowerShell 命令，最多 8192 个 UTF-16 代码单元，不得含 NUL。以 UTF-16LE Base64 传入 -EncodedCommand；不是 CMD、Bash 或交互式输入。' },
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: 120, description: '可选，1–120 秒，默认 30。超时通过独立 Windows Job 后端终止受控进程树；工具必须取得树退出及输出排空证据，未确认则失败并要求核对副作用。' },
    } },
};
const commonDescription = '必须先选择显式、规范的绝对工作目录；无目录会失败，即使 bypass 也不例外。参数必须是 JSON 对象，只允许列出的字段。工具结果正文按各工具说明返回文本或 JSON 对象；失败正文会说明原因。部分协议另有错误标记，不能只凭有返回值就认定成功。遇到错误先核对路径、权限和结果，不要原样盲目重试。';
const descriptions: Record<string, string> = {
    read_file: `${commonDescription} 用于查看现有 UTF-8 普通文件，整个文件必须有效 UTF-8 且不超过 1 MiB；读取无需审批。返回所选字符串片段，无截断标记；用 offset/limit 分段，注意 UTF-16 切片可能分开代理对。覆盖文件前须取得完整内容，不能把片段作为 expectedContent。示例：{"path":"src/app.ts","offset":0,"limit":16000}`,
    read_file_range: `${commonDescription} 返回JSON {text,offset,offsetUnit:"utf16",nextOffset,totalCharacters,fileHash,encoding,truncated}；fileHash是原始字节SHA-256，encoding为utf8或utf8-bom，text不含BOM；nextOffset为下一页索引或null，truncated表示仍有尾页。非零offset必须expectedHash；终点代理对向前调整，limit1遇emoji返回完整pair（最多limit+1）。读取无需审批；无效UTF-8明确拒绝。示例：{"path":"src/app.ts","limit":16000}`,
    apply_patch: `${commonDescription} 对现有最多1 MiB有效UTF-8或UTF-8 BOM文件按序唯一匹配替换，保留BOM和未编辑换行。不新建文件；manual审批，plan/readonly拒绝。原始字节hash冲突、零匹配或重复匹配均不写入。共享write_file的锁、路径复查和flush语义；写入失败可能部分修改，快照失败不能自动重试；不是可回滚事务。成功返回 "File written."。示例：{"path":"src/app.ts","expectedHash":"${textHash('// TODO fixture\n')}","edits":[{"oldText":"TODO","newText":"DONE"}]}`,
    list_directory: `${commonDescription} 用于发现目录中的直接子项，不递归、不保证排序，跳过符号链接，读取无需审批。每行是 "directory 相对路径" 或 "file 相对路径"，相对于所列目录；空目录返回空文本。最多检查 500 项，文本最多 32000 个 UTF-16 代码单元，受限时追加 [Results truncated]；可改列子目录缩小范围。示例：{"path":"src"}`,
    search_files: `${commonDescription} 用于在目录树内查找字面文本，读取无需审批。返回 "相对路径:从1开始的行号: 行文本"，行文本最多 400 个 UTF-16 代码单元；无匹配返回空文本。跳过符号链接及不可读/无效 UTF-8 文件；单文件上限1 MiB，累计检查文件字节上限8 MiB，最多500个目录项、100条匹配，递归进入至第6层，结果文本最多32000个 UTF-16 代码单元。受限时追加 [Results truncated]，缩小 path 或 query 再查；不是全库无遗漏索引。示例：{"path":"src","query":"TODO"}`,
    write_file: `${commonDescription} 用于创建或整文件替换 UTF-8 文本；不创建父目录。manual 要求用户审批，plan/readonly 拒绝，accept-edits/auto/bypass 可直接写。覆盖前核对完整 expectedContent；冲突先重新读取并重新决定修改，不能直接重试旧内容。成功返回 "File written." 并记录变更快照；若提示快照失败，写入已发生，不能自动重写。写入中失败可能部分修改，取消后也须按错误提示检查目标；不是可回滚事务。示例：{"path":"notes.txt","content":"hello\\n","expectedContent":null}`,
    run_command: `${commonDescription} 仅Windows可用，必须注入独立 Windows Job 执行后端；后端不可用会失败，无直接 spawn 回退。工作目录为已选目录；使用 SystemRoot（默认 C:\\Windows）下 System32/WindowsPowerShell/v1.0/powershell.exe，参数 -NoProfile -NonInteractive -EncodedCommand，命令按 UTF-16LE Base64 编码；不保证 PowerShell 7。plan/readonly 拒绝；其他模式均须用户审批，唯 bypass 无审批。Job 管理进程生命周期，不是 sandbox；命令未隔离，可访问工作区外和产生副作用。stdin关闭，不支持交互或依赖控制台的程序。stdout/stderr 分别保存完整 raw 字节 artifact，合计最多16 MiB输出配额；正文仅提供合计最多65536字节的UTF-8预览，预览截断不会停止进程。返回退出码、executionId及树退出/输出排空证据；非零退出码、取消、超时、配额耗尽或证据缺失表示失败。输出artifact记录失败单独标记，命令副作用仍可能已发生；核实后再决定重试。示例：{"command":"Get-Location","timeoutSeconds":30}`,
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
    for (const [key, min, max] of [['offset', 0, call.name === 'read_file_range' ? MAX_RANGE_FILE : MAX_FILE], ['limit', 1, MAX_OUTPUT], ['timeoutSeconds', 1, 120]] as const) if (Object.hasOwn(args, key) && (!Number.isInteger(args[key]) || (args[key] as number) < min || (args[key] as number) > max)) fail('Invalid numeric argument.');
    if (typeof args.query === 'string' && (!args.query || args.query.length > 1024)) fail('Invalid search query.');
    if (typeof args.command === 'string' && (!args.command.trim() || args.command.length > 8192 || args.command.includes('\0'))) fail('Invalid command.');
    if (Object.hasOwn(args, 'expectedHash') && (typeof args.expectedHash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(args.expectedHash))) fail('Invalid expected hash.');
    if (call.name === 'read_file_range' && (args.offset as number ?? 0) > 0 && !args.expectedHash) fail('Nonzero offset requires expectedHash.');
    if (call.name === 'apply_patch') {
        if (!Array.isArray(args.edits) || args.edits.length < 1 || args.edits.length > 32) fail('Invalid patch edits.');
        let bytes = 0;
        for (const edit of args.edits) {
            if (!edit || typeof edit !== 'object' || Array.isArray(edit) || Object.keys(edit).some(key => !['oldText', 'newText'].includes(key)) || typeof edit.oldText !== 'string' || !edit.oldText || typeof edit.newText !== 'string') fail('Invalid patch edit.');
            bytes += Buffer.byteLength(edit.oldText) + Buffer.byteLength(edit.newText);
        }
        if (bytes > MAX_FILE) fail('Patch edit fields exceed 1 MiB.');
    }
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
function isLow(code: number) { return code >= 0xdc00 && code <= 0xdfff; }
function decodeStrict(bytes: Buffer) {
    try { return decodeFileBytes(bytes); } catch { fail('File is not valid UTF-8 or UTF-8 BOM text; other encodings are unsupported.', 'UNSUPPORTED_ENCODING'); }
}
async function readHandleBytes(handle: FileHandle, maximum: number, context: Context): Promise<Buffer> {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) fail(`Only text files up to ${maximum / MAX_FILE} MiB are supported.`);
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
        aborted(context);
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
    }
    if (length > maximum) fail('File exceeds the byte limit.');
    aborted(context);
    return buffer.subarray(0, length);
}
async function readBytes(target: string, maximum: number, context: Context): Promise<Buffer> {
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
        await inspect(target);
        const owned = await handle.stat(); const current = await lstat(target);
        if (owned.dev !== current.dev || owned.ino !== current.ino) fail('File changed while opening.', 'READ_CONFLICT');
        const bytes = await readHandleBytes(handle, maximum, context);
        await inspect(target);
        const after = await lstat(target);
        if (owned.dev !== after.dev || owned.ino !== after.ino) fail('File changed while reading.', 'READ_CONFLICT');
        return bytes;
    } finally { await handle.close(); }
}
async function approval(context: Context, summary: string, target: string): Promise<boolean> {
    aborted(context);
    return new Promise((resolve, reject) => {
        const cancel = () => { context.signal.removeEventListener('abort', cancel); reject(new ToolFailure('Tool cancelled.', 'CANCELLED', 'cancelled')); };
        context.signal.addEventListener('abort', cancel, { once: true });
        Promise.resolve().then(() => { aborted(context); return context.approve(summary, target); }).then(value => { context.signal.removeEventListener('abort', cancel); resolve(value); }, error => { context.signal.removeEventListener('abort', cancel); reject(error); });
    });
}
async function authorize(context: Context, action: 'read' | 'edit' | 'execute', target: string, summary: string) {
    const decision = permissionDecision(context.permissionMode, action, true);
    if (decision === 'deny') fail('Permission mode denies this operation.', 'PERMISSION_DENIED', 'denied');
    if ((decision === 'ask' || (action === 'execute' && context.permissionMode !== 'bypass')) && !await approval(context, summary, target)) fail('Operation approval denied.', 'APPROVAL_DENIED', 'denied');
    aborted(context);
}
export async function executeWorkspaceTool(call: ToolCall, context: Context): Promise<{ content: string; isError?: boolean; outcome: ToolOutcome }> {
    const { outcome, finish } = beginToolOutcome();
    let releaseWriteLock: (() => void) | undefined;
    try {
        const args = parse(call);
        const input = (args.path as string | undefined) ?? '.';
        let target = await resolveTarget(context, input, (call.name === 'write_file' || call.name === 'apply_patch'));
        const action = (call.name === 'write_file' || call.name === 'apply_patch') ? 'edit' : call.name === 'run_command' ? 'execute' : 'read';
        await authorize(context, action, target, call.name === 'run_command' ? `执行以下未隔离命令（UNSANDBOXED）：可能访问工作区外内容（outside the workspace）；Windows Job 后端管理受控进程树，不提供权限隔离：\n${args.command}` : `${call.name}: ${target}`);
        try { await context.acquireResource?.(action === 'read' ? 'read' : 'write'); }
        catch (error) { aborted(context); throw error; }
        aborted(context);
        if ((call.name === 'write_file' || call.name === 'apply_patch')) releaseWriteLock = await acquireWriteLock(target, context);
        target = await resolveTarget(context, input, (call.name === 'write_file' || call.name === 'apply_patch'));
        context.beforeDispatch?.();
        if (call.name === 'run_command') {
            if (!context.commandRunner) fail('Managed execution backend is unavailable.', 'EXECUTION_BACKEND_UNAVAILABLE');
            return finish(await context.commandRunner(args.command as string, target, (args.timeoutSeconds as number | undefined) ?? 30, outcome));
        }
        if (call.name === 'read_file') {
            const text = await readText(target);
            const offset = (args.offset as number | undefined) ?? 0;
            const limit = (args.limit as number | undefined) ?? 16000;
            outcome.resources.push({ uri: pathToFileURL(target).href, beforeHash: textHash(text), afterHash: textHash(text) });
            outcome.truncation = { truncated: offset > 0 || offset + limit < text.length, reason: offset > 0 || offset + limit < text.length ? 'requested_range' : null };
            return finish({ content: text.slice(offset, offset + limit) });
        }
        if (call.name === 'read_file_range') {
            const raw = await readBytes(target, MAX_RANGE_FILE, context);
            const fileHash = rawFileHash(raw);
            outcome.resources.push({ uri: pathToFileURL(target).href, beforeHash: fileHash, afterHash: fileHash, hashKind: 'raw_bytes' });
            if (args.expectedHash && fileHash !== (args.expectedHash as string).toLowerCase()) fail('Read conflict: file bytes changed.', 'READ_CONFLICT');
            const { text, encoding } = decodeStrict(raw);
            const offset = (args.offset as number | undefined) ?? 0;
            if (offset > text.length) fail('Offset exceeds file characters.');
            if (offset < text.length && isLow(text.charCodeAt(offset))) fail('Offset splits a surrogate pair.');
            const limit = (args.limit as number | undefined) ?? 16000;
            let end = Math.min(text.length, offset + limit);
            if (end < text.length && isLow(text.charCodeAt(end))) end = end - offset === 1 ? end + 1 : end - 1;
            const truncated = end < text.length;
            outcome.truncation = { truncated: offset > 0 || truncated, reason: offset > 0 || truncated ? 'requested_range' : null };
            aborted(context);
            return finish({ content: JSON.stringify({ text: text.slice(offset, end), offset, offsetUnit: 'utf16', nextOffset: truncated ? end : null, totalCharacters: text.length, fileHash, encoding, truncated }) });
        }
        if ((call.name === 'write_file' || call.name === 'apply_patch')) {
            const patch = call.name === 'apply_patch';
            const expected = patch ? '' : args.expectedContent as string | null;
            let newContent = args.content as string;
            let writeValue: string | Buffer = newContent;
            aborted(context);
            const handle = await open(target, expected === null ? 'wx' : 'r+');
            const resource = { uri: pathToFileURL(target).href, beforeHash: null as string | null, afterHash: null as string | null, hashKind: patch ? 'raw_bytes' as const : 'utf8_text' as const };
            outcome.resources.push(resource);
            if (expected === null) { outcome.effectState = 'possible'; outcome.retryClass = 'reconcile_first'; }
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
                    if (patch) {
                        const raw = await readHandleBytes(handle, MAX_FILE, context);
                        resource.beforeHash = rawFileHash(raw);
                        if (resource.beforeHash !== (args.expectedHash as string).toLowerCase()) fail('Patch conflict: file bytes changed.', 'WRITE_CONFLICT');
                        const decoded = decodeStrict(raw);
                        oldContent = decoded.text; newContent = oldContent;
                        for (const edit of args.edits as { oldText: string; newText: string }[]) {
                            const index = newContent.indexOf(edit.oldText);
                            if (index < 0 || newContent.indexOf(edit.oldText, index + 1) >= 0) fail('Patch text must match exactly once.', 'PATCH_CONFLICT');
                            newContent = newContent.slice(0, index) + edit.newText + newContent.slice(index + edit.oldText.length);
                        }
                        writeValue = encodeFileText(newContent, decoded.encoding);
                        if (writeValue.length > MAX_FILE) fail('Patched file exceeds 1 MiB.');
                        if (decodeStrict(writeValue).text !== newContent) fail('Patch contains invalid Unicode text.');
                    } else {
                        oldContent = await readHandleText(handle);
                        resource.beforeHash = textHash(oldContent);
                        if (oldContent !== expected) fail('Overwrite conflict: file content changed.', 'WRITE_CONFLICT');
                    }
                }
                aborted(context);
                await inspect(target, false, true);
                const finalIdentity = await lstat(target);
                if (owned.dev !== finalIdentity.dev || owned.ino !== finalIdentity.ino) fail('File changed before writing.', 'WRITE_CONFLICT');
                writeStarted = true;
                outcome.effectState = 'possible'; outcome.retryClass = 'reconcile_first';
                await handle.writeFile(writeValue, 'utf8');
                await handle.truncate(Buffer.byteLength(writeValue));
                await handle.sync();
                outcome.effectState = 'confirmed'; resource.afterHash = patch ? rawFileHash(writeValue as Buffer) : textHash(newContent);
            } catch (error) { failure = error; }
            finally { try { await handle.close(); } catch (error) { failure ??= error; } }
            if (failure) {
                if (!writeStarted && expected === null) {
                    try {
                        await inspect(target, false, true);
                        const current = await lstat(target);
                        if (owned && current.dev === owned.dev && current.ino === owned.ino && current.size === 0 && path.resolve(await realpath(target)).toLowerCase() === target.toLowerCase()) {
                            await unlink(target);
                            try { await lstat(target); fail('Cleanup could not be verified.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
                            outcome.effectState = 'reconciled'; outcome.retryClass = 'safe';
                        }
                        else fail('An empty file may remain after cancellation; verify it before retrying.');
                    } catch { fail('Write did not start, but owned empty-file cleanup could not be verified. Inspect the target before retrying.'); }
                }
                if (writeStarted) {
                    let snapshotWarning = '';
                    try {
                        const raw = patch ? await readBytes(target, MAX_FILE, context) : null;
                        if (raw) resource.afterHash = rawFileHash(raw);
                        const currentContent = raw ? decodeStrict(raw).text : await readText(target);
                        resource.afterHash = raw ? rawFileHash(raw) : textHash(currentContent);
                        if (context.onArtifact) { await context.onArtifact({ path: target, oldContent, newContent: currentContent }); outcome.recordingState = 'durable'; }
                    } catch { if (context.onArtifact) { outcome.recordingState = 'failed'; snapshotWarning = ' Snapshot persistence also failed.'; } }
                    fail(`Write failed${safeCode(failure)} after modification began; the file may be partially changed. Inspect it before retrying.${snapshotWarning}`, 'WRITE_FAILED');
                }
                throw failure;
            }
            // D01 durable here acknowledges the file snapshot only; full tool journaling follows in D03.
            try { if (context.onArtifact) { await context.onArtifact({ path: target, oldContent, newContent }); outcome.recordingState = 'durable'; } }
            catch { outcome.recordingState = 'failed'; outcome.errorCode = 'RECORDING_FAILED'; return finish({ content: 'File written, but snapshot persistence failed. The edit is already applied; do not retry it automatically.', isError: true }); }
            return finish({ content: 'File written.' });
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
        outcome.truncation = { truncated, reason: truncated ? 'result_limit' : null };
        return finish({ content: lines.join('\n').slice(0, 32000) + (truncated ? '\n[Results truncated]' : '') });
    } catch (error) {
        outcome.status = error instanceof ToolFailure ? error.status : 'failed';
        outcome.errorCode = error instanceof ToolFailure ? error.code : 'TOOL_FAILED';
        return finish({ content: error instanceof ToolFailure ? error.message : `${Object.hasOwn(schemas, call.name) ? call.name : 'Tool'} operation failed${safeCode(error)}; no diagnostic file contents are exposed.`, isError: true });
    } finally { releaseWriteLock?.(); }
}
