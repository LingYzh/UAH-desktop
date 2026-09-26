<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useWorkspace } from '../stores/workspace';
import Icon from './Icon.vue';
import { UiButton, UiInput, UiSelect, UiTabs, UiTabPanel } from '@lingyzh/ui';

const props = defineProps({ suspended: Boolean });
const workspace = useWorkspace();
const browserArea = ref(null);
const address = ref('https://example.com');
const browserReady = ref(false);
const busy = ref(false);
const error = ref('');
const observation = ref(null);
const tabs = [
    { id: 'files', label: '历史快照', icon: 'history' },
    { id: 'browser', label: '浏览器', icon: 'globe' },
    { id: 'native', label: '桌面观察', icon: 'monitor' }
];
const artifacts = computed(() => workspace.snapshot.artifacts.filter((item) => item.sessionId === workspace.selectedId));
const artifact = computed(() => artifacts.value.find((item) => item.id === workspace.panel.artifactId) || artifacts.value.at(-1));
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
        <header class="panel-header"><strong>工作面板</strong><UiButton variant="ghost" size="sm" class="text-button panel-close" aria-label="返回对话 ×" @click="workspace.panel.open = false">返回对话<Icon name="close" /></UiButton></header>
        <UiTabs dense variant="underline" v-model="workspace.panel.tab" class="panel-tabs" id-prefix="workspace" :items="tabs" aria-label="工作面板内容"><template #default="{ item }"><Icon :name="item.icon" />{{ item.label }}</template></UiTabs>
        <div v-if="error" class="inline-error" role="alert">{{ error }}</div>
        <UiTabPanel :model-value="workspace.panel.tab" value="files" id-prefix="workspace" class="panel-content">
            <template v-if="artifact"><label class="field-label" for="snapshot-choice">本会话的不可变快照</label><UiSelect id="snapshot-choice" v-model="workspace.panel.artifactId"><option v-for="item in artifacts" :key="item.id" :value="item.id">{{ item.path.split(/[\\/]/).at(-1) }}</option></UiSelect><h3>{{ artifact.path.split(/[\\/]/).at(-1) }}</h3><p class="muted small">{{ new Date(artifact.createdAt).toLocaleString() }} · 文件工具</p><p class="muted small break-word">{{ artifact.path }}</p><div class="diff-label">原内容</div><pre class="snapshot-code old">{{ artifact.oldContent ?? '（新建文件）' }}</pre><div class="diff-label">保存的新内容</div><pre class="snapshot-code">{{ artifact.newContent }}</pre><details><summary>快照身份</summary><p class="muted small break-word">轮次 {{ artifact.turnId }}<br />SHA-256 {{ artifact.hash }}</p></details></template>
            <div v-else class="empty-state"><Icon name="history" /><h3>还没有文件快照</h3><p>批准文件改动后，该轮次的内容会保存在这里。磁盘后续修改不会覆盖历史。</p></div>
        </UiTabPanel>
        <UiTabPanel :model-value="workspace.panel.tab" value="browser" id-prefix="workspace" class="browser-panel">
            <div class="browser-controls"><label class="field-label" for="browser-address">手动浏览 · 当前会话独立登录态</label><div class="button-row"><UiInput id="browser-address" v-model="address" type="url" placeholder="https://" @keydown.enter="openBrowser" /><UiButton :disabled="busy || !workspace.selectedId || !workspace.connected" @click="openBrowser"><Icon name="external" />打开</UiButton><UiButton v-if="browserReady" :disabled="busy" aria-label="关闭网页" title="关闭网页" @click="closeBrowser"><Icon name="close" /></UiButton></div><p class="muted small">Agent 操作未授权。网站没有 UAH 文件和运行权限。</p></div>
            <div ref="browserArea" class="browser-host-area"><p v-if="!browserReady" class="muted">{{ workspace.selectedId ? '输入 HTTPS 地址以打开网页。' : '建立会话后可使用独立浏览器。' }}</p></div>
        </UiTabPanel>
        <UiTabPanel :model-value="workspace.panel.tab" value="native" id-prefix="workspace" class="panel-content"><div class="eyebrow">WINDOWS · 只读</div><h3>观察当前前台窗口</h3><p class="muted">手动读取窗口和 UI Automation 根元素信息。不会截图、点击或输入。</p><UiButton class="panel-action" :disabled="busy || !workspace.connected" @click="observe"><Icon name="monitor" />{{ busy ? '正在观察…' : '读取窗口信息' }}</UiButton><pre v-if="observation" class="snapshot-code observation">{{ JSON.stringify(observation, null, 4) }}</pre></UiTabPanel>
    </aside>
</template>
