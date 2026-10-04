import { setTimeout as delay } from 'node:timers/promises';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

let scenario = {};
try {
    scenario = JSON.parse(process.argv[2] ?? '{}');
} catch {
    process.stderr.write('invalid fixture scenario\n');
    process.exit(2);
}

let input = '';
let stdoutChain = Promise.resolve();
let pendingApprovalId;
let pendingUnknownRequestId;
const pendingDynamicRequests = new Map();
const pendingUserInputRequests = new Map();
let interrupted = false;
let lastAgentId;
let goal = null;
let currentTurnIsPlan = false;
let currentTurnNumber = 0;
let releaseResumeStaleUsage;
const resumeStaleUsageReady = new Promise(resolve => { releaseResumeStaleUsage = resolve; });
const goalStateFile = typeof scenario.recordFile === 'string' && scenario.recordFile.length > 0
    ? `${scenario.recordFile}.goal.json` : null;
if (goalStateFile && existsSync(goalStateFile)) {
    try { goal = JSON.parse(readFileSync(goalStateFile, 'utf8')); } catch { goal = null; }
}

function persistGoal() {
    if (goalStateFile) writeFileSync(goalStateFile, JSON.stringify(goal), 'utf8');
}

function record(event) {
    if (!scenario.recordFile) return;
    appendFileSync(scenario.recordFile, `${JSON.stringify(event)}\n`, 'utf8');
}

function writeMessage(message, fragment = false) {
    const operation = stdoutChain.then(async () => {
        record({ direction: 'server', ...message });
        const bytes = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
        if (!fragment) {
            process.stdout.write(bytes);
            return;
        }
        const marker = Buffer.from('中', 'utf8');
        const at = bytes.indexOf(marker);
        const split = at >= 0 ? at + 1 : Math.max(1, Math.floor(bytes.length / 2));
        process.stdout.write(bytes.subarray(0, split));
        await delay(2);
        process.stdout.write(bytes.subarray(split));
    });
    stdoutChain = operation.catch(() => undefined);
    return operation;
}

function response(id, result) {
    return writeMessage({ id, result });
}

async function notify(method, params) {
    return writeMessage({ method, params }, true);
}

