<script setup>
import { computed, ref, useId } from 'vue';
import { UiMessageActions, UiDialog, UiField, UiTextarea, UiButton, snackbar, writeClipboard } from '@lingyzh/ui';
import { useWorkspace } from '../stores/workspace';
import { displayedReply } from '../../shared/conversation-history';
import { sessionHasFileChanges } from '../../shared/run-effects';
const props = defineProps({ run: { type: Object, required: true }, index: { type: Number, required: true } });
const workspace = useWorkspace();
const dialogId = useId();
const dialog = ref(false);
const operation = ref('');
const text = ref('');
const idle = computed(() => !workspace.activeRun && !workspace.busy && workspace.connected);
const actions = computed(() => [
    { id: 'copy', icon: 'copy', label: '复制回复', disabled: !displayedReply(props.run) },
    { id: 'edit', icon: 'edit', label: '编辑历史回复', disabled: !idle.value },
    { id: 'branch', icon: 'branch', label: '从此回复创建分支', disabled: !idle.value },
    ...(!(workspace.snapshot.historyWindow?.hasFileChanges || sessionHasFileChanges(workspace.snapshot, props.run.sessionId)) ? [{ id: 'regenerate', icon: 'refresh', label: '重新生成最新回复', disabled: !idle.value || workspace.runs.at(-1)?.id !== props.run.id }] : []),
    { id: 'delete', icon: 'trash', label: '删除回复记录', disabled: !idle.value },
]);
const label = computed(() => {
    const duration = Date.parse(props.run.finishedAt) - Date.parse(props.run.createdAt);
    return `第 ${props.index + 1} 轮${Number.isFinite(duration) && duration >= 0 ? ` · ${Math.max(1, Math.round(duration / 1000))} 秒` : ''}`;
});
const title = computed(() => ({ edit: '编辑已保存回复', regenerate: '重新生成最新回复？', delete: '删除这组回复记录？' }[operation.value]));
const confirmLabel = computed(() => ({ edit: '仅保存历史修改', regenerate: '重新生成', delete: '删除记录' }[operation.value]));
async function choose(id) {
    if (id === 'copy') {
        try { await writeClipboard(displayedReply(props.run)); snackbar.show('回复已复制。'); }
        catch { snackbar.show('复制失败，请选中正文手动复制。', { tone: 'error' }); }
        return;
    }
    if (!idle.value) return;
    if (id === 'branch') { await workspace.branchFrom(props.run); return; }
    workspace.error = '';
    operation.value = id;
    text.value = props.run.history?.editedOutput ?? props.run.output;
    dialog.value = true;
}
async function confirm() {
    if (!idle.value) return;
    const command = { type: { edit: 'edit-reply', delete: 'delete-reply', regenerate: 'regenerate-run' }[operation.value], runId: props.run.id };
    if (operation.value === 'edit') command.output = text.value;
    if (operation.value === 'regenerate') {
        const selected = workspace.modelOptions.find(item => item.value === workspace.currentModel);
        command.selection = selected ? { endpointId: selected.endpointId, modelId: selected.modelId } : null;
    }
    await workspace.historyCommand(command);
    if (!workspace.error) dialog.value = false;
}
</script>

<template>
    <UiMessageActions :label="label" :actions="actions" @action="choose" />
    <UiDialog v-model:open="dialog" scrollable :aria-labelledby="`${dialogId}-title`" :error="workspace.error" content-label="回复操作">
        <template #header><h2 :id="`${dialogId}-title`">{{ title }}</h2></template>
        <UiField v-if="operation === 'edit'" label="回复正文" :for="`${dialogId}-reply`" :description="run.plan ? '仅修改回复正文，不修改计划文件或审批版本；要调整计划，请使用计划中的修改按钮。' : '仅修改已保存的回复正文；不会重新调用模型或执行工具。'"><UiTextarea :id="`${dialogId}-reply`" v-model="text" :rows="10" :maxlength="1000000" :disabled="workspace.busy" /></UiField>
        <p v-else-if="operation === 'regenerate'">保留原问题，以当前模型和权限重新生成最新一轮回复。发生过文件修改的会话不支持重新生成。</p>
        <p v-else>从对话中删除这组回复正文与工具展示记录，不会撤销本地文件改动。已保存的文件快照仍可在历史快照中查看。</p>
        <template #footer><div class="d-flex ga-2"><UiButton :disabled="workspace.busy" @click="dialog = false">关闭</UiButton><UiButton variant="primary" :disabled="!idle" @click="confirm">{{ workspace.busy ? '正在处理…' : confirmLabel }}</UiButton></div></template>
    </UiDialog>
</template>
