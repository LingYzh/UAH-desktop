import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const evidence = await (async () => {
    await mkdir(path.join(root, 'artifacts'), { recursive: true });
    return mkdtemp(path.join(root, 'artifacts', 'provider-catalog-'));
})();
const dataDirectory = path.join(evidence, 'data');
const project = path.join(evidence, 'project');
const recordFile = path.join(evidence, 'native-app-server.jsonl');
const fixturePath = path.join(root, 'tests', 'fixtures', 'codex-app-server-fixture.mjs');
const baseUrl = 'https://catalog-fixture.invalid/v1';
const enabledKey = 'catalog-enabled-fixture-key';
const disabledKey = 'catalog-disabled-fixture-key';
const sessionTitle = 'Provider catalog native fixture';
const scenario = {
    recordFile,
    dynamicInputMatch: 'CATALOG',
    dynamicCalls: [{ tool: 'uah_list_agent_presets', arguments: {} }],
    textChunks: ['Provider catalog fixture completed.'],
};
const errors = [];
const checks = [];
const env = { ...process.env, UAH_DATA_DIR: dataDirectory };
delete env.ELECTRON_RUN_AS_NODE;
delete env.UAH_DEV_URL;
await mkdir(project, { recursive: true });

const app = await electron.launch({ args: ['.'], cwd: root, env, timeout: 30000 });
const page = await app.firstWindow();
page.setDefaultTimeout(15000);
page.on('pageerror', error => errors.push(error.message));

async function snapshot() {
    return page.evaluate(() => window.uah.command({ type: 'snapshot' }));
}

async function waitForRun(input) {
    const deadline = Date.now() + 30_000;
    let run;
    while (Date.now() < deadline) {
        const state = await snapshot();
        run = state.runs.find(item => item.input === input);
        if (run && ['completed', 'failed', 'stopped', 'cancelled'].includes(run.state)) break;
        await page.waitForTimeout(50);
    }
    assert.ok(run, `Native catalog run ${input} was saved.`);
    assert.equal(run.state, 'completed', run.error || `Native catalog run ended in ${run.state}.`);
    return run;
}

async function catalogForRun(input) {
    const run = await waitForRun(input);
    const activity = run.activities?.find(item => item.kind === 'tool' && item.tool?.name === 'uah_list_agent_presets');
    assert.ok(activity, `Run ${input} contains the native provider-catalog tool call.`);
    assert.equal(activity.status, 'completed', activity.tool?.result || activity.content);
    const content = activity.tool?.result || activity.content;
    assert.equal(typeof content, 'string');
    return JSON.parse(content);
}

function check(name, condition) {
    assert.ok(condition, name);
    checks.push(name);
    console.log(`PASS ${name}`);
}

async function saveProvider({ name, providerId, enabled, apiKey }) {
    return page.evaluate(async draft => {
        const result = await window.uah.endpoints({ type: 'save', draft });
        return result.endpoints.find(endpoint => endpoint.name === draft.name);
    }, {
        id: null,
        providerId,
        name,
        protocol: 'openai-chat',
        baseUrl,
        models: ['catalog-model'],
        enabled,
        revision: 0,
        apiKey,
    });
}

async function updateProvider(id, update) {
    return page.evaluate(async ({ id, update }) => {
        const current = (await window.uah.endpoints({ type: 'list' })).endpoints.find(item => item.id === id);
        if (!current) throw new Error('Fixture endpoint disappeared.');
        const { hasKey: _hasKey, ...draft } = current;
        const result = await window.uah.endpoints({ type: 'save', draft: { ...draft, ...update, apiKey: null } });
        return result.endpoints.find(item => item.id === id);
    }, { id, update });
}

function assertCatalog(catalog, companyAlias, companyEnabled, internalIds) {
    assert.equal(catalog.providerCatalogAvailable, true);
    assert.ok(Array.isArray(catalog.providers));
    const serializedProviders = JSON.stringify(catalog.providers);
    assert.equal(serializedProviders.includes(enabledKey), false, 'the provider catalog does not expose API keys');
    assert.equal(serializedProviders.includes(disabledKey), false, 'the provider catalog does not expose disabled-provider keys');
    assert.equal(serializedProviders.includes(baseUrl), false, 'the provider catalog does not expose base URLs');
    for (const id of internalIds) assert.equal(serializedProviders.includes(id), false, 'the provider catalog does not expose internal endpoint IDs');
    for (const provider of catalog.providers) {
        assert.equal(Object.hasOwn(provider, 'id'), false, 'catalog entries expose no internal id field');
        assert.equal(Object.hasOwn(provider, 'apiKey'), false);
        assert.equal(Object.hasOwn(provider, 'baseUrl'), false);
    }
    const company = catalog.providers.find(provider => provider.providerId === companyAlias);
    if (companyEnabled) {
        assert.deepEqual(company, {
            providerId: companyAlias,
            name: 'Company catalog fixture',
            models: ['catalog-model'],
            runtimeId: 'api',
        });
    } else {
        assert.equal(company, undefined, 'disabled API providers are omitted from the catalog');
    }
    assert.equal(catalog.providers.some(provider => provider.providerId === 'disabled-company'), false);
    const native = catalog.providers.find(provider => provider.providerId === 'native:codex');
    assert.deepEqual(native, {
        providerId: 'native:codex',
        name: 'Codex 原生',
        models: ['gpt-fixture'],
        runtimeId: 'codex-native',
    });
}