async function finishTurn(status = 'completed') {
    if (scenario.unknownTerminal) status = 'futureStatus';
    if (scenario.wrongThreadDelta) {
        await notify('item/agentMessage/delta', { threadId: 'other-thread', turnId: 'turn-fixture', delta: 'wrong thread' });
    }
    if (scenario.wrongTurnDelta) {
        await notify('item/agentMessage/delta', { threadId: 'thread-fixture', turnId: 'old-turn', delta: 'wrong turn' });
    }
    if (currentTurnIsPlan) {
        const planChunks = Array.isArray(scenario.planDeltas) && scenario.planDeltas.every(chunk => typeof chunk === 'string')
            ? scenario.planDeltas : ['Fixture plan body.'];
        for (const delta of planChunks) {
            await notify('item/plan/delta', { threadId: 'thread-fixture', turnId: 'turn-fixture', itemId: 'item-plan-fixture', delta });
        }
    } else {
        const textChunks = Array.isArray(scenario.textChunks) && scenario.textChunks.every(chunk => typeof chunk === 'string')
            ? scenario.textChunks : ['你好，native。'];
        for (const delta of textChunks) {
            await notify('item/agentMessage/delta', { threadId: 'thread-fixture', turnId: 'turn-fixture', delta });
        }
    }
    await notify('thread/tokenUsage/updated', {
        threadId: 'thread-fixture',
        turnId: 'turn-fixture',
        tokenUsage: {
            last: scenario.usageLast ?? { inputTokens: 11, outputTokens: 7, cachedInputTokens: 3, reasoningOutputTokens: 2, totalTokens: 20 },
            total: scenario.usageTotal ?? { inputTokens: 110, outputTokens: 70, cachedInputTokens: 30, reasoningOutputTokens: 20, totalTokens: 200 },
            modelContextWindow: scenario.modelContextWindow ?? 128000,
        },
    });
    if (goal) {
        goal.tokensUsed += Number.isSafeInteger(scenario.goalTokensPerTurn) && scenario.goalTokensPerTurn >= 0
            ? scenario.goalTokensPerTurn : 0;
        goal.timeUsedSeconds += Number.isSafeInteger(scenario.goalSecondsPerTurn) && scenario.goalSecondsPerTurn >= 0
            ? scenario.goalSecondsPerTurn : 0;
        const goalStatus = Array.isArray(scenario.goalCompletionStatuses)
            ? scenario.goalCompletionStatuses[currentTurnNumber - 1] : scenario.goalCompletionStatus;
        if (['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(goalStatus)) {
            goal.status = goalStatus;
        }
        goal.updatedAt = Math.max(goal.updatedAt + 1, Date.now());
        persistGoal();
    }
    await notify('turn/completed', { threadId: 'thread-fixture', turn: { id: 'turn-fixture', status } });
}

async function sendUserInputRequest(turnParams) {
    const definition = scenario.userInputRequest;
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return [];
    const match = scenario.userInputInputMatch;
    const text = Array.isArray(turnParams.input)
        ? turnParams.input.map(item => typeof item?.text === 'string' ? item.text : '').join('')
        : '';
    if (typeof match === 'string' && (match.length === 0 || !text.includes(match))) return [];
    const requestId = definition.requestId ?? 'user-input-1';
    const questions = definition.questions ?? [{ id: 'choice', header: 'Choice', question: 'Choose one.' }];
    const threadId = definition.threadId ?? 'thread-fixture';
    const turnId = definition.turnId ?? 'turn-fixture';
    const itemId = definition.itemId ?? 'item-user-input';
    const request = {
        id: requestId,
        secretIds: new Set(Array.isArray(questions) ? questions.filter(question => question?.isSecret === true).map(question => question.id) : []),
        promise: undefined,
        resolve: undefined,
    };
    request.promise = new Promise(resolve => { request.resolve = resolve; });
    pendingUserInputRequests.set(requestId, request);
    if (definition.itemStarted === true) {
        await notify('item/started', { threadId, turnId, item: { id: itemId, type: 'functionCall' } });
    }
    if (definition.reasoningItemStarted === true) {
        await notify('item/started', { threadId, turnId, item: { id: definition.reasoningItemId ?? 'item-reasoning-fixture', type: 'reasoning' } });
    }
    await writeMessage({
        id: requestId,
        method: 'item/tool/requestUserInput',
        params: {
            isBlocking: definition.isBlocking ?? true,
            itemId: definition.requestItemId ?? itemId,
            questions,
            threadId,
            turnId,
        },
    });
    return [request];
}

function containsLastAgentId(value) {
    if (value === '$lastAgentId') return true;
    if (Array.isArray(value)) return value.some(containsLastAgentId);
    if (value && typeof value === 'object') return Object.values(value).some(containsLastAgentId);
    return false;
}

function replaceLastAgentId(value) {
    if (value === '$lastAgentId') return lastAgentId ?? value;
    if (Array.isArray(value)) return value.map(replaceLastAgentId);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceLastAgentId(child)]));
    }
    return value;
}

function agentIdFromResponse(response) {
    if (response?.success !== true || !Array.isArray(response.contentItems)) return undefined;
    for (const item of response.contentItems) {
        if (item?.type !== 'inputText' || typeof item.text !== 'string') continue;
        try {
            const parsed = JSON.parse(item.text);
            if (typeof parsed?.agentId === 'string' && parsed.agentId.length > 0) return parsed.agentId;
        } catch { /* Only JSON tool results carry the fixture agent ID. */ }
    }
    return undefined;
}

function waitForDynamicResponses(requests) {
    return Promise.all(requests.map(request => request.promise));
}

