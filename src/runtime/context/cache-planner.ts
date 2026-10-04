import type { ApiConnection } from '../../shared/endpoints';
import { contextHash } from './projection';

export interface CacheFrontier { message: number; block: number; prefixHash: string }
export interface CachePlan {
    profile: 'unknown' | 'deepseek-implicit' | 'anthropic-blocks' | 'openai-responses-breakpoints';
    version: 1;
    maxWritesPerRequest: number | null;
    lookupWindow: number | null;
    previousRetained: boolean;
    candidates: CacheFrontier[];
    evidence: 'planned';
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const openaiModels = new Set(['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6.1-sol']);

/** Only official endpoint/API/model combinations carry built-in capability evidence. */
export function planCache(connection: ApiConnection, model: string, input: Record<string, unknown>, previous?: CacheFrontier): { body: Record<string, unknown>; plan: CachePlan } {
    const body = structuredClone(input);
    const url = new URL(connection.baseUrl);
    const official = url.protocol === 'https:' && !url.port && !url.username && !url.password;
    const profile: CachePlan['profile'] = official && url.hostname === 'api.deepseek.com' ? 'deepseek-implicit'
        : official && url.hostname === 'api.anthropic.com' && connection.protocol === 'anthropic' ? 'anthropic-blocks'
        : official && url.hostname === 'api.openai.com' && connection.protocol === 'openai-responses' && openaiModels.has(model) ? 'openai-responses-breakpoints' : 'unknown';
    const plan: CachePlan = { profile, version: 1, maxWritesPerRequest: profile === 'anthropic-blocks' || profile === 'openai-responses-breakpoints' ? 4 : null,
        lookupWindow: profile === 'anthropic-blocks' ? 20 : profile === 'openai-responses-breakpoints' ? 50 : null,
        previousRetained: false, candidates: [], evidence: 'planned' };
    if (profile === 'unknown' || profile === 'deepseek-implicit') return { body, plan };
    const messages = (connection.protocol === 'openai-responses' ? body.input : body.messages) as unknown[];
    if (!Array.isArray(messages)) throw new Error('Cache planner requires compiled messages');
    // Message boundaries are permanent. Converting string content to one block is deterministic.
    for (const message of messages) if (object(message) && message.role === 'user' && typeof message.content === 'string') {
        message.content = [{ type: profile === 'anthropic-blocks' ? 'text' : 'input_text', text: message.content }];
    }
    const eligible: CacheFrontier[] = [];
    const prefix: unknown[] = [body.tools ?? [], body.system ?? body.instructions ?? ''];
    for (const [messageIndex, message] of messages.entries()) {
        if (!object(message)) continue;
        if (Array.isArray(message.content)) {
            const blocks: unknown[] = [];
            for (const [blockIndex, block] of message.content.entries()) {
                blocks.push(block);
                if (message.role === 'user' && object(block) && (profile === 'anthropic-blocks'
                    ? (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) || block.type === 'tool_result'
                    : block.type === 'input_text' && typeof block.text === 'string' && block.text.length > 0)) {
                    eligible.push({ message: messageIndex, block: blockIndex,
                        prefixHash: contextHash([...prefix, { ...message, content: blocks }]) });
                }
            }
        }
        prefix.push(message);
    }
    const old = previous && eligible.find(item => item.message === previous.message && item.block === previous.block && item.prefixHash === previous.prefixHash);
    const newest = eligible.at(-1);
    plan.previousRetained = !!old;
    plan.candidates = [old, newest].filter((item, index, all): item is CacheFrontier => !!item && all.findIndex(other => other?.prefixHash === item.prefixHash) === index);
    for (const point of plan.candidates) {
        const message = messages[point.message] as { content: Record<string, unknown>[] };
        const block = message.content[point.block];
        if (profile === 'anthropic-blocks') block.cache_control = { type: 'ephemeral' };
        else block.prompt_cache_breakpoint = { mode: 'explicit' };
    }
    // Keep implicit enabled; explicit-only would miss unmarked old endpoints.
    if (profile === 'openai-responses-breakpoints') body.prompt_cache_options = { mode: 'implicit' };
    return { body, plan };
}
