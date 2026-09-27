<script setup>
import { ref, watch } from 'vue';
import { UiDialog, UiButton, UiField, UiSelect, UiInput } from '@lingyzh/ui';
const props = defineProps({ open: Boolean, modelId: String, reported: Object, override: Object });
const emit = defineEmits(['update:open', 'apply', 'restore']);
const form = ref({});
const context = ref('');
const outputLimit = ref('');
const outputMode = ref('inherit');
const outputTypes = ref({});
const error = ref('');
const fields = [
    ['imageInput', '图片输入'], ['pdfInput', 'PDF 输入'], ['audioInput', '音频输入'], ['videoInput', '视频输入'],
    ['tools', '工具调用'], ['reasoning', '推理'], ['streaming', '流式响应'],
];
const modalities = [['text', '文本'], ['image', '图像'], ['audio', '音频'], ['video', '视频'], ['pdf', 'PDF'], ['file', '文件']];
const descriptions = {
    imageInput: '模型能否直接理解图片。', pdfInput: '模型能否直接读取 PDF 内容。',
    audioInput: '模型能否直接理解输入音频。', videoInput: '模型能否直接理解输入视频。',
    tools: '模型能否返回结构化工具调用；应用仍需接入工具执行。',
    reasoning: '模型是否提供专用思考能力；具体强度在生成设置中配置。',
    streaming: '模型能否逐段返回回答。',
};
watch(() => props.open, (open) => {
    if (!open) return;
    const source = props.override || {};
    form.value = Object.fromEntries(fields.map(([key]) => [key, typeof source[key] === 'boolean' ? String(source[key]) : 'inherit']));
    context.value = source.contextWindow?.toString() || '';
    outputLimit.value = source.maxOutputTokens?.toString() || '';
    outputMode.value = source.outputModalities === undefined ? 'inherit' : 'manual';
    outputTypes.value = Object.fromEntries(modalities.map(([key]) => [key, String(source.outputModalities?.includes(key) || false)]));
    error.value = '';
}, { immediate: true });
function declared(key) {
    const value = props.reported?.[key];
    return typeof value === 'boolean' ? (value ? '接口声明：支持' : '接口声明：不支持') : '接口未声明，当前为未知';
}
function apply() {
    const value = { id: props.modelId };
    for (const [key] of fields) if (form.value[key] !== 'inherit') value[key] = form.value[key] === 'true';
    for (const [key, draft] of [['contextWindow', context.value], ['maxOutputTokens', outputLimit.value]]) {
        if (draft.trim()) {
            const number = Number(draft);
            if (!Number.isSafeInteger(number) || number <= 0 || number > 1e9) { error.value = 'Token 上限须为 1–1,000,000,000 的整数；留空使用接口声明。'; return; }
            value[key] = number;
        }
    }
    if (outputMode.value === 'manual') value.outputModalities = modalities.filter(([key]) => outputTypes.value[key] === 'true').map(([key]) => key);
    emit('apply', value);
    emit('update:open', false);
}
function restore() { emit('restore'); emit('update:open', false); }
</script>

<template>
    <UiDialog :open="open" scrollable :error="error" aria-labelledby="model-capabilities-title" @update:open="emit('update:open', $event)">
        <template #header><h2 id="model-capabilities-title" class="ma-0">模型能力设置</h2><p class="muted small break-word">{{ modelId }}</p></template>
        <div class="d-flex flex-column ga-4">
            <p class="muted small">手动设置优先于接口声明，重新读取目录时保留。未覆盖项继续使用接口信息；这些设置不会自动实现当前应用尚未接入的功能。</p>
            <UiField v-for="[key, label] in fields" :key="key" v-slot="{ controlAttrs }" :label="label" :for="'capability-' + key" :description="descriptions[key] + ' ' + declared(key)">
                <UiSelect v-model="form[key]" v-bind="controlAttrs"><option value="inherit">使用接口声明</option><option value="true">支持</option><option value="false">不支持</option></UiSelect>
            </UiField>
            <UiField v-slot="{ controlAttrs }" label="上下文长度覆盖" for="capability-context" :description="'接口声明：' + (reported?.contextWindow || '未知') + ' tokens；留空使用接口声明。'"><UiInput v-model="context" v-bind="controlAttrs" inputmode="numeric" placeholder="使用接口声明" /></UiField>
            <UiField v-slot="{ controlAttrs }" label="最大输出长度覆盖" for="capability-output-limit" :description="'接口声明：' + (reported?.maxOutputTokens || '未知') + ' tokens；留空使用接口声明。'"><UiInput v-model="outputLimit" v-bind="controlAttrs" inputmode="numeric" placeholder="使用接口声明" /></UiField>
            <UiField v-slot="{ controlAttrs }" label="输出模态设置" for="capability-output-mode" description="声明模型能生成的内容类型；选择手动设置可逐项覆盖，不能改变服务端能力。"><UiSelect v-model="outputMode" v-bind="controlAttrs"><option value="inherit">使用接口声明</option><option value="manual">手动设置</option></UiSelect></UiField>
            <template v-if="outputMode === 'manual'">
                <UiField v-for="[key, label] in modalities" :key="key" v-slot="{ controlAttrs }" :label="label + '输出'" :for="'output-' + key" :description="`模型是否能够生成${label}内容。`"><UiSelect v-model="outputTypes[key]" v-bind="controlAttrs"><option value="true">支持</option><option value="false">不支持</option></UiSelect></UiField>
            </template>
        </div>
        <template #footer><div class="d-flex flex-wrap justify-end ga-2"><UiButton variant="ghost" @click="restore">恢复接口声明</UiButton><UiButton aria-label="关闭模型能力设置" @click="emit('update:open', false)">关闭</UiButton><UiButton variant="primary" @click="apply">应用到端点草稿</UiButton></div></template>
    </UiDialog>
</template>
