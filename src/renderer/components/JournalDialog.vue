<script setup>
import { clientError } from '../../shared/client-error.js';

import { computed, onBeforeUnmount, ref, watch, useId } from 'vue';
import { UiDialog, UiButton, UiTable, UiBadge, UiAlert, UiCodeBlock, UiSwitch, UiField, UiTextarea } from '@lingyzh/ui';
import { useWorkspace } from '../stores/workspace';

const props = defineProps({ open: Boolean });
const emit = defineEmits(['update:open']);
const workspace = useWorkspace();
const summary = ref(null);
const detail = ref(null);
const busy = ref(false);
const error = ref('');
const notice = ref('');
const policy = ref(null);
const cleanup = ref(null);
const purge = ref(null);
const confirmation = ref('');
const confirmationId = useId();
let generation = 0;
const headers = [
    { key: 'timestamp', title: '时间' }, { key: 'status', title: '状态' },
    { key: 'inputTokens', title: '输入 token' }, { key: 'outputTokens', title: '输出 token' },
    { key: 'requestId', title: '请求' }
];
const rows = computed(() => (summary.value?.requests || []).map(row => ({ ...row,
    timestamp: new Date(row.timestamp).toLocaleString(),
    status: ({ completed: '完成', failed: '失败', cancelled: '取消' })[row.status] || row.status,
    inputTokens: row.inputTokens ?? '未知', outputTokens: row.outputTokens ?? '未知'
})));
const detailText = computed(() => detail.value ? JSON.stringify(detail.value.snapshot, null, 2) : '');
const preview = computed(() => detailText.value.slice(0, 100_000));
async function query(action, extra = {}) {
    if (busy.value || !props.open || !workspace.selectedId) return;
    const epoch = ++generation;
    const sessionId = workspace.selectedId;
    busy.value = true; error.value = ''; notice.value = '';
    try {
        if (!window.uah?.journal) throw new Error('请重启更新后的桌面端以读取日志。');
        const result = action === 'purge-confirm' ? await workspace.purgeSession(sessionId, extra.fingerprint)
            : await window.uah.journal({ action, sessionId, ...extra });
        const currentPolicy = action === 'summary' && window.uah.journalPolicy ? await window.uah.journalPolicy({ action: 'get' }) : null;
        if (epoch !== generation || sessionId !== workspace.selectedId || !props.open) return;
        if (action === 'summary') { summary.value = result; policy.value = currentPolicy; }
        if (action === 'request') detail.value = result;
        if (action === 'purge-review') { purge.value = result; confirmation.value = ''; }
        if (action === 'cleanup-review') cleanup.value = result;
        if (action === 'cleanup-confirm') {
            cleanup.value = null;
            notice.value = `已清理 ${result.removedFiles} 个无引用文件（${result.removedBytes.toLocaleString()} 字节）。`;
            if (result.error) error.value = `清理中途停止，剩余 ${result.remainingFiles} 个候选未删除：${result.error}`;
        }
        if (action === 'export' && result) notice.value = `已导出至 ${result.destination} · 截止事件 ${result.targetSeq} · ${result.partial ? '部分覆盖' : '完整覆盖'}`;
    } catch (cause) { if (epoch === generation) error.value = clientError(cause); }
    finally { if (epoch === generation) busy.value = false; }
}
async function setCaptureRaw(captureRaw) {
    if (busy.value || !policy.value || !props.open) return;
    const epoch = ++generation;
    busy.value = true; error.value = ''; notice.value = '';
    try {
        const saved = await window.uah.journalPolicy({ action: 'set', revision: policy.value.revision, captureRaw });
        if (epoch !== generation || !props.open) return;
        policy.value = saved;
        notice.value = '日志设置已保存，从下一次模型请求或连接测试生效。';
    } catch (cause) { if (epoch === generation) error.value = clientError(cause); }
    finally { if (epoch === generation) busy.value = false; }
}
watch(() => [props.open, workspace.selectedId], ([open], previous) => {
    generation++; busy.value = false; summary.value = null; detail.value = null; policy.value = null; cleanup.value = null; purge.value = null; confirmation.value = ''; error.value = ''; notice.value = '';
    if (previous && previous[1] !== workspace.selectedId) { emit('update:open', false); return; }
    if (open) query('summary');
}, { immediate: true, flush: 'sync' });
onBeforeUnmount(() => { generation++; });
</script>

