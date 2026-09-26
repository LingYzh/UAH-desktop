"""Focused regressions for review items UAH-01 through UAH-09."""
import json, os, shutil, sys, threading, traceback
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
REPORT = {'checks': [], 'pageErrors': [], 'requests': [], 'environment': 'Chromium, local HTTP prototype, isolated browser context per review regression'}

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args): pass

server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(ROOT)))
threading.Thread(target=server.serve_forever, daemon=True).start()
URL = f'http://127.0.0.1:{server.server_port}/index.html'

def truth(value, message='Assertion failed'):
    assert value, message

def eq(actual, expected):
    assert actual == expected, f'{actual!r} != {expected!r}'

def check(page, name, fn):
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: REPORT['requests'].append(request.url) if urlparse(request.url).hostname not in ('127.0.0.1', 'localhost') else None)
    try:
        page.goto(URL, wait_until='load')
        page.set_default_timeout(3000)
        fn(page)
        truth(not errors, f'page errors: {errors}')
        REPORT['checks'].append({'name': name, 'pass': True})
    except Exception as error:
        REPORT['checks'].append({'name': name, 'pass': False, 'error': traceback.format_exc()[-2400:], 'pageErrors': errors})
        print('FAIL:', name, traceback.format_exc()[-1200:])
    finally:
        REPORT['pageErrors'].extend(errors)
        page.close()

def scene(page, name): page.evaluate('(id) => UAH.scene(id)', name)
def state(page, expression): return page.evaluate('(expr) => Function("return UAH.getState()."+expr)()', expression)
def action(page, name): page.locator(f'[data-action="{name}"]').first.click()
def snapshot_six(page):
    return page.evaluate('''() => {
      const s=UAH.getState(), keys=['agents','providers','memories','sessions','mcps','plugins'];
      return Object.fromEntries(keys.map(k=>[k,JSON.stringify(s[k])]));
    }''')

