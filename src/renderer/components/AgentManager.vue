<script setup>
import { clientError } from '../../shared/client-error.js';

import { computed, onMounted, ref, useId } from 'vue';
import { UiButton, UiCard, UiDialog, UiField, UiInput, UiTextarea, UiSelect, UiSwitch, UiScrollArea, UiTabs, UiTabPanel, UiMarkdown, snackbar } from '@lingyzh/ui';
import { openMarkdownLink } from '../markdown-links';

import { useWorkspace } from '../stores/workspace';

const workspace = useWorkspace();
const busy = ref(false);
const error = ref('');
const editing = ref(false);
const globalOpen = ref(false);
const discardOpen = ref(false);
const discardTarget = ref('');
const removing = ref(null);
const draft = ref(null);
const globalDraft = ref(null);
const original = ref('');
const instructionMode = ref('edit');
const instructionTabsId = useId();
const instructionTabs = [{ id: 'edit', label: '编辑' }, { id: 'preview', label: '预览' }];
const kinds = [['primary', '主 Agent'], ['subagent', '子代理角色']];
const globalNumbers = [
    { key: 'maxConcurrentThreads', label: '最大并发子代理', min: 1, max: 32, description: '同时运行的子代理总上限，越大可能消耗更多资源；所有会话共享此上限。' },
    { key: 'maxDepth', label: '最大委派深度', min: 1, max: 8, description: '主代理为第 0 层；1 表示只能启动直属子代理，不能再次向下委派。' },
    { key: 'timeoutSeconds', label: '子代理超时（秒）', min: 5, max: 3600, description: '一次子任务允许的总时长，包含模型请求、工具和审批等待；超时停止任务。' },
];
const globalSwitches = [
    { key: 'enabled', label: '启用子代理', description: '允许模型通过工具启动子代理；父代理还必须允许委派。' },
    { key: 'inheritHistory', label: '默认继承主代理历史', description: '仅作为未指定时的默认值。主代理每次都可选择全量上下文、挑选或整理后的部分内容、无历史的新会话；与继承 Agent 身份独立。' },
];
const copy = value => JSON.parse(JSON.stringify(value));
const modelValue = computed({ get: () => draft.value?.model ? JSON.stringify([draft.value.model.endpointId, draft.value.model.modelId]) : '', set: value => { draft.value.model = decodeModel(value); } });
function decodeModel(value) { if (!value) return null; const [endpointId, modelId] = JSON.parse(value); return { endpointId, modelId }; }
function modelExists(value) { return workspace.modelOptions.some(item => item.value === value); }
async function perform(action) {
    if (busy.value) return;
    busy.value = true; error.value = '';
    try { await action(); } catch (cause) { error.value = clientError(cause); } finally { busy.value = false; }
}
onMounted(() => perform(() => workspace.agentCommand({ type: 'get' })));
function openProfile(profile, kind = 'primary') {
    draft.value = profile ? copy(profile) : { id: crypto.randomUUID(), name: '', description: '', instructions: '', enabled: true, kind, ...(kind === 'subagent' ? { model: null } : {}), allowDelegation: kind === 'primary' };
    original.value = JSON.stringify(draft.value); instructionMode.value = 'edit'; error.value = ''; editing.value = true;
}
function openGlobal() { globalDraft.value = copy(workspace.agentSettings.subagents); original.value = JSON.stringify(globalDraft.value); error.value = ''; globalOpen.value = true; }
function requestClose(target) {
    if (busy.value) return;
    if (JSON.stringify(target === 'profile' ? draft.value : globalDraft.value) !== original.value) { discardTarget.value = target; discardOpen.value = true; }
    else if (target === 'profile') editing.value = false;
    else globalOpen.value = false;
}
function discard() { if (discardTarget.value === 'profile') editing.value = false; else globalOpen.value = false; discardOpen.value = false; }
function saveProfile() {
    return perform(async () => {
        const settings = copy(workspace.agentSettings);
        const index = settings.profiles.findIndex(item => item.id === draft.value.id);
        if (index < 0) settings.profiles.push(copy(draft.value)); else settings.profiles[index] = copy(draft.value);
        await workspace.agentCommand({ type: 'save', settings }); editing.value = false; snackbar.show('Agent 配置已保存，新会话生效', { tone: 'success' });
    });
}
function saveGlobal() { return perform(async () => { await workspace.agentCommand({ type: 'save', settings: { ...copy(workspace.agentSettings), subagents: copy(globalDraft.value) } }); globalOpen.value = false; snackbar.show('子代理调度设置已保存', { tone: 'success' }); }); }
function remove() { return perform(async () => { const settings = copy(workspace.agentSettings); settings.profiles = settings.profiles.filter(item => item.id !== removing.value.id); await workspace.agentCommand({ type: 'save', settings }); removing.value = null; }); }
</script>

