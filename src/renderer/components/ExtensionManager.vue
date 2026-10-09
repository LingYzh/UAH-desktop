<script setup>
import { clientError } from '../../shared/client-error.js';

import { computed, onMounted, ref, watch } from 'vue';
import { UiAlert, UiBadge, UiButton, UiCard, UiDialog, UiField, UiInput, UiTextarea, UiSelect, UiSwitch, UiScrollArea, UiTabs, UiTabsWindow, UiTabsWindowItem } from '@lingyzh/ui';

const props = defineProps({ section: { type: String, default: 'mcp' } });
const data = ref({ connectors: [], plugins: [], skills: [], marketplaces: [] });
const busy = ref(false);
const error = ref('');
const tab = ref('plugins');
const search = ref('');
const editing = ref(false);
const installing = ref('');
const source = ref('');
const confirm = ref(null);
const testResults = ref({});
const editorError = ref('');
const draft = ref({});
const args = ref('[]');
const secrets = ref('{}');
const secretAction = ref('keep');
const skillSummaries = {
    'builtin:grilling': '在规划和执行前澄清会影响结果的关键歧义；优先使用宿主提问工具，已明确的决定不重复询问。',
    'builtin:powershell-windows-cli': '编写和排查 PowerShell、CMD 与 Windows 命令；处理路径、引号、编码及原生命令调用边界。',
};
const skillDescription = item => item.builtin ? skillSummaries[item.id] || item.description : item.description;
const filtered = list => list.filter(item => `${item.name} ${item.description || ''} ${skillDescription(item) || ''}`.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()));
const connectors = computed(() => filtered(data.value.connectors));
const plugins = computed(() => filtered(data.value.plugins));
const skills = computed(() => filtered(data.value.skills));
const pluginDisabled = item => item.pluginId && !data.value.plugins.find(plugin => plugin.id === item.pluginId)?.enabled;
const title = computed(() => props.section === 'mcp' ? 'MCP 连接器' : '插件与技能');
async function run(command) {
    if (busy.value) return false;
    busy.value = true; error.value = ''; editorError.value = '';
    try {
        if (!window.uah?.extensions) throw new Error('请在更新后的桌面应用中管理扩展。');
        data.value = await window.uah.extensions(command);
        return true;
    } catch (cause) { error.value = clientError(cause) || '扩展操作未完成。'; editorError.value = error.value; return false; }
    finally { busy.value = false; }
}
function edit(item) {
    draft.value = item ? JSON.parse(JSON.stringify(item)) : { id: null, name: '', transport: 'stdio', command: '', args: [], url: '', enabled: false, revision: 0, hasSecrets: false };
    args.value = JSON.stringify(draft.value.args, null, 4); secrets.value = '{}'; secretAction.value = draft.value.hasSecrets ? 'keep' : 'replace'; editorError.value = ''; editing.value = true;
}
async function save() {
    try {
        const { hasSecrets, pluginId, ...fields } = draft.value;
        const command = { type: 'save-connector', draft: { ...fields, args: JSON.parse(args.value), secrets: secretAction.value === 'keep' ? null : secretAction.value === 'clear' ? {} : JSON.parse(secrets.value) } };
        if (await run(command)) { editing.value = false; secrets.value = '{}'; }
    } catch { editorError.value = '参数与凭据必须填写合法 JSON；参数为字符串数组，凭据为字符串键值对象。'; }
}
async function toggleConnector(item, enabled) {
    const { hasSecrets, pluginId, ...fields } = item;
    await run({ type: 'save-connector', draft: { ...fields, enabled, secrets: null } });
    delete testResults.value[item.id];
}
async function test(item) {
    if (busy.value) return;
    busy.value = true; error.value = '';
    try { testResults.value[item.id] = await window.uah.testConnector(item.id); }
    catch (cause) { error.value = clientError(cause); }
    finally { busy.value = false; }
}
function install(type) { installing.value = type; source.value = ''; editorError.value = ''; }
async function chooseSource() {
    if (busy.value) return;
    busy.value = true;
    try { const value = await window.uah.chooseDirectory(); if (value) source.value = value; }
    catch (cause) { editorError.value = clientError(cause); }
    finally { busy.value = false; }
}
async function submitInstall() { if (await run({ type: installing.value, source: source.value.trim() })) installing.value = ''; }
async function remove() { if (confirm.value && await run(confirm.value.command)) confirm.value = null; }
onMounted(() => run({ type: 'list' }));
watch(() => props.section, () => { search.value = ''; error.value = ''; void run({ type: 'list' }); });
watch(editing, value => { if (!value) secrets.value = '{}'; });
</script>

