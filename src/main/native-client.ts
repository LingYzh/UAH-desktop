import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

export class NativeClient {
    private child: ChildProcessWithoutNullStreams | null = null;

    constructor(private executable: string) {}

    observe(): Promise<unknown> {
        if (process.platform !== 'win32') return Promise.reject(new Error('桌面观察目前仅支持 Windows。'));
        if (!existsSync(this.executable)) return Promise.reject(new Error('原生观察组件尚未构建，请运行 npm run build:native。'));
        if (this.child) return Promise.reject(new Error('上一次桌面观察尚未结束。'));
        const child = spawn(this.executable, [], { windowsHide: true, stdio: 'pipe' });
        this.child = child;
        return new Promise((resolve, reject) => {
            const id = randomUUID();
            let buffer = '';
            let size = 0;
            let response: { result?: unknown; error?: unknown } | null = null;
            const timer = setTimeout(() => {
                // shutdown and EOF were already sent after the observation request.
                reject(new Error('桌面观察超时，已请求组件退出。'));
            }, 10000);
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk) => {
                size += Buffer.byteLength(chunk, 'utf8');
                if (size > 65536) {
                    reject(new Error('原生观察响应过大。'));
                    return;
                }
                buffer += chunk;
                let newline;
                while ((newline = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, newline);
                    buffer = buffer.slice(newline + 1);
                    try {
                        const message = JSON.parse(line);
                        if (message.id === id) response = message;
                    } catch { reject(new Error('原生组件返回了无效响应。')); }
                }
            });
            child.stderr.resume();
            child.stdin.on('error', () => {});
            child.once('error', () => { clearTimeout(timer); this.child = null; reject(new Error('无法启动原生观察组件。')); });
            child.once('close', (code) => {
                clearTimeout(timer);
                this.child = null;
                if (code !== 0 || !response || response.error) reject(new Error('当前窗口无法被观察，或原生组件报告错误。'));
                else resolve(response.result);
            });
            child.stdin.end([
                JSON.stringify({ id, method: 'observe-foreground' }),
                JSON.stringify({ id: randomUUID(), method: 'shutdown' }), ''
            ].join('\n'));
        });
    }

    async shutdown() {
        const child = this.child;
        if (!child) return;
        if (!child.stdin.writableEnded) child.stdin.end(JSON.stringify({ id: randomUUID(), method: 'shutdown' }) + '\n');
        await Promise.race([
            new Promise<void>((resolve) => child.once('close', () => resolve())),
            new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('原生组件未确认退出，请等待当前观察结束。')), 5000))
        ]);
    }
}
