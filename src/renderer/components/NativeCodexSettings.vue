<script setup>
import { clientError } from '../../shared/client-error.js';

import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { UiAlert, UiButton, UiCard, UiCodeBlock, UiDialog, UiField, UiInput, UiTextarea, UiSwitch, UiSelect } from '@lingyzh/ui';
import { useWorkspace } from '../stores/workspace';

const workspace = useWorkspace();
const open = ref(false);
const help = ref(false);
const busy = ref(false);
const operation = ref('');
const error = ref('');
const discoveryNote = ref('');
const candidates = ref([]);
const candidate = ref('');
const draft = ref({ enabled: false, command: '', args: [], model: '', revision: 0 });
const args = ref('[]');
const probe = ref(null);
const probeTarget = ref('');
let generation = 0;
const target = computed(() => JSON.stringify([draft.value.command, args.value]));
const models = computed(() => {
    const found = (probe.value?.models || []).map(item => ({ value: item.id, label: `${item.name}${item.isDefault ? '（默认）' : ''}` }));
    if (draft.value.model && !found.some(item => item.value === draft.value.model)) found.unshift({ value: draft.value.model, label: `${draft.value.model}（当前设置，目录未列出）` });
    return found;
});
const sourceLabels = { PATH: '系统 PATH', 'npm native package': 'npm 原生程序', 'npm package': 'npm + Node.js', 'AppData npm': '用户 npm', 'ProgramFiles nodejs': '系统 Node.js', 'Local nodejs': '用户 Node.js' };
const candidateItems = computed(() => candidates.value.map((item, index) => ({ value: String(index), label: `${index + 1} · ${sourceLabels[item.source] || item.source}` })));
const exampleArgs = JSON.stringify(['C:\\Program Files\\nodejs\\node_modules\\@openai\\codex\\bin\\codex.js'], null, 4);
function settingsForProbe() {
    const parsed = JSON.parse(args.value);
    if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) throw new Error('启动参数必须为 JSON 字符串数组。');
    return { ...draft.value, enabled: false, args: parsed };
}
async function guarded(label, work) {
    if (busy.value) return;
    const current = generation;
    busy.value = true; operation.value = label; error.value = '';
    try { await work(current); }
    catch (cause) { if (current === generation) error.value = clientError(cause); }
    finally { if (current === generation) { busy.value = false; operation.value = ''; } }
}
async function fetchModels(current) {
    const fingerprint = target.value;
    const result = await workspace.nativeCommand({ type: 'probe', settings: settingsForProbe() });
    if (current !== generation || fingerprint !== target.value) return;
    probe.value = result.probe; probeTarget.value = fingerprint;
    if (!draft.value.model) draft.value.model = result.probe.models.find(item => item.isDefault)?.id || result.probe.models[0]?.id || '';
    if (!result.probe.models.length) error.value = 'Codex 没有返回模型，请检查本机登录与配置，或手动填写模型 ID。';
}
async function scan(current, fillEmpty) {
    const result = await workspace.nativeCommand({ type: 'discover' });
    if (current !== generation) return;
    candidates.value = result.candidates || [];
    discoveryNote.value = candidates.value.length ? `找到 ${candidates.value.length} 个启动方式，可切换或手动修改。` : '未找到 Codex。请安装 Codex CLI，或手动填写已有安装路径。';
    if (fillEmpty && !draft.value.command && candidates.value.length) {
        candidate.value = '0'; draft.value.command = candidates.value[0].command;
        args.value = JSON.stringify(candidates.value[0].args, null, 4);
    }
    if (draft.value.command) await fetchModels(current);
}
function edit() {
    generation++;
    draft.value = JSON.parse(JSON.stringify(workspace.nativeStatus?.settings || draft.value));
    args.value = JSON.stringify(draft.value.args, null, 4);
    error.value = ''; probe.value = null; candidates.value = []; candidate.value = ''; discoveryNote.value = ''; open.value = true;
    void guarded('正在查找安装并获取模型…', current => scan(current, true));
}
function useCandidate(value) {
    const selected = candidates.value[Number(value)];
    if (!selected || busy.value) return;
    candidate.value = value; draft.value.command = selected.command; args.value = JSON.stringify(selected.args, null, 4);
    void guarded('正在获取模型…', fetchModels);
}
async function save() {
    await guarded('正在保存…', async current => {
        const result = await workspace.nativeCommand({ type: 'save', settings: { ...settingsForProbe(), enabled: draft.value.enabled } });
        if (current !== generation) return;
        draft.value = structuredClone(result.settings);
        open.value = false;
        void workspace.refreshNativeModels();
    });
}
watch(target, () => { if (probeTarget.value !== target.value) probe.value = null; });
watch(open, value => { if (!value) { help.value = false; error.value = ''; } });
onBeforeUnmount(() => { generation++; });
</script>

