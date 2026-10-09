<script setup>
import { clientError } from '../../shared/client-error.js';

import NativeQuestionCard from './NativeQuestionCard.vue';
import NativeContextDialog from './NativeContextDialog.vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useWorkspace, stateLabels } from '../stores/workspace';
import Icon from './Icon.vue';
import RunContent from './RunContent.vue';
import RunActions from './RunActions.vue';
import { messageTime } from '../message-time';
import PlanReview from './PlanReview.vue';
import { UiButton, UiSelect, UiMarkdown, UiFileChanges, UiUsageMeter, UiMenu, UiMenuItem } from '@lingyzh/ui';
import RequestContextDialog from './RequestContextDialog.vue';
import JournalDialog from './JournalDialog.vue';
import RecoveryDialog from './RecoveryDialog.vue';
import GoalVerificationDialog from './GoalVerificationDialog.vue';
import { useGit } from '../composables/use-git';
import { openMarkdownLink } from '../markdown-links';
import { roundFileChanges } from '../file-changes';
import { fileChangeItem } from '../change-presentation';
import { currentPlanRun, planStatusLabels, planRunInput } from '../plan-presentation';
import { visibleRootRuns } from '../../shared/conversation-history';

const workspace = useWorkspace();
const journalOpen = ref(false);
const recoveryRun = ref(null);
const verificationRun = ref(null);
const { selected, selectedId, runs, activeRun, currentInput } = storeToRefs(workspace);
const canSteer = computed(() => activeRun.value?.effective?.runtimeId === 'api' && activeRun.value?.effective?.permissionMode !== 'plan'
    && ['running', 'approval'].includes(activeRun.value?.state));
