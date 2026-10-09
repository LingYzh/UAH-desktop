<script setup>
import { computed, ref, watch } from 'vue';
import { stateLabels } from '../stores/workspace';
import { overviewForSnapshot } from '../run-events';
import Icon from './Icon.vue';
import { UiButton, UiInput, UiDialog } from '@lingyzh/ui';

const props = defineProps({ open: Boolean, sessions: { type: Array, default: () => [] }, latestStates: Object, runs: { type: Array, default: () => [] } });
const emit = defineEmits(['close', 'select-session', 'navigate-settings', 'navigate-endpoints', 'navigate-extensions', 'present-change']);
const dialog = ref(null);
const input = ref(null);
const query = ref('');
const shortcuts = [
    { id: 'models', label: '模型与账号', disabled: false },
    { id: 'mcp', label: 'MCP 连接器', disabled: false },
    { id: 'plugins', label: '插件与技能', disabled: false },
    { id: 'settings', label: '设置', disabled: false }
];
const normalizedQuery = computed(() => query.value.trim().toLocaleLowerCase());
const sessions = computed(() => props.sessions.filter((item) => `${item.title} ${item.directory || ''}`.toLocaleLowerCase().includes(normalizedQuery.value)));
const entries = computed(() => shortcuts.filter((item) => item.label.toLocaleLowerCase().includes(normalizedQuery.value)));
const sessionStates = computed(() => new Map(Object.entries(props.latestStates || overviewForSnapshot({ runs: props.runs }).latestStates).map(([sessionId, run]) => [sessionId, stateLabels[run.state] || '就绪'])));
const directoryName = (item) => item.directory?.split(/[\\/]/).filter(Boolean).at(-1) || '无工作目录';
function focusSearch() { input.value?.focus(); input.value?.select(); }
let pendingSelection = null;
function close() { emit('close'); }
function selectSession(id) { pendingSelection = () => emit('select-session', id); close(); }
function selectShortcut(item) { pendingSelection = () => ['mcp', 'plugins'].includes(item.id) ? emit('navigate-extensions', item.id) : emit(item.id === 'models' ? 'navigate-endpoints' : 'navigate-settings'); close(); }
function closed() {
    const action = pendingSelection;
    pendingSelection = null;
    action?.();
}
watch(() => props.open, (open) => {
    if (open) { query.value = ''; pendingSelection = null; }
}, { flush: 'pre' });
function keydown(event) {
    if (event.isComposing || event.keyCode === 229) return;
    const results = [...dialog.value.element.querySelectorAll('[data-search-result]:not(:disabled)')];
    if (event.key === 'Enter' && event.target === input.value?.element) {
        event.preventDefault();
        results[0]?.click();
    } else if (['ArrowUp', 'ArrowDown'].includes(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        const items = [input.value?.element, ...results];
        const current = items.indexOf(document.activeElement);
        const step = event.key === 'ArrowDown' ? 1 : -1;
        items[(current + step + items.length) % items.length]?.focus();
    }
}
defineExpose({ focusSearch });
</script>

<template>
    <!-- The DOM overlay surface receives layout through public props/attrs, outside the parent's scoped root. -->
    <UiDialog ref="dialog" :open="open" :width="800" class="search-dialog d-flex flex-column" style="padding: 0; overflow: hidden" aria-labelledby="search-title"
        @update:open="close" @present-change="emit('present-change', $event)" @closed="closed" @keydown="keydown">
        <header class="search-header"><h2 id="search-title">搜索</h2><UiButton variant="ghost" size="sm" icon class="search-close ml-auto text-muted" aria-label="关闭搜索" @click="close"><Icon name="close" /></UiButton></header>
        <div class="search-body">
            <UiInput ref="input" v-model="query" class="search-box" type="text" autocomplete="off" autofocus placeholder="搜索会话、项目与设置" aria-label="搜索会话、项目与设置"><template #leading><Icon name="search" :size="16" /></template></UiInput>
            <div class="search-results">
                <div class="search-label">会话</div>
                <button v-for="item in sessions" :key="item.id" class="search-result" data-search-result :title="item.directory || '无工作目录'" @click="selectSession(item.id)"><Icon name="chat" :size="15" /><span class="search-copy">{{ item.title }}<small>{{ directoryName(item) }} · {{ sessionStates.get(item.id) || '就绪' }}</small></span></button>
                <p v-if="!sessions.length" class="search-empty">没有匹配的会话。</p>
                <div class="search-divider"></div>
                <div class="search-label">快捷入口</div>
                <button v-for="item in entries" :key="item.id" class="search-result" data-search-result :disabled="item.disabled" :title="item.disabled ? '尚未接入' : undefined" @click="selectShortcut(item)"><Icon name="chevron" :size="15" /><span>{{ item.label }}</span><small v-if="item.disabled" class="search-unavailable">尚未接入</small></button>
                <p v-if="!entries.length" class="search-empty">没有匹配的快捷入口。</p>
            </div>
            <p class="search-note">只搜索本机已有会话与快捷入口，不扫描磁盘。</p>
        </div>
    </UiDialog>
</template>

<style scoped>
.search-header { display: flex; align-items: center; gap: 12px; padding: 22px 25px 13px; flex-shrink: 0; }
.search-header h2 { margin: 0; font: 23px/1.4 var(--serif); }
.search-body { min-height: 0; overflow-y: auto; padding: 7px 25px 25px; }
.search-box { min-height: 40px; font-size: 12px; line-height: 20px; }
.search-results { margin-top: 15px; }
.search-label { margin-bottom: 8px; font-size: 11px; color: var(--muted); }
.search-result { width: 100%; min-height: 36px; display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 6px; font-size: 12px; line-height: 1.5; }
.search-result:hover:not(:disabled), .search-result:focus-visible { background: var(--soft); }
.search-result > .prototype-icon { color: var(--muted); }
.search-copy { min-width: 0; overflow-wrap: anywhere; }
.search-copy small { display: block; margin-top: 4px; color: var(--muted); font-size: 10px; line-height: 1.5; }
.search-unavailable { margin-left: auto; font-size: 10px; color: var(--muted); }
.search-divider { height: 1px; background: var(--line); margin: 14px 0; }
.search-empty, .search-note { font-size: 11px; color: var(--muted); line-height: 1.7; }
.search-empty { margin: 9px 0; }
.search-note { margin: 20px 0 0; }
</style>