async function sendNativeActivityEvents(turnParams) {
    const definition = scenario.nativeActivityEvents;
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return false;
    const input = Array.isArray(turnParams.input)
        ? turnParams.input.map(item => typeof item?.text === 'string' ? item.text : '').join('')
        : '';
    const match = typeof scenario.nativeActivityInputMatch === 'string'
        ? scenario.nativeActivityInputMatch
        : definition.inputMatch;
    if (typeof match === 'string' && (match.length === 0 || !input.includes(match))) return false;

    const reasoning = definition.reasoning;
    if (reasoning && typeof reasoning === 'object') {
        const summary = Array.isArray(reasoning.summary) ? reasoning.summary : ['Public native reasoning summary.'];
        const itemId = typeof reasoning.itemId === 'string' ? reasoning.itemId : 'item-reasoning-fixture';
        await notify('item/started', { threadId: 'thread-fixture', turnId: 'turn-fixture', item: { id: itemId, type: 'reasoning', summary: [] } });
        if (typeof definition.wrongTurnReasoningDelta === 'string') {
            await notify('item/reasoning/summaryTextDelta', { threadId: 'thread-fixture', turnId: 'old-turn', itemId: 'item-wrong-turn', summaryIndex: 0, delta: definition.wrongTurnReasoningDelta });
        }
        const deltas = Array.isArray(reasoning.deltas) ? reasoning.deltas : summary.map(part => typeof part === 'string' ? part : part?.text).filter(part => typeof part === 'string');
        for (const [index, delta] of deltas.entries()) {
            if (typeof delta === 'string') await notify('item/reasoning/summaryTextDelta', { threadId: 'thread-fixture', turnId: 'turn-fixture', itemId, summaryIndex: Math.min(index, summary.length - 1), delta });
        }
        await notify('item/completed', { threadId: 'thread-fixture', turnId: 'turn-fixture', item: {
            id: itemId, type: 'reasoning', status: 'completed', summary,
            ...(Object.hasOwn(reasoning, 'content') ? { content: reasoning.content } : {}),
            ...(Object.hasOwn(reasoning, 'encrypted_content') ? { encrypted_content: reasoning.encrypted_content } : {}),
        } });
    }

    if (definition.command && typeof definition.command === 'object') {
        const command = definition.command;
        const itemId = typeof command.itemId === 'string' ? command.itemId : 'item-command-fixture';
        const commandText = typeof command.command === 'string' ? command.command : 'echo fixture';
        const cwd = typeof command.cwd === 'string' ? command.cwd : process.cwd();
        await notify('item/started', { threadId: 'thread-fixture', turnId: 'turn-fixture', item: { id: itemId, type: 'commandExecution', command: commandText, cwd, status: 'inProgress', aggregatedOutput: '' } });
        for (const delta of Array.isArray(command.outputDeltas) ? command.outputDeltas : []) {
            if (typeof delta === 'string') await notify('item/commandExecution/outputDelta', { threadId: 'thread-fixture', turnId: 'turn-fixture', itemId, delta });
        }
        const aggregatedOutput = typeof command.aggregatedOutput === 'string'
            ? command.aggregatedOutput
            : Array.isArray(command.outputDeltas) ? command.outputDeltas.filter(value => typeof value === 'string').join('') : 'fixture output';
        await notify('item/completed', { threadId: 'thread-fixture', turnId: 'turn-fixture', item: {
            id: itemId, type: 'commandExecution', command: commandText, cwd,
            status: command.exitCode === undefined || command.exitCode === 0 ? 'completed' : 'failed', aggregatedOutput, exitCode: command.exitCode ?? 0,
        } });
    }

    if (definition.mcpToolCall && typeof definition.mcpToolCall === 'object') {
        const call = definition.mcpToolCall;
        const itemId = typeof call.itemId === 'string' ? call.itemId : 'item-mcp-fixture';
        await notify('item/started', { threadId: 'thread-fixture', turnId: 'turn-fixture', item: {
            id: itemId, type: 'mcpToolCall', server: call.server ?? 'fixture', tool: call.tool ?? 'lookup',
            arguments: call.arguments ?? {}, status: 'inProgress',
        } });
        await notify('item/completed', { threadId: 'thread-fixture', turnId: 'turn-fixture', item: {
            id: itemId, type: 'mcpToolCall', server: call.server ?? 'fixture', tool: call.tool ?? 'lookup', arguments: call.arguments ?? {},
            status: call.error ? 'failed' : 'completed',
            ...(call.error ? { error: { message: call.error } } : { result: { content: [{ type: 'text', text: call.resultText ?? 'Fixture MCP result.' }] } }),
        } });
    }

    if (definition.fileChange && typeof definition.fileChange === 'object') {
        const change = definition.fileChange;
        await notify('item/completed', { threadId: 'thread-fixture', turnId: 'turn-fixture', item: {
            id: change.itemId ?? 'item-file-change-fixture', type: 'fileChange', status: 'completed', changes: Array.isArray(change.changes) ? change.changes : [],
        } });
    }

    if (Array.isArray(definition.unknownItems)) {
        for (const [index, item] of definition.unknownItems.entries()) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
            await notify('item/completed', { threadId: 'thread-fixture', turnId: 'turn-fixture', item: {
                id: item.id ?? `item-unknown-${index + 1}`, type: item.type ?? 'futureNativeItem', status: 'completed', ...item,
            } });
        }
    }

    if (currentTurnIsPlan) {
        await notify('turn/plan/updated', { threadId: 'thread-fixture', turnId: 'turn-fixture', plan: [{ step: 'Fixture step', status: 'completed' }], explanation: 'Fixture progress' });
        await notify('item/completed', { threadId: 'thread-fixture', turnId: 'turn-fixture', item: { id: 'item-plan-fixture', type: 'plan', text: 'Native fixture plan body' } });
    }
    return true;
}

