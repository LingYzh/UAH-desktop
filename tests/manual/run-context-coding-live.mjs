import { build } from 'esbuild';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, '..', '..');
const artifactRoot = join(root, 'artifacts', 'context-coding-live');
const templateRoot = join(artifactRoot, 'project-template');
const snapshotRoot = join(root, 'artifacts', 'context-usage-live-probe-20261004', 'host-snapshot');
const source = join(scriptDirectory, 'context-coding-live.ts');
const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const files = new Map([
    ['PROJECT_BRIEF.md', `# CSV 工具项目\n\n从零实现一个小型 Node.js CSV 命令行工具。项目只依赖 Node.js 自带模块，使用 ESM 与 node:test，不安装依赖。请逐轮阅读规格、实现、补测试，并保留清楚的错误信息。\n\n## 用户目标\n\n工具名为 csvtool，核心模块负责解析和序列化 CSV；命令行支持查看摘要、选列、筛选记录。输入可来自 UTF-8 文件或标准输入，输出可写到文件或标准输出。列以第一条记录为表头；保留原始列顺序，除非 select 明确指定顺序。默认逗号分隔，文件最后一行可有或没有换行。\n\n## 实现边界\n\n项目需有 package.json、src/、tests/ 和 README。公开 API 保持小而清楚，命令行入口可直接用 node 执行。不要添加第三方包。CLI 错误写到 stderr 并返回非零退出码；成功摘要写到 stdout。任何失败都不能静默截断数据。\n\n## 编码与兼容\n\n接受 UTF-8 与 UTF-8 BOM。统一处理 LF、CRLF；输出使用 LF。保留空字符串、前后空格和 Unicode 字符。无表头、列数不一致、未闭合引号及非法命令均应得到可诊断错误。\n\n详细规则见 specs/csv-contract.md，命令和测试范围见 specs/acceptance-matrix.md。`],
    ['specs/csv-contract.md', `# CSV 行为契约\n\n本文是实现依据。若样例与本文表面不一致，先按本文规则判断，并在 README 记录清楚。\n\n## 1. 解析模型\n\n解析器输入一个完整 UTF-8 文本，返回记录数组；每条记录是字段字符串数组。解析器可以提供 headers 与 rows 的高层辅助函数，但底层必须保留字段内容，不做 trim、不推断数字/日期、不把空字段转成 null。第一条逻辑记录是表头。空文件返回专用错误；只有空白行的输入不能假装成合法的有表头表格。\n\n## 2. 分隔符、引用和记录结束\n\n默认分隔符是逗号。被引用字段以双引号开始和结束；字段内容中的双引号写成两个连续双引号。被引用字段中允许逗号、CR、LF 和组合换行，它们都是字段内容。引用字段结束后只能遇到分隔符、记录结束或输入末尾；其他字符属于格式错误。未引用字段中出现双引号属于格式错误。\n\nCRLF 是一个记录结束符；单独 LF 也是记录结束符。CRLF 中的 CR 不能残留在字段末尾。输入末尾恰好结束在记录结束符后时，不应生成额外空记录。输入末尾不是换行时仍要提交最后一个完整记录。空字段是两个相邻分隔符之间的零长度字符串；行尾分隔符代表最后一个空字段。\n\n状态机至少需要区分：字段起始、未引用字段、引用字段、引用字段中的候选结束引号。连续空格是数据。BOM 只允许出现在整份输入的第一个字符；后续 BOM 字符按普通数据保留。\n\n## 3. 表格形状与表头\n\n首条记录作为表头。表头名称按原文保留，包括大小写、空格和 Unicode；但空名称不允许。重复表头名称报错，并给出列名。数据行字段数必须与表头一致，错误需报告一基行号和预期/实际列数。行号按逻辑记录计数，引用字段内部换行不增加错误中的逻辑行号。\n\n辅助函数应返回 '{ headers, rows }'，其中 rows 为对象数组。对象应使用普通无原型数据对象或 null 原型对象，且不要把 '__proto__'、'constructor' 等输入表头解释为对象行为。若输出对象 API 不安全，可以只导出数组接口并由 CLI 自己映射。所有公开函数遇到无效分隔符、无效类型或损坏输入时必须抛出 Error 子类或稳定错误消息。\n\n## 4. 序列化\n\n序列化接收表头和记录，输出 UTF-8 可写字符串，不加 BOM。字段含分隔符、双引号、CR 或 LF 时必须用双引号包围；包围后将每个双引号重复一次。纯空字段可以输出为空字段。字段的空格不触发 trim，也不改变内容。记录以 LF 分隔，最后一条记录可有终止 LF，但同一 formatter 必须保持稳定选择。\n\n输入行必须与表头宽度相符；缺字段不能通过 stringify 隐式补空，超额字段也不能丢弃。所有字段必须先显式转成字符串，拒绝 null、undefined、对象和函数，避免意外生成 '[object Object]'。\n\n## 5. 命令行接口\n\n语法目标：'node src/cli.js <inspect|select|filter> [options] [file]'。帮助选项 '--help' 与 '-h' 在任何位置都显示用法并以 0 退出。未给 file 时从 stdin 读取；file 为 '-' 时也从 stdin 读取。输入文件采用 UTF-8 文本读取，输出不覆盖输入路径，除非用户明确给出不同 '--output' 路径；输入和输出解析到同一绝对路径时应报错。\n\n'inspect' 输出 JSON 摘要，至少包括记录数、列名、每列非空值数量和空值数量。JSON 键顺序稳定；不会把原始整份 CSV 写进摘要。\n\n'select --columns name,name2' 按用户给出的顺序输出这些列。列名精确匹配、区分大小写；未知列和重复列均报错。'--output path' 写结果；未给时输出标准输出。输出保留每行内容和选中列的顺序。\n\n'filter --column name --equals value' 保留完全相等的行；'--not-equals value' 保留不相等的行，两个比较开关互斥。匹配是精确字符串比较，空字符串可以作为 value。过滤结果仍包含原表头，即使没有记录匹配。列名精确匹配。\n\n参数重复、缺值、未知选项、多个输入文件、命令不完整或 flag 与子命令不匹配时均报错。选项值以独立 argv 项读取；不要使用 shell 拼接去执行字符串。\n\n## 6. 错误与退出码\n\n成功退出码为 0；用户输入或 CSV 语法错误为 2；文件读取/写入错误为 1。错误文本应简短说明原因，可带文件名或逻辑行号，不带堆栈。用法错误时可打印一行简短用法提示。stderr 与 stdout 分离。不要捕获后吞掉异常，也不要在失败时输出半截 JSON。\n\n## 7. 可维护性\n\n解析、序列化、摘要、过滤和参数解析分别保持可单测。命令行模块仅在作为入口直接执行时运行 main；导入模块不能意外退出进程。使用 node:path 与 node:fs。不要引入全局可变解析状态；同一解析器应可重复处理多个输入。错误对象可带 code/line/expected/actual 字段，但稳定行为要写测试。`],
    ['specs/acceptance-matrix.md', `# 验收矩阵\n\n宿主最终使用固定 'node --test' 执行项目测试。测试要使用临时目录或内存字符串，不修改仓库外的固定路径，不联网，不调用子进程。测试名要说明行为。\n\n## Parser\n\n覆盖普通表头和多行数据；含逗号字段；含双引号字段；转义双引号；引用字段内 CRLF/LF；行末无换行；CRLF 与 LF 混用；空字段、行尾空字段；BOM；Unicode（中文、emoji、组合字符）；空输入；空行输入；未闭合引号；引号后非法字符；未引用字段中引号；重复表头；空表头；字段数量过少和过多。引用字段里的换行不应改变逻辑记录计数。\n\n## Serializer\n\n覆盖只含普通字符、空值字符串、分隔符、双引号、LF、CRLF、前后空格、Unicode。验证 parse(stringify(table)) 与原表一致；也验证 stringify 的分隔符转义确实正确，而不只检查结果长度。拒绝 null/对象等非字符串字段和行宽错误。\n\n## CLI inspect\n\n对标题、数据行和不同列空值做精确计数；输出可解析 JSON；空输入和格式错误返回非零；帮助不需要文件；错误诊断不污染 stdout JSON。\n\n## CLI select\n\n默认顺序与指定顺序；一列和多列；未知列；重复列；无数据行；表头只有一列；字段值含逗号、换行和引号；输出文件与输入不同；同一路径覆盖保护。\n\n## CLI filter\n\n相等与不等；没有匹配记录；空字符串比较；未知列；比较选项冲突；值含空格、逗号和等号；表头只有一行；保留表头与原行序。\n\n## 输入、输出与参数\n\nstdin 输入、'-' 输入、文件输入；标准输出和 '--output'；不能把错误写进 CSV 内容；未知命令/选项；选项缺值；重复选项；多余位置参数；输出路径不可用。优先把文件读取/输出函数做成可替换的小函数，使测试不依赖宿主 shell。\n\n## 项目收尾\n\nREADME 给出 Node 版本前提、安装（无依赖）、三条命令示例、stdin 示例、错误/退出码和规格中有意保留的限制。执行 'node --test' 必须发现至少一个测试，且全部通过。不要为通过测试删除错误处理、跳过测试或缩小断言。\n\n## 样例记录\n\n fixtures/sample.csv 至少包含列名、普通值、空值、含逗号字段、含引号字段和 Unicode。若样例使用引用字段内换行，测试须断言其为同一记录。样例应可读并保持 LF 或 CRLF 一致。`],
    ['fixtures/sample.csv', 'name,status,note\nAda,active,"likes tea, coffee"\n李雷,inactive,"says ""hello"""\nMira,active,"first line\nsecond line"\nNoor,active,\n'],
]);

