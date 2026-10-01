<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useWorkspace } from '../stores/workspace';
import Icon from './Icon.vue';
import SubagentPanel from './SubagentPanel.vue';
import PlanFiles from './PlanFiles.vue';
import GitPanel from './GitPanel.vue';
import { UiButton, UiInput, UiSelect, UiTabs, UiTabPanel, UiScrollArea, UiDiff, UiFileChanges } from '@lingyzh/ui';
import { roundFileChanges } from '../file-changes';
import { fileChangeItem, displayFilePath } from '../change-presentation';

const props = defineProps({ suspended: Boolean });
const workspace = useWorkspace();
const browserArea = ref(null);
const address = ref('https://example.com');
const browserReady = ref(false);
const busy = ref(false);
const error = ref('');
const observation = ref(null);
const tabs = [
    { id: 'git', label: 'Git', icon: 'branch' },
    { id: 'agents', label: '子代理', icon: 'subagent' },
    { id: 'files', label: '历史快照', icon: 'history' },
    { id: 'plans', label: '计划', icon: 'plan' },
    { id: 'browser', label: '浏览器', icon: 'globe' },
    { id: 'native', label: '桌面观察', icon: 'monitor' }
];
const changeRun = computed(() => workspace.snapshot.runs.find(run => run.sessionId === workspace.selectedId && run.id === workspace.panel.changeRunId));
const artifacts = computed(() => changeRun.value ? roundFileChanges(changeRun.value, workspace.snapshot) : workspace.snapshot.artifacts.filter(item => item.sessionId === workspace.selectedId));
const artifact = computed(() => changeRun.value && !workspace.panel.artifactId ? null : artifacts.value.find(item => item.id === workspace.panel.artifactId) || artifacts.value.at(-1));
const changeItems = computed(() => artifacts.value.map(item => fileChangeItem(item, workspace.selected?.directory)));
const changeTitle = computed(() => `第 ${workspace.runs.findIndex(run => run.id === changeRun.value?.id) + 1} 轮文件改动`);
let observer;
let epoch = 0;
const browserSessions = new Map();

async function hideBrowser() {
    await window.uah?.browser({ type: 'hide' }).catch(() => {});
}
async function layoutBrowser() {
    if (props.suspended || !browserReady.value || !browserArea.value || !workspace.panel.open || workspace.panel.tab !== 'browser' || workspace.page !== 'chat') return;
    const bounds = browserArea.value.getBoundingClientRect();
    await window.uah?.browser({ type: 'bounds', sessionId: workspace.selectedId, x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.floor(bounds.width), height: Math.floor(bounds.height) }).catch((cause) => { error.value = cause.message; });
}
async function openBrowser() {
    if (busy.value || !workspace.selectedId || !window.uah) return;
    busy.value = true;
    error.value = '';
    const generation = ++epoch;
    const sessionId = workspace.selectedId;
    const requestedUrl = address.value;
    browserReady.value = false;
    try {
        const result = await window.uah.browser({ type: 'open', sessionId, url: requestedUrl });
        if (result.error) throw new Error(result.error);
        if (!result.url) return;
        browserSessions.set(sessionId, { url: result.url, ready: true });
        if (generation !== epoch) return;
        address.value = result.url;
        browserReady.value = true;
        await nextTick();
        await layoutBrowser();
    } catch (cause) { if (generation === epoch) error.value = cause.message; }
    finally { busy.value = false; }
}
async function closeBrowser() {
    if (busy.value) return;
    epoch++;
    browserSessions.delete(workspace.selectedId);
    browserReady.value = false;
    try { await window.uah?.browser({ type: 'close' }); }
    catch (cause) { error.value = cause.message; }
}
async function observe() {
    if (busy.value || !window.uah) return;
    busy.value = true;
    error.value = '';
    try { observation.value = await window.uah.observeDesktop(); }
    catch (cause) { error.value = cause.message; }
    finally { busy.value = false; }
}
watch(() => [workspace.selectedId, workspace.panel.tab, workspace.panel.open, workspace.page, props.suspended], async ([sessionId], previous) => {
    const generation = ++epoch;
    if (previous?.[0]) {
        const state = browserSessions.get(previous[0]);
        if (state) state.url = address.value;
    }
    error.value = '';
    browserReady.value = false;
    await hideBrowser();
    if (generation !== epoch) return;
    const state = browserSessions.get(sessionId);
    address.value = state?.url || 'https://example.com';
    browserReady.value = Boolean(state?.ready);
    observation.value = null;
    await nextTick();
    await layoutBrowser();
}, { flush: 'sync' });
watch(browserArea, (element) => {
    observer?.disconnect();
    if (element) { observer = new ResizeObserver(layoutBrowser); observer.observe(element); }
});
onBeforeUnmount(() => { epoch++; observer?.disconnect(); hideBrowser(); });
</script>

