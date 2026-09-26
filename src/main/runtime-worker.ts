import { Supervisor } from '../runtime/supervisor';
import { parseCommand } from '../shared/contracts';

const parent = process.parentPort;
if (!parent || !process.argv[2]) throw new Error('Runtime must be launched by the desktop host.');
try {
    const supervisor = new Supervisor({
        dataDirectory: process.argv[2],
        onEvent: (event) => parent.postMessage({ kind: 'event', event })
    });
    let queue = Promise.resolve();
    let closing = false;
    parent.on('message', ({ data }) => {
        queue = queue.then(async () => {
            try {
                if (closing) throw new Error('运行进程正在退出。');
                if (data.kind === 'shutdown') {
                    closing = true;
                    await supervisor.shutdown();
                    parent.postMessage({ kind: 'reply', id: data.id });
                    setTimeout(() => process.exit(0), 50);
                } else if (data.kind === 'command') {
                    const snapshot = await supervisor.execute(parseCommand(data.command));
                    parent.postMessage({ kind: 'reply', id: data.id, snapshot });
                }
            } catch (error) {
                parent.postMessage({ kind: 'reply', id: data.id, error: error instanceof Error ? error.message : '运行请求失败。' });
            }
        });
    });
    parent.postMessage({ kind: 'ready' });
} catch (error) {
    parent.postMessage({ kind: 'fatal', error: error instanceof Error ? error.message : '运行进程初始化失败。' });
    process.exitCode = 1;
}
