<script setup>
import { clientError } from '../../shared/client-error.js';

import { ref, watch, onBeforeUnmount, useId } from 'vue';
import { UiDialog, UiButton, UiAlert, UiTable, UiTextarea, UiField } from '@lingyzh/ui';
import { useWorkspace } from '../stores/workspace';

const props = defineProps({ run: Object });
const emit = defineEmits(['close']);
const workspace = useWorkspace();
const id = useId();
const review = ref(null);
const criteria = ref('');
const busy = ref(false);
const error = ref('');
let generation = 0;
const fileHeaders = [{ key: 'uri', title: '文件版本证据' }, { key: 'status', title: '当前核对' }];
const commandHeaders = [{ key: 'command', title: '已执行命令' }, { key: 'exit', title: '退出码' }, { key: 'fresh', title: '后续动作' }];
const labels = { matched: '版本一致', changed: '已经变化', missing: '文件缺失', unverifiable: '无法核对' };
async function refresh() {
    if (!props.run || busy.value) return;
    const epoch = ++generation;
    const run = props.run;
    busy.value = true; error.value = ''; review.value = null;
    try {
        const result = await window.uah.journal({ action: 'verification', sessionId: run.sessionId, runId: run.id });
        if (epoch === generation) review.value = result;
    } catch (cause) { if (epoch === generation) error.value = clientError(cause); }
    finally { if (epoch === generation) busy.value = false; }
}
async function accept() {
    if (busy.value || workspace.busy || !review.value?.canVerify || !criteria.value.trim()) return;
    const epoch = ++generation;
    busy.value = true; error.value = '';
    try {
        await workspace.historyCommand({ type: 'verify-goal', runId: review.value.runId, fingerprint: review.value.fingerprint, criteria: criteria.value.trim() });
        if (epoch !== generation) return;
        if (workspace.error) throw new Error(workspace.error);
        criteria.value = ''; busy.value = false; await refresh();
    } catch (cause) { if (epoch === generation) error.value = clientError(cause); }
    finally { if (epoch === generation) busy.value = false; }
}
watch(() => props.run, () => { generation++; busy.value = false; criteria.value = ''; error.value = ''; review.value = null; if (props.run) refresh(); }, { immediate: true });
watch(() => workspace.selectedId, () => emit('close'));
onBeforeUnmount(() => { generation++; });
</script>

<template>
    <UiDialog :open="!!run" scrollable aria-label="目标验收" content-label="目标验收证据" @update:open="!$event && emit('close')">
        <template #header><h2>目标验收</h2></template>
        <UiAlert v-if="error" tone="error" class="mb-3">{{ error }}</UiAlert>
        <p v-if="busy" role="status">正在核对验收证据…</p>
        <template v-if="review">
            <p>运行结束后，请独立检查任务结果，再记录你实际验收的标准。命令退出码为 0 不代表目标自动通过。</p>
            <p class="muted small">文件核对仅覆盖下方已有版本证据；未记录的文件、外部系统及实际效果仍需人工检查。本操作不执行命令。</p>
            <UiAlert v-if="review.status === 'current'" class="my-3">已有人工验收记录，本次检查的记录及文件版本仍匹配。</UiAlert>
            <UiAlert v-else-if="review.status === 'stale'" tone="warning" class="my-3">旧验收记录已经失效或无法确认当前有效，不能用于证明当前结果。</UiAlert>
            <p v-if="review.previous" class="break-word">上次标准：{{ review.previous.criteria }}</p>
            <UiAlert v-for="reason in review.reasons" :key="reason" tone="warning" class="mb-3">{{ reason }}</UiAlert>
            <UiTable :headers="fileHeaders" :items="review.resources" item-value="uri" label="验收文件证据" empty-text="没有可自动核对的文件版本证据" height="180px" fixed-header dense>
                <template #item.uri="{ item }"><span class="break-word">{{ item.uri }}</span></template>
                <template #item.status="{ item }">{{ labels[item.status] }}</template>
            </UiTable>
            <UiTable class="mt-3" :headers="commandHeaders" :items="review.commands" item-value="invocationId" label="验收命令证据" empty-text="没有持久命令结果；验收依据由你实际检查" height="180px" fixed-header dense>
                <template #item.command="{ item }"><span class="break-word">{{ item.command }}</span></template>
                <template #item.exit="{ item }">{{ item.outcome.exitCode ?? '未知' }} · {{ item.outcome.status }}</template>
                <template #item.fresh="{ item }">{{ item.hasLaterEffects ? '之后有副作用，需重新检查' : '未记录后续副作用' }}</template>
            </UiTable>
            <UiField v-if="review.canVerify" label="我已独立检查的验收标准" :for="id + '-criteria'" class="flex-column align-start ga-2 mt-3">
                <UiTextarea :id="id + '-criteria'" v-model="criteria" :rows="3" :maxlength="4000" :disabled="busy" placeholder="写明已实际检查的功能、结果或测试，以及验收覆盖范围" />
            </UiField>
        </template>
        <template #footer><div class="d-flex flex-wrap ga-2">
            <UiButton :disabled="busy || workspace.busy" @click="refresh">重新检查版本</UiButton>
            <UiButton v-if="review?.canVerify" variant="primary" :disabled="busy || workspace.busy || !criteria.trim()" @click="accept">记录人工验收通过</UiButton>
            <UiButton :disabled="busy" @click="emit('close')">关闭</UiButton>
        </div></template>
    </UiDialog>
</template>