const renderedRuns = computed(() => runs.value.slice(-workspace.historyLimit));
const hiddenTurns = computed(() => Math.max(0, workspace.historyTotal - renderedRuns.value.length));
async function loadEarlierTurns() {
    const element = scroll.value;
    const previousHeight = element?.scrollHeight ?? 0;
    const previousTop = element?.scrollTop ?? 0;
    const anchor = element && [...element.querySelectorAll('[data-run-id]')].find(item => item.getBoundingClientRect().bottom > element.getBoundingClientRect().top);
    const anchorId = anchor?.dataset.runId;
    const anchorTop = anchor?.getBoundingClientRect().top;
    following.value = false;
    const sessionId = selectedId.value;
    await workspace.loadEarlier();
    if (selectedId.value !== sessionId) return;
    await nextTick();
    if (element) {
        const restored = [...element.querySelectorAll('[data-run-id]')].find(item => item.dataset.runId === anchorId);
        element.scrollTop = restored && anchorTop !== undefined
            ? element.scrollTop + restored.getBoundingClientRect().top - anchorTop
            : previousTop + element.scrollHeight - previousHeight;
    }
}
const scroll = ref(null);
const messages = ref(null);
const composer = ref(null);
const multiline = ref(false);
const directory = computed(() => selected.value ? selected.value.directory : workspace.draft.directory);
const terminalRuns = computed(() => runs.value.filter(run => ['completed', 'stopped', 'failed'].includes(run.state)).map(run => `${run.id}:${run.state}`).join(','));
const git = useGit(directory, selectedId, () => terminalRuns.value);
watch(() => workspace.page, page => { if (page === 'chat') git.refresh(); });
const gitLabel = computed(() => {
    if (git.busy.value) return '读取 Git…';
    if (git.error.value) return 'Git 读取失败';
    const snapshot = git.result.value?.snapshot;
    if (!snapshot) return directory.value ? 'Git 状态未知' : '没有仓库';
    if (snapshot.state === 'ready') return `${snapshot.branch || '分离 HEAD'}${snapshot.files.length ? ` · ${snapshot.files.length} 项改动` : ''}`;
    return ({ 'no-directory': '没有仓库', 'not-repository': '非 Git 仓库', unavailable: 'Git 不可用', error: 'Git 读取失败' })[snapshot.state];
});
const contextOpen = ref(false);
const nativeContextRun = computed(() => visibleRootRuns(workspace.snapshot.runs, selectedId.value).filter(run => run.nativeContext).at(-1));
function fillNativeCommand(command, acceptsTask = false) {
    currentInput.value = acceptsTask ? `${command} ${currentInput.value}` : command;
    nextTick(() => composer.value?.focus());
}
function importFiles(event) {
    const files = [...(event.clipboardData?.files || event.dataTransfer?.files || [])];
    if (!files.length) return;
    event.preventDefault();
    if (!workspace.nativeMode || !available.value || activeRun.value) { workspace.error = '请在空闲的原生 Codex 对话中添加附件。'; return; }
    workspace.addAttachments(files);
}
const contextRun = computed(() => activeRun.value?.requestContext ? activeRun.value : visibleRootRuns(workspace.snapshot.runs, selectedId.value).filter(run => run.requestContext).at(-1));
const contextSummary = computed(() => contextRun.value?.requestContext);
watch(selectedId, () => { contextOpen.value = false; }, { flush: 'sync' });
function showGit() { workspace.panel.tab = 'git'; workspace.panel.open = true; }
const directoryName = computed(() => directory.value?.split(/[\\/]/).filter(Boolean).at(-1) || (selected.value || workspace.draft.directoryChosen ? '无目录' : '选择目录'));
const following = ref(true);
let readingDisclosure = false;
function inspectDisclosure(event) {
    if (!(event.target instanceof Element) || !event.target.closest('button[aria-expanded]')) return;
    readingDisclosure = true;
    following.value = false;
    cancelAnimationFrame(followFrame);
    followFrame = 0;
}
function resumeScrollIntent(event) {
    if (event.type !== 'keydown' || ['PageDown', 'PageUp', 'Home', 'End', 'ArrowDown', 'ArrowUp'].includes(event.key)) readingDisclosure = false;
}
const positions = new Map();
// A selected session can render an empty view while its IPC history is loading.
// Defer restoration so that the old/empty content cannot clamp and overwrite its saved position.
let pendingScrollKey;
function historyLoaded() {
    return !Object.hasOwn(workspace.snapshot, 'viewSessionId') || workspace.snapshot.viewSessionId === selectedId.value;
}
async function restoreScroll() {
    const key = selectedId.value || 'draft';
    await nextTick();
    if (pendingScrollKey !== key || !historyLoaded() || workspace.page !== 'chat' || !scroll.value?.getClientRects().length) return;
    const saved = positions.get(key);
    following.value = saved?.following ?? true;
    scroll.value.scrollTop = following.value ? scroll.value.scrollHeight : saved?.top ?? 0;
    pendingScrollKey = undefined;
}
const available = computed(() => workspace.connected && workspace.ready && !workspace.busy);
const apiMode = computed(() => workspace.currentModel && workspace.currentModel !== 'local-verification');
const inherited = computed(() => selected.value?.branchMessages || []);
const hasHistory = computed(() => runs.value.length > 0 || inherited.value.length > 0);
const currentPlan = computed(() => currentPlanRun(workspace.snapshot, selectedId.value));
const reviewPlan = computed(() => !workspace.nativeMode && workspace.sessionControls.permissionMode === 'plan'
    && currentPlan.value?.plan?.status === 'proposed' && currentPlan.value?.state === 'completed' && !activeRun.value ? currentPlan.value : null);
const permissionItems = computed(() => workspace.nativeMode ? [
    { value: 'readonly', label: '只读', description: 'Codex 只读文件沙箱；MCP 按原生配置运行。' },
    { value: 'manual', label: '默认权限', description: '允许工作区内操作；由 Codex 按需请求额外权限。' },
    { value: 'bypass', label: '完全访问', description: 'Codex 不限制文件和网络访问，也不请求执行审批。' },
] : [
    { value: 'manual', label: 'Manual', description: '读取工作区；修改文件和执行命令前询问。' },
    { value: 'accept-edits', label: 'Accept edits', description: '自动接受工作区内编辑；执行命令前询问。' },
    { value: 'plan', label: 'Plan', description: '只读调研并提交计划；审阅批准后开始实施。' },
    { value: 'readonly', label: 'Readonly', description: '只读取工作区；禁止修改和执行命令。' },
    { value: 'auto', label: 'Auto', description: '自动执行授权工作区内的操作。' },
    { value: 'bypass', label: 'Bypass permissions', description: '允许任意操作，跳过审批和工作区范围限制。' },
]);
const effortItems = [
    { value: 'default', label: '服务默认', description: '不发送强度或预算，由模型服务决定。' },
    { value: 'none', label: '关闭思考', description: '显式请求关闭思考，须模型支持。' },
    ...['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((value, index) => ({
        value, label: value, description: `${['极低', '低', '中', '高', '极高', '最大', '扩展'][index]}强度；须模型支持，越高通常耗时和用量越多。`,
    })),
];
function pendingNativeQuestions(run) {
    if (activeRun.value?.id !== run.id) return [];
    return workspace.snapshot.runs.filter(item => item.sessionId === run.sessionId && ['running', 'approval'].includes(item.state)).flatMap(item => (item.nativeQuestions || []).filter(question => question.status === 'pending').map(question => ({ ...question, runId: item.id })));
}
const pendingApprovals = (run) => workspace.snapshot.approvals.filter((item) => item.runId === run.id && !item.toolCallId && item.status === 'pending');
const changes = computed(() => Object.fromEntries(runs.value.map(run => [run.id, roundFileChanges(run, workspace.snapshot).map(item => fileChangeItem(item, selected.value?.directory))])));
let composerObserver;
let messagesObserver;
let followFrame = 0;
let composerWidth = 0;