<template>
    <section class="settings-page" aria-label="Agent 设置">
        <UiScrollArea label="Agent 配置列表" height="100%" class="flex-grow-1 min-w-0">
            <div class="pa-7 d-flex flex-column ga-5">
                <div class="d-flex flex-wrap align-center justify-space-between ga-3"><div><h1 class="settings-title">Agent 设置</h1><p class="muted">为不同任务配置角色和指令。权限在会话中选择；模型与生成参数在模型与账号中设置。</p></div><UiButton :disabled="busy || !workspace.connected" @click="perform(() => workspace.agentCommand({ type: 'get' }))">刷新配置</UiButton></div>
                <p v-if="error && !editing && !globalOpen && !removing" role="alert" class="inline-error">{{ error }}</p>
                <template v-for="[kind, label] in kinds" :key="kind">
                    <div class="d-flex flex-wrap align-center justify-space-between ga-2"><h2 class="ma-0">{{ label }}</h2><div class="d-flex ga-2"><UiButton v-if="kind === 'subagent'" :disabled="busy || !workspace.agentSettings" @click="openGlobal">调度预设</UiButton><UiButton :disabled="busy || !workspace.agentSettings" @click="openProfile(null, kind)">添加{{ label }}</UiButton></div></div>
                    <p class="muted small ma-0">{{ kind === 'primary' ? '开始对话前选择主 Agent；首轮启动后锁定身份和指令，更换请新建对话。' : '子代理可以继承主 Agent、使用预设角色，或由主代理提供临时指令；所有来源均不能提升权限。执行时应用会话权限和调度上限。' }}</p>
                    <p v-if="kind === 'subagent' && workspace.agentSettings" class="muted small ma-0">{{ workspace.agentSettings.subagents.enabled ? '编排工具已启用。无需创建预设角色，也可继承主 Agent 或使用临时指令。模型须支持工具调用，且当前 Agent 允许委派。' : '编排工具已关闭，模型不会收到子代理工具。请打开「调度预设」并启用子代理。' }}</p>
                    <UiCard v-for="profile in workspace.agentSettings?.profiles.filter(item => item.kind === kind) || []" :key="profile.id" density="compact">
                        <div class="d-flex flex-wrap align-center justify-space-between ga-2"><strong>{{ profile.name }}</strong><span class="muted small">{{ profile.enabled ? '可选' : '已停用' }}</span></div>
                        <p class="muted small break-word">{{ profile.description || '尚未填写用途说明' }}</p>
                        <div class="d-flex flex-wrap justify-space-between align-center ga-2"><span class="muted small">{{ kind === 'subagent' ? (profile.model?.modelId || '模型可继承') : '权限由会话设置' }}</span><div class="d-flex ga-1"><UiButton size="sm" :disabled="busy" :aria-label="`编辑 Agent ${profile.name}`" @click="openProfile(profile)">编辑</UiButton><UiButton size="sm" variant="ghost" :disabled="busy" :aria-label="`删除 Agent ${profile.name}`" @click="error = ''; removing = profile">删除</UiButton></div></div>
                    </UiCard>
                </template>
            </div>
        </UiScrollArea>
        <UiDialog scrollable :open="editing" :error="error" aria-label="编辑 Agent 配置" @update:open="requestClose('profile')">
            <template #header><h2 class="ma-0">{{ draft?.kind === 'subagent' ? '子代理角色' : '主 Agent' }}配置</h2></template>
            <div v-if="draft" class="d-flex flex-column ga-4">
                <UiField v-slot="{ controlAttrs }" label="名称" for="agent-name" description="用于识别和选择角色，不改变模型。"><UiInput v-model="draft.name" v-bind="controlAttrs" maxlength="100" :disabled="busy" /></UiField>
                <UiField v-slot="{ controlAttrs }" label="可供选择" for="agent-enabled" description="停用后不能在新会话或新子任务中选择；已有会话保留原配置。"><UiSwitch v-model="draft.enabled" v-bind="controlAttrs" :disabled="busy" /></UiField>
                <UiField v-slot="{ controlAttrs }" label="用途说明" for="agent-description" description="说明适用任务，方便用户和主代理选择角色；不会作为系统指令发送。"><UiTextarea v-model="draft.description" v-bind="controlAttrs" :rows="2" maxlength="2000" :disabled="busy" /></UiField>
                <section class="d-flex flex-column ga-3 min-w-0" aria-label="Agent 提示词编辑器">
                    <p class="muted small ma-0">支持 Markdown 标题、列表、代码块和表格。预览展示可编辑指令；实际请求还会按角色、权限和可用工具注入宿主规则，指令不能授予额外权限。</p>
                    <UiTabs v-model="instructionMode" :items="instructionTabs" :id-prefix="instructionTabsId" aria-label="提示词显示方式" />
                    <UiTabPanel :model-value="instructionMode" value="edit" :id-prefix="instructionTabsId">
                        <UiField v-slot="{ controlAttrs }" label="Agent 指令" for="agent-instructions" description="定义专业要求、工作流程和回答方式。预设开头的 UAH_PROMPT_PROFILE 标记用于选择角色风格；删除后使用通用角色。角色和工具规则由运行时按条件装配。最多 32000 字符。"><UiTextarea v-model="draft.instructions" v-bind="controlAttrs" :rows="12" maxlength="32000" :disabled="busy" spellcheck="false" /></UiField>
                    </UiTabPanel>
                    <UiTabPanel :model-value="instructionMode" value="preview" :id-prefix="instructionTabsId">
                        <template v-if="instructionMode === 'preview'"><UiMarkdown v-if="draft.instructions.trim()" :source="draft.instructions" @link-click="openMarkdownLink" /><p v-else class="muted small">尚未填写提示词，切换到编辑后输入 Markdown。</p></template>
                    </UiTabPanel>
                    <p class="muted small ma-0" aria-live="polite">{{ draft.instructions.length }} / 32000 字符</p>
                </section>
                <UiField v-if="draft.kind === 'subagent'" v-slot="{ controlAttrs }" label="可选绑定模型" for="agent-model" description="不指定时继承父代理模型；主代理启动时仍可指定 provider、模型及思考强度。生成参数在模型设置中维护。"><UiSelect v-model="modelValue" v-bind="controlAttrs" :disabled="busy"><option value="">继承父代理模型</option><optgroup v-for="group in workspace.modelGroups" :key="group.id" :label="group.label"><option v-for="model in group.models" :key="model.value" :value="model.value">{{ model.label }}</option></optgroup><option v-if="modelValue && !modelExists(modelValue)" :value="modelValue" disabled>已配置模型不可用</option></UiSelect></UiField>
                <UiField v-if="draft.kind === 'primary'" v-slot="{ controlAttrs }" label="允许继续委派" for="agent-delegate" description="默认开启，允许主代理准备子任务；子代理权限始终不能超过它。全局子代理开关和深度上限同样有效。"><UiSwitch v-model="draft.allowDelegation" v-bind="controlAttrs" :disabled="busy" /></UiField>
                <p class="muted small ma-0">主代理通过工具选择子代理模型、思考强度和上下文；可绑定 API 或已启用的 Codex 原生模型。绑定原生模型的角色由原生父任务启动。API 使用端点额度，原生使用本机账号；权限不能超过父代理，原生父任务的 API 子任务写入需逐次审批。</p>
            </div>
            <template #footer><div class="d-flex justify-end ga-2"><UiButton :disabled="busy" @click="requestClose('profile')">关闭</UiButton><UiButton variant="primary" :loading="busy" @click="saveProfile">保存 Agent</UiButton></div></template>
        </UiDialog>
        <UiDialog scrollable :open="globalOpen" :error="error" aria-label="子代理调度预设" @update:open="requestClose('global')">
            <template #header><h2 class="ma-0">子代理调度预设</h2><p class="muted small">对后续启动的子任务生效；不会提升会话自身权限。</p></template>
            <div v-if="globalDraft" class="d-flex flex-column ga-3">
                <UiField v-for="field in globalSwitches" :key="field.key" v-slot="{ controlAttrs }" :label="field.label" :description="field.description" :for="`sub-${field.key}`"><UiSwitch v-model="globalDraft[field.key]" v-bind="controlAttrs" :disabled="busy" /></UiField>
                <UiField v-for="field in globalNumbers" :key="field.key" v-slot="{ controlAttrs }" :label="field.label" :description="field.description" :for="`sub-${field.key}`"><UiInput :model-value="String(globalDraft[field.key])" v-bind="controlAttrs" type="number" :min="field.min" :max="field.max" :disabled="busy" @update:model-value="globalDraft[field.key] = Number($event)" /></UiField>
            </div>
            <template #footer><div class="d-flex justify-end ga-2"><UiButton :disabled="busy" @click="requestClose('global')">关闭</UiButton><UiButton variant="primary" :loading="busy" @click="saveGlobal">保存调度预设</UiButton></div></template>
        </UiDialog>
        <UiDialog v-model:open="discardOpen" aria-label="放弃 Agent 更改"><h2>放弃未保存的更改？</h2><div class="d-flex justify-end ga-2"><UiButton @click="discardOpen = false">继续编辑</UiButton><UiButton @click="discard">放弃更改</UiButton></div></UiDialog>
        <UiDialog :open="Boolean(removing)" aria-label="删除 Agent" @update:open="!busy && (removing = null)"><h2>删除 {{ removing?.name }}？</h2><p>已有会话保留锁定的角色配置；新会话将不能选择此角色。</p><p v-if="error" role="alert" class="inline-error">{{ error }}</p><div class="d-flex justify-end ga-2"><UiButton :disabled="busy" @click="removing = null">关闭</UiButton><UiButton :loading="busy" @click="remove">确认删除</UiButton></div></UiDialog>
    </section>
</template>
