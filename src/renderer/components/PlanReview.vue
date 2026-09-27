<script setup>
import { computed, ref, useId, watch } from 'vue';
import { UiCard, UiField, UiSelect, UiTextarea, UiButton, UiScrollArea } from '@lingyzh/ui';
import { useWorkspace } from '../stores/workspace';
import { currentPlanRun } from '../plan-presentation';

const props = defineProps({ run: { type: Object, required: true } });
const workspace = useWorkspace();
const id = useId();
const feedback = ref('');
const permission = ref('auto');
const revising = ref(false);
const error = ref('');
const submitting = ref(false);
const modes = [
    { value: 'auto', label: 'Auto', description: '自动接受工作区编辑；当前未隔离的命令仍需审批。' },
    { value: 'bypass', label: 'Bypass permissions', description: '跳过工具审批和工作区范围限制。' },
];
const current = computed(() => workspace.selectedId === props.run.sessionId
    && currentPlanRun(workspace.snapshot, props.run.sessionId)?.id === props.run.id
    && props.run.plan?.status === 'proposed' && !props.run.history?.deleted && props.run.state === 'completed');
const reviewable = computed(() => current.value && workspace.sessionControls.permissionMode === 'plan');
const editorOpen = computed(() => workspace.panel.planEditorId === props.run.plan.id);
const idle = computed(() => workspace.connected && !workspace.busy && !workspace.activeRun && workspace.modelAvailable && !submitting.value && !editorOpen.value);
const subtitle = computed(() => {
    if (editorOpen.value) return '正在编辑计划。请先在右栏保存新版本，或关闭编辑，再选择如何继续。';
    if (props.run.plan.status === 'draft') return '草稿已保存，Agent 完成规划后会提交审阅。';
    if (props.run.plan.status === 'approved') return '此版本已批准。实施仍遵守你选择的工具权限。';
    if (props.run.plan.status === 'revision-requested') return '已将修改意见交给 Agent，修订后会再次提交审批。';
    if (!current.value) return '已保存的历史计划；请审阅当前任务的最新版本。';
    if (!reviewable.value) return '此计划尚未批准。切回 Plan 模式后可以审阅。';
    return '审阅后选择如何继续。你可以直接编辑，也可以指导 Agent 修订。';
});
watch(() => props.run.plan.id, () => { error.value = ''; });

function inspect(edit = false) {
    workspace.panel.planRunId = props.run.id;
    workspace.panel.planVersionId = props.run.plan.id;
    workspace.panel.planEditing = edit;
    workspace.panel.tab = 'plans';
    workspace.panel.open = true;
}

async function resolve(decision, mode) {
    if (!idle.value || !reviewable.value || (decision === 'revise' && !feedback.value.trim())) return;
    const model = workspace.modelOptions.find(item => item.value === workspace.currentModel);
    if (!model) return;
    submitting.value = true;
    error.value = '';
    try {
        await workspace.historyCommand({ type: 'resolve-plan', runId: props.run.id, planId: props.run.plan.id, decision,
            selection: { endpointId: model.endpointId, modelId: model.modelId },
            ...(decision === 'approve' ? { permissionMode: mode } : { feedback: feedback.value.trim() }) });
        error.value = workspace.error;
    } finally { submitting.value = false; }
}
</script>

<template>
    <UiScrollArea label="计划审批操作" max-height="min(48dvh, 430px)">
        <UiCard density="compact" title="计划已就绪" :subtitle="subtitle" aria-label="实施计划审阅">
            <div class="d-flex flex-wrap align-center ga-2">
                <span class="muted small">{{ run.plan.title || '实施计划' }} · v{{ run.plan.version || 1 }}</span>
                <UiButton variant="ghost" size="sm" @click="inspect()">在右栏查看计划文件</UiButton>
            </div>
            <div v-if="reviewable" class="d-flex flex-column ga-3 mt-3">
                <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
                <template v-if="revising">
                    <UiField class="flex-column align-start ga-2" :for="id + '-feedback'" label="计划修改意见" description="指出需要补充、调整或重新考虑的地方。Agent 会修订同一份计划，再次提交审批。">
                        <UiTextarea :id="id + '-feedback'" v-model="feedback" :maxlength="20000" :rows="3" :disabled="!idle" />
                    </UiField>
                    <div class="d-flex flex-wrap ga-2">
                        <UiButton variant="primary" :disabled="!idle || !feedback.trim()" @click="resolve('revise')">提交意见并继续规划</UiButton>
                        <UiButton :disabled="submitting" @click="revising = false">关闭</UiButton>
                    </div>
                </template>
                <template v-else>
                    <div class="d-flex flex-wrap ga-2">
                        <UiButton variant="primary" :disabled="!idle" @click="resolve('approve', 'accept-edits')">批准并自动编辑</UiButton>
                        <UiButton :disabled="!idle" @click="resolve('approve', 'manual')">批准并逐项审批</UiButton>
                    </div>
                    <p class="muted small ma-0">自动编辑允许修改工作区文件，命令执行仍需审批；逐项审批会在每次编辑或执行命令前询问。</p>
                    <div class="d-flex flex-wrap ga-2">
                        <UiButton :disabled="!idle" @click="revising = true">指导 Agent 修订</UiButton>
                    <UiButton variant="ghost" :disabled="!workspace.connected || workspace.busy || !!workspace.activeRun || editorOpen" @click="inspect(true)">直接编辑 Markdown</UiButton>
                    </div>
                    <details>
                        <summary>其他实施权限</summary>
                        <div class="d-flex flex-column align-start ga-3 mt-3">
                            <UiField :for="id + '-permission'" label="实施时的权限" description="只在批准后切换权限；修改此选项不会开始实施。">
                                <UiSelect :id="id + '-permission'" v-model="permission" :items="modes" :disabled="!idle" aria-label="实施时的权限" />
                            </UiField>
                            <UiButton :disabled="!idle" @click="resolve('approve', permission)">批准并使用所选权限</UiButton>
                        </div>
                    </details>
                </template>
            </div>
        </UiCard>
    </UiScrollArea>
</template>