<template>
    <UiCard density="compact" title="Codex 原生运行时" subtitle="把本机 Codex CLI 作为 UAH 的另一种聊天运行方式，使用它自己的登录账号。">
        <div class="d-flex flex-wrap ga-3 align-center justify-space-between">
            <span class="text-muted">{{ workspace.nativeStatus?.settings.enabled ? `已启用 · ${workspace.nativeStatus.settings.model}` : '未启用' }}</span>
            <UiButton :disabled="!workspace.connected" @click="edit">配置原生 Codex</UiButton>
        </div>
        <p class="text-muted mb-0">启用后，聊天模型菜单增加「Codex 原生」。关闭后不再启动新原生轮次，正在运行的任务需单独停止；API 端点、登录信息和历史记录保留。</p>
        <UiAlert v-if="workspace.nativeCatalogError" tone="warning">模型目录未刷新：{{ workspace.nativeCatalogError }}。可打开配置重试。</UiAlert>
    </UiCard>
    <UiDialog :open="open" scrollable :error="error" aria-labelledby="native-settings-title" @update:open="value => { if (!busy) open = value; }">
        <template #header><h2 id="native-settings-title" class="ma-0">Codex 原生运行时</h2></template>
        <div class="d-flex flex-column ga-4">
            <UiAlert>打开时自动查找安装并获取模型。检测只读取版本、登录状态和模型目录；保存前不会更改绑定，也不会发送模型任务。</UiAlert>
            <div class="d-flex flex-wrap ga-2"><UiButton :disabled="busy" @click="guarded('正在重新扫描…', current => scan(current, true))">重新扫描安装</UiButton><UiButton :disabled="busy" @click="help = true">启动参数怎么写</UiButton></div>
            <p v-if="busy || discoveryNote" class="text-muted ma-0" role="status">{{ busy ? operation : discoveryNote }}</p>
            <UiField v-if="candidates.length" label="检测到的安装" for="native-candidate" description="已有配置会保留；选择另一项会重新获取模型。"><UiSelect id="native-candidate" :model-value="candidate" :items="candidateItems" placeholder="选择检测到的安装" :disabled="busy" @update:model-value="useCandidate" /></UiField>
            <UiField label="可执行文件绝对路径" for="native-command" description="使用 codex.exe，或 node.exe 配合 codex.js 启动参数。"><UiInput id="native-command" v-model="draft.command" :disabled="busy" placeholder="C:\Program Files\nodejs\node.exe" /></UiField>
            <UiField label="启动参数（JSON 数组）" for="native-args" description="这里只写启动入口参数；app-server --stdio 由应用追加。"><UiTextarea id="native-args" v-model="args" :rows="3" :disabled="busy" /></UiField>
            <UiField label="默认模型" for="native-model" description="自动通过 model/list 获取。保留已有选择；新绑定优先选择 Codex 返回的默认模型。">
                <UiSelect v-if="probe?.models.length" id="native-model" v-model="draft.model" :items="models" :disabled="busy" />
                <UiInput v-else id="native-model" v-model="draft.model" :disabled="busy" placeholder="获取失败时可手动填写模型 ID" />
            </UiField>
            <UiButton :disabled="busy || !draft.command" @click="guarded('正在获取模型…', fetchModels)">刷新模型与登录状态</UiButton>
            <UiField label="启用原生 Codex" for="native-enabled" description="保存后，在聊天中提供原生模型选择。关闭仅阻止新原生轮次，不退出账号、不删历史、不自动停止当前任务。"><UiSwitch id="native-enabled" v-model="draft.enabled" :disabled="busy" /></UiField>
            <UiCard density="compact" title="子代理边界"><p class="ma-0">原生 Codex 可通过 UAH 工具启动和等待子代理。子代理可绑定 API 模型或「Codex 原生」模型；API 调用使用端点额度，原生调用使用本机 Codex 账号。角色、并发、深度和超时统一由 UAH 管理。</p><p class="text-muted mb-0">需在「Agent 配置 → 调度预设」启用子代理。原生自带的多代理功能关闭，避免两套调度混用。共享工作区的执行按锁串行；停止父任务会停止下级任务。原生内部请求不可完整观察，预算只统计宿主可见轮次、工具与用量。</p></UiCard>
            <p class="text-muted ma-0">原生主会话使用 native-default 和本机 Codex 配置；子代理只附加角色要求，不替换原生基础指令。API 子代理不开放无沙箱命令或外部 MCP，避免越过原生父任务边界。API 父任务暂不能反向启动原生子代理。权限使用 Codex 原生的只读、默认权限和完全访问；MCP 按本机及 UAH 扩展配置运行。/plan 使用原生计划模式，/goal 使用原生目标接口。UAH 记录可观察事件，未暴露的请求与文件快照显示为部分覆盖。</p>
            <UiCard v-if="probe" density="compact" title="检测结果" :subtitle="probe.version"><p class="ma-0">{{ probe.authenticated ? '已登录' : '未检测到登录账号' }} · {{ probe.models.length }} 个模型</p><p class="text-muted mb-0">模型目录可能来自本机缓存；实际可用性取决于账号与服务，不发送任务验证权限。</p></UiCard>
        </div>
        <template #footer><div class="d-flex flex-wrap justify-end ga-2"><UiButton :disabled="busy" @click="open = false">关闭</UiButton><UiButton variant="primary" :loading="busy" :disabled="busy" @click="save">保存</UiButton></div></template>
    </UiDialog>
    <UiDialog v-model:open="help" scrollable aria-labelledby="native-args-help-title">
        <template #header><h2 id="native-args-help-title" class="ma-0">启动参数怎么写</h2></template>
        <div class="d-flex flex-column ga-4">
            <p class="ma-0">启动参数是 JSON 字符串数组，每个元素代表一个参数。路径有空格时也放在同一个字符串内；Windows 反斜杠写成两个，或者改用正斜杠。</p>
            <UiCard density="compact" title="方式一：直接使用 codex.exe"><p>可执行文件填 Codex 的完整 exe 路径，参数留空数组：</p><UiCodeBlock code="[]" language="json" dense /></UiCard>
            <UiCard density="compact" title="方式二：通过 Node.js 启动 npm 安装的 Codex"><p>可执行文件填 node.exe 的完整路径；参数填 codex.js 的实际路径。以下只是示例，以自动扫描结果为准：</p><UiCodeBlock :code="exampleArgs" language="json" dense /></UiCard>
            <p class="ma-0">不要粘贴整行终端命令、codex.cmd 或 PowerShell 脚本。UAH 自动追加 app-server --stdio；模型在默认模型中选择，权限在聊天中选择。</p>
            <UiAlert>此版本不接受 -c、--model、--sandbox 等 CLI 选项，也不要填写 Token 或其他凭据。高级配置使用 Codex 支持的本机配置文件；登录在本机 Codex 中完成。</UiAlert>
            <p class="text-muted ma-0">找不到安装时，可先在终端确认 Codex CLI 已安装，再重新扫描。修改路径或参数后点「刷新模型与登录状态」，成功后保存。</p>
        </div>
        <template #footer><UiButton @click="help = false">知道了</UiButton></template>
    </UiDialog>
</template>