with sync_playwright() as pw:
    executable = os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('google-chrome')
    browser = pw.chromium.launch(**({'executable_path': executable} if executable else {}), headless=True, args=['--no-sandbox'])
    def fresh_page():
        return browser.new_page(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)

    def review_01(page):
        scene(page, 'agent-edit')
        original = page.locator('#agent-name').input_value()
        page.fill('#agent-name', 'Coder isolated draft')
        page.evaluate('window.__formNode=document.querySelector("#agent-name"); UAH.render()')
        truth(page.evaluate('window.__formNode===document.querySelector("#agent-name")'), 'render replaced the edited control node')
        truth(page.evaluate('document.activeElement===window.__formNode'), 'render did not retain focus')
        page.evaluate('UAH.getState().editId="reviewer"; UAH.render()')
        eq(page.locator('#agent-name').input_value(), '审查助手')
        eq(state(page, 'editableDrafts["agent:coder"]["agent-name"]'), 'Coder isolated draft')
        truth(state(page, 'editableDrafts["agent:reviewer"]') is None, 'Agent A draft leaked into Agent B')
        page.evaluate('UAH.getState().editId="coder"; UAH.render()')
        eq(page.locator('#agent-name').input_value(), 'Coder isolated draft')
        action(page, 'new-chat')
        truth(page.locator('.modal').is_visible(), 'dirty navigation did not prompt')
        action(page, 'close-modal')
        eq(state(page, 'page'), 'agent-edit')
        eq(page.locator('#agent-name').input_value(), 'Coder isolated draft')
        action(page, 'new-chat')
        action(page, 'dirty-discard-and-continue')
        eq(state(page, 'page'), 'home')
        truth(state(page, 'editableDrafts["agent:coder"]') is None, 'discard retained the old draft')
        scene(page, 'agent-edit')
        eq(page.locator('#agent-name').input_value(), original)
        page.fill('#agent-name', 'Saved Agent')
        action(page, 'new-chat')
        page.evaluate('() => { window.__savedSetItem = Storage.prototype.setItem; }')
        page.evaluate('Storage.prototype.setItem=function(){throw new Error("quota injection")}; UAH.action("dirty-save-and-continue")')
        eq(state(page, 'page'), 'agent-edit')
        eq(state(page, 'agents.find(x=>x.id==="coder").name'), original)
        truth(state(page, 'editableDrafts["agent:coder"]["agent-name"]') == 'Saved Agent', 'failed save discarded the draft')
        page.evaluate('() => { Storage.prototype.setItem = window.__savedSetItem; }')
        action(page, 'dirty-save-and-continue')
        eq(state(page, 'page'), 'home')
        eq(state(page, 'agents.find(x=>x.id==="coder").name'), 'Saved Agent')
    check(fresh_page(), 'UAH-01 keyed DOM, cross-form draft isolation and dirty save/discard/cancel', review_01)

    def review_02(page):
        page.emulate_media(reduced_motion='no-preference')
        scene(page, 'chat')
        page.evaluate('UAH.openPanel("plan"); UAH.action("close-panel"); UAH.openPanel("tasks")')
        page.wait_for_timeout(390)
        eq(state(page, 'sessions.find(x=>x.id===UAH.getState().selected).panel'), 'tasks')
        truth(state(page, 'sessions.find(x=>x.id===UAH.getState().selected).panelOpen'), 'stale close transition hid the reopened panel')
        truth(page.locator('.right-panel').is_visible())
    check(fresh_page(), 'UAH-02 reopening a panel cancels the stale per-session close generation', review_02)

    def review_03(page):
        scene(page, 'import')
        before = snapshot_six(page)
        page.evaluate('''() => {
          const s=UAH.getState(), keys=['agents','providers','memories','sessions','mcps','plugins'];
          const collections=Object.fromEntries(keys.map(k=>[k,JSON.parse(JSON.stringify(s[k]))]));
          for(const k of keys) collections[k].push({id:'rollback-'+k,name:'rollback'});
          try { UAH.commitImportPlan({collections,count:6},key=>{if(key==='mcps')throw new Error('injected mid-transaction failure')}); }
          catch(e) { window.__midFailure=e.message; }
        }''')
        truth('mid-transaction' in page.evaluate('window.__midFailure'))
        eq(snapshot_six(page), before)
        page.evaluate('''() => {
          const s=UAH.getState(), keys=['agents','providers','memories','sessions','mcps','plugins'];
          s.importData={agents:[{id:'imp-agent',name:'A',toolIds:['read']}],providers:[{id:'imp-provider',name:'P',protocol:'OpenAI 兼容'}],memories:[{id:'imp-memory',title:'M',body:'B'}],sessions:[{id:'imp-session',title:'S',userText:'text',model:'sonnet-api'}],mcps:[{id:'imp-mcp',name:'C'}],plugins:[{id:'imp-plugin',name:'L'}]};
          s.importRows=[['Agent','agents','imp-agent'],['供应商','providers','imp-provider'],['记忆','memories','imp-memory'],['会话','sessions','imp-session'],['MCP','mcps','imp-mcp'],['插件','plugins','imp-plugin']].map(([type,key,id])=>({key:key+':'+id,originalId:id,name:id,type}));
          s.importChoices={};
        }''')
        page.evaluate('() => { window.__savedSetItem = Storage.prototype.setItem; }')
        page.evaluate('Storage.prototype.setItem=function(){throw new Error("quota injection")}; UAH.action("apply-import")')
        truth('导入未完成' in page.locator('#toast-root').inner_text(), 'storage failure was reported as success')
        eq(page.locator('#modal-title').inner_text(), '预览导入与冲突')
        eq(snapshot_six(page), before)
        truth(state(page, 'importBackup') is None)
        page.evaluate('() => { Storage.prototype.setItem = window.__savedSetItem; }')
        page.evaluate('UAH.action("apply-import")')
        after_import = snapshot_six(page)
        for key in before:
            eq(len(json.loads(after_import[key])), len(json.loads(before[key])) + 1)
        page.evaluate('Storage.prototype.setItem=function(){throw new Error("undo quota injection")}; UAH.action("undo-import")')
        eq(snapshot_six(page), after_import)
        truth(state(page, 'importBackup') is not None, 'failed undo discarded the recovery snapshot')
        page.evaluate('() => { Storage.prototype.setItem = window.__savedSetItem; }')
        page.evaluate('UAH.action("undo-import")')
        eq(snapshot_six(page), before)
    check(fresh_page(), 'UAH-03 six-collection import rollback covers mid-transaction and storage failures', review_03)

    def review_04(page):
        scene(page, 'chat')
        page.evaluate('''() => {
          const s=UAH.getState().sessions.find(x=>x.id==='s1');
          s.model='manual-model-id'; s.userText='visible question'; s.generatedText='visible answer'; s.followUps=['follow-up'];
          s.attachments=[{name:'private.txt'}]; s.extraDirectories=[{name:'Extra'}]; s.worktree='private-worktree'; s.apiKey='secret';
          s.workspace={planFile:{path:'docs/plan.md',saved:'v2',content:'# Durable plan'},backgroundTasks:[{id:'task-run',title:'Background',state:'running',detail:'history'}],subagents:[{id:'child-run',title:'Review',model:'gpt-demo',state:'running',turns:[{role:'user',text:'Inspect'},{role:'assistant',text:'Done'}]}]};
        }''')
        envelope = page.evaluate('UAH.serializeSession(UAH.getState().sessions.find(x=>x.id==="s1"))')
        eq(envelope['session']['model'], 'manual-model-id')
        eq(envelope['session']['userText'], 'visible question')
        eq(envelope['session']['workspace']['planFile']['content'], '# Durable plan')
        eq(envelope['session']['workspace']['subagents'][0]['turns'][1]['text'], 'Done')
        eq(envelope['session']['state'], 'stopped')
        eq(envelope['session']['attachments'], [])
        eq(envelope['session']['extraDirectories'], [])
        truth('apiKey' not in envelope['session'])
        page.locator('#config-input').set_input_files({'name':'session.json','mimeType':'application/json','buffer':json.dumps(envelope,ensure_ascii=False).encode('utf-8')})
        page.wait_for_function('UAH.getState().importRows?.length===1')
        action(page, 'apply-import')
        imported = page.evaluate('UAH.getState().sessions.find(x=>x.id!=="s1"&&x.title.includes("导入副本"))')
        truth(imported is not None, 'imported session was not created')
        eq(imported['model'], 'manual-model-id')
        eq(imported['userText'], 'visible question')
        eq(imported['generatedText'], 'visible answer')
        eq(imported['workspace']['planFile']['content'], '# Durable plan')
        eq(imported['workspace']['backgroundTasks'][0]['state'], 'stopped')
        eq(imported['workspace']['subagents'][0]['turns'][0]['text'], 'Inspect')
        eq(imported['state'], 'stopped')
        eq(imported['attachments'], [])
        eq(imported['extraDirectories'], [])
    check(fresh_page(), 'UAH-04 session export/import round-trip preserves visible history and strips execution context', review_04)

    def review_05(page):
        scene(page, 'provider-edit')
        action(page, 'model-add')
        page.fill('#new-model-name', 'Draft Model')
        page.fill('#new-model-id', 'draft-model-wire')
        action(page, 'model-add-save')
        eq(state(page, 'pendingProviderModels.length'), 1)
        action(page, 'new-chat')
        truth(page.locator('.modal').is_visible())
        action(page, 'dirty-discard-and-continue')
        eq(state(page, 'pendingProviderModels.length'), 0)
        eq(state(page, 'page'), 'home')
        scene(page, 'home-ready')
        page.evaluate('''() => { const s=UAH.getState(); s.draft.model='sonnet-api'; s.draft.input='cannot send'; s.providers.find(x=>x.id==='anthropic').enabled=false; UAH.render(); }''')
        truth(page.locator('#send-button').is_disabled())
        count = state(page, 'sessions.length')
        page.evaluate('UAH.sendMessage()')
        eq(state(page, 'sessions.length'), count)
        eq(state(page, 'draft.model'), 'sonnet-api')
        truth(page.evaluate('JSON.parse(localStorage.getItem("uah-pc-prototype-v1")).models.find(x=>x.id==="sonnet-api").providerId==="anthropic"'), 'provider association was not persisted')
        page.evaluate('''() => { const s=UAH.getState(); s.providers=s.providers.filter(x=>x.id!=='anthropic'); UAH.render(); }''')
        truth(page.locator('#send-button').is_disabled())
        eq(state(page, 'draft.model'), 'sonnet-api')
        unavailable = page.evaluate('UAH.sanitizeImportedSession({id:"unknown-session",title:"unknown",model:"manual-model-id"}).model')
        eq(unavailable, 'manual-model-id')
        page.evaluate('UAH.getState().draft.model="manual-model-id"; UAH.render()')
        truth('manual-model-id' in (page.locator('[data-menu="models"]').get_attribute('aria-label') or ''))
        truth('模型不可用' in page.locator('[data-menu="models"]').inner_text())
        scene(page, 'provider-edit')
        action(page, 'model-add')
        page.fill('#new-model-name', 'Durable Model')
        page.fill('#new-model-id', 'durable-model-wire')
        action(page, 'model-add-save')
        model_id = state(page, 'pendingProviderModels[0].id')
        action(page, 'save-provider')
        page.locator('[data-provider="anthropic"]').first.click()
        page.fill('#provider-name', 'Renamed provider')
        action(page, 'save-provider')
        page.evaluate('history.replaceState(null,"",location.pathname)')
        page.reload()
        eq(state(page, 'providers.find(x=>x.id==="anthropic").name'), 'Renamed provider')
        persisted = page.evaluate('(id)=>JSON.parse(localStorage.getItem("uah-pc-prototype-v1")).models.find(x=>x.id===id)', model_id)
        eq(persisted['providerId'], 'anthropic')
        eq(persisted['wire'], 'durable-model-wire')
        page.evaluate('(id)=>UAH.selectModel(id)', model_id)
        page.locator('[data-menu="effort"]').click()
        truth(page.locator('#effort-slider').count() == 1, 'renaming the provider removed protocol effort options')
        wire = page.locator('#effort-wire').text_content()
        truth('output_config.effort' in wire, f'wrong protocol after rename: {wire}')
    check(fresh_page(), 'UAH-05 provider/model drafts stay scoped and disabled, deleted or unknown models cannot send', review_05)

    def review_06(page):
        scene(page, 'chat')
        page.evaluate('''() => {
          const s=UAH.getState().sessions.find(x=>x.id==='s1');
          s.followUps=Array.from({length:40},(_,i)=>'Long conversation turn '+i);
          UAH.render();
        }''')
        scroller = page.locator('#chat-scroll')
        page.evaluate('''() => { const e=document.querySelector('#chat-scroll'); e.scrollTo({top:e.scrollHeight,behavior:'instant'}); }''')
        actual = scroller.evaluate('(e)=>e.scrollTop')
        truth(scroller.evaluate('(e)=>e.scrollHeight>e.clientHeight'), 'chat transcript is not scrollable')
        page.evaluate('UAH.selectSession("s2")')
        page.evaluate('UAH.selectSession("s1")')
        eq(scroller.evaluate('(e)=>e.scrollTop'), actual)
        eq(state(page, 'sessions.find(x=>x.id==="s1").scrollTop'), actual)
        page.evaluate('UAH.action("nav-settings")')
        eq(state(page, 'page'), 'settings')
        page.evaluate('UAH.action("back-chat")')
        eq(scroller.evaluate('(e)=>e.scrollTop'), actual)
        page.evaluate('''() => {
          const s=UAH.getState().sessions.find(x=>x.id==='s1');
          s.workspace.planFile={path:'docs/long-plan.md',saved:'now',content:Array.from({length:100},(_,i)=>'Plan paragraph '+i).join(String.fromCharCode(10))};
          UAH.openPanel('plan');
        }''')
        page.evaluate('() => Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})))')
        panel_scroll = page.locator('.right-panel .panel-body')
        panel_top = panel_scroll.evaluate('(e)=>{e.scrollTo({top:500,behavior:"instant"});return e.scrollTop}')
        truth(panel_top > 100, 'plan fixture is not scrollable')
        page.evaluate('UAH.action("nav-settings")')
        page.evaluate('UAH.action("back-chat")')
        page.evaluate('() => Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})))')
        eq(panel_scroll.evaluate('(e)=>e.scrollTop'), panel_top)
    check(fresh_page(), 'UAH-06 each session restores only its own existing chat scroll position', review_06)

    def review_07(page):
        page.evaluate('UAH.toastForTest("hover pause",160)')
        box = page.locator('.toast').bounding_box()
        page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
        page.wait_for_timeout(260)
        truth(page.locator('.toast').is_visible(), 'hover did not pause toast expiration')
        page.mouse.move(20, 20)
        page.wait_for_timeout(210)
        eq(page.locator('.toast').count(), 0)
        focused = page.evaluate('''() => {
          UAH.toastForTest('focus pause',180);
          const button=document.querySelector('.toast button'); button.focus();
          return document.activeElement===button;
        }''')
        truth(focused, 'toast close button cannot receive focus')
        page.wait_for_timeout(280)
        truth(page.locator('.toast').is_visible(), 'focus did not pause toast expiration')
        page.locator('.toast button[aria-label="关闭提示"]').click()
        eq(page.locator('.toast').count(), 0)
    check(fresh_page(), 'UAH-07 toast text clicks pass through, hover/focus pause and close button dismisses', review_07)

    def review_08(page):
        page.emulate_media(reduced_motion='reduce')
        scene(page, 'home')
        page.evaluate('UAH.selectModel("codex"); UAH.action("open-effort")')
        if page.locator('.popover').count() == 0: page.evaluate('UAH.action("effort")')
        if page.locator('#effort-slider').count() == 0: page.locator('[data-menu="effort"]').click()
        page.locator('#effort-slider').press('End')
        eq(page.locator('html').get_attribute('data-reduced-motion'), 'true')
        eq(page.locator('.effort-fill').evaluate('(e)=>getComputedStyle(e).animationName'), 'none')
        eq(page.locator('.chat-scroll').count(), 0)
        page.emulate_media(reduced_motion='no-preference')
        scene(page, 'appearance')
        page.evaluate('UAH.getState().reduced=true; UAH.render()')
        eq(page.locator('html').get_attribute('data-reduced-motion'), 'true')
        if page.locator('.chat-scroll').count(): eq(page.locator('.chat-scroll').evaluate('(e)=>getComputedStyle(e).scrollBehavior'), 'auto')
    check(fresh_page(), 'UAH-08 system and app reduced-motion disable continuous animation and smooth scrolling', review_08)

    def review_09(page):
        scene(page, 'appearance')
        page.select_option('#font-choice', 'sans')
        eq(state(page, 'fontChoice'), 'sans')
        eq(page.evaluate('JSON.parse(localStorage.getItem("uah-pc-prototype-v1")).fontChoice'), 'sans')
        page.reload()
        eq(page.locator('#font-choice').input_value(), 'sans')
        scene(page, 'search-settings')
        page.select_option('#search-service', 'Brave')
        page.fill('#search-endpoint', 'https://search.example.test/api')
        action(page, 'save-search')
        settings = page.evaluate('JSON.parse(localStorage.getItem("uah-pc-prototype-v1")).searchSettings')
        eq(settings, {'service':'Brave','endpoint':'https://search.example.test/api'})
        eq(state(page, 'searchSettings.service'), 'Brave')
        page.reload()
        eq(page.locator('#search-service').input_value(), 'Brave')
        eq(page.locator('#search-endpoint').input_value(), 'https://search.example.test/api')
        page.evaluate('() => { window.__savedSetItem = Storage.prototype.setItem; }')
        page.select_option('#font-choice', 'system') if page.locator('#font-choice').count() else None
        scene(page, 'search-settings')
        page.fill('#search-endpoint', 'https://not-saved.example.test')
        page.evaluate('Storage.prototype.setItem=function(){throw new Error("quota injection")}; UAH.action("save-search")')
        eq(state(page, 'searchSettings.endpoint'), 'https://search.example.test/api')
        truth('未能持久化' in page.locator('#toast-root').inner_text() or '仅保留' in page.locator('#toast-root').inner_text(), 'failed search save claimed success')
        page.evaluate('() => { Storage.prototype.setItem = window.__savedSetItem; }')
    check(fresh_page(), 'UAH-09 font and search settings persist only after successful storage writes', review_09)

    REPORT['browserVersion'] = browser.version
    browser.close()
server.shutdown(); server.server_close()
REPORT['passed'] = sum(item['pass'] for item in REPORT['checks'])
REPORT['failed'] = sum(not item['pass'] for item in REPORT['checks'])
REPORT['total'] = len(REPORT['checks'])
(ROOT / 'tests' / 'review_regressions.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({key:REPORT[key] for key in ['total','passed','failed','pageErrors']}, ensure_ascii=False, indent=2))
if REPORT['failed'] or REPORT['pageErrors'] or REPORT['requests']:
    sys.exit(1)
