<script setup>
import { clientError } from '../../shared/client-error.js';

import { computed, ref, watch } from 'vue';
import { UiDialog, UiButton, UiField, UiInput, UiSelect, UiTextarea } from '@lingyzh/ui';
import { defaultModelParameters, parseModelParameters } from '../../shared/model-parameters';

const props = defineProps({ open: Boolean, modelId: String, parameters: Object });
const emit = defineEmits(['update:open', 'apply']);
const form = ref(defaultModelParameters());
const error = ref('');
const fields = [
    { key: 'temperature', label: 'Temperature', min: 0, max: 2, step: .1, description: '控制回答的随机程度；较低更稳定，较高更多样。留空使用服务默认值，通常无需和 Top P 同时修改。' },
    { key: 'topP', label: 'Top P', min: 0, max: 1, step: .05, description: '限制采样时考虑的候选词概率范围；越小越集中。留空使用服务默认值。' },
    { key: 'maxOutputTokens', label: '最大输出 tokens', min: 1, max: 1000000, step: 1, description: '限制一次回答的输出预算，过小可能截断回答；不是模型能力声明中的最大上限。留空使用协议默认值。' },
    { key: 'historyTurns', label: '携带历史轮数', min: 0, max: 100, step: 1, description: '发送最近多少轮已完成的问答；0 仅发送当前消息和 Agent 指令。减少历史可以降低用量，但模型会失去前文。' },
    { key: 'timeoutSeconds', label: '请求超时（秒）', min: 5, max: 600, step: 1, description: '一次请求允许的总时长，超时将停止等待。较长的推理或回答可能需要增加此值。' },
];
const stopText = computed({ get: () => form.value.stop.join('\n'), set: value => { form.value.stop = value.split('\n').filter(Boolean); } });
watch(() => props.open, open => {
    if (open) { form.value = JSON.parse(JSON.stringify(props.parameters || defaultModelParameters())); error.value = ''; }
});
function apply() {
    try { emit('apply', { id: props.modelId, parameters: parseModelParameters(JSON.parse(JSON.stringify(form.value))) }); emit('update:open', false); }
    catch (cause) { error.value = clientError(cause); }
}
</script>

<template>
    <UiDialog :open="open" scrollable :error="error" aria-label="模型生成设置" @update:open="emit('update:open', $event)">
        <template #header><h2 class="ma-0">模型生成设置</h2><p class="muted small break-word">{{ modelId }} · 保存端点后用于下一轮请求，与所选 Agent 无关。</p></template>
        <div class="d-flex flex-column ga-3">
            <UiField v-for="field in fields" :key="field.key" v-slot="{ controlAttrs }" :label="field.label" :description="field.description" :for="`model-param-${field.key}`">
                <UiInput :model-value="form[field.key] == null ? '' : String(form[field.key])" v-bind="controlAttrs" type="number" :min="field.min" :max="field.max" :step="field.step" placeholder="默认" @update:model-value="form[field.key] = $event === '' ? null : Number($event)" />
            </UiField>
            <UiField v-slot="{ controlAttrs }" label="停止序列" for="model-param-stop" description="输出遇到这些文本时提前停止，每行一个，最多 4 个；通常留空。Responses 协议不支持此项。"><UiTextarea v-model="stopText" v-bind="controlAttrs" :rows="3" /></UiField>
            <p class="muted small ma-0">不同模型支持的参数和范围不同，不支持的组合会返回明确错误。修改能力声明不会让服务端自动支持这些参数。</p>
        </div>
        <template #footer><div class="d-flex flex-wrap justify-end ga-2"><UiButton variant="ghost" @click="form = defaultModelParameters()">恢复默认</UiButton><UiButton @click="emit('update:open', false)">关闭</UiButton><UiButton variant="primary" @click="apply">应用到端点草稿</UiButton></div></template>
    </UiDialog>
</template>
