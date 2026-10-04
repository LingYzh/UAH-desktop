<script setup>
import { clientError } from '../shared/client-error.js';

import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useWorkspace, stateLabels } from './stores/workspace';
import { overviewForSnapshot } from './run-events';
import ChatWorkspace from './components/ChatWorkspace.vue';
import Icon from './components/Icon.vue';
import WorkspacePanel from './components/WorkspacePanel.vue';
import SearchDialog from './components/SearchDialog.vue';
import EndpointManager from './components/EndpointManager.vue';
import AgentManager from './components/AgentManager.vue';
import ExtensionManager from './components/ExtensionManager.vue';
import { UiAlert, UiButton, UiSelect, UiSwitch, UiField, UiTabs, UiTabPanel, UiDialog, UiSnackbarHost, snackbar } from '@lingyzh/ui';

const workspace = useWorkspace();
const width = ref(window.innerWidth);
const collapsed = ref(false);
const narrowNavigationExpanded = ref(false);
const settings = reactive({ theme: 'light', reduced: false, font: 'system', codeSize: 13 });
const settingsDraft = reactive({ ...settings });
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const systemReduced = ref(motionQuery.matches);
const systemDark = ref(darkQuery.matches);
const effectiveReduced = computed(() => settings.reduced || systemReduced.value);
const dirty = computed(() => JSON.stringify(settings) !== JSON.stringify(settingsDraft));
const leaveIntent = ref(null);
const confirmOpen = ref(false);
const confirmPresent = ref(false);
const searchPresent = ref(false);
let afterConfirm = null;
const searchOpen = ref(false);
const searchDialog = ref(null);
const settingsSection = ref('appearance');
const themes = [{ id: 'light', label: '浅色' }, { id: 'dark', label: '深色' }, { id: 'system', label: '跟随系统' }];
const customizedPanelWidths = new Set();
let drag;
const compact = computed(() => collapsed.value || (workspace.page === 'chat' && workspace.panel.open && width.value < 1099) || (width.value < 900 && !narrowNavigationExpanded.value));
const panelFocus = computed(() => workspace.panel.open && width.value < 800);
const panelVisible = computed(() => workspace.panel.open && workspace.page === 'chat');
const navWidth = computed(() => compact.value ? 57 : 254);
const maxPanelWidth = computed(() => Math.max(260, width.value - navWidth.value - 5 - 370));
const panelWidth = computed(() => Math.min(maxPanelWidth.value, Math.max(260, workspace.panel.width)));
const layoutStyle = computed(() => ({ '--nav-width': `${navWidth.value}px`, '--panel-width': `${panelWidth.value}px` }));
const overview = computed(() => overviewForSnapshot(workspace.snapshot));
const lastRun = (sessionId) => overview.value.rootStates[sessionId];
const activeCount = computed(() => overview.value.activeRunIds.length);
const futureFeatures = [
    { label: 'MCP 连接器', icon: 'plug', page: 'mcp' },
    { label: '插件与技能', icon: 'puzzle', page: 'plugins' }
];
function openSearch() {
    if (leaveIntent.value) return;
    if (searchOpen.value) searchDialog.value?.focusSearch();
    else searchOpen.value = true;
}
function selectSearchSession(id) {
    searchOpen.value = false;
    navigate(() => workspace.select(id));
}
function selectSearchSettings() {
    searchOpen.value = false;
    showSettings();
}
function selectSearchEndpoints() {
    searchOpen.value = false;
    navigate(() => workspace.page = 'endpoints');
}
watch(() => workspace.selectedId, (id) => {
    const key = id || 'draft';
    if (!customizedPanelWidths.has(key) && workspace.panel.width === 390) workspace.panel.width = 470;
}, { immediate: true });

