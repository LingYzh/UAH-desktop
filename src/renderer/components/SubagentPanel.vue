<script setup>
import { clientError } from '../../shared/client-error.js';

import { computed, ref, watch } from 'vue';
import { UiButton, UiCard, UiDialog, UiField, UiScrollArea, UiTextarea, UiMarkdown } from '@lingyzh/ui';
import { useWorkspace, stateLabels } from '../stores/workspace';
import RunContent from './RunContent.vue';
import { openMarkdownLink } from '../markdown-links';

const workspace = useWorkspace();
const children = computed(() => workspace.snapshot.runs.filter(run => run.sessionId === workspace.selectedId && run.parentRunId));
const selected = computed(() => children.value.find(run => run.id === workspace.panel.childRunId));
const stopping = ref(null);
const reason = ref('');
const dialogOpen = ref(false);
const live = run => ['running', 'approval'].includes(run.state);
const name = run => run.effective.agentName || '子代理';
function requestStop(run) {
    stopping.value = run;
    reason.value = '';
    dialogOpen.value = true;
}
async function confirmStop() {
    if (workspace.busy || !stopping.value) return;
    await workspace.stop(stopping.value, reason.value);
    if (!workspace.error) dialogOpen.value = false;
}
watch(() => workspace.selectedId, () => { dialogOpen.value = false; stopping.value = null; });
</script>

<template>
    <UiScrollArea :key="selected?.id || 'list'" label="子代理面板" height="100%" :rounded="false">
        <div class="pa-4 d-flex flex-column ga-3">
            <template v-if="selected">
                <UiButton size="sm" variant="ghost" @click="workspace.panel.childRunId = null">返回子代理列表</UiButton>
                <h3 class="break-word">{{ name(selected) }}</h3>
                <p class="muted small break-word">只读会话 · {{ stateLabels[selected.state] }}<br />{{ selected.effective.modelId }} · {{ selected.effective.permissionMode }}</p>
                <UiCard density="compact" title="任务"><UiMarkdown :source="selected.input" @link-click="openMarkdownLink" /></UiCard>
                <RunContent :run="selected" readonly />
                <p v-if="selected.stopReason" class="small break-word">停止理由：{{ selected.stopReason }}</p>
                <p v-if="selected.error" role="alert" class="inline-error">{{ clientError(selected.error) }}</p>
            </template>
            <template v-else>
                <p class="muted small">当前会话的全部子代理 · {{ children.length }} 个</p>
                <p v-if="!children.length" class="muted">主代理启动子代理后，会在这里显示任务和状态。</p>
                <UiCard v-for="run in children" :key="run.id" density="compact" :data-child-id="run.id">
                    <UiButton variant="ghost" class="w-100 justify-start" :title="name(run)" :aria-label="`${name(run)} · ${stateLabels[run.state]}`" @click="workspace.panel.childRunId = run.id"><span class="min-w-0 overflow-hidden">{{ name(run) }}</span><span class="flex-shrink-0">· {{ stateLabels[run.state] }}</span></UiButton>
                    <p class="small break-word">{{ run.input.length > 180 ? `${run.input.slice(0, 180)}…` : run.input }}</p>
                    <p class="muted small break-word">{{ run.effective.modelId }} · 第 {{ run.depth || 1 }} 级</p>
                    <p v-if="run.stopReason" class="small break-word">停止理由：{{ run.stopReason }}</p>
                    <template v-if="live(run)" #actions><UiButton size="sm" :disabled="workspace.busy" :aria-label="`停止子代理 ${name(run)}`" @click="requestStop(run)">停止</UiButton></template>
                </UiCard>
            </template>
        </div>
    </UiScrollArea>
    <UiDialog v-model:open="dialogOpen" scrollable aria-labelledby="stop-child-title" :error="workspace.error" content-label="停止子代理设置">
        <template #header><h2 id="stop-child-title">停止子代理</h2></template>
        <p>{{ stopping ? name(stopping) : '' }} 的运行及其下级子代理将停止。</p>
        <UiField label="停止理由（可选）" for="child-stop-reason" description="理由会记录在会话中，并返回给主代理。留空也可以停止。"><UiTextarea id="child-stop-reason" v-model="reason" :rows="3" :maxlength="2000" :disabled="workspace.busy" /></UiField>
        <template #footer><div class="d-flex ga-2"><UiButton :disabled="workspace.busy" @click="dialogOpen = false">关闭</UiButton><UiButton variant="primary" :disabled="workspace.busy" @click="confirmStop">{{ workspace.busy ? '正在停止…' : '确认停止' }}</UiButton></div></template>
    </UiDialog>
</template>
