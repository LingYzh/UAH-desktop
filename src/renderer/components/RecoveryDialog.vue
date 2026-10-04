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
const busy = ref(false);
const error = ref('');
const note = ref('');
const input = ref('继续完成尚未完成的工作，先核对已有执行结果。');
let generation = 0;
const headers = [{ key: 'uri', title: '文件证据' }, { key: 'status', title: '核对结果' }];
const labels = { matched: '版本一致', changed: '文件已变化', missing: '文件不存在', unverifiable: '无法自动核对' };

async function refresh() {
    if (!props.run || busy.value) return;
    const epoch = ++generation;
    const run = props.run;
    busy.value = true; error.value = ''; review.value = null;
    try {
        const result = await window.uah.journal({ action: 'recovery', sessionId: run.sessionId, runId: run.id });
        if (epoch === generation) review.value = result;
    } catch (cause) { if (epoch === generation) error.value = clientError(cause); }
    finally { if (epoch === generation) busy.value = false; }
}
async function act(type) {
    if (busy.value || workspace.busy || !review.value || !props.run) return;
    const epoch = ++generation;
    const captured = review.value;
    busy.value = true; error.value = '';
    try {
        await workspace.historyCommand({ type, runId: captured.runId, fingerprint: captured.fingerprint,
            ...(type === 'resume-run' ? { input: input.value.trim() } : { note: note.value.trim() }) });
        if (epoch !== generation) return;
        if (workspace.error) throw new Error(workspace.error);
        if (type === 'resume-run') emit('close');
        else { busy.value = false; await refresh(); }
    } catch (cause) { if (epoch === generation) error.value = clientError(cause); }
    finally { if (epoch === generation) busy.value = false; }
}
watch(() => props.run, () => { generation++; busy.value = false; review.value = null; note.value = ''; error.value = ''; if (props.run) refresh(); }, { immediate: true });
watch(() => workspace.selectedId, () => emit('close'));
onBeforeUnmount(() => { generation++; });
</script>

<template>
    <UiDialog :open="!!run" scrollable aria-label="核对并继续" content-label="任务续接核对" @update:open="!$event && emit('close')">
        <template #header><h2>核对并继续</h2></template>
        <UiAlert v-if="error" tone="error" class="mb-3">{{ error }}</UiAlert>
        <p v-if="busy" role="status" class="muted">正在核对…</p>
        <template v-if="review">
            <UiAlert v-for="reason in review.reasons" :key="reason" tone="warning" class="mb-3">{{ reason }}</UiAlert>
            <p>旧运行和已完成动作保留。继续会创建关联的新运行，使用当前权限，并重新检查文件证据。</p>
            <p class="muted small">本次追加最多 {{ review.grant.maxRequests }} 次请求、{{ review.grant.maxTools }} 次工具调用、{{ Math.round(review.grant.maxElapsedMs / 60000) }} 分钟。累计 token 用量仅作统计，不限制运行。</p>
            <UiTable :headers="headers" :items="review.resources" item-value="uri" label="恢复文件证据" empty-text="没有可自动核对的文件版本证据" height="220px" fixed-header dense>
                <template #item.uri="{ item }"><span class="break-word">{{ item.uri }}</span></template>
                <template #item.status="{ item }">{{ labels[item.status] }}</template>
            </UiTable>
            <template v-if="review.canReconcile">
                <UiAlert tone="warning" class="my-3">存在文件变化、无法核对的资源或未确认副作用。请查看会话日志并实际检查文件、命令及外部系统；确认只记录你的核对结论，不会重执行旧工具，也不证明目标完成。</UiAlert>
                <p v-if="review.uncertainRuns.length" class="muted small">需要核对副作用的运行：{{ review.uncertainRuns.length }} 个。</p>
                <UiField :for="id + '-note'" label="核对结论" class="flex-column align-start ga-2 mt-3"><UiTextarea :id="id + '-note'" v-model="note" :rows="3" aria-label="核对结论" :disabled="busy" :maxlength="4000" placeholder="说明已经检查的动作、当前结果，以及仍需继续处理的事项" /></UiField>
            </template>
            <UiField v-if="review.canResume" :for="id + '-input'" label="继续要求" class="flex-column align-start ga-2 mt-3"><UiTextarea :id="id + '-input'" v-model="input" :rows="3" aria-label="继续要求" :disabled="busy" :maxlength="20000" /></UiField>
        </template>
        <template #footer>
            <div class="d-flex flex-wrap ga-2">
                <UiButton :disabled="busy || workspace.busy" @click="refresh">重新核对</UiButton>
                <UiButton v-if="review?.canReconcile" :disabled="busy || workspace.busy || !note.trim()" @click="act('reconcile-run')">保存核对结论</UiButton>
                <UiButton v-if="review?.canResume" variant="primary" :disabled="busy || workspace.busy || !input.trim()" @click="act('resume-run')">追加预算并继续</UiButton>
                <UiButton :disabled="busy" @click="emit('close')">关闭</UiButton>
            </div>
        </template>
    </UiDialog>
</template>