function followContent() {
    if (pendingScrollKey || followFrame || readingDisclosure || !following.value) return;
    followFrame = requestAnimationFrame(() => {
        followFrame = 0;
        const element = scroll.value;
        const selection = window.getSelection();
        if (workspace.page !== 'chat' || !element?.getClientRects().length || !following.value) return;
        if (selection && !selection.isCollapsed && element.contains(selection.anchorNode)) return;
        element.scrollTop = element.scrollHeight;
    });
}

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
    if (pendingScrollKey || !historyLoaded() || !element?.getClientRects().length || workspace.page !== 'chat') return;
    if (!readingDisclosure) following.value = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
    positions.set(selectedId.value || 'draft', { top: element.scrollTop, following: following.value });
}
watch(selectedId, async (_id, previous) => {
    readingDisclosure = false;
    if (!pendingScrollKey && scroll.value?.getClientRects().length) positions.set(previous || 'draft', { top: scroll.value.scrollTop, following: following.value });
    pendingScrollKey = selectedId.value || 'draft';
    await restoreScroll();
}, { flush: 'pre' });
watch(() => workspace.page, async (page, previous) => {
    if (previous === 'chat' && scroll.value?.getClientRects().length) {
        positions.set(selectedId.value || 'draft', { top: scroll.value.scrollTop, following: following.value });
    }
    if (page === 'chat') {
        await nextTick();
        const saved = positions.get(selectedId.value || 'draft');
        following.value = saved?.following ?? true;
        if (pendingScrollKey) await restoreScroll();
        else if (scroll.value) scroll.value.scrollTop = following.value ? scroll.value.scrollHeight : saved?.top ?? 0;
        resizeComposer();
    }
}, { flush: 'pre' });
watch(() => [workspace.snapshot.viewSessionId, workspace.snapshot.runs.filter(run => run.sessionId === selectedId.value).map((run) => `${run.id}:${run.sequence}:${run.state}`).join(',')], async () => {
    await nextTick();
    if (pendingScrollKey) await restoreScroll();
    followContent();
});
watch(() => [selectedId.value, activeRun.value?.id], async ([sessionId, runId], [previousSessionId, previousRunId]) => {
    if (!runId || runId === previousRunId || sessionId !== previousSessionId) return;
    // An explicitly started turn returns to the latest message, including any
    // confirmation it needs; unfolding older content only pauses that turn.
    readingDisclosure = false;
    following.value = true;
    await nextTick();
    followContent();
});
watch(currentInput, async () => {
    await nextTick();
    resizeComposer();
});
watch(composer, async element => {
    composerObserver?.disconnect();
    if (element) composerObserver?.observe(element);
    await nextTick();
    resizeComposer();
}, { flush: 'post' });
function showPlan(run) {
    workspace.panel.planRunId = run.id;
    workspace.panel.planVersionId = run.plan.id;
    workspace.panel.tab = 'plans';
    workspace.panel.open = true;
}
watch(() => currentPlan.value ? `${selectedId.value}:${currentPlan.value.plan.id}:${currentPlan.value.plan.status}` : '', () => {
    if (workspace.sessionControls.permissionMode === 'plan' && ['draft', 'proposed'].includes(currentPlan.value?.plan?.status)) showPlan(currentPlan.value);
}, { immediate: true });
function keydown(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        if (canSteer.value) workspace.steer();
        else workspace.send();
    }
}
function showChanges(run, id = null) {
    workspace.panel.changeRunId = run.id;
    workspace.panel.artifactId = id;
    workspace.panel.tab = 'files';
    workspace.panel.open = true;
}
async function applySuggestion(prompt) {
    currentInput.value = prompt;
    await nextTick();
    composer.value?.focus();
}
onMounted(() => {
    messagesObserver = new ResizeObserver(followContent);
    if (messages.value) messagesObserver.observe(messages.value);
    resizeComposer();
    composerObserver = new ResizeObserver(([entry]) => {
        if (entry.contentRect.width !== composerWidth) {
            composerWidth = entry.contentRect.width;
            resizeComposer();
        }
    });
    if (composer.value) composerObserver.observe(composer.value);
});
onBeforeUnmount(() => { rememberScroll(); composerObserver?.disconnect(); messagesObserver?.disconnect(); cancelAnimationFrame(followFrame); });
</script>

