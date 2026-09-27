export interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export interface ToolCall {
    id: string;
    name: string;
    arguments: string;
}

export interface ToolResult {
    id: string;
    content: string;
    isError?: boolean;
}

/** Provider-reported cumulative usage for one request; snapshots replace, never add.
 * inputTokens includes cached input. Anthropic input_tokens excludes cache reads/creation,
 * so transport adds those reported components. OpenAI cache reads are already a subset
 * of inputTokens. Missing counters remain absent; totalTokens is not context input usage.
 */
export interface ApiUsage {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheCreationInputTokens?: number;
    totalTokens?: number;
}

export type AgentStreamEvent =
    | { type: 'text' | 'reasoning'; text: string }
    | { type: 'usage'; usage: ApiUsage }
    | { type: 'complete'; toolCalls: ToolCall[]; continuation: unknown[] };
