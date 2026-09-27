<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { UiDialog, UiButton, UiSelect, UiUsageMeter, UiCollapse, UiCodeBlock } from '@lingyzh/ui';
import { useWorkspace } from '../stores/workspace';

const props = defineProps({ open: Boolean, initialRunId: { type: String, default: '' } });
const emit = defineEmits(['update:open']);
const workspace = useWorkspace();
const available = computed(() => workspace.runs.filter(run => run.requestContext));
const runId = ref('');
const selectedRun = computed(() => available.value.find(run => run.id === runId.value));
const detail = ref(null);
const busy = ref(false);
const error = ref('');
const expanded = ref({});
let generation = 0;
const segments = computed(() => (detail.value?.sections || []).map(section => ({ id: section.id, label: section.label, value: section.estimatedTokens })));
const usageRows = computed(() => [
    ['输出 token', detail.value?.usage?.outputTokens],
    ['缓存读取 token（包含在输入内）', detail.value?.usage?.cachedInputTokens],
    ['缓存创建 token（包含在输入内）', detail.value?.usage?.cacheCreationInputTokens]
].filter(([, value]) => value !== undefined));
watch(() => [props.open, workspace.selectedId], ([open], previous) => {
    generation++;
    detail.value = null;
    error.value = '';
    expanded.value = {};
    if (previous && previous[1] !== workspace.selectedId) { emit('update:open', false); runId.value = ''; return; }
    runId.value = open ? (available.value.some(run => run.id === props.initialRunId) ? props.initialRunId : available.value.at(-1)?.id || '') : '';
}, { immediate: true, flush: 'sync' });
watch(() => [props.open, workspace.selectedId, runId.value, selectedRun.value?.requestContext?.requestId, selectedRun.value?.requestContext?.round, JSON.stringify(selectedRun.value?.requestContext?.usage)], async () => {
    const epoch = ++generation;
    detail.value = null;
    error.value = '';
    expanded.value = {};
    busy.value = false;
    if (!props.open || !selectedRun.value) return;
    const sessionId = workspace.selectedId;
    const requestedRun = runId.value;
    busy.value = true;
    try {
        if (!window.uah?.requestContext) throw new Error('请重启更新后的桌面端以读取请求快照。');
        const response = await window.uah.requestContext({ runId: requestedRun });
        if (epoch !== generation || sessionId !== workspace.selectedId || !props.open) return;
        if (response && response.runId !== requestedRun) throw new Error('请求快照与当前轮次不一致。');
        detail.value = response;
    } catch (cause) { if (epoch === generation) error.value = cause?.message || String(cause); }
    finally { if (epoch === generation) busy.value = false; }
}, { immediate: true, flush: 'sync' });
onBeforeUnmount(() => { generation++; });
</script>

<template>
    <UiDialog :open="open" scrollable aria-label="请求上下文" content-label="最近请求上下文" @update:open="emit('update:open', $event)">
        <template #header><h2>请求上下文</h2></template>
        <p class="muted small">展示此会话最近实际尝试发送的请求快照，不是下一次请求的预测。</p>
        <template v-if="available.length"><label for="request-context-run" class="field-label">本会话轮次</label><UiSelect id="request-context-run" v-model="runId"><option v-for="run in available" :key="run.id" :value="run.id">第 {{ workspace.runs.findIndex(item => item.id === run.id) + 1 }} 轮 · {{ run.requestContext.modelId }} · 请求 {{ run.requestContext.round + 1 }}</option></UiSelect></template>
        <p v-if="busy" role="status" class="muted">正在读取请求快照…</p>
        <p v-if="error" role="alert" class="muted">{{ error }}</p>
        <p v-if="!busy && !detail && !error" class="muted">{{ available.length ? '此轮快照已不可用。' : '本会话还没有模型请求快照。' }}</p>
        <template v-if="detail">
            <p class="muted small break-word">{{ detail.modelId }} · 请求 {{ detail.round + 1 }} · {{ new Date(detail.capturedAt).toLocaleString() }} · {{ detail.protocol }}</p>
            <UiUsageMeter label="最近请求输入 token" :used="detail.usage?.inputTokens ?? detail.estimatedInputTokens" :capacity="detail.capacity" :estimated="detail.usage?.inputTokens === undefined" :segments="segments" composition-label="可见请求分类" composition-estimated />
            <p v-for="[label, value] in usageRows" :key="label" class="muted small">{{ label }}：{{ value.toLocaleString() }}</p>
            <p v-if="detail.omittedPrivateState" class="muted small">此处仅为可见请求投影；原生运行时内部状态不包含在内，不能据此还原完整原生上下文。</p>
            <p class="muted small">分类 token 为本地估算，不包含密钥或隐藏推理。服务未上报的字段不会当作零。</p>
            <div v-for="section in detail.sections" :key="section.id" class="my-3">
                <UiButton variant="ghost" size="sm" :aria-expanded="Boolean(expanded[section.id])" @click="expanded[section.id] = !expanded[section.id]">{{ section.label }} · {{ section.characters.toLocaleString() }} 字符 · 估算 {{ section.estimatedTokens.toLocaleString() }} token</UiButton>
                <UiCollapse :open="Boolean(expanded[section.id])"><p v-if="section.truncated" class="muted small" role="status">保存的可见内容已截断，以下不是完整正文。</p><UiCodeBlock :code="section.content || '（空）'" language="text" /></UiCollapse>
            </div>
        </template>
        <template #footer><UiButton @click="emit('update:open', false)">关闭</UiButton></template>
    </UiDialog>
</template>
