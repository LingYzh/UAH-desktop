<script setup>
import { clientError } from '../../shared/client-error.js';

import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { UiButton, UiCard, UiSelect, UiCodeBlock, UiScrollArea } from '@lingyzh/ui';
import { useWorkspace } from '../stores/workspace';
import { useGit } from '../composables/use-git';

const workspace = useWorkspace();
const directory = computed(() => workspace.selected ? workspace.selected.directory : workspace.draft.directory);
const terminal = computed(() => workspace.runs.filter(run => ['completed', 'stopped', 'failed'].includes(run.state)).map(run => `${run.id}:${run.state}`).join(','));
const { result, busy, error, refresh, query } = useGit(directory, () => workspace.selectedId, () => terminal.value);
const snapshot = computed(() => result.value?.snapshot);
const mode = ref('worktree');
const selectedPath = ref('');
const diff = ref(null);
const commits = ref(null);
const diffBusy = ref(false);
const logBusy = ref(false);
const diffError = ref('');
const logError = ref('');
let diffEpoch = 0;
let logEpoch = 0;
const file = computed(() => snapshot.value?.files.find(item => item.path === selectedPath.value));
async function loadDiff() {
    const generation = ++diffEpoch;
    diffBusy.value = true;
    diffError.value = '';
    diff.value = null;
    try {
        const response = await query('diff', { staged: mode.value === 'index', ...(selectedPath.value ? { path: selectedPath.value } : {}) });
        if (generation === diffEpoch && response) diff.value = response;
    } catch (cause) { if (generation === diffEpoch) diffError.value = clientError(cause); }
    finally { if (generation === diffEpoch) diffBusy.value = false; }
}
async function loadLog() {
    const generation = ++logEpoch;
    logBusy.value = true;
    logError.value = '';
    commits.value = null;
    try {
        const response = await query('log');
        if (generation === logEpoch && response) commits.value = response;
    } catch (cause) { if (generation === logEpoch) logError.value = clientError(cause); }
    finally { if (generation === logEpoch) logBusy.value = false; }
}
async function refreshAll() {
    await refresh();
}
watch(() => [workspace.selectedId, directory.value], () => {
    diffEpoch++; logEpoch++;
    diff.value = null; commits.value = null;
    diffBusy.value = false; logBusy.value = false;
    diffError.value = ''; logError.value = '';
    selectedPath.value = ''; mode.value = 'worktree';
}, { flush: 'sync' });
watch(() => snapshot.value?.capturedAt, () => {
    if (snapshot.value?.state === 'ready') {
        if (selectedPath.value && !snapshot.value.files.some(item => item.path === selectedPath.value)) selectedPath.value = '';
        loadDiff(); loadLog();
    }
});
watch([mode, selectedPath], () => { if (snapshot.value?.state === 'ready') loadDiff(); });
onBeforeUnmount(() => { diffEpoch++; logEpoch++; });
</script>