async function sendDynamicCalls(turnParams) {
    const match = scenario.dynamicInputMatch;
    const text = Array.isArray(turnParams.input)
        ? turnParams.input.map(item => typeof item?.text === 'string' ? item.text : '').join('')
        : '';
    if (typeof match !== 'string' || match.length === 0 || !text.includes(match) || !Array.isArray(scenario.dynamicCalls)) return [];

    const requests = [];
    for (const [index, call] of scenario.dynamicCalls.entries()) {
        if (!call || typeof call !== 'object' || Array.isArray(call)) continue;
        if (containsLastAgentId(call.arguments)) await waitForDynamicResponses(requests);
        const id = call.requestId ?? `dynamic-${index + 1}`;
        const request = {
            id,
            tool: typeof call.tool === 'string' ? call.tool : 'fixture_tool',
            callId: typeof call.callId === 'string' ? call.callId : `fixture-call-${index + 1}`,
            promise: undefined,
            resolve: undefined,
        };
        request.promise = new Promise(resolve => { request.resolve = resolve; });
        pendingDynamicRequests.set(id, request);
        requests.push(request);
        await writeMessage({
            id,
            method: 'item/tool/call',
            params: {
                threadId: typeof call.threadId === 'string' ? call.threadId : 'thread-fixture',
                turnId: typeof call.turnId === 'string' ? call.turnId : 'turn-fixture',
                tool: request.tool,
                callId: request.callId,
                arguments: replaceLastAgentId(call.arguments ?? {}),
                ...(Object.hasOwn(call, 'namespace') ? { namespace: call.namespace } : {}),
            },
        });
    }
    return requests;
}

