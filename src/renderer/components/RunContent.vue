<script setup>
import { computed, watch } from 'vue';
import { UiActivity, UiMarkdown } from '@lingyzh/ui';
import { useWorkspace } from '../stores/workspace';
import { activityGroups } from '../activity-groups';
import { openMarkdownLink } from '../markdown-links';
import RunActivity from './RunActivity.vue';
const props = defineProps({ run: { type: Object, required: true }, readonly: Boolean });
const workspace = useWorkspace();
const view = computed(() => workspace.activityView(props.run));
const expanded = computed(() => view.value.expanded);
const edited = computed(() => props.run.history?.editedOutput !== undefined);
const planContainsReply = computed(() => !edited.value && props.run.plan && props.run.plan.content.trim() === props.run.output.trim());
const groups = computed(() => activityGroups((props.run.activities || []).filter(item => !(edited.value || planContainsReply.value) || item.kind !== 'text')));
const groupKey = group => `group:${group.id}`;
const toolCount = group => group.items.filter(item => ['tool', 'agent'].includes(item.kind)).length;
const groupStatus = group => group.items.some(item => item.status === 'approval') && props.run.state === 'approval' ? '等待审批' : group.items.some(item => item.status === 'running') && props.run.state === 'running' ? '运行中' : group.items.some(item => item.status === 'failed') ? '有操作失败' : '';
watch(groups, values => {
    for (const group of values) {
        const pending = group.items.find(item => item.status === 'approval');
        const marker = pending ? `group-approval:${pending.id}` : '';
        if (pending && !view.value.seenApprovals[marker]) {
            expanded.value[groupKey(group)] = true;
            view.value.seenApprovals[marker] = true;
        }
    }
}, { immediate: true });
</script>

<template>
    <template v-for="group in groups" :key="group.id">
        <UiActivity v-if="group.tool && toolCount(group) > 1" v-model:open="expanded[groupKey(group)]" variant="inline" icon="terminal" :title="`使用了 ${toolCount(group)} 个工具`" :status="groupStatus(group)" :scrollable="false">
            <RunActivity v-for="activity in group.items" :key="activity.id" :run="run" :activity="activity" :readonly="readonly" />
        </UiActivity>
        <RunActivity v-else :run="run" :activity="group.items[0]" :readonly="readonly" />
    </template>
    <div v-if="edited || (!run.activities?.length && !planContainsReply)" class="assistant-message"><UiMarkdown :source="edited ? run.history.editedOutput : run.output || '正在准备…'" :streaming="!edited && workspace.page === 'chat' && run.state === 'running' && Boolean(run.output)" @link-click="openMarkdownLink" /></div>
</template>