<template>
    <div class="d-flex flex-column ga-4">
        <div class="d-flex align-center justify-space-between ga-2"><strong>Git · 只读</strong><UiButton size="sm" variant="ghost" :disabled="busy || diffBusy || logBusy" @click="refreshAll">{{ busy ? '正在刷新…' : '刷新 Git' }}</UiButton></div>
        <p class="muted small break-word">{{ directory || '当前会话未绑定目录' }}</p>
        <p v-if="busy" role="status" class="muted small">正在读取仓库状态…</p>
        <p v-if="error" role="alert" class="muted small">{{ error }}</p>
        <p v-if="snapshot && snapshot.state !== 'ready'" role="status" class="muted">{{ snapshot.message || ({ 'no-directory': '当前没有目录。', 'not-repository': '此目录不是 Git 仓库。', unavailable: 'Git 不可用。', error: '无法读取仓库。' })[snapshot.state] }}</p>
        <template v-if="snapshot?.state === 'ready'">
            <p v-if="snapshot.message" class="muted small">{{ snapshot.message }}</p>
            <UiCard :title="snapshot.branch || '分离 HEAD'" :subtitle="snapshot.head || '尚无提交'" density="compact">
                <p class="muted small break-word">上游：{{ snapshot.upstream || '未设置' }}</p>
                <p v-if="snapshot.ahead !== undefined || snapshot.behind !== undefined" class="muted small">领先 {{ snapshot.ahead ?? '未知' }} · 落后 {{ snapshot.behind ?? '未知' }}</p>
                <p class="muted small">读取于 {{ new Date(snapshot.capturedAt).toLocaleString() }}</p>
            </UiCard>
            <div><label for="git-file-choice" class="field-label">工作区文件 · {{ snapshot.files.length }}</label><UiSelect id="git-file-choice" v-model="selectedPath"><option value="">全部改动</option><option v-for="item in snapshot.files" :key="item.path" :value="item.path">{{ item.indexStatus || ' ' }}{{ item.worktreeStatus || ' ' }} · {{ item.path }}{{ item.untracked ? ' · 未跟踪' : '' }}</option></UiSelect></div>
            <p v-if="!snapshot.files.length" class="muted small">当前目录范围内没有检测到文件改动。</p>
            <p v-if="snapshot.truncated" role="status" class="muted small">文件列表已截断，未显示全部改动。</p>
            <UiScrollArea v-if="snapshot.files.length" label="Git 文件状态" max-height="220px"><div class="d-flex flex-column ga-2"><UiButton v-for="item in snapshot.files" :key="item.path" variant="ghost" size="sm" :title="item.path" @click="selectedPath = item.path"><span class="break-word">{{ item.path }}</span><span class="muted small">暂存 {{ item.indexStatus || '—' }} · 工作区 {{ item.worktreeStatus || '—' }}{{ item.untracked ? ' · 未跟踪' : '' }}</span></UiButton></div></UiScrollArea>
            <p v-if="file?.originalPath" class="muted small break-word">原路径：{{ file.originalPath }}</p>
            <p v-if="file?.untracked" class="muted small">未跟踪文件尚无 Git 差异；这里不会读取其文件正文。</p>
            <div><label for="git-diff-mode" class="field-label">磁盘当前差异</label><UiSelect id="git-diff-mode" v-model="mode" :disabled="diffBusy"><option value="worktree">未暂存 · 工作区对索引</option><option value="index">已暂存 · 索引对 HEAD</option></UiSelect></div>
            <p v-if="diffBusy" role="status" class="muted small">正在读取差异…</p><p v-if="diffError" role="alert" class="muted small">{{ diffError }}</p>
            <template v-if="diff"><p v-if="diff.snapshot.state !== 'ready'" class="muted small">{{ diff.snapshot.message }}</p><UiCodeBlock v-else-if="diff.diff" :code="diff.diff" language="diff" /><p v-else class="muted small">此范围没有差异。</p><p v-if="diff.truncated" role="status" class="muted small">差异已截断。</p></template>
            <div class="d-flex align-center justify-space-between"><strong>近期提交</strong><UiButton size="sm" variant="ghost" :disabled="logBusy" @click="loadLog">{{ logBusy ? '正在读取…' : '刷新提交' }}</UiButton></div>
            <p v-if="logError" role="alert" class="muted small">{{ logError }}</p>
            <template v-if="commits"><p v-if="commits.snapshot.state !== 'ready'" class="muted small">{{ commits.snapshot.message }}</p><p v-else-if="!commits.commits?.length" class="muted small">还没有提交。</p><UiCard v-for="commit in commits.commits || []" :key="commit.hash" :title="commit.subject" :subtitle="`${commit.shortHash} · ${commit.date}`" dense /><p v-if="commits.truncated" class="muted small">提交列表已截断。</p></template>
        </template>
    </div>
</template>