async function handle(message) {
    if (typeof message.method === 'string') {
        if (Object.hasOwn(message, 'id')) {
            const { id, method, params = {} } = message;
            record({ direction: 'client', id, method, params });
            if (scenario.rejectMethod === method) {
                await writeMessage({ id, error: scenario.rpcErrorRepeat ? { ...scenario.rpcError, message: scenario.rpcError.message.repeat(scenario.rpcErrorRepeat) } : scenario.rpcError });
                return;
            }
            if (method === 'initialize') {
                if (scenario.badLine) {
                    process.stdout.write('{broken json}\n');
                    return;
                }
                await response(id, { userAgent: 'Codex/0.156.1 fixture' });
                return;
            }
            if (method === 'model/list') {
                if (scenario.unknownResponse) await response(id + 1000, { data: [] });
                const data = Array.isArray(scenario.models) ? scenario.models : scenario.emptyModels ? [] : [{
                    id: 'gpt-fixture', model: 'gpt-fixture', displayName: 'Fixture model',
                    supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }],
                }];
                await response(id, { data, nextCursor: null });
                if (scenario.duplicateResponse) await response(id, { data, nextCursor: null });
                return;
            }
            if (method === 'account/read') {
                const account = scenario.omitAccount ? undefined : (scenario.account ?? null);
                await response(id, { ...(account === undefined ? {} : { account }), requiresOpenaiAuth: true });
                return;
            }
            if (method === 'config/read') {
                const config = scenario.badEffectiveConfig
                    ? { mcp_servers: null }
                    : (scenario.effectiveConfig ?? { mcp_servers: {} });
                await response(id, { config, origins: {} });
                return;
            }
            if (method.startsWith('thread/goal/')) {
                await writeMessage({ method: 'fixture/goalRequest', params: { method, params } });
                if (scenario.unsupportedGoalMethod === method) {
                    await writeMessage({ id, error: { code: -32601, message: 'fixture goal method unavailable' } });
                    return;
                }
                if (Number.isFinite(scenario.goalResponseDelayMs) && scenario.goalResponseDelayMs > 0) {
                    await delay(scenario.goalResponseDelayMs);
                }
                if (method === 'thread/goal/set') {
                    if (Object.hasOwn(params, 'objective')) {
                        goal = {
                            createdAt: Date.now(),
                            objective: params.objective,
                            status: params.status ?? 'active',
                            threadId: params.threadId,
                            timeUsedSeconds: 0,
                            tokensUsed: 0,
                            updatedAt: Date.now(),
                            tokenBudget: Object.hasOwn(params, 'tokenBudget') ? params.tokenBudget : null,
                        };
                    } else if (!goal) {
                        await writeMessage({ id, error: { code: -32602, message: 'fixture has no goal to update' } });
                        return;
                    } else {
                        if (Object.hasOwn(params, 'status')) goal.status = params.status;
                        if (Object.hasOwn(params, 'tokenBudget')) goal.tokenBudget = params.tokenBudget;
                        goal.updatedAt += 1;
                    }
                    persistGoal();
                    const responseGoal = { ...goal };
                    if (scenario.goalWrongThread) responseGoal.threadId = 'other-thread';
                    if (scenario.goalUnknownStatus) responseGoal.status = 'futureStatus';
                    if (scenario.goalInvalidCounter) responseGoal.tokensUsed = 2.5;
                    await response(id, { goal: responseGoal });
                    return;
                }
                if (method === 'thread/goal/get') {
                    if (scenario.omitGoalField) await response(id, {});
                    else {
                        const responseGoal = goal ? { ...goal } : null;
                        if (responseGoal && scenario.goalWrongThread) responseGoal.threadId = 'other-thread';
                        if (responseGoal && scenario.goalUnknownStatus) responseGoal.status = 'futureStatus';
                        if (responseGoal && scenario.goalInvalidCounter) responseGoal.tokensUsed = 2.5;
                        await response(id, { goal: responseGoal });
                    }
                    return;
                }
                if (method === 'thread/goal/clear') {
                    const cleared = goal !== null;
                    goal = null;
                    persistGoal();
                    await response(id, { cleared });
                    return;
                }
            }
            if (method === 'thread/start' || method === 'thread/resume') {
                await writeMessage({ method: 'fixture/threadRequest', params });
                if (scenario.threadId) await notify('thread/started', { thread: { id: scenario.threadId } });
                else await notify('thread/started', { thread: { id: 'thread-fixture' } });
                const threadId = scenario.threadId ?? 'thread-fixture';
                await response(id, { thread: { id: threadId } });
                if (method === 'thread/resume' && scenario.resumeStaleUsageAfterResponse === true) {
                    await delay(scenario.resumeStaleUsageDelayMs ?? 10);
                    await notify('thread/tokenUsage/updated', {
                        threadId,
                        turnId: 'turn-previous',
                        tokenUsage: { last: { inputTokens: 999, outputTokens: 888, cachedInputTokens: 777 } },
                    });
                    if (scenario.resumeMatchingEarlyUsage === true) {
                        await notify('thread/tokenUsage/updated', {
                            threadId,
                            turnId: 'turn-fixture',
                            tokenUsage: { last: { inputTokens: 22, outputTokens: 33, cachedInputTokens: 44 } },
                        });
                    }
                    releaseResumeStaleUsage();
                }
                return;
            }
            if (method === 'turn/start') {
                currentTurnNumber += 1;
                await writeMessage({ method: 'fixture/turnRequest', params });
                currentTurnIsPlan = params.collaborationMode?.mode === 'plan';
                if (scenario.resumeStaleUsageAfterResponse === true) await resumeStaleUsageReady;
                if (scenario.eofOnTurnStart) {
                    process.exit(0);
                    return;
                }
                let dynamicRequests = [];
                let userInputRequests = [];
                if (scenario.dynamicCallsBeforeTurnStartResponse) dynamicRequests = await sendDynamicCalls(params);
                if (scenario.userInputBeforeTurnStartResponse) userInputRequests = await sendUserInputRequest(params);
                await response(id, { turn: { id: 'turn-fixture', status: 'inProgress' } });
                await sendNativeActivityEvents(params);
                if (scenario.approval) {
                    pendingApprovalId = `approval-${id}`;
                    await writeMessage({
                        id: pendingApprovalId,
                        method: 'item/commandExecution/requestApproval',
                        params: { threadId: 'thread-fixture', turnId: 'turn-fixture', command: 'echo fixture', cwd: scenario.cwd ?? process.cwd() },
                    });
                    return;
                }
                if (scenario.unknownRequest) {
                    pendingUnknownRequestId = `unknown-${id}`;
                    const method = typeof scenario.requestMethod === 'string' ? scenario.requestMethod : 'unsupported/request';
                    const params = scenario.requestParams && typeof scenario.requestParams === 'object' && !Array.isArray(scenario.requestParams)
                        ? scenario.requestParams : { threadId: 'thread-fixture' };
                    await writeMessage({ id: pendingUnknownRequestId, method, params });
                    return;
                }
                if (!scenario.dynamicCallsBeforeTurnStartResponse) dynamicRequests = await sendDynamicCalls(params);
                if (!scenario.userInputBeforeTurnStartResponse) userInputRequests = await sendUserInputRequest(params);
                if (dynamicRequests.length > 0 || userInputRequests.length > 0) {
                    if (scenario.completeBeforeDynamicResponses && !scenario.cancel) await finishTurn(scenario.initialStatus ?? 'completed');
                    await Promise.all([
                        ...dynamicRequests.map(request => request.promise),
                        ...userInputRequests.map(request => request.promise),
                    ]);
                    if (!scenario.cancel && !scenario.completeBeforeDynamicResponses && !interrupted) {
                        await finishTurn(scenario.initialStatus ?? 'completed');
                    }
                    return;
                }
                if (scenario.holdTurns?.includes(currentTurnNumber) || scenario.hold) {
                    if (scenario.completeFile) {
                        const timer = setInterval(() => {
                            if (!existsSync(scenario.completeFile)) return;
                            clearInterval(timer);
                            void finishTurn(scenario.holdStatus ?? 'completed');
                        }, 10);
                        timer.unref();
                    }
                } else if (!scenario.cancel) {
                    await delay(5);
                    await finishTurn(scenario.initialStatus ?? 'completed');
                }
                return;
            }
            if (method === 'turn/interrupt') {
                interrupted = true;
                await response(id, {});
                await finishTurn('interrupted');
                return;
            }
            await writeMessage({ id, error: { code: -32601, message: 'fixture does not implement method' } });
            return;
        }
        if (message.method === 'initialized') return;
        return;
    }

    if (Object.hasOwn(message, 'id') && pendingDynamicRequests.has(message.id)) {
        const request = pendingDynamicRequests.get(message.id);
        pendingDynamicRequests.delete(message.id);
        const result = Object.hasOwn(message, 'result') ? message.result : undefined;
        const error = Object.hasOwn(message, 'error') ? message.error : undefined;
        record({ direction: 'client-response', id: message.id, result, error });
        if (request.tool === 'spawn_agent' || request.tool === 'uah_spawn_agent') {
            const agentId = agentIdFromResponse(result);
            if (agentId) lastAgentId = agentId;
        }
        await writeMessage({
            method: 'fixture/dynamicToolResponse',
            params: { tool: request.tool, callId: request.callId, result, error },
        });
        request.resolve({ result, error });
        return;
    }

    if (Object.hasOwn(message, 'id') && pendingUserInputRequests.has(message.id)) {
        const request = pendingUserInputRequests.get(message.id);
        pendingUserInputRequests.delete(message.id);
        const result = Object.hasOwn(message, 'result') ? message.result : undefined;
        const error = Object.hasOwn(message, 'error') ? message.error : undefined;
        const safeResult = result && typeof result === 'object' && result.answers && typeof result.answers === 'object'
            ? { ...result, answers: Object.fromEntries(Object.entries(result.answers).map(([key, value]) => [
                key,
                request.secretIds.has(key)
                    ? { answers: Array.isArray(value?.answers) ? value.answers.map(() => '[REDACTED]') : [] }
                    : value,
            ])) }
            : result;
        record({ direction: 'client-response', id: message.id, result: safeResult, error });
        await writeMessage({ method: 'fixture/userInputResponse', params: { result: safeResult, error } });
        request.resolve({ result, error });
        return;
    }

    if (Object.hasOwn(message, 'id') && pendingApprovalId && message.id === pendingApprovalId) {
        record({ direction: 'client-response', id: message.id, result: message.result, error: message.error });
        const allowed = message.result?.decision === 'accept';
        if (!allowed && message.result?.decision !== 'decline') {
            process.stderr.write('unexpected approval response\n');
            process.exitCode = 3;
            return;
        }
        if (scenario.recordApproval) {
            await writeMessage({ method: 'fixture/approval', params: { allowed, summary: 'Codex requests approval to run a command.' } });
        }
        pendingApprovalId = undefined;
        await finishTurn('completed');
        return;
    }

    if (Object.hasOwn(message, 'id') && pendingUnknownRequestId && message.id === pendingUnknownRequestId) {
        record({ direction: 'client-response', id: message.id, error: message.error });
        await writeMessage({ method: 'fixture/serverRequestResponse', params: { error: message.error } });
        pendingUnknownRequestId = undefined;
        await finishTurn('completed');
        return;
    }

    if (Object.hasOwn(message, 'id') && Object.hasOwn(message, 'result')) {
        record({ direction: 'client-response', id: message.id, result: message.result });
    }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    input += chunk;
    for (;;) {
        const newline = input.indexOf('\n');
        if (newline < 0) break;
        const line = input.slice(0, newline).replace(/\r$/, '');
        input = input.slice(newline + 1);
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            process.stderr.write('invalid client json\n');
            process.exitCode = 4;
            continue;
        }
        void handle(message).catch(() => {
            process.stderr.write('fixture request failed\n');
            process.exitCode = 5;
        });
    }
});

process.stdin.on('end', () => {
    if (scenario.cancel && !interrupted) process.exitCode = 6;
    process.exit(process.exitCode ?? 0);
});
