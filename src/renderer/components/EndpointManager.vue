<script setup>
import { clientError } from '../../shared/client-error.js';

import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { UiButton, UiCard, UiDialog, UiField, UiInput, UiScrollArea, UiSelect, UiSwitch, UiIcon, UiTooltip, snackbar } from '@lingyzh/ui';
import ModelCapabilitiesEditor from './ModelCapabilitiesEditor.vue';
import ModelParametersEditor from './ModelParametersEditor.vue';
import NativeCodexSettings from './NativeCodexSettings.vue';
import { effectiveModelDetails } from '../../shared/endpoints';
import { useWorkspace } from '../stores/workspace';

const workspace = useWorkspace();
const protocols = { 'openai-chat': 'OpenAI Chat Completions', 'openai-responses': 'OpenAI Responses', anthropic: 'Anthropic Messages' };
const blank = () => ({ id: null, providerId: '', name: '', protocol: 'openai-chat', baseUrl: '', models: [], modelDetails: [], modelOverrides: [], modelParameters: [], enabled: true, revision: 0 });
const draft = ref(blank());
const original = ref('');
const key = ref('');
const keyAction = ref('replace');
const modelInput = ref('');
const testModel = ref('');
const editing = ref(false);
const discardOpen = ref(false);
const deleteTarget = ref(null);
const busy = ref('');
const error = ref('');
const testResult = ref(null);
const capabilitiesOpen = ref(false);
const capabilitiesModel = ref('');
const parametersOpen = ref(false);
const parametersModel = ref('');
function editParameters(id) { parametersModel.value = id; parametersOpen.value = true; }
function applyParameters(value) {
    draft.value.modelParameters = [...draft.value.modelParameters.filter(item => item.id !== value.id), value];
}
const openingLogs = ref(false);
const toggleError = ref('');
const pendingEnablement = ref({});
async function toggleEndpoint(endpoint, enabled) {
    if (busy.value) return;
    pendingEnablement.value[endpoint.id] = enabled;
    busy.value = `toggle:${endpoint.id}`;
    toggleError.value = '';
    try {
        const { hasKey, ...saved } = endpoint;
        await workspace.endpointCommand({ type: 'save', draft: { ...JSON.parse(JSON.stringify(saved)), enabled, apiKey: null } });
    } catch (cause) { toggleError.value = `${endpoint.name}：${clientError(cause)}`; }
    finally { delete pendingEnablement.value[endpoint.id]; busy.value = ''; }
}
async function openLogs() {
    if (openingLogs.value || !window.uah) return;
    openingLogs.value = true;
    try { await window.uah.openLogs(); }
    catch { snackbar.show('无法打开日志目录，请重启更新后的桌面端再试。', { tone: 'error' }); }
    finally { openingLogs.value = false; }
}
const hasStoredKey = ref(false);
const dirty = computed(() => JSON.stringify(draft.value) !== original.value || key.value !== '' || keyAction.value !== (hasStoredKey.value ? 'keep' : 'replace') || modelInput.value.trim() !== '');

const detailsById = computed(() => new Map(draft.value.modelDetails.map(item => [item.id, item])));
const modalityLabels = { text: '文本', image: '图像', audio: '音频', video: '视频', file: '文件', pdf: 'PDF' };
const overrideById = computed(() => new Map(draft.value.modelOverrides.map(item => [item.id, item])));
function editCapabilities(id) { capabilitiesModel.value = id; capabilitiesOpen.value = true; }
function applyCapabilities(value) {
    draft.value.modelOverrides = draft.value.modelOverrides.filter(item => item.id !== value.id);
    if (Object.keys(value).length > 1) draft.value.modelOverrides.push(value);
}
function restoreCapabilities() { draft.value.modelOverrides = draft.value.modelOverrides.filter(item => item.id !== capabilitiesModel.value); }
function capabilityIcons(id) {
    const details = effectiveModelDetails(draft.value, id);
    const flags = [['imageInput', 'image', '图片输入'], ['pdfInput', 'file', 'PDF 输入'], ['audioInput', 'volume', '音频输入'], ['videoInput', 'monitor', '视频输入'], ['tools', 'puzzle', '工具调用'], ['reasoning', 'spark', '推理'], ['streaming', 'refresh', '流式输出']];
    const icons = flags.filter(([key]) => details[key] === true).map(([key, icon, label]) => ({ key, icon, label }));
    const outputIcons = { image: 'image', audio: 'volume', video: 'monitor', file: 'paperclip', pdf: 'file' };
    for (const modality of details.outputModalities || []) {
        if (outputIcons[modality]) icons.push({ key: `output-${modality}`, icon: outputIcons[modality], label: `${modalityLabels[modality]}输出` });
    }
    return icons;
}
function capabilitiesText(id) {
    const details = effectiveModelDetails(draft.value, id);
    const labels = [];
    if (details.contextWindow) labels.push('上下文：' + details.contextWindow.toLocaleString() + ' tokens');
    if (details.maxOutputTokens) labels.push('最大输出：' + details.maxOutputTokens.toLocaleString() + ' tokens');
    if (overrideById.value.has(id)) labels.push('手动设置');
    return labels.join(' · ');
}