<template>
    <UiDialog :open="open" scrollable aria-label="会话日志" content-label="日志与逐请求用量" @update:open="emit('update:open', $event)">
        <template #header><h2>会话日志</h2></template>
        <UiAlert v-if="error" tone="error" class="mb-3">{{ error }}</UiAlert>
        <UiAlert v-if="notice" tone="success" class="mb-3">{{ notice }}</UiAlert>
        <p v-if="busy" role="status" class="muted">正在处理日志…</p>
        <template v-if="policy">
            <label class="d-flex align-center justify-space-between ga-3 mb-2">保存额外原始请求与响应<UiSwitch :model-value="policy.captureRaw" :disabled="busy" @update:model-value="setCaptureRaw" /></label>
            <p class="muted small mb-3">全局设置。关闭后不保存原始请求正文与 SSE 事件，日志标为部分覆盖；聊天、过滤后的请求上下文、文件快照和必要原生续接历史仍保留。不会删除旧日志。</p>
        </template>
        <template v-if="summary">
            <div class="d-flex flex-wrap ga-2 mb-3">
                <UiBadge :tone="summary.health.status === 'healthy' ? 'success' : 'error'">{{ summary.health.status === 'healthy' ? '记录正常' : summary.health.status === 'failed' ? '记录失败' : '文件导出滞后' }}</UiBadge>
                <UiBadge :tone="summary.coverage === 'complete' ? 'success' : 'warning'">{{ summary.coverage === 'complete' ? '完整覆盖' : summary.coverage === 'legacy_partial' ? '旧记录 · 部分覆盖' : '部分覆盖' }}</UiBadge>
            </div>
            <p class="muted small">已持久化 {{ summary.health.durableSeq }} · 已写出 {{ summary.health.exportedSeq }}。每次请求尝试分别展示用量，未知字段不计作零。</p>
            <UiAlert v-if="summary.health.error" tone="warning" class="mb-3">{{ clientError(summary.health.error) }}</UiAlert>
            <UiTable :headers="headers" :items="rows" item-value="attemptId" label="逐请求用量" empty-text="此会话暂无模型请求记录" height="280px" fixed-header dense>
                <template #item.requestId="{ item }"><UiButton size="sm" variant="ghost" :disabled="busy" :aria-label="`查看请求 ${item.requestId} 尝试 ${item.attemptId}`" @click="query('request', { requestId: item.requestId, attemptId: item.attemptId })">查看详情</UiButton></template>
            </UiTable>
            <p v-if="summary.truncated" class="muted small">界面仅显示最近 100 次请求尝试；导出包含截止水位内的全部记录。</p>
        </template>
        <template v-if="detail">
            <h3 class="mt-4">最终请求快照</h3>
            <p class="muted small break-word">请求 {{ detail.requestId }} · 尝试 {{ detail.attemptId }}</p>
            <p v-if="detail.snapshot?.bodyCapture === 'disabled'" class="muted small">本次已关闭原始请求正文捕获，以下仅为请求身份和记录策略。</p>
            <p v-if="detailText.length > preview.length" class="muted small">预览已截断；完整内容保存在本地导出中。</p>
            <UiCodeBlock :code="preview" language="json" max-height="320px" />
        </template>
        <UiAlert tone="info" class="mt-4">本地副本包含对话、代码和路径。分享副本会移除受限块并降低覆盖范围，发送前仍需检查内容。</UiAlert>
        <section class="mt-4" aria-label="日志存储清理">
            <h3>无引用文件清理</h3>
            <p class="muted small mb-3">检查此会话超过 24 小时、未被任何日志引用的内容文件。聊天、文件快照、原始日志和分支所需内容继续保留；仅在任务结束且日志校验通过后可清理。</p>
            <UiButton :disabled="busy" @click="query('cleanup-review')">检查可清理文件</UiButton>
            <template v-if="cleanup">
                <p role="status" class="mt-3">{{ cleanup.files.length }} 个可清理文件，共 {{ cleanup.bytes.toLocaleString() }} 字节。</p>
                <UiTable v-if="cleanup.files.length" :headers="[{ key: 'relativePath', title: '内容文件' }, { key: 'byteLength', title: '字节' }]" :items="cleanup.files" item-value="relativePath" label="清理候选" height="180px" dense />
                <UiButton v-if="cleanup.files.length" class="mt-3" :disabled="busy" @click="query('cleanup-confirm', { fingerprint: cleanup.fingerprint })">确认清理这些无引用文件</UiButton>
            </template>
        </section>
        <section class="mt-4" aria-label="彻底删除会话">
            <h3>彻底删除会话</h3>
            <p class="muted small mb-3">移除此会话的聊天、快照、日志、计划草稿、命令输出及专属浏览器数据。工作区实际文件、独立分支和外部导出仍保留。</p>
            <UiButton variant="danger" :disabled="busy" @click="query('purge-review')">检查会话删除范围</UiButton>
            <template v-if="purge">
                <p class="mt-3">{{ purge.runCount }} 个任务，{{ purge.fileCount }} 个内容文件（{{ purge.bytes.toLocaleString() }} 字节）。另将从 {{ purge.backupCount }} 个升级备份中移除此会话记录，保留其中其他会话。</p>
                <UiAlert v-if="purge.incompleteBackupFiles" tone="warning" class="mt-3">同时移除 {{ purge.incompleteBackupFiles }} 个未完成升级备份文件；这些不完整备份也可能含有其他会话，不能用作完整恢复来源。</UiAlert>
                <UiAlert v-for="reason in purge.reasons" :key="reason" tone="warning" class="mt-3">{{ reason }}</UiAlert>
                <template v-if="purge.canDelete">
                    <UiAlert tone="warning" class="mt-3">此操作无法撤销；已有分支副本和外部导出无法一并追回，也不保证磁盘残留在物理上不可恢复。中途失败会保留待完成状态，可重试。</UiAlert>
                    <UiField :for="confirmationId" label="输入“永久删除”确认" class="d-flex flex-column align-start ga-2 mt-3">
                        <UiTextarea :id="confirmationId" v-model="confirmation" :rows="1" :disabled="busy" />
                    </UiField>
                    <UiButton variant="danger" class="mt-3" :disabled="busy || confirmation !== '永久删除'" @click="query('purge-confirm', { fingerprint: purge.fingerprint })">永久删除此会话</UiButton>
                </template>
            </template>
        </section>
        <template #footer>
            <div class="d-flex flex-wrap ga-2">
                <UiButton :disabled="busy" @click="query('summary')">刷新</UiButton>
                <UiButton :disabled="busy" @click="query('open')">打开目录</UiButton>
                <UiButton :disabled="busy" @click="query('export', { mode: 'full' })">导出本地副本</UiButton>
                <UiButton :disabled="busy" @click="query('export', { mode: 'share' })">导出分享副本</UiButton>
                <UiButton @click="emit('update:open', false)">关闭</UiButton>
            </div>
        </template>
    </UiDialog>
</template>
