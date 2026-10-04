<script setup>
import { computed } from 'vue';
import { UiDialog, UiButton, UiUsageMeter } from '@lingyzh/ui';
const props = defineProps({ open: Boolean, run: Object });
const emit = defineEmits(['update:open']);
const usage = computed(() => props.run?.nativeContext);
const fields = [['totalTokens', '上下文 token（原生 last.total）'], ['inputTokens', '最近请求输入'], ['outputTokens', '最近请求输出'], ['cachedInputTokens', '缓存读取输入（包含在输入内）'], ['cacheWriteInputTokens', '缓存写入输入'], ['reasoningOutputTokens', '推理输出（包含在输出内）']];
const count = value => value === undefined ? '未上报' : value.toLocaleString();
</script>

<template>
    <UiDialog :open="open" scrollable aria-label="原生上下文统计" @update:open="emit('update:open', $event)">
        <template #header><h2>原生上下文统计</h2></template>
        <p class="muted small">来自 Codex 最近一次真实用量通知。上下文取原生 last.totalTokens，容量取 modelContextWindow；占比按这两个原始值计算。线程累计消耗不是当前上下文占用，也不是下一次请求的预测。</p>
        <template v-if="usage">
            <UiUsageMeter label="原生上下文 token" :used="usage.totalTokens" :capacity="usage.capacity" />
            <p v-for="[field, label] in fields" :key="field">{{ label }}：{{ count(usage[field]) }}</p>
            <p>上下文容量：{{ count(usage.capacity) }}</p>
            <p>线程累计 token：{{ count(usage.cumulative?.totalTokens) }}</p>
            <p>累计输入 / 输出：{{ count(usage.cumulative?.inputTokens) }} / {{ count(usage.cumulative?.outputTokens) }}</p>
            <p>累计缓存读取 / 写入：{{ count(usage.cumulative?.cachedInputTokens) }} / {{ count(usage.cumulative?.cacheWriteInputTokens) }}</p>
            <p>累计推理输出：{{ count(usage.cumulative?.reasoningOutputTokens) }}</p>
            <p class="muted small">更新于 {{ new Date(usage.capturedAt).toLocaleString() }}。原生内部完整提示词和分类占比未暴露，未知字段不按零处理。</p>
        </template>
        <p v-else class="muted">Codex 尚未上报此会话的上下文用量。</p>
        <template #footer><UiButton @click="emit('update:open', false)">关闭</UiButton></template>
    </UiDialog>
</template>
