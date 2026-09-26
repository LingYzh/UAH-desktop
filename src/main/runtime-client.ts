import { utilityProcess, type UtilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import type { Command, RuntimeEvent, Snapshot } from '../shared/contracts';

export class RuntimeClient {
    private child: UtilityProcess;
    private pending = new Map<string, { resolve: (value: Snapshot) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    private ready: Promise<void>;
    private exited: Promise<void>;
    private dead = false;

    constructor(workerPath: string, dataDirectory: string, onEvent: (event: RuntimeEvent) => void) {
        this.child = utilityProcess.fork(workerPath, [dataDirectory], { serviceName: 'UAH Runtime Supervisor', stdio: 'pipe' });
        // Never relay raw runtime stdout/stderr to the renderer.
        this.child.stdout?.resume();
        this.child.stderr?.resume();
        this.ready = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('运行进程启动超时。')), 15000);
            this.child.on('message', (message) => {
                if (message?.kind === 'ready') { clearTimeout(timer); resolve(); }
                if (message?.kind === 'fatal') { clearTimeout(timer); reject(new Error(message.error || '运行进程初始化失败。')); }
            });
            this.child.once('exit', () => { clearTimeout(timer); reject(new Error('运行进程已退出。')); });
        });
        // Attach immediately, including when startup fails before the first command.
        this.ready.catch(() => {});
        this.child.on('message', (message) => {
            if (message?.kind === 'event') onEvent(message.event);
            if (message?.kind !== 'reply') return;
            const request = this.pending.get(message.id);
            if (!request) return;
            clearTimeout(request.timer);
            this.pending.delete(message.id);
            if (message.error) request.reject(new Error(message.error));
            else request.resolve(message.snapshot);
        });
        this.exited = new Promise((resolve) => this.child.once('exit', () => {
            this.dead = true;
            for (const request of this.pending.values()) {
                clearTimeout(request.timer);
                request.reject(new Error('运行进程意外退出；重启后会将未完成任务标记为中止。'));
            }
            this.pending.clear();
            resolve();
        }));
    }

    async execute(command: Command): Promise<Snapshot> {
        await this.ready;
        return this.request({ kind: 'command', command });
    }

    private request(message: Record<string, unknown>): Promise<Snapshot> {
        if (this.dead) return Promise.reject(new Error('运行进程不可用。'));
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('运行进程未响应；请检查任务状态后再操作。'));
            }, 15000);
            this.pending.set(id, { resolve, reject, timer });
            this.child.postMessage({ ...message, id });
        });
    }

    async shutdown() {
        if (this.dead) return;
        await this.ready;
        await this.request({ kind: 'shutdown' });
        await Promise.race([
            this.exited,
            new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('运行进程尚未确认退出。')), 5000))
        ]);
    }
}