function applyPreferences() {
    const selectedTheme = workspace.page === 'settings' ? settingsDraft.theme : settings.theme;
    const theme = selectedTheme === 'system' ? (systemDark.value ? 'dark' : 'light') : selectedTheme;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.reducedMotion = String(effectiveReduced.value);
    document.documentElement.dataset.font = settings.font;
    document.documentElement.style.setProperty('--code-size', `${settings.codeSize}px`);
    window.uah?.setWindowTheme?.(theme)?.catch(() => {});
}
watch([settings, systemReduced, systemDark, () => settingsDraft.theme, () => workspace.page], applyPreferences, { deep: true });
function saveSettings() {
    try {
        localStorage.setItem('uah-desktop-preferences-v1', JSON.stringify(settingsDraft));
        Object.assign(settings, settingsDraft);
        snackbar.show('设置已保存', { tone: 'success' });
        return true;
    } catch { workspace.error = '设置无法保存到本机，请检查存储权限。'; return false; }
}
function themeKey(event, index) {
    const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0;
    if (!direction && !['Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? themes.length - 1 : (index + direction + themes.length) % themes.length;
    settingsDraft.theme = themes[target].id;
    event.currentTarget.parentElement.children[target].focus();
}
function navigate(action) {
    if (workspace.page === 'settings' && dirty.value) {
        leaveIntent.value = action;
        confirmOpen.value = true;
    } else action();
}
function resolveLeave(choice) {
    if (!leaveIntent.value) return;
    if (choice === 'save' && !saveSettings()) return;
    if (choice === 'discard') Object.assign(settingsDraft, settings);
    const action = leaveIntent.value;
    leaveIntent.value = null;
    afterConfirm = choice !== 'cancel' ? action : null;
    confirmOpen.value = false;
}
function confirmClosed() { const action = afterConfirm; afterConfirm = null; action?.(); }
function showSettings() {
    if (workspace.page === 'settings') return;
    Object.assign(settingsDraft, settings);
    workspace.page = 'settings';
    window.uah?.browser({ type: 'hide' }).catch(() => {});
}
function togglePanel() {
    if (!workspace.panel.open && !customizedPanelWidths.has(workspace.selectedId || 'draft') && workspace.panel.width === 390) {
        workspace.panel.width = 470;
    }
    workspace.panel.open = !workspace.panel.open;
}
function toggleNavigation() {
    if (compact.value) {
        collapsed.value = false;
        narrowNavigationExpanded.value = true;
        if (panelVisible.value && width.value < 1099) workspace.panel.open = false;
    } else {
        collapsed.value = true;
        narrowNavigationExpanded.value = false;
    }
}
function handleGlobalShortcut(event) {
    if (event.isComposing || event.keyCode === 229 || !(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (['k', 'n'].includes(key) && document.querySelector('dialog[open]:not(.search-dialog)')) {
        event.preventDefault();
        return;
    }
    if (key === 'k') {
        event.preventDefault();
        openSearch();
    } else if (key === 'n') {
        event.preventDefault();
        if (leaveIntent.value) return;
        searchOpen.value = false;
        navigate(workspace.newSession);
    }
}
function resizeWindow() {
    width.value = window.innerWidth;
    if (width.value >= 900) narrowNavigationExpanded.value = false;
}
function startResize(event) {
    if (event.button !== 0) return;
    drag = { pointer: event.pointerId, element: event.currentTarget };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing');
}
function moveResize(event) {
    if (!drag) return;
    customizedPanelWidths.add(workspace.selectedId || 'draft');
    workspace.panel.width = Math.min(maxPanelWidth.value, Math.max(260, width.value - event.clientX));
}
function finishResize() {
    if (drag?.element.hasPointerCapture(drag.pointer)) drag.element.releasePointerCapture(drag.pointer);
    drag = null;
    document.body.classList.remove('resizing');
}
function resizeKey(event) {
    const values = { ArrowLeft: panelWidth.value + 20, ArrowRight: panelWidth.value - 20, Home: 260, End: maxPanelWidth.value };
    if (!(event.key in values)) return;
    event.preventDefault();
    customizedPanelWidths.add(workspace.selectedId || 'draft');
    workspace.panel.width = Math.max(260, Math.min(maxPanelWidth.value, values[event.key]));
}
onMounted(() => {
    try {
        const stored = JSON.parse(localStorage.getItem('uah-desktop-preferences-v1') || 'null');
        if (stored && ['light', 'dark', 'system'].includes(stored.theme) && typeof stored.reduced === 'boolean' && ['system', 'serif'].includes(stored.font) && [12, 13, 14, 16].includes(stored.codeSize)) {
            Object.assign(settings, { theme: stored.theme, reduced: stored.reduced, font: stored.font, codeSize: stored.codeSize });
            Object.assign(settingsDraft, settings);
        }
    } catch { /* Invalid preferences fall back to visible defaults. */ }
    applyPreferences();
    workspace.initialize();
    window.addEventListener('resize', resizeWindow);
    window.addEventListener('blur', finishResize);
    window.addEventListener('keydown', handleGlobalShortcut);
    motionQuery.addEventListener('change', motionChange);
    darkQuery.addEventListener('change', darkChange);
});
function motionChange(event) { systemReduced.value = event.matches; }
function darkChange(event) { systemDark.value = event.matches; }
onBeforeUnmount(() => {
    workspace.dispose();
    finishResize();
    window.removeEventListener('resize', resizeWindow);
    window.removeEventListener('blur', finishResize);
    window.removeEventListener('keydown', handleGlobalShortcut);
    motionQuery.removeEventListener('change', motionChange);
    darkQuery.removeEventListener('change', darkChange);
});
</script>

<template>
    <div class="app-shell" :class="{ 'compact-navigation': compact }" :style="layoutStyle">
        <div class="titlebar">
            <div class="titlebar-brand"><template v-if="!compact"><img src="/assets/uah-mark.svg" alt="" /><span>Used AI Harness</span></template><UiButton class="navigation-toggle" variant="ghost" size="sm" icon aria-label="收起或展开导航" :aria-expanded="!compact" title="收起或展开导航" @click="toggleNavigation"><Icon name="panel" /></UiButton></div>
            <div class="titlebar-center">本地工作区</div>
            <div class="titlebar-system-space" aria-hidden="true"></div>
        </div>
        <div class="desktop" :class="{ compact, 'panel-open': workspace.panel.open && workspace.page === 'chat', 'panel-focus': panelFocus && workspace.page === 'chat' }">
            <aside class="sidebar" aria-label="主导航">
                <button class="nav-button new-chat" title="新对话" :aria-current="!workspace.selectedId && workspace.page === 'chat' ? 'page' : undefined" @click="navigate(workspace.newSession)"><Icon name="edit" /><span class="nav-label">新对话</span></button>
                <button class="nav-button search-toggle" title="搜索会话、项目与设置" aria-haspopup="dialog" :aria-expanded="searchOpen" @click="openSearch"><Icon name="search" /><span class="nav-label">搜索</span><kbd v-if="!compact" class="nav-shortcut">Ctrl K</kbd></button>
                <div class="nav-separator"></div>
                <div class="nav-section-title nav-label">快捷功能</div>
                <button class="nav-button" title="模型与账号" :aria-current="workspace.page === 'endpoints' ? 'page' : undefined" @click="navigate(() => workspace.page = 'endpoints')"><Icon name="models" /><span class="nav-label">模型与账号</span></button>
                <button class="nav-button" title="Agent" :aria-current="workspace.page === 'agents' ? 'page' : undefined" @click="navigate(() => workspace.page = 'agents')"><Icon name="agent" /><span class="nav-label">Agent</span></button>
                <nav class="shortcut-list" aria-label="快捷功能">
                    <button v-for="item in futureFeatures" :key="item.label" class="nav-button" :class="{ active: workspace.page === item.page }" :title="item.label" :aria-label="item.label" @click="navigate(() => workspace.page = item.page)"><Icon :name="item.icon" /><span class="nav-label">{{ item.label }}</span></button>
                </nav>
                <div class="nav-section-title nav-label">会话 <span>{{ workspace.snapshot.sessions.length }}</span></div>
                <nav class="session-list" aria-label="会话列表"><button v-for="item in workspace.snapshot.sessions" :key="item.id" class="session-button" :class="{ selected: workspace.selectedId === item.id && workspace.page === 'chat' }" :aria-current="workspace.selectedId === item.id ? 'page' : undefined" :title="`${item.title} · ${stateLabels[lastRun(item.id)?.state] || '就绪'}`" @click="navigate(() => workspace.select(item.id))"><span class="state-dot" :data-state="lastRun(item.id)?.state" aria-hidden="true"></span><span class="session-copy nav-label"><span>{{ item.title }}</span><small>{{ stateLabels[lastRun(item.id)?.state] || '就绪' }}</small></span></button><p v-if="!workspace.snapshot.sessions.length" class="sidebar-empty nav-label">发送第一条消息后，会话会保存在这里。</p></nav>
                <div class="sidebar-bottom"><button class="nav-button" title="设置" :aria-current="workspace.page === 'settings' ? 'page' : undefined" @click="showSettings"><Icon name="settings" /><span class="nav-label">设置</span></button><div class="workspace-identity"><div class="avatar">U</div><div class="nav-label"><strong>本地工作区</strong><small>{{ activeCount ? `${activeCount} 个任务进行中` : '对话历史保存在本机' }}</small></div></div></div>
            </aside>
            <main class="main-area" :inert="panelFocus && workspace.page === 'chat'">
                <div v-if="!workspace.connected" class="preview-banner">网页预览 · 运行、文件与桌面能力请使用 Electron 应用</div>
                <div v-if="workspace.error" class="global-error" role="alert"><span>{{ clientError(workspace.error) }}</span><button aria-label="关闭错误提示" @click="workspace.error = ''"><Icon name="close" /></button></div>
                <UiAlert v-for="id in workspace.snapshot.pendingSessionPurges || []" :key="id" tone="warning" class="ma-3">
                    会话 {{ id.slice(0, 8) }} 已移出历史，但文件、备份或浏览器清理尚未全部完成。
                    <UiButton size="sm" :disabled="workspace.busy" @click="workspace.retryPurge(id)">重试删除</UiButton>
                </UiAlert>
                <ChatWorkspace v-show="workspace.page === 'chat'" :class="{ 'view-enter': workspace.page === 'chat' }" />
                <EndpointManager v-if="workspace.page === 'endpoints'" />
                <AgentManager v-if="workspace.page === 'agents'" />
                <ExtensionManager v-if="['mcp', 'plugins'].includes(workspace.page)" :section="workspace.page" />
                <section v-show="workspace.page === 'settings'" class="settings-page" :class="{ 'view-enter': workspace.page === 'settings' }" aria-label="设置">
                    <div class="settings-layout">
                        <nav class="settings-navigation" aria-label="设置分类">
                            <h2>设置</h2>
                            <UiTabs v-model="settingsSection" id-prefix="settings" orientation="vertical" aria-label="设置分类" :items="[{ id: 'appearance', label: '外观', icon: 'sun' }, { id: 'about', label: '关于与能力', icon: 'info' }]"><template #default="{ item }"><Icon :name="item.icon" />{{ item.label }}</template></UiTabs>
                        </nav>
                        <div class="settings-body">
                            <UiTabPanel :model-value="settingsSection" value="appearance" id-prefix="settings">
                                <h2 class="settings-title">外观</h2>
                                <p class="muted">让工作台适合你的阅读习惯。</p>
                                <h3 class="section-heading" id="theme-label">主题</h3>
                                <div class="theme-grid" role="radiogroup" aria-labelledby="theme-label">
                                    <button v-for="(theme, index) in themes" :key="theme.id" class="theme-option" :class="{ selected: settingsDraft.theme === theme.id }" role="radio" :aria-label="theme.label" :aria-checked="settingsDraft.theme === theme.id" :tabindex="settingsDraft.theme === theme.id ? 0 : -1" @click="settingsDraft.theme = theme.id" @keydown="themeKey($event, index)">
                                        <span class="theme-preview" :class="theme.id" aria-hidden="true"><span></span><i></i><b></b></span>
                                        <span class="theme-option-label">{{ theme.label }}<Icon v-if="settingsDraft.theme === theme.id" name="check" :size="15" /></span>
                                    </button>
                                </div>
                                <div class="settings-grid">
                                    <UiField v-slot="{ controlAttrs }" label="字体" for="reading-font" description="界面使用系统字体；阅读标题采用系统衬线字体。"><UiSelect v-model="settingsDraft.font" v-bind="controlAttrs" aria-label="阅读字体"><option value="system">系统默认</option><option value="serif">衬线字体</option></UiSelect></UiField>
                                    <UiField v-slot="{ controlAttrs }" label="代码字号" for="code-size" description="独立调整代码和历史快照的阅读大小。"><UiSelect v-model="settingsDraft.codeSize" v-bind="controlAttrs"><option v-for="size in [12, 13, 14, 16]" :key="size" :value="size">{{ size }} px</option></UiSelect></UiField>
                                    <UiField v-slot="{ controlAttrs }" label="减少动效" for="reduce-motion" :description="systemReduced ? '系统已启用减少动效，应用将始终遵循。' : '关闭非必要过渡；始终尊重系统的减少动效设置。'"><UiSwitch v-model="settingsDraft.reduced" v-bind="controlAttrs" aria-label="减少动效" /></UiField>
                                    <UiField label="侧栏" description="收起后保留常用入口，让对话获得更多空间。"><UiButton size="sm" @click="toggleNavigation"><Icon name="panel" />{{ compact ? '展开侧栏' : '收起侧栏' }}</UiButton></UiField>
                                </div>
                                <div class="button-row settings-save"><UiButton variant="primary" :disabled="!dirty" @click="saveSettings">保存设置</UiButton><span class="muted small">{{ dirty ? '有未保存的更改' : '已保存' }}</span></div>
                            </UiTabPanel>
                            <UiTabPanel :model-value="settingsSection" value="about" id-prefix="settings" class="capability-summary"><h2 class="settings-title">关于与能力</h2><p>UAH · 本地桌面工作区</p><h3>当前可用</h3><p>三协议 API · 原生 Codex · 工作区文件工具与命令审批 · 计划与子代理 · 日志与用量 · MCP 连接器 · 插件与技能管理 · 独立浏览器</p><h3>能力边界</h3><p>原生 Codex 需要本机 CLI 与有效认证，运行记录为可观察事件的部分覆盖。插件支持 skills 与 MCP，不执行 hooks 和安装脚本。长期记忆、完整 PTY 与 Agent 电脑操作尚未接入。</p></UiTabPanel>
                        </div>
                    </div>
                </section>
            </main>
            <div class="panel-resizer" role="separator" :tabindex="panelVisible && !panelFocus ? 0 : -1" :aria-hidden="!panelVisible || panelFocus" :inert="!panelVisible || panelFocus" aria-label="调整工作面板宽度" aria-orientation="vertical" :aria-valuemin="260" :aria-valuemax="maxPanelWidth" :aria-valuenow="panelWidth" @pointerdown="startResize" @pointermove="moveResize" @pointerup="finishResize" @pointercancel="finishResize" @lostpointercapture="finishResize" @keydown="resizeKey"></div>
            <WorkspacePanel :suspended="searchOpen || searchPresent || confirmPresent || Boolean(leaveIntent)" :inert="!panelVisible" :aria-hidden="!panelVisible" />
        </div>
    </div>
    <SearchDialog ref="searchDialog" :open="searchOpen" :sessions="workspace.snapshot.sessions" :latest-states="overview.latestStates" @close="searchOpen = false" @present-change="searchPresent = $event" @select-session="selectSearchSession" @navigate-settings="selectSearchSettings" @navigate-endpoints="selectSearchEndpoints" @navigate-extensions="page => navigate(() => workspace.page = page)" />
    <UiSnackbarHost />
    <UiDialog v-model:open="confirmOpen" @present-change="confirmPresent = $event" @closed="confirmClosed" @update:open="resolveLeave('cancel')" class="confirm-dialog" aria-labelledby="dirty-title"><h2 id="dirty-title">保存设置更改？</h2><p>离开之前，可以保存或放弃本次修改。</p><div class="button-row"><UiButton @click="resolveLeave('cancel')">继续编辑</UiButton><UiButton @click="resolveLeave('discard')">放弃更改</UiButton><UiButton variant="primary" @click="resolveLeave('save')">保存并离开</UiButton></div></UiDialog>
</template>
