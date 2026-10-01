export interface JournalPolicy { revision: number; captureRaw: boolean }
export type JournalPolicyCommand = { action: 'get' } | { action: 'set'; revision: number; captureRaw: boolean };
export function parseJournalPolicyCommand(value: unknown): JournalPolicyCommand {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('无效的日志设置。');
    for (const key of Reflect.ownKeys(value)) if (typeof key !== 'string' || !('value' in Object.getOwnPropertyDescriptor(value, key)!) || !Object.getOwnPropertyDescriptor(value, key)!.enumerable) throw new TypeError('无效的日志设置。');
    const item = value as Record<string, unknown>;
    if (item.action === 'get' && Reflect.ownKeys(item).length === 1) return { action: 'get' };
    if (item.action !== 'set' || Reflect.ownKeys(item).length !== 3 || typeof item.captureRaw !== 'boolean'
        || !Number.isSafeInteger(item.revision) || (item.revision as number) < 0) throw new TypeError('无效的日志设置。');
    return { action: 'set', revision: item.revision as number, captureRaw: item.captureRaw };
}