<template>
    <aside class="workspace-panel" aria-label="会话工作面板">
        <header class="panel-header"><strong>工作面板</strong><UiButton variant="ghost" size="sm" class="text-button panel-close" aria-label="关闭工作面板" @click="workspace.panel.open = false"><Icon name="close" /></UiButton></header>
        <UiScrollArea label="工作面板标签" axis="horizontal" :rounded="false" class="flex-shrink-0"><UiTabs dense variant="underline" v-model="workspace.panel.tab" class="panel-tabs" style="width: max-content; min-width: 100%" id-prefix="workspace" :items="tabs" aria-label="工作面板内容"><template #default="{ item }"><Icon :name="item.icon" />{{ item.label }}</template></UiTabs></UiScrollArea>
        <div v-if="error" class="inline-error" role="alert">{{ error }}</div>
        <UiTabPanel :model-value="workspace.panel.tab" value="agents" id-prefix="workspace" class="overflow-hidden" style="display: flex; flex-direction: column; flex: 1; min-height: 0"><SubagentPanel v-if="workspace.historyPanelReady" /><p v-else role="status">正在加载会话历史…</p></UiTabPanel>
        <UiTabPanel :model-value="workspace.panel.tab" value="plans" id-prefix="workspace" class="panel-content"><PlanFiles v-if="workspace.historyPanelReady" /><p v-else role="status">正在加载会话历史…</p></UiTabPanel>
        <UiTabPanel :model-value="workspace.panel.tab" value="git" id-prefix="workspace" class="panel-content"><GitPanel v-if="workspace.panel.tab === 'git' && workspace.panel.open && workspace.page === 'chat'" /></UiTabPanel>
        <UiTabPanel :model-value="workspace.panel.tab" value="files" id-prefix="workspace" class="panel-content">
            <p v-if="!workspace.historyPanelReady" role="status">正在加载会话历史…</p>
            <template v-else>
            <UiFileChanges v-if="changeRun && !artifact" :title="changeTitle" :items="changeItems" @select="workspace.panel.artifactId = $event" @view-all="workspace.panel.artifactId = null" />
            <UiButton v-if="changeRun && artifact" variant="ghost" size="sm" @click="workspace.panel.artifactId = null">全部文件改动</UiButton>
            <template v-if="artifact">
                <label class="field-label" for="snapshot-choice">{{ changeRun ? changeTitle : '本会话的不可变快照' }}</label>
                <UiSelect id="snapshot-choice" v-model="workspace.panel.artifactId"><option v-for="item in artifacts" :key="item.id" :value="item.id">{{ displayFilePath(item.path, workspace.selected?.directory) }}</option></UiSelect>
                <h3>{{ artifact.path.split(/[\\/]/).at(-1) }}</h3>
                <p class="muted small">{{ new Date(artifact.createdAt).toLocaleString() }} · 文件工具</p>
                <p v-if="changeRun && artifact.artifactIds.length > 1" class="muted small">汇总 {{ artifact.artifactIds.length }} 次实际修改：首次修改前 → 最后修改后。</p>
                <p class="muted small break-word">{{ artifact.path }}</p>
                <UiDiff :key="artifact.id" :path="displayFilePath(artifact.path, workspace.selected?.directory)" :before="artifact.oldContent" :after="artifact.newContent" />
                <details><summary>快照身份</summary><p class="muted small break-word">{{ changeRun ? `关联 ${artifact.artifactIds.length} 个已保存快照` : `轮次 ${artifact.turnId}` }}<br />SHA-256 {{ artifact.hash }}</p></details>
            </template>
            <div v-else-if="!changeRun" class="empty-state"><Icon name="history" /><h3>还没有文件快照</h3><p>批准文件改动后，该轮次的内容会保存在这里。磁盘后续修改不会覆盖历史。</p></div>
            </template>
        </UiTabPanel>
        <UiTabPanel :model-value="workspace.panel.tab" value="browser" id-prefix="workspace" class="browser-panel">
            <div class="browser-controls"><label class="field-label" for="browser-address">手动浏览 · 当前会话独立登录态</label><div class="button-row"><UiInput id="browser-address" v-model="address" type="url" placeholder="https://" @keydown.enter="openBrowser" /><UiButton :disabled="busy || !workspace.selectedId || !workspace.connected" @click="openBrowser"><Icon name="external" />打开</UiButton><UiButton v-if="browserReady" :disabled="busy" aria-label="关闭网页" title="关闭网页" @click="closeBrowser"><Icon name="close" /></UiButton></div><p class="muted small">Agent 操作未授权。网站没有 UAH 文件和运行权限。</p></div>
            <div ref="browserArea" class="browser-host-area"><p v-if="!browserReady" class="muted">{{ workspace.selectedId ? '输入 HTTPS 地址以打开网页。' : '建立会话后可使用独立浏览器。' }}</p></div>
        </UiTabPanel>
        <UiTabPanel :model-value="workspace.panel.tab" value="native" id-prefix="workspace" class="panel-content"><div class="eyebrow">WINDOWS · 只读</div><h3>观察当前前台窗口</h3><p class="muted">手动读取窗口和 UI Automation 根元素信息。不会截图、点击或输入。</p><UiButton class="panel-action" :disabled="busy || !workspace.connected" @click="observe"><Icon name="monitor" />{{ busy ? '正在观察…' : '读取窗口信息' }}</UiButton><pre v-if="observation" class="snapshot-code observation">{{ JSON.stringify(observation, null, 4) }}</pre></UiTabPanel>
    </aside>
</template>