function openEditor(endpoint) {
    if (busy.value) return;
    draft.value = endpoint ? { id: endpoint.id, providerId: endpoint.providerId || '', name: endpoint.name, protocol: endpoint.protocol, baseUrl: endpoint.baseUrl, models: [...endpoint.models], modelDetails: JSON.parse(JSON.stringify(endpoint.modelDetails || [])), modelOverrides: JSON.parse(JSON.stringify(endpoint.modelOverrides || [])), modelParameters: JSON.parse(JSON.stringify(endpoint.modelParameters || [])), enabled: endpoint.enabled, revision: endpoint.revision } : blank();
    original.value = JSON.stringify(draft.value);
    hasStoredKey.value = Boolean(endpoint?.hasKey);
    keyAction.value = endpoint?.hasKey ? 'keep' : 'replace';
    key.value = '';
    modelInput.value = '';
    testModel.value = draft.value.models[0] || '';
    error.value = '';
    testResult.value = null;
    editing.value = true;
}
function addModel() {
    const value = modelInput.value.trim();
    if (!value || busy.value) return;
    if (value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) { error.value = '模型 ID 格式无效。'; return; }
    if (draft.value.models.length >= 500) { error.value = '模型目录最多包含 500 项。'; return; }
    if (!draft.value.models.includes(value)) draft.value.models.push(value);
    testModel.value ||= value;
    modelInput.value = '';
}
function removeModel(id) {
    draft.value.models = draft.value.models.filter((item) => item !== id);
    draft.value.modelDetails = draft.value.modelDetails.filter((item) => item.id !== id);
    draft.value.modelOverrides = draft.value.modelOverrides.filter((item) => item.id !== id);
    draft.value.modelParameters = draft.value.modelParameters.filter((item) => item.id !== id);
    if (testModel.value === id) testModel.value = draft.value.models[0] || '';
}
function payload() {
    return { ...JSON.parse(JSON.stringify(draft.value)), apiKey: keyAction.value === 'keep' ? null : keyAction.value === 'remove' ? '' : key.value };
}
function run(operation, action) {
    if (busy.value) return Promise.resolve();
    busy.value = operation;
    error.value = '';
    return action().catch((cause) => { error.value = clientError(cause); }).finally(() => { busy.value = ''; });
}
function save() {
    if (busy.value) return;
    addModel();
    if (modelInput.value.trim()) return;
    return run('save', () => workspace.endpointCommand({ type: 'save', draft: payload() }).then(() => {
        key.value = '';
        editing.value = false;
        snackbar.show(draft.value.id ? '端点已保存' : '端点已添加并启用', { tone: 'success' });
    }));
}
function discover() {
    return run('discover', () => workspace.endpointCommand({ type: 'discover', draft: payload() }).then((reply) => {
        const merged = [...new Set([...draft.value.models, ...reply.models])];
        if (merged.length > 500) throw new Error('合并后的模型超过 500 项，请先移除不需要的模型。');
        draft.value.models = merged;
        const discovered = new Set(reply.models);
        draft.value.modelDetails = [...draft.value.modelDetails.filter(item => !discovered.has(item.id)), ...(reply.modelDetails || [])];
        testModel.value ||= merged[0] || '';
        snackbar.show(`已读取 ${reply.models.length} 个模型，其中 ${reply.modelDetails?.length || 0} 个含能力信息，保存端点后生效`, { tone: 'success' });
    }));
}
watch(() => [draft.value.baseUrl, draft.value.protocol, key.value, keyAction.value, testModel.value], () => { testResult.value = null; });
function testConnection() {
    testResult.value = null;
    return run('test', () => workspace.endpointCommand({ type: 'test', draft: payload(), modelId: testModel.value }).then((reply) => {
        testResult.value = { ...reply.testResult, modelId: testModel.value };
    }));
}
function requestClose() {
    if (busy.value) return;
    if (dirty.value) discardOpen.value = true;
    else editing.value = false;
}
function discard() { discardOpen.value = false; editing.value = false; key.value = ''; }
function clearEditor() { key.value = ''; draft.value = blank(); modelInput.value = ''; error.value = ''; }
function deleteEndpoint() {
    return run('delete', () => workspace.endpointCommand({ type: 'delete', id: deleteTarget.value.id, revision: deleteTarget.value.revision }).then(() => {
        deleteTarget.value = null;
        snackbar.show('端点已删除，历史对话仍保留', { tone: 'success' });
    }));
}
onBeforeUnmount(() => { key.value = ''; });
</script>

