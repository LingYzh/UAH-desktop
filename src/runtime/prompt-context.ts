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
        },
        DYNAMIC_TOOL_AND_MCP_INSTRUCTIONS: {
            tools: toolNames, mcp: '未接入', hooks: '未接入',
            note: '仅 tools 数组列出的名称当前可用；调用参数、权限和执行结果以本轮工具契约为准。',
        },
        // MEMORY_CONTEXT: attach explicitly scoped retrieved memory after memory support exists.
        // Replace the MCP unavailable value above only after the tool registry exposes MCP tools.
    };
}
