<script setup>
import { computed, ref } from 'vue';
import { UiButton, UiCard, UiField, UiInput, UiSelect } from '@lingyzh/ui';
import { useWorkspace } from '../stores/workspace';

const props = defineProps({ runId: String, request: Object });
const workspace = useWorkspace();
const threadReplacement = computed(() => props.request.id === 'question:thread-replacement');
const selections = ref(Object.fromEntries(props.request.questions.map(question => [question.id, ''])));
const text = ref({});
const answer = question => text.value[question.id]?.trim() || selections.value[question.id] || '';
const complete = computed(() => props.request.questions.every(question => answer(question)));
async function submit() {
    if (!complete.value || workspace.busy) return;
    const answers = Object.fromEntries(props.request.questions.map(question => [question.id, { answers: [answer(question)] }]));
    await workspace.answerNativeQuestion(props.runId, props.request.id, answers);
    if (!workspace.error) text.value = {};
}
async function decideThread(label) {
    if (workspace.busy) return;
    await workspace.answerNativeQuestion(props.runId, props.request.id, { 'confirm-thread-replacement': { answers: [label] } });
}
</script>

<template>
    <UiCard :title="threadReplacement ? '需要新建 Codex 线程' : 'Codex 需要你的回答'" density="compact">
        <div v-if="threadReplacement" class="d-flex flex-column ga-4">
            <template v-for="question in request.questions" :key="question.id">
                <p v-for="(line, index) in question.question.split('\n').filter(Boolean)" :key="index" class="small break-word ma-0">{{ line }}</p>
            </template>
            <div class="d-flex flex-wrap ga-2">
                <UiButton :disabled="workspace.busy" @click="decideThread('取消本次发送')">取消本次发送</UiButton>
                <UiButton :disabled="workspace.busy" @click="decideThread('新建线程并继续')">新建线程并继续</UiButton>
            </div>
        </div>
        <div v-else class="d-flex flex-column ga-4">
            <div v-for="question in request.questions" :key="question.id">
                <UiField :label="question.question" :for="`${request.id}-${question.id}`">
                    <UiSelect v-if="question.options?.length && !question.isSecret" :id="`${request.id}-${question.id}`" v-model="selections[question.id]" :disabled="workspace.busy" placeholder="请选择">
                        <option v-for="option in question.options" :key="option.label" :value="option.label">{{ option.label }} — {{ option.description }}</option>
                    </UiSelect>
                    <UiInput v-else :id="`${request.id}-${question.id}`" v-model="text[question.id]" :type="question.isSecret ? 'password' : 'text'" :disabled="workspace.busy" :maxlength="4000" />
                </UiField>
                <UiField v-if="question.options?.length && !question.isSecret" label="或填写自己的回答" :for="`${request.id}-${question.id}-custom`">
                    <UiInput :id="`${request.id}-${question.id}-custom`" v-model="text[question.id]" :disabled="workspace.busy" :maxlength="4000" />
                </UiField>
            </div>
            <UiButton :disabled="!complete || workspace.busy" @click="submit">提交回答</UiButton>
        </div>
    </UiCard>
</template>
