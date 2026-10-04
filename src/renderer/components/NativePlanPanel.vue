<script setup>
import { computed } from 'vue';
import { UiButton, UiMarkdown, UiCard } from '@lingyzh/ui';
import { useWorkspace } from '../stores/workspace';
import { visibleRootRuns } from '../../shared/conversation-history';
import { openMarkdownLink } from '../markdown-links';
const workspace = useWorkspace();
const roots = computed(() => visibleRootRuns(workspace.snapshot.runs, workspace.selectedId));
const plan = computed(() => roots.value.filter(run => run.nativePlan?.content || run.effective.nativeCollaborationMode === 'plan' && run.state === 'completed' && run.output && !(run.nativeCommand?.kind === 'plan' && !run.nativeCommand.task)).at(-1));
const progress = computed(() => roots.value.filter(run => run.nativePlan?.steps).at(-1)?.nativePlan);
const labels = { pending: '待处理', inProgress: '进行中', completed: '已完成' };
const idle = computed(() => workspace.connected && !workspace.busy && !workspace.activeRun);
</script>

<template>
    <div class="d-flex flex-column ga-3">
        <h3>Codex 原生计划</h3>
        <p class="muted small">原生计划与步骤状态同步显示在这里。执行会退出 Plan 模式并保留当前权限；修订会留在 Plan 模式。</p>
        <div v-if="plan" class="d-flex flex-wrap ga-2">
            <UiButton variant="primary" :disabled="!idle || workspace.selected?.nativeCollaborationMode !== 'plan'" @click="workspace.executeNativePlan">执行计划</UiButton>
            <UiButton :disabled="!idle" @click="workspace.reviseNativePlan">修订计划（Revise）</UiButton>
        </div>
        <UiMarkdown v-if="plan" :source="plan.nativePlan?.content || plan.output" @link-click="openMarkdownLink" />
        <p v-else class="muted">还没有原生计划。可在输入框左侧的 + 菜单进入计划模式。</p>
        <template v-if="progress">
            <h3>执行进度</h3>
            <p v-if="progress.explanation" class="muted">{{ progress.explanation }}</p>
            <UiCard v-for="(step, index) in progress.steps" :key="index" density="compact" :title="step.step" :subtitle="labels[step.status]" />
        </template>
    </div>
</template>
