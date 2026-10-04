<script setup>
import { clientError } from '../../shared/client-error.js';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { UiDialog, UiButton, UiUsageMeter, UiCollapse, UiCodeBlock } from '@lingyzh/ui';
import { useWorkspace } from '../stores/workspace';

const props = defineProps({ open: Boolean, initialRunId: { type: String, default: '' } });
const emit = defineEmits(['update:open']);
const workspace = useWorkspace();
const detail = ref(null);
const busy = ref(false);
const error = ref('');
const expanded = ref({});
let generation = 0;
const latest = computed(() => workspace.runs.filter(run => !run.parentRunId && !run.history?.deleted && run.requestContext)
    .sort((a, b) => a.requestContext.capturedAt.localeCompare(b.requestContext.capturedAt)).at(-1));
const pressure = computed(() => detail.value?.pressure);
const occupied = computed(() => pressure.value?.requiredTokens ?? detail.value?.usage?.inputTokens ?? detail.value?.estimatedInputTokens);
const segments = computed(() => {
    const values = (detail.value?.sections || []).map(section => ({ id: section.id, label: section.label, value: section.estimatedTokens }));
    const capacity = detail.value?.capacity;
    if (Number.isFinite(capacity) && capacity > 0) {
        const visible = values.reduce((sum, section) => sum + section.value, 0);
        const input = pressure.value?.inputEstimatedTokens ?? detail.value?.usage?.inputTokens ?? visible;
        if (input > visible) values.push({ id: 'other', label: '协议与不可见内容估算差额', value: input - visible });
        const reserve = (pressure.value?.outputReserve ?? 0) + (pressure.value?.toolReserve ?? 0) + (pressure.value?.errorReserve ?? 0);
        if (reserve) values.push({ id: 'reserve', label: '输出、工具与误差预留', value: reserve });
        values.push({ id: 'remaining', label: '剩余可用上下文', value: Math.max(0, capacity - Math.max(visible + reserve, input + reserve)), tone: 'remaining' });
    }
    return values;
});
const sessionUsage = computed(() => detail.value?.sessionUsage);
const usageRows = computed(() => [
    ['累计输入 token', sessionUsage.value?.inputTokens],
    ['累计缓存读取 token', sessionUsage.value?.cachedInputTokens],
    ['累计未命中缓存输入 token', sessionUsage.value?.uncachedInputTokens],
    ['累计输出 token', sessionUsage.value?.outputTokens],
    ['累计缓存写入 token', sessionUsage.value?.cacheCreationInputTokens]
]);
const displayCounter = field => field?.total != null ? field.total.toLocaleString()
    : field?.reportedAttempts > 0 && field.knownSum != null ? `${field.knownSum.toLocaleString()}（已上报部分）` : '未完整上报';
const cacheHitRate = computed(() => {
    const usage = sessionUsage.value;
    if (usage?.cacheHitRate != null) return `${(usage.cacheHitRate * 100).toFixed(2)}%`;
    if (usage?.knownCacheHitRate != null) return `${(usage.knownCacheHitRate * 100).toFixed(2)}%（已上报 ${usage.cacheHitRateReportedAttempts}/${usage.attemptCount} 次尝试）`;
    return '未完整上报或无输入';
});
const accountingRevision = computed(() => JSON.stringify(workspace.snapshot.runs
    .filter(run => run.sessionId === workspace.selectedId)
    .map(run => [run.id, run.state, run.requestContext?.requestId, run.requestContext?.usage])));
watch(() => [props.open, workspace.selectedId, latest.value?.requestContext?.requestId, accountingRevision.value], async ([open, sessionId], previous) => {
    const epoch = ++generation;
    if (previous && previous[1] !== sessionId) { detail.value = null; emit('update:open', false); return; }
    error.value = '';
    if (!open || !sessionId) { detail.value = null; busy.value = false; return; }
    busy.value = true;
    try {
        const result = await window.uah.requestContext({ sessionId });
        if (epoch === generation) detail.value = result;
    } catch (cause) { if (epoch === generation) error.value = clientError(cause, '无法读取会话上下文。'); }
    finally { if (epoch === generation) busy.value = false; }
}, { immediate: true });
onBeforeUnmount(() => { generation++; });
</script>

<template>
    <UiDialog :open="open" aria-label="会话上下文" content-label="会话上下文详情" :error="error" scrollable @update:open="emit('update:open', $event)">
        <template #header><h2>会话上下文</h2></template>
        <p v-if="busy && !detail" class="muted small" role="status">正在读取会话上下文…</p>
        <p v-else-if="!detail" class="muted small">此会话尚无可用的 API 上下文记录。</p>
        <template v-if="detail">
            <p class="muted small">累计用量覆盖本会话全部模型请求；当前窗口以最近一次实际请求为准，不将重复输入累计为上下文占用。</p>
            <p class="muted small">{{ detail.modelId }} · {{ new Date(detail.capturedAt).toLocaleString() }} · {{ detail.protocol }}</p>
            <UiUsageMeter label="当前上下文与预留 token" :used="occupied" :capacity="detail.capacity" :estimated="Boolean(pressure) || detail.usage?.inputTokens === undefined" :segments="segments" composition-label="当前上下文构成" composition-estimated />
            <p class="muted small">分类为可见内容估算；当前压力另含协议与隐藏内容估算及输出、工具和误差预留。估算不等于服务计费。</p>
            <p v-if="pressure" class="muted small">计量来源：{{ pressure.estimateConfidence === 'calibrated' ? '服务用量基准加增量估算' : '本地保守估算' }} · 请求体 {{ pressure.bodyBytes.toLocaleString() }} / {{ pressure.bodyByteLimit?.toLocaleString() }} bytes（本地资源上限）</p>
            <p class="small">会话累计用量 · {{ sessionUsage?.requestCount ?? 0 }} 个请求 / {{ sessionUsage?.attemptCount ?? 0 }} 次尝试</p>
            <p v-for="[label, field] in usageRows" :key="label" class="muted small">{{ label }}：{{ displayCounter(field) }}</p>
            <p class="muted small">会话缓存命中率（累计缓存读取 / 累计输入）：{{ cacheHitRate }}</p>
            <p class="muted small">包含本会话子任务、摘要和重试；缺失字段不补零。缓存写入属于未命中缓存输入的一部分，不能再次相加。</p>
            <div v-if="detail.contextDiagnostics" class="my-3">
                <UiButton variant="ghost" size="sm" :aria-expanded="Boolean(expanded.diagnostics)" @click="expanded.diagnostics = !expanded.diagnostics">前缀与缓存诊断</UiButton>
                <UiCollapse :open="Boolean(expanded.diagnostics)"><p class="muted small">前缀比较来自本地请求；缓存计划不代表服务端已写入或命中。</p><UiCodeBlock :code="detail.contextDiagnostics" language="json" /></UiCollapse>
            </div>
            <div v-for="section in detail.sections" :key="section.id" class="my-3">
                <UiButton variant="ghost" size="sm" :aria-expanded="Boolean(expanded[section.id])" @click="expanded[section.id] = !expanded[section.id]">{{ section.label }} · {{ section.characters.toLocaleString() }} 字符 · 估算 {{ section.estimatedTokens.toLocaleString() }} token</UiButton>
                <UiCollapse :open="Boolean(expanded[section.id])"><p v-if="section.truncated" class="muted small" role="status">保存的可见内容已截断，以下不是完整正文。</p><UiCodeBlock :code="section.content || '（空）'" language="text" /></UiCollapse>
            </div>
        </template>
        <template #footer><UiButton @click="emit('update:open', false)">关闭</UiButton></template>
    </UiDialog>
</template>
