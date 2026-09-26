import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..', '..');
const helperPath = path.join(
    repoRoot,
    'native',
    'UAH.NativeHelper',
    'bin',
    'Release',
    'net10.0-windows',
    'UAH.NativeHelper.exe'
);

const child = spawn(helperPath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });

child.stdin.end([
    JSON.stringify({ id: 'caps', method: 'capabilities' }),
    '{bad json',
    JSON.stringify({ id: 'unknown', method: 'not-a-method' }),
    'x'.repeat(65_537),
    JSON.stringify({ id: 'stop', method: 'shutdown' })
].join('\n') + '\n');

const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
});

assert.equal(exitCode, 0, `helper exit code; stderr: ${stderr}`);
const responses = stdout.trimEnd().split(/\r?\n/).map((line) => JSON.parse(line));
assert.equal(responses.length, 5, `expected five protocol responses; stdout: ${stdout}`);
assert.deepEqual(responses[0], {
    id: 'caps',
    result: {
        platform: 'windows',
        observation: true,
        actions: false,
        processGroups: false
    }
});
assert.deepEqual(responses[1], { id: null, error: 'Input is not valid JSON.' });
assert.deepEqual(responses[2], { id: 'unknown', error: "Unknown method 'not-a-method'." });
assert.deepEqual(responses[3], { id: null, error: 'Input line exceeds the 65536-character limit.' });
assert.deepEqual(responses[4], { id: 'stop', result: { shutdown: true } });

const eofChild = spawn(helperPath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let eofOutput = '';
eofChild.stdout.setEncoding('utf8');
eofChild.stdout.on('data', (chunk) => { eofOutput += chunk; });
eofChild.stdin.end();
const eofCode = await new Promise((resolve, reject) => {
    eofChild.once('error', reject);
    eofChild.once('close', (code) => resolve(code));
});
assert.equal(eofCode, 0, 'EOF should exit successfully');
assert.equal(eofOutput, '', 'EOF should not produce a response');

process.stdout.write('Native helper JSON Lines protocol checks passed.\n');