try {
    await page.waitForFunction(() => Boolean(window.uah?.nativeCodex && window.uah?.endpoints && window.uah?.agents));

    const company = await saveProvider({ name: 'Company catalog fixture', providerId: 'company', enabled: true, apiKey: enabledKey });
    const disabled = await saveProvider({ name: 'Disabled catalog fixture', providerId: 'disabled-company', enabled: false, apiKey: disabledKey });
    assert.ok(company?.id && disabled?.id);
    assert.notEqual(company.id, 'company');
    assert.equal(company.providerId, 'company');
    assert.equal(company.hasKey, true);
    assert.equal(disabled.enabled, false);

    const agentSettings = await page.evaluate(() => window.uah.agents({ type: 'get' }));
    await page.evaluate(settings => window.uah.agents({ type: 'save', settings }), {
        ...agentSettings,
        subagents: { ...agentSettings.subagents, enabled: true },
    });

    const args = [fixturePath, JSON.stringify(scenario)];
    await page.evaluate(({ command, args: nativeArgs }) => window.uah.nativeCodex({ type: 'save', settings: {
        enabled: true, command, args: nativeArgs, model: 'gpt-fixture', revision: 0,
    } }), { command: process.execPath, args });
    await app.evaluate(({ dialog }, directory) => {
        dialog.showOpenDialog = async (...args) => {
            const options = args.at(-1) || {};
            return options.properties?.includes('openDirectory')
                ? { canceled: false, filePaths: [directory] }
                : { canceled: false, filePaths: [] };
        };
    }, project);
    await page.evaluate(async title => {
        const directory = await window.uah.chooseDirectory();
        await window.uah.command({
            type: 'create-session', title, directory,
            selection: { endpointId: 'native:codex', modelId: 'gpt-fixture' },
            controls: { permissionMode: 'manual', reasoningEffort: 'default' },
            agentId: 'default',
        });
    }, sessionTitle);
    await page.reload();
    await page.getByRole('button', { name: new RegExp(sessionTitle) }).click();
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();

    const sendQuery = async input => {
        await page.getByRole('textbox', { name: '消息', exact: true }).fill(input);
        await page.getByRole('button', { name: '发送消息', exact: true }).click();
        return catalogForRun(input);
    };

    const initialCatalog = await sendQuery('CATALOG_FIRST');
    assertCatalog(initialCatalog, 'company', true, [company.id, disabled.id]);
    check('native list-agent-presets receives enabled API providers and the current native model through desktop IPC', true);
    const firstTurn = page.locator('article.turn').first();
    await firstTurn.getByRole('button', { name: /已查询子代理角色/ }).click();
    await firstTurn.getByText('uah_list_agent_presets', { exact: true }).waitFor();
    await firstTurn.getByText(/Provider ID：company/).waitFor();
    assert.equal(await firstTurn.getByText('操作详情不可用。', { exact: true }).count(), 0);
    assert.equal(await firstTurn.locator('.ui-code-block').filter({ hasText: '"currentProviderId"' }).count(), 0, 'raw JSON stays cold until requested');
    await page.evaluate(async () => { await Promise.all(document.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); });
    await page.screenshot({ path: path.join(evidence, 'native-provider-summary.png') });
    await firstTurn.getByRole('button', { name: '原始返回', exact: true }).click();
    await firstTurn.getByText(/"currentProviderId"/).waitFor();
    await page.evaluate(async () => { await Promise.all(document.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); });
    await page.screenshot({ path: path.join(evidence, 'native-provider-friendly.png') });
    check('native tool shows a friendly catalog, exact tool name, and optional raw result', true);

    const changed = await updateProvider(company.id, { providerId: 'company-renamed' });
    assert.equal(changed.providerId, 'company-renamed');
    assert.equal(changed.hasKey, true);
    const refreshedCatalog = await sendQuery('CATALOG_RENAMED');
    assertCatalog(refreshedCatalog, 'company-renamed', true, [company.id, disabled.id]);
    check('the next real native tool request sees the updated provider alias', true);

    const disabledCompany = await updateProvider(company.id, { enabled: false });
    assert.equal(disabledCompany.providerId, 'company-renamed');
    assert.equal(disabledCompany.enabled, false);
    const disabledCatalog = await sendQuery('CATALOG_DISABLED');
    assertCatalog(disabledCatalog, 'company-renamed', false, [company.id, disabled.id]);
    check('disabled API providers disappear from later catalog reads while native remains available', true);

    assert.deepEqual(errors, []);
    await writeFile(path.join(evidence, 'summary.json'), JSON.stringify({ checks, errors }, null, 4));
    console.log(JSON.stringify({ evidence, checks: checks.length, errors }));
} catch (error) {
    const body = await page.locator('body').innerText().catch(() => '');
    await writeFile(path.join(evidence, 'failure.txt'), body);
    console.error('Evidence:', evidence);
    throw error;
} finally {
    await app.close();
}
