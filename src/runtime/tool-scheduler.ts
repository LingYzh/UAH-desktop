export type ToolResourceMode = 'read' | 'write';

interface Waiter {
    mode: ToolResourceMode;
    signal: AbortSignal;
    grant: (release: () => void) => void;
    reject: (error: Error) => void;
    cancel: () => void;
}

/** One application-wide FIFO queue. Owners retain leases through durable result recording. */
export class ToolScheduler {
    private readonly queue: Waiter[] = [];
    private readers = 0;
    private writer = false;

    constructor(private readonly maxReaders = 4) {
        if (!Number.isSafeInteger(maxReaders) || maxReaders < 1) throw new Error('maxReaders must be a positive safe integer.');
    }

    acquire(mode: ToolResourceMode, signal: AbortSignal): Promise<() => void> {
        if (mode !== 'read' && mode !== 'write') return Promise.reject(new Error('Invalid tool resource mode.'));
        if (signal.aborted) return Promise.reject(this.cancelled());
        return new Promise((grant, reject) => {
            const waiter: Waiter = { mode, signal, grant, reject, cancel: () => {
                const index = this.queue.indexOf(waiter);
                if (index < 0) return; // Granted ownership is released only by its owner.
                this.queue.splice(index, 1);
                signal.removeEventListener('abort', waiter.cancel);
                reject(this.cancelled());
                this.drain();
            } };
            this.queue.push(waiter);
            signal.addEventListener('abort', waiter.cancel, { once: true });
            if (signal.aborted) waiter.cancel();
            else this.drain();
        });
    }

    private cancelled(): Error { return new DOMException('Tool resource request cancelled.', 'AbortError'); }

    private drain(): void {
        if (this.writer) return;
        while (this.queue.length) {
            const next = this.queue[0];
            if (next.mode === 'write' ? this.readers > 0 : this.readers >= this.maxReaders) return;
            this.queue.shift();
            next.signal.removeEventListener('abort', next.cancel);
            if (next.mode === 'write') this.writer = true;
            else this.readers++;
            let released = false;
            next.grant(() => {
                if (released) return;
                released = true;
                if (next.mode === 'write') this.writer = false;
                else this.readers--;
                this.drain();
            });
            if (this.writer) return;
        }
    }
}
