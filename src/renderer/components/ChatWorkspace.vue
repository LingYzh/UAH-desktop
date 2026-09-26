<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useWorkspace, stateLabels } from '../stores/workspace';
import Icon from './Icon.vue';
import { UiButton, UiSelect } from '@lingyzh/ui';

const workspace = useWorkspace();
const { selected, selectedId, runs, activeRun, currentInput } = storeToRefs(workspace);
const scroll = ref(null);
const composer = ref(null);
const multiline = ref(false);
const directory = computed(() => selected.value?.directory || workspace.draft.directory);
const directoryName = computed(() => directory.value?.split(/[\\/]/).filter(Boolean).at(-1) || '选择目录（可跳过）');
const following = ref(true);
const positions = new Map();
const available = computed(() => workspace.connected && workspace.ready && !workspace.busy);
const pendingApprovals = (run) => workspace.snapshot.approvals.filter((item) => item.runId === run.id && item.status === 'pending');
const artifacts = (run) => workspace.snapshot.artifacts.filter((item) => item.runId === run.id);
let composerObserver;
let composerWidth = 0;

function resizeComposer() {
    const element = composer.value;
    if (!element?.getClientRects().length) return;
    element.style.height = 'auto';
    const height = Math.max(25, Math.min(element.scrollHeight, 180));
    element.style.height = `${height}px`;
    multiline.value = height > 25;
}

function rememberScroll() {
    const element = scroll.value;
    if (!element?.getClientRects().length || workspace.page !== 'chat') return;
    following.value = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
    positions.set(selectedId.value || 'draft', { top: element.scrollTop, following: following.value });
}
watch(selectedId, async (_id, previous) => {
    if (scroll.value?.getClientRects().length) positions.set(previous || 'draft', { top: scroll.value.scrollTop, following: following.value });
    await nextTick();
    const saved = positions.get(selectedId.value || 'draft');
    following.value = saved?.following ?? true;
    if (scroll.value) scroll.value.scrollTop = saved?.top ?? scroll.value.scrollHeight;
}, { flush: 'pre' });
watch(() => workspace.page, async (page, previous) => {
    if (previous === 'chat' && scroll.value?.getClientRects().length) {
        positions.set(selectedId.value || 'draft', { top: scroll.value.scrollTop, following: following.value });
    }
    if (page === 'chat') {
        await nextTick();
        const saved = positions.get(selectedId.value || 'draft');
        following.value = saved?.following ?? true;
        if (scroll.value) scroll.value.scrollTop = following.value ? scroll.value.scrollHeight : saved?.top ?? 0;
        resizeComposer();
    }
}, { flush: 'pre' });
watch(() => runs.value.map((run) => `${run.id}:${run.output.length}:${run.state}`).join(','), async () => {
    await nextTick();
    if (workspace.page === 'chat' && scroll.value?.getClientRects().length && following.value) {
        scroll.value.scrollTop = scroll.value.scrollHeight;
    }
});
watch(currentInput, async () => {
    await nextTick();
    resizeComposer();
});
function keydown(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        workspace.send();
    }
}
function showArtifact(artifact) {
    workspace.panel.artifactId = artifact.id;
    workspace.panel.tab = 'files';
    workspace.panel.open = true;
}
async function applySuggestion(prompt) {
    currentInput.value = prompt;
    await nextTick();
    composer.value?.focus();
}
onMounted(() => {
    resizeComposer();
    composerObserver = new ResizeObserver(([entry]) => {
        if (entry.contentRect.width !== composerWidth) {
            composerWidth = entry.contentRect.width;
            resizeComposer();
        }
    });
    if (composer.value) composerObserver.observe(composer.value);
});
onBeforeUnmount(() => { rememberScroll(); composerObserver?.disconnect(); });
</script>