<template>
    <section class="settings-page" aria-label="模型与账号">
        <UiScrollArea class="flex-grow-1 min-w-0" label="API 端点列表">
            <div class="pa-7 d-flex flex-column ga-5">
                <div class="d-flex flex-wrap align-center justify-space-between ga-3">
                    <div><h1 class="settings-title">模型与账号</h1><p class="muted">配置 API 与自定义端点，选择模型开始对话。</p></div>
                    <div class="d-flex ga-2"><UiButton :disabled="!workspace.connected" :loading="openingLogs" @click="openLogs">打开日志目录</UiButton><UiButton variant="primary" :disabled="!workspace.connected" @click="openEditor()">添加端点</UiButton></div>
                </div>
                <NativeCodexSettings />
                <p class="muted small">API 支持三种协议的文本流式对话。API 测试和发送消息可能产生服务商费用。</p>
                <UiCard v-if="!workspace.endpoints.length" title="还没有 API 端点" subtitle="添加服务商的 API 基础地址和模型 ID；密钥经系统加密保存在本机。">
                    <p>例如 https://api.openai.com/v1 或 https://api.anthropic.com/v1。本地服务可使用回环 HTTP 地址。</p>
                </UiCard>
                <p v-if="toggleError" role="alert" class="inline-error ma-0">{{ toggleError }}</p>
                <UiCard v-for="endpoint in workspace.endpoints" :key="endpoint.id" density="compact" :aria-label="endpoint.name">
                    <div class="d-flex align-center justify-space-between ga-3">
                        <strong class="ellipsis min-w-0" :title="endpoint.name">{{ endpoint.name }}</strong>
                        <label class="d-flex align-center ga-2 small"><span>{{ busy === `toggle:${endpoint.id}` ? '保存中…' : endpoint.enabled ? '已启用' : '已停用' }}</span><UiSwitch :model-value="pendingEnablement[endpoint.id] ?? endpoint.enabled" :aria-label="`启用 ${endpoint.name}`" :disabled="Boolean(busy)" @update:model-value="toggleEndpoint(endpoint, $event)" /></label>
                    </div>
                    <p class="ellipsis muted small my-2" :title="endpoint.baseUrl">{{ endpoint.baseUrl }}</p>
                    <p class="break-word small my-2">Provider ID：<code>{{ endpoint.providerId || endpoint.id }}</code></p>
                    <div class="d-flex flex-wrap align-center justify-space-between ga-2">
                        <span class="muted small">{{ protocols[endpoint.protocol] }} · {{ endpoint.models.length }} 个模型 · {{ endpoint.hasKey ? '已保存密钥' : '无密钥' }}</span>
                        <div class="d-flex ga-1">
                            <UiButton size="sm" variant="ghost" :disabled="Boolean(busy)" :aria-label="`编辑 ${endpoint.name}`" @click="openEditor(endpoint)">编辑</UiButton>
                            <UiButton size="sm" variant="ghost" :disabled="Boolean(busy)" :aria-label="`删除 ${endpoint.name}`" @click="error = ''; deleteTarget = endpoint">删除</UiButton>
                        </div>
                    </div>
                </UiCard>
            </div>
        </UiScrollArea>
        <UiDialog scrollable :error="error" :open="editing" aria-labelledby="endpoint-editor-title" @update:open="requestClose" @closed="clearEditor">
            <template #header><h2 id="endpoint-editor-title" class="ma-0">{{ draft.id ? '编辑端点' : '添加端点' }}</h2><p v-if="busy === 'test'" role="status" class="muted small">正在测试 {{ testModel }}，等待完整流式响应…</p><UiCard v-if="testResult" class="mt-3" density="compact" title="流式对话测试通过" :subtitle="testResult.modelId + ' · ' + testResult.elapsedMs + ' ms'"><UiScrollArea max-height="100px" label="测试模型实际回复"><p role="status" class="ma-0 break-word">{{ testResult.text }}</p></UiScrollArea></UiCard></template>
            <div class="d-flex flex-column ga-4">
                <UiField v-slot="{ controlAttrs }" label="名称" for="endpoint-name"><UiInput v-model="draft.name" v-bind="controlAttrs" :disabled="Boolean(busy)" maxlength="100" placeholder="我的 API 服务" /></UiField>
                <UiField v-slot="{ controlAttrs }" label="Provider ID（可选）" for="endpoint-provider-id" :description="`供子代理调用，区别于显示名称。支持字母、数字、中文、点、下划线和短横线，区分大小写且不能重复。留空使用默认 ID${draft.id ? '：' + draft.id : '（保存时自动生成）'}。修改不影响已有会话和模型配置。`"><UiInput v-model="draft.providerId" v-bind="controlAttrs" :disabled="Boolean(busy)" maxlength="100" spellcheck="false" placeholder="例如 company 或 公司" /></UiField>
                <UiField v-slot="{ controlAttrs }" label="协议" for="endpoint-protocol"><UiSelect v-model="draft.protocol" v-bind="controlAttrs" :disabled="Boolean(busy)"><option v-for="(label, id) in protocols" :key="id" :value="id">{{ label }}</option></UiSelect></UiField>
                <UiField v-slot="{ controlAttrs }" label="API 基础地址" for="endpoint-url" description="包含版本前缀（如 /v1），不包含 /chat/completions、/responses 或 /messages。"><UiInput v-model="draft.baseUrl" v-bind="controlAttrs" :disabled="Boolean(busy)" type="url" maxlength="2048" placeholder="https://api.example.com/v1" /></UiField>
                <UiField v-if="hasStoredKey" v-slot="{ controlAttrs }" label="密钥操作" for="endpoint-key-action" description="默认保留已保存的密钥，修改协议或地址不会清除。可单独替换或移除。"><UiSelect v-model="keyAction" v-bind="controlAttrs" :disabled="Boolean(busy)"><option value="keep">保留已保存的密钥</option><option value="replace">替换密钥</option><option value="remove">移除密钥</option></UiSelect></UiField>
                <UiField v-if="keyAction === 'replace'" v-slot="{ controlAttrs }" label="API Key" for="endpoint-key" description="保存后不回显；无需认证的本地服务可留空。"><UiInput v-model="key" v-bind="controlAttrs" :disabled="Boolean(busy)" type="password" autocomplete="off" spellcheck="false" maxlength="8192" /></UiField>
                <UiCard title="模型目录" density="compact" subtitle="同步接口报告的模型能力；未报告项为未知。已接入文本、思考展示与工具调用；附件输入随后接入。">
                    <div class="d-flex flex-column ga-3">
                        <UiField v-slot="{ controlAttrs }" label="手动模型 ID" for="endpoint-model"><UiInput v-model="modelInput" v-bind="controlAttrs" :disabled="Boolean(busy)" maxlength="200" placeholder="服务商提供的精确模型 ID" @keydown.enter.prevent="addModel" /></UiField>
                        <div class="d-flex flex-wrap ga-2"><UiButton size="sm" :disabled="Boolean(busy) || !modelInput.trim()" @click="addModel">添加模型</UiButton><UiButton size="sm" :loading="busy === 'discover'" :disabled="Boolean(busy) || !draft.name.trim() || !draft.baseUrl.trim()" @click="discover">读取模型目录</UiButton></div>
                        <UiScrollArea v-if="draft.models.length" max-height="180px" label="已选模型"><div class="d-flex flex-column ga-2"><div v-for="id in draft.models" :key="id" class="d-flex align-center justify-space-between ga-2"><div class="min-w-0 flex-grow-1"><div class="ellipsis" :title="id">{{ id }}</div><div class="d-flex flex-wrap align-center ga-2 muted small"><UiTooltip v-for="capability in capabilityIcons(id)" :key="capability.key" :text="capability.label"><span role="img" :aria-label="capability.label"><UiIcon :name="capability.icon" :size="16" /></span></UiTooltip><span v-if="capabilitiesText(id)">{{ capabilitiesText(id) }}</span></div></div><UiButton size="sm" :disabled="Boolean(busy)" :aria-label="`编辑模型能力 ${id}`" @click="editCapabilities(id)">能力设置</UiButton><UiButton size="sm" :disabled="Boolean(busy)" :aria-label="`编辑模型参数 ${id}`" @click="editParameters(id)">生成设置</UiButton><UiButton size="sm" variant="ghost" :disabled="Boolean(busy)" :aria-label="`移除模型 ${id}`" @click="removeModel(id)">移除</UiButton></div></div></UiScrollArea>
                        <p v-else class="muted small">尚未添加模型。目录读取失败时，可手动填写模型 ID。</p>
                    </div>
                </UiCard>
                <UiField v-slot="{ controlAttrs }" label="测试模型" for="endpoint-test-model" description="向该端点发送一条简短消息，验证真实流式响应，可能产生费用。"><UiSelect v-model="testModel" v-bind="controlAttrs" :disabled="Boolean(busy) || !draft.models.length"><option value="" disabled>选择测试模型</option><option v-for="id in draft.models" :key="id" :value="id">{{ id }}</option></UiSelect></UiField>
            </div>
            <template #footer>
                <div class="d-flex flex-wrap ga-2 justify-end"><UiButton v-if="error" variant="ghost" :loading="openingLogs" @click="openLogs">打开日志目录</UiButton><UiButton :disabled="Boolean(busy)" @click="requestClose">关闭</UiButton><UiButton :loading="busy === 'test'" :disabled="Boolean(busy) || !testModel || !draft.name.trim() || !draft.baseUrl.trim()" @click="testConnection">测试连接</UiButton><UiButton variant="primary" :loading="busy === 'save'" :disabled="Boolean(busy) || !draft.name.trim() || !draft.baseUrl.trim()" @click="save">保存端点</UiButton></div>
            </template>
        </UiDialog>
        <ModelCapabilitiesEditor v-model:open="capabilitiesOpen" :model-id="capabilitiesModel" :reported="detailsById.get(capabilitiesModel)" :override="overrideById.get(capabilitiesModel)" @apply="applyCapabilities" @restore="restoreCapabilities" />
        <ModelParametersEditor v-model:open="parametersOpen" :model-id="parametersModel" :parameters="draft.modelParameters.find(item => item.id === parametersModel)?.parameters" @apply="applyParameters" />
        <UiDialog v-model:open="discardOpen" aria-labelledby="discard-endpoint-title"><h2 id="discard-endpoint-title">放弃端点更改？</h2><p>未保存的设置和密钥将被清除。</p><div class="d-flex ga-2 justify-end"><UiButton @click="discardOpen = false">继续编辑</UiButton><UiButton @click="discard">放弃更改</UiButton></div></UiDialog>
        <UiDialog :open="Boolean(deleteTarget)" aria-labelledby="delete-endpoint-title" @update:open="!busy && (deleteTarget = null)"><h2 id="delete-endpoint-title">删除端点？</h2><p>{{ deleteTarget?.name }} 的配置与已保存密钥将被删除。历史对话保留，但不能再通过此端点发送消息。</p><p v-if="error" class="inline-error" role="alert">{{ error }}</p><div class="d-flex ga-2 justify-end"><UiButton :disabled="Boolean(busy)" @click="deleteTarget = null">关闭</UiButton><UiButton :loading="busy === 'delete'" :disabled="Boolean(busy)" @click="deleteEndpoint">确认删除</UiButton></div></UiDialog>
    </section>
</template>
