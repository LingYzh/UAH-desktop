<script setup>
import { computed, ref, watch, useId, onBeforeUnmount } from 'vue';
import { UiSelect, UiMarkdown, UiButton, UiField, UiInput, UiTextarea, UiTabs, UiTabsWindow, UiTabsWindowItem, snackbar, writeClipboard } from '@lingyzh/ui';
import { useWorkspace } from '../stores/workspace';
import { openMarkdownLink } from '../markdown-links';
import { currentPlanRun, planDocuments, planStatusLabels } from '../plan-presentation';

const workspace = useWorkspace();
const id = useId();
const documents = computed(() => planDocuments(workspace.snapshot, workspace.selectedId));
const document = computed(() => documents.value.find(item => item.versions.some(version => version.runId === workspace.panel.planRunId)) || documents.value.at(-1));
const selected = computed(() => document.value?.versions.find(item => item.id === workspace.panel.planVersionId) || document.value?.versions.at(-1));
const taskId = computed({ get: () => document.value?.id || '', set: value => selectVersion(documents.value.find(item => item.id === value)?.versions.at(-1)) });
const versionId = computed({ get: () => selected.value?.id || '', set: value => selectVersion(document.value?.versions.find(item => item.id === value)) });
const taskItems = computed(() => documents.value.map(item => ({ value: item.id, label: item.title })));
const versionItems = computed(() => document.value?.versions.map(item => ({ value: item.id, label: 'v' + item.version + ' · ' + (planStatusLabels[item.status] || item.status) })).reverse() || []);
const current = computed(() => currentPlanRun(workspace.snapshot, workspace.selectedId));
const canEdit = computed(() => selected.value?.id === current.value?.plan?.id && current.value?.plan?.status === 'proposed'
    && current.value?.state === 'completed' && workspace.sessionControls.permissionMode === 'plan');
const editing = computed({
    get: () => Boolean(selected.value && workspace.panel.planEditorId === selected.value.id),
    set: value => { workspace.panel.planEditorId = value ? selected.value?.id : null; },
});
const saving = ref(false);
const idle = computed(() => workspace.connected && !workspace.busy && !workspace.activeRun && !saving.value);
const error = ref('');
const title = ref('');
const content = ref('');
const editorMode = ref('edit');
const editIdentity = ref(null);
const tabs = [{ id: 'edit', label: '编辑 Markdown' }, { id: 'preview', label: '预览' }];

function selectVersion(version) {
    if (!version || saving.value) return;
    editing.value = false;
    error.value = '';
    workspace.panel.planRunId = version.runId;
    workspace.panel.planVersionId = version.id;
}

function startEditing() {
    if (!canEdit.value || !idle.value) return;
    title.value = selected.value.title;
    content.value = selected.value.content;
    editIdentity.value = { runId: selected.value.runId, planId: selected.value.id };
    editorMode.value = 'edit';
    error.value = '';
    editing.value = true;
}

watch(() => workspace.panel.planEditing, value => {
    if (!value) return;
    startEditing();
    workspace.panel.planEditing = false;
}, { immediate: true });
watch(() => workspace.selectedId, () => { editing.value = false; error.value = ''; });
onBeforeUnmount(() => { editing.value = false; });

async function save() {
    if (!editing.value || !idle.value || !editIdentity.value || !title.value.trim() || !content.value.trim()) return;
    saving.value = true;
    error.value = '';
    try {
        await workspace.historyCommand({ type: 'edit-plan', ...editIdentity.value, title: title.value.trim(), content: content.value });
        error.value = workspace.error;
        if (!error.value) {
            const latest = workspace.snapshot.runs.find(run => run.id === editIdentity.value.runId)?.plan;
            workspace.panel.planVersionId = latest?.id;
            editing.value = false;
            snackbar.show('已保存新版本，尚未批准实施。');
        }
    } finally { saving.value = false; }
}

async function copy() {
    if (!selected.value) return;
    try { await writeClipboard(selected.value.content); snackbar.show('计划内容已复制。'); }
    catch { snackbar.show('复制失败，请选中文字手动复制。', { tone: 'error' }); }
}
</script>

<template>
    <div v-if="selected" class="d-flex flex-column ga-3">
        <UiField v-if="documents.length > 1" class="flex-column align-start ga-2" :for="id + '-task'" label="任务计划">
            <UiSelect :id="id + '-task'" v-model="taskId" :items="taskItems" :disabled="editing || saving" aria-label="任务计划" />
        </UiField>
        <div class="d-flex flex-wrap align-center justify-space-between ga-2">
            <h3 class="ma-0">{{ document.title }}</h3>
            <span class="muted small">{{ planStatusLabels[selected.status] }}</span>
        </div>
        <UiSelect v-model="versionId" :items="versionItems" :disabled="editing || saving" aria-label="计划文件版本" />
        <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
        <template v-if="editing">
            <p class="muted small ma-0">保存会保留旧版本，不会批准或开始实施。</p>
            <UiField class="flex-column align-start ga-2" :for="id + '-title'" label="计划标题">
                <UiInput :id="id + '-title'" v-model="title" class="w-100" :maxlength="200" :disabled="saving" />
            </UiField>
            <UiTabs v-model="editorMode" :items="tabs" :id-prefix="id + '-editor'" aria-label="计划编辑方式" />
            <UiTabsWindow eager :keyboard="false" :model-value="editorMode" :id-prefix="id + '-editor'">
                <UiTabsWindowItem value="edit" :transition="false">
                    <UiField class="flex-column align-start ga-2" :for="id + '-content'" label="计划 Markdown" description="支持标题、列表、表格和代码块。">
                        <UiTextarea :id="id + '-content'" v-model="content" :rows="16" :maxlength="100000" :disabled="saving" spellcheck="false" />
                    </UiField>
                </UiTabsWindowItem>
                <UiTabsWindowItem value="preview" :transition="false">
                    <UiMarkdown :source="content" @link-click="openMarkdownLink" />
                </UiTabsWindowItem>
            </UiTabsWindow>
            <div class="d-flex flex-wrap ga-2">
                <UiButton variant="primary" :loading="saving" :disabled="!idle || !title.trim() || !content.trim()" @click="save">保存新版本</UiButton>
                <UiButton :disabled="saving" @click="editing = false">关闭</UiButton>
            </div>
        </template>
        <template v-else>
            <p class="muted small ma-0">{{ selected.status === 'draft' ? '草稿仍在规划中，提交后可审阅。' : '每次提交与手动编辑均保留版本；历史版本仅供查看。' }}</p>
            <UiMarkdown :source="selected.content" @link-click="openMarkdownLink" />
            <div class="d-flex flex-wrap ga-2">
                <UiButton v-if="canEdit" size="sm" :disabled="!idle" @click="startEditing">直接编辑 Markdown</UiButton>
                <UiButton variant="ghost" size="sm" @click="copy">复制计划内容</UiButton>
            </div>
        </template>
        <details>
            <summary>文件与版本信息</summary>
            <p class="muted small break-word">{{ selected.filePath }}</p>
            <p v-if="selected.hash" class="muted small break-word">SHA-256 {{ selected.hash }}</p>
        </details>
    </div>
    <div v-else class="empty-state"><h3>还没有计划文件</h3><p>在对话中选择 Plan 模式。每项任务的计划与版本历史会显示在这里。</p></div>
</template>