<template>
    <section class="chat-workspace" :class="{ 'empty-chat': !runs.length }" aria-label="对话">
        <header class="workspace-header" :class="{ 'home-header': !runs.length }">
            <div class="header-title"><span v-if="runs.length" class="eyebrow">本地工作区</span><h1>{{ selected?.title || '新对话' }}</h1></div>
            <button class="quiet-button" :aria-expanded="workspace.panel.open" @click="workspace.panel.open = !workspace.panel.open">{{ workspace.panel.open ? '收起面板' : '工作面板' }} <Icon name="panelRight" /></button>
        </header>
        <div ref="scroll" class="chat-scroll" @scroll.passive="rememberScroll">
            <div v-if="!runs.length" class="welcome">
                <div class="home-greeting"><img class="brand-symbol" src="/assets/uah-mark.svg" alt="" /><h2>今天，我们一起做点什么？</h2></div>
                <p class="home-sub">从问题或项目出发，让想法在这里继续。</p>
                <div class="quick-prompts" aria-label="开始方式">
                    <button @click="applySuggestion('请梳理这个项目的结构，说明主要模块及它们的关系。')"><Icon name="code" />梳理项目结构</button>
                    <button @click="applySuggestion('检查最近的代码改动，指出值得关注的风险。')"><Icon name="diff" />检查最近的改动</button>
                    <button @click="applySuggestion('先阅读项目规范，再为我的需求制定实施计划。')"><Icon name="plan" />先做一个实施计划</button>
                </div>
            </div>
            <div class="messages">
                <article v-for="(run, index) in runs" :key="run.id" class="turn" :aria-label="`第 ${index + 1} 轮`">
                    <div class="user-message">{{ run.input }}</div>
                    <div class="assistant-heading"><img class="small-mark" src="/assets/uah-mark.svg" alt="" /><strong>UAH</strong><span class="muted">本地验证</span><span class="status" :data-state="run.state">{{ stateLabels[run.state] }}</span></div>
                    <div class="assistant-message">{{ run.output || '正在准备…' }}</div>
                    <div v-if="run.error" class="inline-error" role="alert">{{ run.error }}</div>
                    <div v-for="approval in pendingApprovals(run)" :key="approval.requestId" class="approval-card">
                        <div class="eyebrow">需要你的批准</div>
                        <h3>{{ approval.summary }}</h3>
                        <code>{{ approval.path }}</code>
                        <p>仅授权本次文件创建。查看面板不会批准操作。</p>
                        <div class="button-row"><UiButton variant="primary" :disabled="workspace.busy" @click="workspace.resolve(approval, 'approve')">批准本次操作</UiButton><UiButton :disabled="workspace.busy" @click="workspace.resolve(approval, 'reject')">拒绝</UiButton></div>
                    </div>
                    <div class="artifact-list">
                        <button v-for="artifact in artifacts(run)" :key="artifact.id" class="artifact-row" @click="showArtifact(artifact)"><Icon name="external" />{{ artifact.path.split(/[\\/]/).at(-1) }} <span class="muted">查看第 {{ index + 1 }} 轮快照</span></button>
                        <span v-if="!artifacts(run).length && ['completed', 'stopped', 'failed'].includes(run.state)" class="muted small">本轮无文件改动</span>
                    </div>
                </article>
            </div>
        </div>
        <div class="composer-dock">
            <div class="directory-row">
                <button class="location-chip directory-chip" :disabled="Boolean(selected) || !available" :title="directory || '选择工作目录，可跳过'" aria-label="选择工作目录（可选）" @click="workspace.chooseDirectory"><Icon name="folder" /><span class="ellipsis">{{ directoryName }}</span><Icon name="down" /></button>
                <button v-if="!selected && directory" class="location-chip" aria-label="移除工作目录" @click="workspace.draft.directory = null"><Icon name="close" /></button>
                <span class="location-chip branch-chip" :title="directory ? 'Git 信息尚未接入' : '当前未绑定项目目录'"><Icon name="branch" /><span>{{ directory ? 'Git 未接入' : '没有仓库' }}</span></span>
                <span class="location-path ellipsis" :title="directory || ''">{{ directory || '无目录对话可直接发送；项目文件需先绑定目录' }}</span>
            </div>
            <div class="composer">
                <div class="composer-main" :class="{ multiline }">
                    <button class="icon-button attach-trigger" aria-label="添加附件与上下文" title="附件功能尚未接入" disabled><Icon name="plus" /></button>
                    <textarea ref="composer" v-model="currentInput" rows="1" aria-label="消息" :placeholder="!selected ? '描述任务或提出问题…' : activeRun ? '补充想法，停止当前任务后发送…' : '继续这段对话…'" :maxlength="20000" @keydown="keydown"></textarea>
                    <button v-if="activeRun" class="send-button stop-button" :disabled="workspace.busy || ['stopping', 'cancelRequested'].includes(activeRun.state)" aria-label="停止当前任务" title="停止当前任务" @click="workspace.stop(activeRun)"><Icon name="stop" /></button>
                    <button v-else class="send-button" :disabled="!available || !currentInput.trim() || (!selected && !workspace.draft.model)" aria-label="发送消息" title="发送消息" @click="workspace.send"><Icon name="arrow" /></button>
                </div>
            </div>
            <div class="composer-options">
                <button class="composer-control" title="当前为本地验证 Agent；Agent 管理尚未接入" disabled><Icon name="code" /><span>本地助手</span><Icon name="down" /></button>
                <UiSelect compact v-if="!selected" v-model="workspace.draft.model" aria-label="运行模型"><option value="" disabled>选择模型</option><option value="local-verification">本地验证（非 AI）</option></UiSelect>
                <button v-else class="composer-control model-control" title="本会话使用本地验证运行时，不调用 AI" disabled>本地验证（非 AI）<Icon name="down" /></button>
                <span class="control-divider" aria-hidden="true"></span>
                <button class="composer-control" title="仅允许审批后创建验证文件；权限切换尚未接入" disabled><Icon name="shield" />需审批<Icon name="down" /></button>
                <button class="composer-control" title="本地验证运行时没有模型思考参数" disabled>思考未接入<Icon name="down" /></button>
                <span class="context-status" title="本地验证运行时没有模型上下文用量"><span class="context-ring" aria-hidden="true"></span>未统计</span>
            </div>
            <div class="composer-foot">Enter 发送 · Shift+Enter 换行 · 当前为本地验证，不调用 AI</div>
        </div>
    </section>
</template>
