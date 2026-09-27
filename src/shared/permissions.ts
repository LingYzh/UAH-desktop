export type PermissionMode = 'manual' | 'plan' | 'readonly' | 'accept-edits' | 'auto' | 'bypass';
export const permissionModes: readonly PermissionMode[] = ['manual', 'accept-edits', 'plan', 'readonly', 'auto', 'bypass'];

export function parsePermissionMode(value: unknown): PermissionMode {
    if (typeof value !== 'string' || !permissionModes.includes(value as PermissionMode)) throw new Error('会话权限模式无效。');
    return value as PermissionMode;
}
export function permissionDecision(mode: PermissionMode, action: 'read' | 'edit' | 'execute', insideWorkspace: boolean): 'allow' | 'ask' | 'deny' {
    if (!permissionModes.includes(mode) || !['read', 'edit', 'execute'].includes(action)) return 'deny';
    if (mode === 'bypass') return 'allow';
    if (!insideWorkspace) return 'deny';
    if (action === 'read') return 'allow';
    if (mode === 'readonly' || mode === 'plan') return 'deny';
    if (mode === 'manual' || (mode === 'accept-edits' && action === 'execute')) return 'ask';
    return 'allow';
}
export function permissionIsSubset(child: PermissionMode, parent: PermissionMode): boolean {
    if (!permissionModes.includes(child) || !permissionModes.includes(parent)) return false;
    const weight = { deny: 0, ask: 1, allow: 2 };
    return [true, false].every(inside => (['read', 'edit', 'execute'] as const).every(action => weight[permissionDecision(child, action, inside)] <= weight[permissionDecision(parent, action, inside)]));
}
