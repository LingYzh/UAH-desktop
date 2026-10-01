import type { RunRecord } from '../shared/contracts';
import type { PromptContext } from '../shared/prompt-context';

/** Verified Git (read before each request), memory and MCP providers supply bounded snapshots.
 * Leave absent slots undefined to retain explicit unavailable/unknown fallback text.
 * I/O belongs to explicit host providers, never arbitrary instructions or repository code.
 */
export function runtimePromptContext(run: RunRecord, directory: string | null, toolNames: string[], providers?: Pick<PromptContext, 'GIT_STATUS_AND_TASK_CONTEXT' | 'MEMORY_CONTEXT'>): PromptContext {
    return {
        ...providers,
        ENVIRONMENT_CONTEXT: {
            harness: 'UAH', runId: run.id, parentRunId: run.parentRunId ?? null, platform: process.platform, directory,
            directoryStatus: directory === null ? '未选择工作目录' : '当前会话已选择的工作目录',
            modelId: run.effective.modelId, providerId: run.effective.endpointId ?? null,
            permissionMode: run.effective.permissionMode ?? 'manual',
            role: run.parentRunId ? 'subagent' : 'primary', depth: run.depth ?? 0,
            executionState: run.harnessState ?? 'legacy',
            taskTreeBudget: run.budgetState ?? '未分配；不能推断剩余额度',
            recovery: run.effective.runtimeId === 'api' && !run.parentRunId && run.effective.permissionMode !== 'plan' ? { resumeOfRunId: run.resumeOfRunId ?? null,
                policy: '续接由用户核对后显式发起，创建关联的新运行；保留历史预算消耗并追加额度。旧工具不自动重放，先前已执行动作必须以日志证据核对；用户核对不等于工具成功或目标已验证。' } : '当前运行不支持核对续接',
            goalVerification: {
                record: run.goalVerification ? { id: run.goalVerification.id, method: run.goalVerification.method, freshness: '本轮提示词未重新检查，不得当作当前有效证明' } : null,
                policy: '运行completed与目标验收分开。用户可在运行结束后独立检查并记录验收标准，宿主重新核对已有文件版本；验收仅覆盖记录的标准。模型回复、命令退出码0或子代理报告不能自动证明目标通过，未记录文件和外部系统不在自动核对范围。',
            },
            toolProgress: run.effective.runtimeId === 'api' ? {
                state: run.toolProgress ?? null,
                policy: '单轮累计6个失败工具批次或连续3个参数、错误、资源版本及结果证据相同的全失败批次后暂停。新的用户补充重置连续重复计数，不返还累计纠错额度；宿主不自动重执行工具。',
            } : '当前运行时未接入工具纠错计数',
            steering: run.effective.runtimeId === 'api' && !run.parentRunId && run.effective.permissionMode !== 'plan'
                ? '宿主可接收绑定当前步骤的补充指令；在安全边界作为用户消息加入，未派发的旧工具停止。已执行效果不会自动撤销，权限不因补充文本升级。'
                : '当前运行不支持运行中补充；新指令须在停止或结束后作为新请求提交。',
            historyMode: run.effective.runtimeId === 'api' ? '逐轮持久历史；兼容原生块或公开证据回退，受当前历史窗口限制' : '公开历史',
        },
        DYNAMIC_TOOL_AND_MCP_INSTRUCTIONS: {
            tools: toolNames, mcp: '未接入', hooks: '未接入',
            note: '仅 tools 数组列出的名称当前可用；调用参数、权限和执行结果以本轮工具契约为准。',
        },
        // MEMORY_CONTEXT: attach explicitly scoped retrieved memory after memory support exists.
        // Replace the MCP unavailable value above only after the tool registry exposes MCP tools.
    };
}