function ensureTemplate() {
    for (const [name, content] of files) {
        const path = join(templateRoot, name);
        mkdirSync(dirname(path), { recursive: true });
        if (!existsSync(path)) writeFileSync(path, content, { encoding: 'utf8', flag: 'wx' });
    }
}

function argsMap() {
    const result = new Map();
    for (const item of process.argv.slice(2)) {
        if (!item.startsWith('--')) continue;
        const equals = item.indexOf('=');
        if (equals < 0) result.set(item, '');
        else result.set(item.slice(0, equals), item.slice(equals + 1));
    }
    return result;
}

function copyPrivateSnapshot(userData) {
    mkdirSync(userData, { recursive: false });
    for (const name of ['endpoints.sqlite', 'Local State']) {
        const sourcePath = join(snapshotRoot, name);
        const targetPath = join(userData, name);
        const stat = lstatSync(sourcePath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('snapshot_unavailable');
        copyFileSync(sourcePath, targetPath, 1);
    }
}

function safelyRemoveClonedCredentials(userData, runRoot) {
    const rootPath = resolve(runRoot);
    if (resolve(userData) !== join(rootPath, 'userData')) throw new Error('unsafe_cleanup_target');
    for (const name of ['endpoints.sqlite', 'endpoints.sqlite-wal', 'endpoints.sqlite-shm', 'Local State']) {
        const target = join(userData, name);
        if (existsSync(target) && dirname(resolve(target)) === resolve(userData)) rmSync(target, { force: true });
    }
}

function readSafeChildLine(line, phase) {
    let value;
    try { value = JSON.parse(line); } catch { return undefined; }
    if (!value || value.type !== 'context-coding-live' || value.version !== 1 || value.phase !== phase) return undefined;
    const event = String(value.event ?? '');
    if (!['turn-started', 'turn-finished', 'host-tests', 'complete', 'failed'].includes(event)) return undefined;
    const safe = { type: value.type, version: 1, event, phase };
    for (const key of ['turn', 'totalTurns', 'turnsCompleted', 'exitCode', 'tests', 'passed', 'failed', 'modelRequests',
        'readCalls', 'writeCalls', 'patchCalls', 'testExitCode']) {
        if (Number.isSafeInteger(value[key])) safe[key] = value[key];
    }
    for (const key of ['requestThresholdMet', 'actualSupervisorRestartObserved']) {
        if (typeof value[key] === 'boolean') safe[key] = value[key];
    }
    if (['completed', 'failed', 'stopped'].includes(value.state)) safe.state = value.state;
    if (typeof value.failure === 'string' && /^[a-z0-9_]{1,64}$/.test(value.failure)) safe.failure = value.failure;
    return safe;
}

function runElectronPhase(bundle, phase, runRoot, endpointId, modelId, contextWindow) {
    return new Promise((resolveRun, rejectRun) => {
        const userData = join(runRoot, 'userData');
        const parameters = [bundle,
            `--phase=${phase}`,
            `--endpoint-id=${endpointId}`,
            `--model=${modelId}`,
            `--data-dir=${userData}`,
            `--workspace=${join(runRoot, 'workspace')}`,
            `--state-file=${join(runRoot, 'state.json')}`,
            `--report-file=${join(runRoot, 'report.json')}`,
            `--test-result-file=${join(runRoot, 'host-test-result.json')}`,
            `--node-exe=${process.execPath}`,
            ...(contextWindow ? [`--context-window=${contextWindow}`] : []),
        ];
        const childEnvironment = { ...process.env };
        delete childEnvironment.NODE_OPTIONS;
        const child = spawn(electron, parameters, { cwd: root, env: childEnvironment, windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'] });
        let output = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            output += chunk;
            if (output.length > 64_000) output = output.slice(-32_000);
            for (const line of output.split(/\r?\n/).slice(0, -1)) {
                const safe = readSafeChildLine(line, phase);
                if (safe) process.stdout.write(`${JSON.stringify(safe)}\n`);
            }
            output = output.split(/\r?\n/).at(-1) ?? '';
        });
        child.once('error', rejectRun);
        child.once('close', code => {
            const tail = readSafeChildLine(output, phase);
            if (tail) process.stdout.write(`${JSON.stringify(tail)}\n`);
            resolveRun(code ?? 1);
        });
    });
}

async function main() {
    ensureTemplate();
    mkdirSync(join(artifactRoot, 'build'), { recursive: true });
    const bundle = join(artifactRoot, 'build', `context-coding-live-${process.pid}.cjs`);
    await build({ entryPoints: [source], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node24',
        external: ['electron'], logLevel: 'silent' });
    const flags = argsMap();
    if (!flags.has('--arm-live')) {
        process.stdout.write(`${JSON.stringify({ type: 'context-coding-live-ready', liveCalls: false,
            templateFiles: files.size, userTurns: 8, minimumModelRequests: 20,
            restartAfterTurn: 4, hostAcceptanceCommand: 'node --test',
            sourceSnapshotPresent: ['endpoints.sqlite', 'Local State'].every(name => existsSync(join(snapshotRoot, name))),
            bundleReady: existsSync(bundle) })}\n`);
        return;
    }
    const endpointId = flags.get('--endpoint-id');
    const modelId = flags.get('--model');
    if (!endpointId || !modelId || endpointId.length > 200 || modelId.length > 200 || /[\u0000-\u001f]/.test(endpointId + modelId)) {
        throw new Error('live_requires_explicit_endpoint_and_model');
    }
    if (!existsSync(electron) || !['endpoints.sqlite', 'Local State'].every(name => existsSync(join(snapshotRoot, name)))) {
        throw new Error('electron_or_snapshot_unavailable');
    }
    const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    const resume = flags.get('--resume-run');
    if (resume && !/^\d{14}-[a-f0-9]{8}$/.test(resume)) throw new Error('invalid_resume_run');
    const runRoot = join(artifactRoot, 'runs', resume || runId);
    mkdirSync(dirname(runRoot), { recursive: true });
    if (!resume) mkdirSync(runRoot, { recursive: false });
    else if (!existsSync(join(runRoot, 'state.json'))) throw new Error('resume_state_missing');
    const workspace = join(runRoot, 'workspace');
    if (!resume) cpSync(templateRoot, workspace, { recursive: true, errorOnExist: true, force: false });
    for (const name of ['src', 'tests']) mkdirSync(join(workspace, name), { recursive: true });
    const userData = join(runRoot, 'userData');
    try {
        if (resume) {
            const oldReport = join(runRoot, 'report.json');
            if (existsSync(oldReport)) copyFileSync(oldReport, join(runRoot, `report-before-${Date.now()}.json`), 1);
            for (const name of ['endpoints.sqlite', 'Local State']) copyFileSync(join(snapshotRoot, name), join(userData, name), 1);
        } else copyPrivateSnapshot(userData);
        if (flags.has('--audit-only') && !resume) throw new Error('audit_requires_existing_run');
        const phases = flags.has('--audit-only') ? ['audit'] : resume && flags.get('--resume-phase') !== 'first' ? ['repair'] : ['first', 'middle', 'final'];
        for (const phase of phases) {
            const code = await runElectronPhase(bundle, phase, runRoot, endpointId, modelId, flags.get('--context-window'));
            if (code !== 0) throw new Error(`phase_${phase}_failed`);
        }
        const reportPath = join(runRoot, 'report.json');
        const report = JSON.parse(await (await import('node:fs/promises')).readFile(reportPath, 'utf8'));
        process.stdout.write(`${JSON.stringify({ type: 'context-coding-live-result', runId: resume || runId,
            protocol: report.endpoint.protocol, modelId: report.endpoint.modelId,
            turnsCompleted: report.turnsCompleted, modelRequests: report.modelRequests,
            requestThresholdMet: report.requestThresholdMet,
            actualSupervisorRestartObserved: report.actualSupervisorRestartObserved,
            tools: report.toolSummary.counts, hostTests: { tests: report.hostAcceptance.tests, passed: report.hostAcceptance.passed,
                failed: report.hostAcceptance.failed, exitCode: report.hostAcceptance.exitCode },
            acceptance: report.turnsCompleted >= 8 && report.requestThresholdMet && report.actualSupervisorRestartObserved
                && report.realReadWritePatchCallsObserved && report.hostAcceptance.exitCode === 0 && report.hostAcceptance.tests > 0 })}\n`);
        if (!(report.turnsCompleted >= 8 && report.requestThresholdMet && report.actualSupervisorRestartObserved
            && report.realReadWritePatchCallsObserved && report.hostAcceptance.exitCode === 0 && report.hostAcceptance.tests > 0)) process.exitCode = 1;
    } finally {
        safelyRemoveClonedCredentials(userData, runRoot);
    }
}

main().catch(error => {
    const code = error instanceof Error && /^[a-z0-9_]{1,64}$/.test(error.message) ? error.message : 'runner_failure';
    process.stdout.write(`${JSON.stringify({ type: 'context-coding-live-result', liveCallsStarted: true, failure: code })}\n`);
    process.exitCode = 1;
});
