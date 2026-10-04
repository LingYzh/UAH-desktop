<script setup>
import { computed, ref, watch } from 'vue';
import { UiActivity, UiButton, UiCodeBlock, UiDiff, UiMarkdown } from '@lingyzh/ui';
import { useWorkspace, stateLabels } from '../stores/workspace';
import { presentTool } from '../tool-presentation';
import { openMarkdownLink } from '../markdown-links';
import { changeCounts, displayFilePath } from '../change-presentation';
const props = defineProps({ run: { type: Object, required: true }, activity: { type: Object, required: true }, readonly: Boolean });
const workspace = useWorkspace();
const view = computed(() => workspace.activityView(props.run));
const expanded = computed(() => view.value.expanded);
// Keep cold disclosure bodies out of the DOM; retain them after first opening
// so closing transitions and local copy/scroll state remain intact.
const contentReady = ref(false);
const rawOpen = ref(false);
const rawReady = ref(false);
watch(() => Boolean(expanded.value[props.activity.id]), open => { if (open) contentReady.value = true; }, { immediate: true });
watch(rawOpen, open => { if (open) rawReady.value = true; });
const child = computed(() => workspace.snapshot.runs.find(run => run.id === props.activity.childRunId));
const directory = computed(() => workspace.snapshot.sessions.find(session => session.id === props.run.sessionId)?.directory);
const tool = computed(() => ['tool', 'agent'].includes(props.activity.kind) ? presentTool(props.activity, workspace.snapshot.artifacts, { runId: props.run.id, directory: directory.value }) : null);
const counts = computed(() => tool.value?.diffSource ? changeCounts(tool.value.before, tool.value.after) : null);
const approvals = computed(() => workspace.snapshot.approvals.filter(item => item.runId === props.run.id && item.toolCallId === props.activity.id && item.status === 'pending'));
const status = computed(() => child.value?.state || (['failed', 'stopped'].includes(props.run.state) && ['running', 'approval'].includes(props.activity.status) ? props.run.state : props.activity.status));
const tone = computed(() => status.value === 'failed' ? 'error' : ['running', 'approval'].includes(status.value) ? 'busy' : 'neutral');
const title = computed(() => {
    if (props.activity.kind === 'reasoning') return status.value === 'completed' ? '已思考' : '思考过程';
    if (!tool.value) return props.activity.title;
    if (status.value !== 'completed') return tool.value.title;
    return { '编辑文件': '已编辑', '读取文件': '已读取', '浏览目录': '已浏览目录', '搜索文件': '已搜索文件', '执行命令': '运行了命令', '启动子代理': '已启动子代理', '等待子代理': '已等待子代理', '查询子代理角色': '已查询子代理角色' }[tool.value.title] || tool.value.title;
});
const icon = computed(() => props.activity.kind === 'reasoning' ? 'spark' : tool.value?.diffSource ? 'file' : tool.value?.path ? 'folder' : props.activity.kind === 'agent' ? 'subagent' : 'terminal');
const live = computed(() => workspace.page === 'chat' && props.run.state === 'running' && props.run.activities?.at(-1)?.id === props.activity.id);
watch(() => props.activity, item => {
    if (item.status === 'approval' && !view.value.seenApprovals[item.id]) {
        view.value.seenApprovals[item.id] = true;
        expanded.value[item.id] = true;
    }
}, { immediate: true });
function inspect() {
    workspace.panel.changeRunId = null;
    workspace.panel.artifactId = tool.value.artifactId;
    workspace.panel.tab = 'files';
    workspace.panel.open = true;
}
function viewChild() {
    workspace.panel.tab = 'agents';
    workspace.panel.childRunId = props.activity.childRunId;
    workspace.panel.open = true;
}
</script>

<template>
    <div v-if="activity.kind === 'text'" class="assistant-message mb-4"><UiMarkdown :source="activity.content" :streaming="live" @link-click="openMarkdownLink" /></div>
    <UiActivity v-else v-model:open="expanded[activity.id]" variant="inline" :icon="icon" :title="title" :filename="tool?.path?.split(/[\\/]/).at(-1)" :added="counts?.added ?? undefined" :removed="counts?.removed ?? undefined" :status="status === 'completed' ? '' : stateLabels[status] || status" :tone="tone" :scrollable="activity.kind === 'reasoning'">
        <UiMarkdown v-if="contentReady && activity.kind === 'reasoning'" :source="activity.content" :streaming="Boolean(expanded[activity.id] && live && activity.status === 'running')" @link-click="openMarkdownLink" />
        <div v-else-if="contentReady && tool" class="d-flex flex-column ga-3">
            <p v-if="tool.originalToolName || tool.toolName" class="muted small ma-0">工具：<code>{{ tool.originalToolName || tool.toolName }}</code></p>
            <UiDiff v-if="tool.diffSource" compact :inspectable="Boolean(tool.artifactId)" :path="displayFilePath(tool.path, directory)" :before="tool.before" :after="tool.after" :proposed="tool.diffSource === 'proposal'" @inspect="inspect" />
            <template v-else><UiCodeBlock v-if="tool.language" :code="tool.usage" :language="tool.language" max-height="240px" dense /><p v-else class="small break-word ma-0">{{ tool.usage }}</p></template>
            <UiCodeBlock v-if="tool.result && (!tool.diffSource || status === 'failed')" :code="tool.result" language="text" max-height="320px" dense />
            <p v-else-if="!tool.diffSource && !tool.result" class="muted small ma-0">{{ ['running', 'approval'].includes(status) ? '等待执行结果…' : '没有返回结果。' }}</p>
            <UiActivity v-if="tool.rawResult" v-model:open="rawOpen" variant="inline" title="原始返回" :scrollable="false"><UiCodeBlock v-if="rawReady" :code="tool.rawResult" language="text" max-height="320px" dense /></UiActivity>
            <template v-if="child"><p class="muted small ma-0">{{ child.effective.modelId }} · {{ stateLabels[child.state] }}</p><UiButton size="sm" @click="viewChild">查看子代理会话</UiButton></template>
        </div>
        <p v-else-if="contentReady" class="muted small">活动详情不可用。</p>
        <template v-if="!readonly && approvals.length" #actions><div v-for="approval in approvals" :key="approval.requestId"><p class="small break-word">{{ tool?.diffSource ? '批准后应用上方文件修改。' : approval.summary }}</p><p class="small break-word">{{ approval.path }}</p><div class="d-flex ga-2"><UiButton size="sm" variant="primary" :disabled="workspace.busy" @click="workspace.resolve(approval, 'approve')">批准本次操作</UiButton><UiButton size="sm" :disabled="workspace.busy" @click="workspace.resolve(approval, 'reject')">拒绝</UiButton></div></div></template>
    </UiActivity>
</template>