<template>
    <section class="settings-page" :aria-label="title">
        <UiScrollArea class="flex-grow-1 min-w-0" :label="title">
            <div class="pa-7 d-flex flex-column ga-5">
                <div class="d-flex flex-wrap align-center justify-space-between ga-3">
                    <div><h1 class="settings-title">{{ title }}</h1><p class="text-muted">{{ section === 'mcp' ? '管理本地与远程工具服务，检查连接及可用工具。' : '安装可复用技能和 Claude Code 插件，按需启用。' }}</p></div>
                    <div class="d-flex flex-wrap ga-2"><UiButton :disabled="busy" @click="run({ type: 'list' })">刷新</UiButton><UiButton v-if="section === 'mcp'" variant="primary" :disabled="busy" @click="edit()">添加连接器</UiButton></div>
                </div>
                <UiAlert v-if="error" tone="error">{{ error }}</UiAlert>
                <UiInput v-model="search" :aria-label="`搜索${title}`" placeholder="按名称或描述筛选" />
                <p class="text-muted ma-0">原生 Codex 的扩展配置在下一轮生效；要立即中止正在进行的原生操作，请停止当前任务。</p>
                <template v-if="section === 'mcp'">
                    <p class="text-muted ma-0">支持 stdio 和 Streamable HTTP，以环境变量或认证请求头连接；浏览器 OAuth 尚未接入。启用后会连接服务并发现工具；API 外部调用默认逐次审批，只读与计划模式不提供外部调用。凭据经系统加密保存。</p>
                    <UiCard v-if="!connectors.length" title="没有匹配的连接器" subtitle="添加服务地址或可执行文件，也可从插件导入 MCP 服务。" />
                    <UiCard v-for="item in connectors" :key="item.id" density="compact" :title="item.name" :subtitle="item.transport === 'http' ? item.url : item.command">
                        <div class="d-flex flex-wrap align-center justify-space-between ga-3">
                            <div class="d-flex flex-wrap align-center ga-2"><UiBadge>{{ item.transport === 'http' ? 'HTTP' : 'stdio' }}</UiBadge><span v-if="item.pluginId" class="text-muted">来自插件{{ pluginDisabled(item) ? ' · 插件已停用' : '' }}</span><UiSwitch :model-value="item.enabled" :disabled="busy || Boolean(pluginDisabled(item))" :aria-label="`启用 ${item.name}`" @update:model-value="toggleConnector(item, $event)" /></div>
                            <div class="d-flex flex-wrap ga-2"><UiButton :disabled="busy || !item.enabled || Boolean(pluginDisabled(item))" @click="test(item)">测试连接</UiButton><UiButton :disabled="busy" @click="edit(item)">编辑</UiButton><UiButton v-if="!item.pluginId" :disabled="busy" @click="confirm = { name: item.name, command: { type: 'delete-connector', id: item.id, revision: item.revision } }">删除</UiButton></div>
                        </div>
                        <p v-if="testResults[item.id]" role="status" class="text-muted mb-0">{{ testResults[item.id].state === 'connected' ? `连接成功 · ${testResults[item.id].tools} 个工具` : testResults[item.id].error || '连接失败，请检查服务配置。' }}</p>
                    </UiCard>
                </template>
                <template v-else>
                    <UiTabs v-model="tab" :items="[{ id: 'plugins', label: '已安装插件' }, { id: 'skills', label: '技能' }, { id: 'marketplaces', label: '插件市场' }]" id-prefix="extensions" aria-label="扩展类型" />
                    <UiTabsWindow eager :keyboard="false" :model-value="tab" id-prefix="extensions">
                        <UiTabsWindowItem value="plugins" :transition="false">
                            <div class="d-flex flex-column ga-4">
                                <div class="d-flex justify-end"><UiButton variant="primary" :disabled="busy" @click="install('install-plugin')">安装插件</UiButton></div>
                                <p class="text-muted ma-0">支持插件包中的 skills 与 MCP；不执行 hooks、安装脚本和其他未支持组件。</p>
                                <UiCard v-if="!plugins.length" title="没有匹配的插件" subtitle="从本地目录、HTTPS Git 仓库或插件市场安装。" />
                                <UiCard v-for="item in plugins" :key="item.id" :title="item.name" :subtitle="item.description" density="compact">
                                    <div class="d-flex flex-wrap align-center justify-space-between ga-3"><span class="text-muted">{{ item.version || '未声明版本' }}</span><div class="d-flex flex-wrap align-center ga-2"><UiSwitch :model-value="item.enabled" :disabled="busy" :aria-label="`启用 ${item.name}`" @update:model-value="run({ type: 'set-plugin-enabled', id: item.id, enabled: $event })" /><UiButton :disabled="busy" @click="run({ type: 'update-plugin', id: item.id })">更新</UiButton><UiButton :disabled="busy" @click="confirm = { name: item.name, command: { type: 'remove-plugin', id: item.id } }">卸载</UiButton></div></div>
                                    <p v-if="item.unsupported.length" class="text-muted mb-0">未启用的组件：{{ item.unsupported.join('、') }}</p>
                                </UiCard>
                            </div>
                        </UiTabsWindowItem>
                        <UiTabsWindowItem value="skills" :transition="false">
                            <div class="d-flex flex-column ga-4"><div class="d-flex justify-end"><UiButton variant="primary" :disabled="busy" @click="install('install-skill')">安装技能</UiButton></div>
                                <UiCard v-if="!skills.length" title="没有匹配的技能" subtitle="选择包含 SKILL.md 的目录，或安装提供技能的插件。" />
                                <UiCard v-for="item in skills" :key="item.id" :title="item.name" :subtitle="skillDescription(item)" density="compact"><div class="d-flex flex-wrap align-center justify-space-between ga-3"><span class="text-muted">{{ item.builtin ? '内置技能 · 随应用更新，可停用' : item.pluginId ? `来自插件${pluginDisabled(item) ? ' · 插件已停用' : ''}` : '独立技能' }}</span><div class="d-flex align-center ga-2"><UiSwitch :model-value="item.enabled" :disabled="busy || Boolean(pluginDisabled(item))" :aria-label="`启用 ${item.name}`" @update:model-value="run({ type: 'set-skill-enabled', id: item.id, enabled: $event })" /><UiButton v-if="!item.pluginId && !item.builtin" :disabled="busy" @click="confirm = { name: item.name, command: { type: 'remove-skill', id: item.id } }">卸载</UiButton></div></div></UiCard>
                            </div>
                        </UiTabsWindowItem>
                        <UiTabsWindowItem value="marketplaces" :transition="false">
                            <div class="d-flex flex-column ga-4"><div class="d-flex justify-end"><UiButton variant="primary" :disabled="busy" @click="install('add-marketplace')">添加插件市场</UiButton></div>
                                <UiCard v-if="!data.marketplaces.length" title="尚未添加插件市场" subtitle="添加包含 .claude-plugin/marketplace.json 的本地目录或 Git 仓库。" />
                                <UiCard v-for="market in data.marketplaces" :key="market.id" :title="market.name" density="compact"><div class="d-flex flex-column ga-3"><div class="d-flex justify-end"><UiButton :disabled="busy" @click="confirm = { name: market.name, command: { type: 'remove-marketplace', id: market.id } }">移除市场</UiButton></div><UiCard v-for="item in filtered(market.plugins)" :key="item.name" :title="item.name" :subtitle="item.description" density="compact"><UiButton :disabled="busy" @click="run({ type: 'install-marketplace-plugin', marketplaceId: market.id, name: item.name })">安装</UiButton></UiCard></div></UiCard>
                            </div>
                        </UiTabsWindowItem>
                    </UiTabsWindow>
                </template>
            </div>
        </UiScrollArea>
        <UiDialog :open="editing" scrollable :error="editorError" aria-labelledby="connector-editor-title" @update:open="value => { if (!busy) editing = value; }">
            <template #header><h2 id="connector-editor-title" class="ma-0">{{ draft.id ? '编辑连接器' : '添加连接器' }}</h2></template>
            <div class="d-flex flex-column ga-4">
                <UiField label="名称" for="connector-name"><UiInput id="connector-name" v-model="draft.name" :disabled="busy" /></UiField>
                <UiField label="传输方式" for="connector-transport"><UiSelect id="connector-transport" v-model="draft.transport" :disabled="busy" :items="[{ value: 'stdio', label: '本地进程（stdio）' }, { value: 'http', label: '远程服务（Streamable HTTP）' }]" /></UiField>
                <template v-if="draft.transport === 'stdio'"><UiField label="可执行文件" for="connector-command" description="Windows 请使用 exe，或 node.exe 加脚本路径；不使用 cmd/bat 启动器。"><UiInput id="connector-command" v-model="draft.command" :disabled="busy" /></UiField><UiField label="参数（JSON 字符串数组）" for="connector-args"><UiTextarea id="connector-args" v-model="args" :rows="4" :disabled="busy" /></UiField></template>
                <UiField v-else label="服务地址" for="connector-url" description="远程服务使用 HTTPS，本地回环允许 HTTP。"><UiInput id="connector-url" v-model="draft.url" :disabled="busy" placeholder="https://example.com/mcp" /></UiField>
                <UiField label="凭据处理" for="connector-secret-action"><UiSelect id="connector-secret-action" v-model="secretAction" :disabled="busy" :items="[{ value: 'keep', label: '保留已保存凭据' }, { value: 'replace', label: '替换凭据' }, { value: 'clear', label: '清除凭据' }]" /></UiField>
                <UiField v-if="secretAction === 'replace'" :label="draft.transport === 'stdio' ? '环境变量（JSON 字符串对象）' : '认证请求头（JSON 字符串对象）'" for="connector-secrets" description="保存后不会再次显示。不要把密钥放在参数或 URL 中。"><UiTextarea id="connector-secrets" v-model="secrets" :rows="4" :disabled="busy" autocomplete="off" /></UiField>
                <UiField label="保存后启用连接器" for="connector-enabled"><UiSwitch id="connector-enabled" v-model="draft.enabled" :disabled="busy" /></UiField>
            </div>
            <template #footer><div class="d-flex justify-end ga-2"><UiButton :disabled="busy" @click="editing = false">关闭</UiButton><UiButton variant="primary" :loading="busy" :disabled="busy" @click="save">保存连接器</UiButton></div></template>
        </UiDialog>
        <UiDialog :open="Boolean(installing)" scrollable :error="editorError" aria-labelledby="extension-install-title" @update:open="value => { if (!value && !busy) installing = ''; }"><template #header><h2 id="extension-install-title" class="ma-0">{{ installing === 'install-skill' ? '安装技能' : installing === 'add-marketplace' ? '添加插件市场' : '安装插件' }}</h2></template><div class="d-flex flex-column ga-4"><UiField label="来源" for="extension-source" :description="installing === 'install-skill' ? '包含 SKILL.md 的本地目录。' : '本地目录、HTTPS Git URL 或 GitHub owner/repo。'"><UiInput id="extension-source" v-model="source" :disabled="busy" /></UiField><UiButton :disabled="busy" @click="chooseSource">选择本地目录</UiButton><p class="text-muted ma-0">安装到应用管理的独立副本，源目录保留。插件中的 MCP 默认停用，请检查配置后启用。</p></div><template #footer><div class="d-flex justify-end ga-2"><UiButton :disabled="busy" @click="installing = ''">关闭</UiButton><UiButton variant="primary" :loading="busy" :disabled="busy || !source.trim()" @click="submitInstall">确认安装</UiButton></div></template></UiDialog>
        <UiDialog :open="Boolean(confirm)" :error="editorError" aria-labelledby="extension-remove-title" @update:open="value => { if (!value && !busy) confirm = null; }"><h2 id="extension-remove-title">移除 {{ confirm?.name }}？</h2><p>移除应用管理的配置或安装副本；原始来源与对话记录保留。</p><div class="d-flex justify-end ga-2"><UiButton :disabled="busy" @click="confirm = null">取消</UiButton><UiButton variant="danger" :disabled="busy" :loading="busy" @click="remove">确认移除</UiButton></div></UiDialog>
    </section>
</template>