<template>
    <section class="chat-workspace" :class="{ 'empty-chat': !hasHistory }" aria-label="对话">
        <header class="workspace-header" :class="{ 'home-header': !hasHistory }">
            <div class="header-title"><span v-if="hasHistory" class="eyebrow">本地工作区</span><h1>{{ selected?.title || '新对话' }}</h1></div>
            <button class="quiet-button" :aria-expanded="workspace.panel.open" @click="workspace.panel.open = !workspace.panel.open">{{ workspace.panel.open ? '收起面板' : '工作面板' }} <Icon name="panelRight" /></button>
        </header>
        <div ref="scroll" class="chat-scroll" @scroll.passive="rememberScroll" @wheel.passive="resumeScrollIntent" @pointerdown="resumeScrollIntent" @keydown="resumeScrollIntent">
            <div v-if="!hasHistory" class="welcome">
                <div class="home-greeting"><img class="brand-symbol" src="/assets/uah-mark.svg" alt="" /><h2>今天，我们一起做点什么？</h2></div>
                <p class="home-sub">从问题或项目出发，让想法在这里继续。</p>
                <div class="quick-prompts" aria-label="开始方式">
                    <button @click="applySuggestion('请梳理这个项目的结构，说明主要模块及它们的关系。')"><Icon name="code" />梳理项目结构</button>
                    <button @click="applySuggestion('检查最近的代码改动，指出值得关注的风险。')"><Icon name="diff" />检查最近的改动</button>
                    <button @click="applySuggestion('先阅读项目规范，再为我的需求制定实施计划。')"><Icon name="plan" />先做一个实施计划</button>
                </div>
            </div>
            <div ref="messages" class="messages" @click.capture="inspectDisclosure">
                <template v-if="inherited.length">
                    <p class="muted small" role="status">分支已保存 · 已继承 {{ inherited.length }} 条历史消息，可直接继续对话。</p>
                    <article v-for="(message, index) in inherited" :key="`${selectedId}:inherited:${index}`" class="inherited-message mb-4" :aria-label="`继承的${message.role === 'user' ? '用户' : '助手'}消息`">
                        <div v-if="message.role === 'assistant'" class="assistant-heading"><img class="small-mark" src="/assets/uah-mark.svg" alt="" /><strong>UAH</strong><span class="muted small">继承的历史回复</span></div>
                        <div :class="message.role === 'user' ? 'user-message' : 'assistant-message'"><UiMarkdown :source="message.content" @link-click="openMarkdownLink" /></div>
                        <p class="muted small" :class="{ 'text-end': message.role === 'user' }">原消息时间未记录</p>
                    </article>
                    <p class="muted small">以下为此分支的新对话</p>
                </template>
                <UiButton v-if="hiddenTurns" variant="ghost" size="sm" :disabled="workspace.historyLoading" @click="loadEarlierTurns">加载更早的对话（还有 {{ hiddenTurns }} 轮）</UiButton>
                <article v-for="(run, index) in renderedRuns" :key="run.id" :data-run-id="run.id" class="turn" :aria-label="`第 ${hiddenTurns + index + 1} 轮`">
                    <div class="user-message"><UiMarkdown :source="planRunInput(run, workspace.snapshot)" @link-click="openMarkdownLink" /></div>
                    <p class="muted small text-end mt-1 mb-3" title="本地时间"><time :datetime="run.createdAt">发送于 {{ messageTime(run.createdAt) }}</time></p>
                    <div v-if="run.attachments?.length" class="d-flex flex-wrap ga-2 my-2" aria-label="消息附件"><span v-for="attachment in run.attachments" :key="attachment.id" class="muted small" :title="attachment.path || attachment.name">{{ attachment.name }} · {{ attachment.kind === 'image' ? '图片快照' : attachment.kind === 'text' ? '文本快照' : '路径引用（未解析）' }}</span></div>
                    <div v-for="steer in run.steering || []" :key="steer.id" class="user-message" aria-label="补充指令">
                        <span class="muted small">{{ steer.status === 'applied' ? '已加入后续上下文' : ['completed', 'failed', 'stopped'].includes(run.state) ? '本轮未应用' : '等待安全边界' }}</span>
                        <UiMarkdown :source="steer.input" @link-click="openMarkdownLink" />
                        <p class="muted small text-end mt-1 mb-0" title="本地时间"><time :datetime="steer.createdAt">发送于 {{ messageTime(steer.createdAt) }}</time></p>
                    </div>
                    <div class="assistant-heading"><img class="small-mark" src="/assets/uah-mark.svg" alt="" /><strong>UAH</strong><span class="muted ellipsis" :title="run.effective?.modelId">{{ run.effective?.runtimeId === 'codex-native' ? `Codex · ${run.effective.modelId}` : run.effective?.runtimeId === 'api' ? run.effective.modelId : '本地验证' }}</span><span class="status" :data-state="run.state">{{ stateLabels[run.state] }}</span></div>
                    <p v-if="run.native" class="muted small">原生运行 · 记录为部分覆盖<span v-if="run.native.usage"> · 本轮输入 {{ run.native.usage.inputTokens ?? '未知' }} / 输出 {{ run.native.usage.outputTokens ?? '未知' }} tokens</span></p>
                    <RunContent v-if="!run.history?.deleted" :run="run" />
                    <p v-else class="muted small">回复记录已删除</p>
                    <div v-if="run.effective?.runtimeId === 'codex-native' && !run.history?.deleted && (run.nativePlan || run.effective.nativeCollaborationMode === 'plan' && run.output && !(run.nativeCommand?.kind === 'plan' && !run.nativeCommand.task))" class="d-flex flex-wrap ga-2 my-3">
                        <UiButton size="sm" variant="ghost" @click="workspace.panel.tab = 'plans'; workspace.panel.open = true">查看原生计划</UiButton>
                        <template v-if="run === runs.at(-1) && run.state === 'completed' && selected?.nativeCollaborationMode === 'plan'">
                            <UiButton size="sm" :disabled="workspace.busy || Boolean(activeRun)" @click="workspace.executeNativePlan">执行计划</UiButton>
                            <UiButton size="sm" variant="ghost" :disabled="workspace.busy || Boolean(activeRun)" @click="workspace.reviseNativePlan(); nextTick(() => composer?.focus())">修订计划（Revise）</UiButton>
                        </template>
                    </div>
                    <div v-if="run.plan && !run.history?.deleted" class="d-flex flex-wrap align-center ga-2 my-3">
                        <UiButton variant="ghost" size="sm" @click="showPlan(run)"><Icon name="plan" />查看计划 · v{{ run.plan.version || 1 }}</UiButton>
                        <span class="muted small">{{ run.plan.title || '实施计划' }} · {{ planStatusLabels[run.plan.status] }}</span>
                    </div>
                    <template v-if="activeRun?.id === run.id"><NativeQuestionCard v-for="question in pendingNativeQuestions(run)" :key="question.id" :run-id="question.runId" :request="question" /></template>
                    <p v-if="run.native?.goal" class="muted small">原生目标：{{ ({ active: '进行中', paused: '已暂停', blocked: '受阻', usageLimited: '用量受限', budgetLimited: '达到预算', complete: '已完成' })[run.native.goal.status] }} · 已用 {{ run.native.goal.tokensUsed }} tokens</p>
                    <div v-if="run.error" class="inline-error" role="alert">{{ clientError(run.error) }}</div>
                    <p v-if="run.stopReason" class="muted small" role="status">停止理由：{{ run.stopReason }}</p>
                    <p v-if="run.resumeOfRunId" class="muted small">本轮由先前任务核对后继续，历史记录和消耗保持不变。</p>
                    <UiButton v-if="run === runs.at(-1) && !activeRun && run.effective?.runtimeId === 'api' && !run.plan && ['failed', 'stopped'].includes(run.state)" variant="ghost" size="sm" :disabled="workspace.busy" @click="recoveryRun = run">核对并继续</UiButton>
                    <UiButton v-if="run.goalVerification || (run.effective.runtimeId !== 'codex-native' && run === runs.at(-1) && run.state === 'completed' && !run.plan && !run.history?.deleted)" variant="ghost" size="sm" :disabled="workspace.busy || !!activeRun" @click="verificationRun = run">{{ run.goalVerification ? '查看目标验收记录' : '目标验收' }}</UiButton>
                    <div v-for="approval in pendingApprovals(run)" :key="approval.requestId" class="approval-card">
                        <div class="eyebrow">需要你的批准</div>
                        <h3>{{ approval.summary }}</h3>
                        <code>{{ approval.path }}</code>
                        <p>仅授权本次文件创建。查看面板不会批准操作。</p>
                        <div class="button-row"><UiButton variant="primary" :disabled="workspace.busy" @click="workspace.resolve(approval, 'approve')">批准本次操作</UiButton><UiButton :disabled="workspace.busy" @click="workspace.resolve(approval, 'reject')">拒绝</UiButton></div>
                    </div>
                    <p v-if="run.native" class="muted small">原生文件快照未接入；文件改动请结合原生工具记录与 Git 面板核对。</p>
                    <UiFileChanges v-else-if="changes[run.id].length || ['completed', 'stopped', 'failed'].includes(run.state)" :title="`第 ${hiddenTurns + index + 1} 轮文件改动`" :items="changes[run.id]" @select="showChanges(run, $event)" @view-all="showChanges(run)" />
                    <RunActions v-if="!run.history?.deleted && ['completed', 'stopped', 'failed'].includes(run.state)" :run="run" :index="hiddenTurns + index" />
                </article>
            </div>
        </div>
        <div class="composer-dock">
            <div class="directory-row">
                <button class="location-chip directory-chip" :disabled="Boolean(selected) || !available" :title="directory || '选择工作目录，可跳过'" aria-label="选择工作目录（可选）" @click="workspace.chooseDirectory"><Icon name="folder" /><span class="ellipsis">{{ directoryName }}</span><Icon name="down" /></button>
                <button v-if="!selected && directory" class="location-chip" aria-label="移除工作目录" @click="workspace.draft.directory = null; workspace.draft.directoryChosen = false"><Icon name="close" /></button>
                <UiButton v-if="!selected && !workspace.draft.directoryChosen" size="sm" variant="ghost" :disabled="!available" @click="workspace.chooseNoDirectory">无目录</UiButton>
                <UiButton size="sm" variant="ghost" :title="git.error.value || git.result.value?.snapshot.message || '查看当前目录的只读 Git 状态'" @click="showGit"><Icon name="branch" /><span>{{ gitLabel }}</span></UiButton>
                <UiButton v-if="directory" size="sm" variant="ghost" :disabled="git.busy.value" aria-label="刷新当前 Git 状态" @click="git.refresh">刷新</UiButton>
                <span class="location-path ellipsis" :title="directory || ''">{{ directory || '无目录对话可直接发送；项目文件需先绑定目录' }}</span>
            </div>
            <PlanReview v-if="reviewPlan" :key="reviewPlan.id" :run="reviewPlan" />
            <div v-else class="composer" @dragover.prevent @drop.prevent="importFiles" @paste="importFiles">
                <div v-if="workspace.currentAttachments.length" class="d-flex flex-wrap ga-2 pa-2" aria-label="待发送附件">
                    <UiButton v-for="attachment in workspace.currentAttachments" :key="attachment.id" size="sm" variant="ghost" :disabled="workspace.busy" :title="attachment.path || attachment.name" :aria-label="`移除附件 ${attachment.name}`" @click="workspace.removeAttachment(attachment.id)">{{ attachment.name }} · {{ attachment.kind === 'image' ? '图片' : attachment.kind === 'text' ? '文本快照' : '路径引用' }} ×</UiButton>
                </div>
                <div class="composer-main" :class="{ multiline }">
                    <UiMenu placement="top-start" label="附件与原生指令">
                        <template #activator="{ props }"><button v-bind="props" class="icon-button attach-trigger" aria-label="添加附件与上下文" :disabled="!available || Boolean(activeRun)"><Icon name="plus" /></button></template>
                        <UiMenuItem :disabled="!workspace.nativeMode" @click="workspace.addAttachments()">添加附件<template #trailing>{{ workspace.nativeMode ? '图片 / 文件' : '仅原生 Codex' }}</template></UiMenuItem>
                        <template v-if="workspace.nativeMode">
                            <UiMenuItem @click="fillNativeCommand(selected?.nativeCollaborationMode === 'plan' ? '/plan off' : '/plan', selected?.nativeCollaborationMode !== 'plan')" :disabled="selected?.nativeCollaborationMode === 'plan' && Boolean(currentInput.trim())">{{ selected?.nativeCollaborationMode === 'plan' ? '退出计划模式' : '进入计划模式' }}<template #trailing>/plan</template></UiMenuItem>
                            <UiMenuItem @click="fillNativeCommand('/goal', true)">设置目标<template #trailing>/goal 目标内容</template></UiMenuItem>
                            <UiMenuItem v-if="selected?.nativeCollaborationMode === 'plan'" :disabled="Boolean(currentInput.trim())" @click="fillNativeCommand('/plan execute')">执行计划<template #trailing>/plan execute</template></UiMenuItem>
                            <UiMenuItem @click="fillNativeCommand('/plan revise', true)">修订计划（Revise）<template #trailing>/plan revise</template></UiMenuItem>
                            <UiMenuItem :disabled="Boolean(currentInput.trim())" @click="fillNativeCommand('/goal')">查看目标状态<template #trailing>/goal</template></UiMenuItem>
                            <UiMenuItem :disabled="Boolean(currentInput.trim())" @click="fillNativeCommand('/goal pause')">暂停目标<template #trailing>/goal pause</template></UiMenuItem>
                            <UiMenuItem :disabled="Boolean(currentInput.trim())" @click="fillNativeCommand('/goal resume')">继续目标<template #trailing>/goal resume</template></UiMenuItem>
                            <UiMenuItem :disabled="Boolean(currentInput.trim())" @click="fillNativeCommand('/goal clear')">清除目标<template #trailing>/goal clear</template></UiMenuItem>
                        </template>
                    </UiMenu>
                    <textarea ref="composer" v-model="currentInput" rows="1" aria-label="消息" :placeholder="!selected ? '描述任务或提出问题…' : canSteer ? '补充指令，将在安全边界加入…' : activeRun ? '补充想法，停止当前任务后发送…' : '继续这段对话…'" :maxlength="20000" @keydown="keydown"></textarea>
                    <UiButton v-if="canSteer" variant="ghost" size="sm" :disabled="workspace.busy || !activeRun.activeStepId || !currentInput.trim()" title="停止尚未派发的旧工具，在安全边界加入；已执行的更改不会自动撤销" @click="workspace.steer">补充指令</UiButton>
                    <button v-if="activeRun" class="send-button stop-button" :disabled="workspace.busy || ['stopping', 'cancelRequested'].includes(activeRun.state)" aria-label="停止当前任务" title="停止当前任务" @click="workspace.stop(activeRun)"><Icon name="stop" /></button>
                    <button v-else class="send-button" :disabled="!available || (!currentInput.trim() && !workspace.currentAttachments.length) || !workspace.modelAvailable || !workspace.agentAvailable || !workspace.configurationReady" aria-label="发送消息" title="发送消息" @click="workspace.send"><Icon name="arrow" /></button>
                </div>
            </div>
            <div class="composer-options">
                <UiSelect v-if="workspace.currentModel !== 'local-verification'" compact placeholder="选择 Agent" v-model="workspace.currentAgent" aria-label="主 Agent" :disabled="workspace.busy || Boolean(activeRun) || workspace.agentLocked" :title="workspace.agentLocked ? '会话已开始，主 Agent 已锁定；更换请新建对话' : '选择本次会话的角色，与模型独立'"><option v-for="profile in workspace.agentOptions" :key="profile.id" :value="profile.id">{{ profile.name }}</option><option v-if="workspace.currentAgent && !workspace.agentAvailable" :value="workspace.currentAgent" disabled>已选 Agent 不可用</option></UiSelect>
                <button v-else class="composer-control" title="本地验证，不应用 API Agent 参数" disabled><Icon name="code" /><span>本地验证</span></button>
                <UiSelect compact v-model="workspace.currentModel" :disabled="workspace.busy || Boolean(activeRun)" placeholder="选择模型" aria-label="运行模型">
                    <option value="local-verification" :disabled="workspace.agentLocked && apiMode">本地验证（非 AI）</option>
                    <optgroup v-for="group in workspace.modelGroups" :key="group.id" :label="group.label">
                        <option v-for="model in group.models" :key="model.value" :value="model.value" :disabled="workspace.agentLocked && (!apiMode || ((workspace.lockedAgent?.runtimeId === 'codex-native') !== (group.id === 'native:codex')))">{{ model.label }}</option>
                    </optgroup>
                    <option v-if="workspace.currentModel && !workspace.modelAvailable" :value="workspace.currentModel" disabled>已选模型不可用</option>
                </UiSelect>
                <span class="control-divider" aria-hidden="true"></span>
                <UiSelect compact ghost placeholder="选择权限" :model-value="workspace.sessionControls.permissionMode" :items="permissionItems" menu-title="Mode · 权限模式" aria-label="权限模式" :disabled="!available || Boolean(activeRun) || !apiMode" :title="workspace.nativeMode ? '使用 Codex 原生沙箱与审批策略，MCP 遵循原生配置。' : '仅影响本会话的后续轮次；Auto 命令执行仍需审批，文件操作按权限执行'" @update:model-value="workspace.setSessionControl('permissionMode', $event)" />
                <UiSelect compact ghost placeholder="思考强度" :model-value="workspace.sessionControls.reasoningEffort" :items="effortItems" menu-title="思考强度" aria-label="思考强度" :disabled="!available || Boolean(activeRun) || !apiMode" title="保存到会话，下一轮请求生效；支持的档位取决于模型和协议" @update:model-value="workspace.setSessionControl('reasoningEffort', $event)" />
                <UiUsageMeter v-if="workspace.nativeMode" compact label="原生上下文" :used="nativeContextRun?.nativeContext?.totalTokens" :capacity="nativeContextRun?.nativeContext?.capacity" @inspect="contextOpen = true" />
                <UiUsageMeter v-else compact label="会话上下文" :used="contextSummary?.pressure?.requiredTokens ?? contextSummary?.usage?.inputTokens ?? contextSummary?.estimatedInputTokens" :capacity="contextSummary?.capacity" :estimated="Boolean(contextSummary?.pressure || contextSummary && contextSummary.usage?.inputTokens === undefined)" @inspect="contextOpen = true" />
                <UiButton size="sm" variant="ghost" :disabled="!selectedId" @click="journalOpen = true">会话日志</UiButton>
            </div>
            <div class="composer-foot">{{ reviewPlan ? '计划正文与版本历史显示在右侧；批准后才会开始实施' : !workspace.configurationReady ? (workspace.nativeMode ? '原生 Codex 需要选择工作目录、模型、权限和思考强度' : '首次使用请手动选择 Agent、模型、权限、思考强度和目录（可选无目录）') : !workspace.agentAvailable ? '请选择可用的主 Agent；当前角色已停用或删除' : workspace.modelAvailable ? (apiMode ? 'Enter 发送 · 按会话配置发送消息，工具操作受当前权限约束' : 'Enter 发送 · Shift+Enter 换行 · 当前为本地验证，不调用 AI') : '请选择可用模型；端点停用、模型移除或端点删除后不能发送' }}</div>
        </div>
        <NativeContextDialog v-if="workspace.nativeMode" v-model:open="contextOpen" :run="nativeContextRun" />
        <RequestContextDialog v-else v-model:open="contextOpen" :initial-run-id="contextRun?.id || ''" />
        <JournalDialog v-model:open="journalOpen" />
        <RecoveryDialog :run="recoveryRun" @close="recoveryRun = null" />
        <GoalVerificationDialog :run="verificationRun" @close="verificationRun = null" />
    </section>
</template>
