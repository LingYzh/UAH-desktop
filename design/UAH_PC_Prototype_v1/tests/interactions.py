"""UI-only deterministic checks; external integrations are intentionally not tested."""
import json, os, shutil, time, threading, sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
REPORT={'checks':[], 'pageErrors':[], 'requests':[], 'environment':'Chromium, local HTTP served prototype; browser storage enabled; no external requests expected'}

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self,format,*args): pass

server=ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()

def check(name,fn):
    try:
        fn()
        REPORT['checks'].append({'name':name,'pass':True})
    except Exception as e:
        REPORT['checks'].append({'name':name,'pass':False,'error':str(e)[:1600]})
        print('FAIL:',name,str(e)[:250])

def eq(a,b):
    assert a==b,f'{a!r} != {b!r}'
def truth(value,msg='Assertion failed'):assert value,msg

with sync_playwright() as pw:
    executable=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('google-chrome')
    browser=pw.chromium.launch(**({'executable_path':executable} if executable else {}),headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1440,'height':1000},device_scale_factor=1,accept_downloads=True)
    page.set_default_timeout(2500)
    page.on('pageerror',lambda e:REPORT['pageErrors'].append(str(e)))
    page.on('request',lambda r:REPORT['requests'].append(r.url) if urlparse(r.url).hostname not in ('127.0.0.1','localhost') else None)
    page.goto(f'http://127.0.0.1:{server.server_port}/index.html',wait_until='load')
    page.emulate_media(reduced_motion='reduce')
    scene=lambda id:page.evaluate('(id)=>UAH.scene(id)',id)
    state=lambda expr:page.evaluate('UAH.getState().'+expr)
    click=lambda selector:page.locator(selector).first.click()
    action=lambda id:click(f'[data-action="{id}"]')

    def draft():
        scene('home');eq(state('sessions.length'),5);eq(state('draft.model'),None);truth(page.locator('#send-button').is_disabled());action('new-chat');eq(state('sessions.length'),5)
    check('Draft does not create an empty history entry',draft)
    def composer_position():
        scene('home-ready')
        page.evaluate('UAH.getState().draft.project="notes"; UAH.render()')
        home=page.locator('.home-composer-dock .composer').bounding_box()
        truth(home is not None)
        action('send')
        chat=page.locator('.composer-dock:not(.home-composer-dock) .composer').bounding_box()
        truth(chat is not None)
        truth(abs(home['y']-chat['y'])<=2,f"Composer moved after send: {home['y']} → {chat['y']}")
        truth(abs(home['height']-chat['height'])<=2)
    check('New-chat composer stays at the bottom after first send',composer_position)
    def require_model():
        scene('home');page.fill('#composer-input','有内容但未选择模型');truth(page.locator('#send-button').is_disabled());page.evaluate('UAH.selectModel("sonnet-api")');truth(not page.locator('#send-button').is_disabled())
    check('First draft requires an explicitly selected model',require_model)
    def stopped():
        scene('home');click('[data-menu="projects"]');click('[data-project-select="notes"]');eq(state('draft.project'),'notes');eq(page.locator('.modal').count(),0)
    check('Stopped/history-only directory does not show concurrency warning',stopped)
    def send():
        stopped();page.evaluate('UAH.selectModel("sonnet-api")');page.fill('#composer-input','测试首次发送');click('#send-button');eq(state('sessions.length'),6);eq(state('page'),'chat');eq(state('sessions[0].userText'),'测试首次发送');page.evaluate('UAH.sendMessage()');eq(state('sessions.length'),6)
    check('First valid send commits exactly one session',send)
    def session_directories():
        scene('home')
        page.evaluate("window.showDirectoryPicker=async()=>({name:'Reference',kind:'directory'})")
        click('[data-menu="projects"]')
        eq(page.locator('[data-action="directories"]').count(),0)
        click('[data-project-select="notes"]')
        eq(state('draft.model'),None)
        click('[data-menu="projects"]')
        truth(page.locator('[data-action="directories"]').count()==1)
        action('directories')
        eq(page.locator('#read-directories').count(),0)
        action('pick-extra-read')
        page.wait_for_function('UAH.getState().draft.extraDirectories.length===1')
        eq(state('draft.extraDirectories[0].name'),'Reference')
        eq(state('draft.extraDirectories[0].path'),None)
        action('close-modal')
        action('new-chat')
        eq(state('draft.extraDirectories.length'),0)
        eq(state('draftDefaults.extraDirectories'),None)
    check('Folder picker adds session-only directories without typed paths',session_directories)
    def main_directory_picker():
        scene('home')
        page.evaluate("window.showDirectoryPicker=async()=>({name:'FreshProject',kind:'directory',getDirectoryHandle:async()=>{throw Error('not git')},getFileHandle:async()=>{throw Error('not git')}})")
        click('[data-menu="projects"]')
        click('.popover [data-action="add-project"]')
        page.wait_for_function('UAH.getState().draft.project!==null')
        eq(state('projects.at(-1).name'),'FreshProject')
        eq(state('projects.at(-1).pathKnown'),False)
        click('[data-menu="projects"]')
        truth(page.locator('[data-action="directories"]').count()==1)
    check('Main directory picker unlocks extra-directory management',main_directory_picker)
    def stream():
        send();id=state('selected');page.wait_for_timeout(240);a=page.evaluate('(id)=>UAH.getState().sessions.find(t=>t.id===id).generatedText.length',id);page.evaluate('UAH.selectSession("s1")');page.wait_for_timeout(240);b=page.evaluate('(id)=>UAH.getState().sessions.find(t=>t.id===id).generatedText.length',id);truth(b>a);page.evaluate('(id)=>UAH.stopTask(id)',id);c=page.evaluate('(id)=>UAH.getState().sessions.find(t=>t.id===id).generatedText',id);page.wait_for_timeout(180);eq(page.evaluate('(id)=>UAH.getState().sessions.find(t=>t.id===id).generatedText',id),c)
    check('Simulated streaming continues in background and cancellation stops it',stream)
    def worktree():
        scene('home');click('[data-menu="projects"]');click('[data-project-select="agentapp"]');truth(page.locator('#modal-title').inner_text().startswith('这个目录'));eq(state('draft.project'),None);click('[data-worktree="isolated"]');action('worktree-confirm');truth('worktrees' in state('draft.worktree'))
    check('Active Git directory requires an explicit worktree decision',worktree)
    def ordinary():
        scene('folder-conflict');eq(page.locator('[data-worktree="isolated"]').count(),0);action('worktree-confirm');eq(state('draft.project'),'notes');eq(state('draft.worktree'),None)
    check('Ordinary folders never offer Git worktree',ordinary)
    def command():
        scene('chat');eq(page.locator('details[data-detail="s1/command"] summary').inner_text().strip(),'运行了命令');truth(not page.locator('details[data-detail="s1/command"]').evaluate('(e)=>e.open'));click('details[data-detail="s1/command"] summary');truth(page.locator('details[data-detail="s1/command"]').evaluate('(e)=>e.open'));truth('npm run test' in page.locator('details[data-detail="s1/command"]').inner_text());eq(page.locator('.modal').count(),0)
    check('Command disclosure expands actual sample command/output inline',command)
    def inline_diff():
        scene('chat');click('details[data-detail="s1/edit-tool"] summary');truth(page.locator('details[data-detail="s1/edit-tool"] .diff-line').count()>0);eq(page.locator('.right-panel').count(),0);eq(page.locator('.modal').count(),0)
    check('Editing disclosure uses an inline diff, not a tool modal',inline_diff)
    def persistence():
        command();page.evaluate('UAH.openPanel("plan")');page.evaluate('UAH.selectSession("s2"); UAH.selectSession("s1")');truth(page.locator('details[data-detail="s1/command"]').evaluate('(e)=>e.open'))
    check('Disclosure state survives panel and session changes',persistence)
    def panelstate():
        scene('diff');click('[data-diff-file="state"]');page.evaluate('UAH.selectSession("s2"); UAH.openPanel("plan"); UAH.selectSession("s1")');eq(state('diffFile'),'state');eq(state('sessions.find(x=>x.id==="s1").panel'),'diff')
    check('Each session retains its panel and selected diff file',panelstate)
    def session_panels():
        scene('chat');page.evaluate('UAH.openPanel("plan")');truth('inline-tool-refactor.md' in page.locator('.right-panel').inner_text())
        page.evaluate('UAH.selectSession("s3"); UAH.openPanel("plan")');truth('还没有计划' in page.locator('.right-panel').inner_text())
        page.evaluate('UAH.openPanel("tasks")');truth('当前会话' in page.locator('.right-panel').inner_text());truth('运行工具交互测试' not in page.locator('.right-panel').inner_text())
        page.evaluate('UAH.selectSession("s1"); UAH.openPanel("tasks")');truth('运行工具交互测试' in page.locator('.right-panel').inner_text())
        page.evaluate('UAH.openPanel("agents")');click('[data-child]');truth('只读会话' in page.locator('.right-panel').inner_text());action('child-back');truth(page.locator('[data-child]').count()>0)
    check('Plan, tasks and two-level subagents stay in the current session',session_panels)
    def currentfile():
        scene('diff');action('current-file');eq(state('page'),'files');truth('当前' in page.locator('.page').inner_text());action('back-chat');eq(state('sessions.find(x=>x.id==="s1").panel'),'diff');truth('保存的历史 Diff' in page.locator('.right-panel').inner_text())
    check('Current file navigation does not overwrite historical diff',currentfile)
    def nochange():
        scene('markdown');truth('本轮无文件改动' in page.locator('.round-changes').inner_text())
    check('A no-change round still displays its changes section',nochange)
    def degraded():
        for id,text in [('diff-binary','二进制文件'),('diff-missing','历史快照缺失'),('diff-large','超出文本预览预算'),('diff-uncertain','无法精确归因')]:
            scene(id);truth(text in page.locator('.right-panel').inner_text(),id)
    check('Binary, missing, large and uncertain diff states are explicit',degraded)
    def approval():
        scene('approval');click('details summary');eq(state('sessions.find(t=>t.id==="s2").state'),'approval');action('approve');eq(state('sessions.find(t=>t.id==="s2").state'),'running')
    check('Reading a tool is not approval; Allow is an explicit action',approval)
    def plan():
        scene('plan-approval');action('approval-scope');eq(state('sessions.find(t=>t.id==="s2").state'),'approval');truth(page.locator('.right-panel').is_visible());action('approve');eq(state('sessions.find(t=>t.id==="s2").mode'),'accept');eq(state('sessions.find(t=>t.id==="s2").state'),'running')
    check('Plan viewing remains separate from execution approval',plan)
    def deny():
        scene('approval');action('deny-approval');eq(state('sessions.find(t=>t.id==="s2").state'),'stopped');truth('拒绝' in page.locator('.transcript').inner_text())
    check('Denied approval is recorded without execution',deny)
    def runtime_branch():
        scene('chat');click('[data-menu="models"]');click('[data-select-model="codex"]');eq(state('selected'),'s1');truth('不迁移' in page.locator('.modal').inner_text());action('confirm-runtime-switch');truth(state('draft.sourceSession')=='s1');eq(state('draft.model'),'codex');eq(state('sessions.length'),5)
    check('Cross-runtime selection creates a branch draft with migration boundaries',runtime_branch)
    def api_switch():
        scene('chat');click('[data-menu="models"]');click('[data-select-model="ds-api"]');eq(state('selected'),'s1');eq(state('sessions.find(t=>t.id==="s1").model'),'ds-api');eq(page.locator('.modal').count(),0)
    check('Changing a model within UAH does not fabricate a runtime branch',api_switch)
    def context_ring():
        scene('chat');truth(page.locator('.context-ring-progress').count()==1);truth('12%' in page.locator('.context-trigger').inner_text())
        click('.context-trigger');truth(page.locator('.context-legend span').count()==8);action('close-modal')
        page.evaluate('UAH.selectModel("ds-api")');truth('容量未配置' in page.locator('.context-trigger').inner_text());eq(page.locator('.context-ring-progress').count(),0)
    check('Compact context is one-color percent; detail keeps categories and unknown stays unknown',context_ring)
    def unknown_effort():
        api_switch();click('[data-menu="effort"]');eq(page.locator('#effort-slider').count(),0);truth('思考参数' in page.locator('.popover').inner_text())
    check('Unsupported reasoning does not display a fabricated slider',unknown_effort)
    def fallback_effort():
        scene('home');page.evaluate('UAH.selectModel("antigravity")');click('[data-menu="effort"]')
        eq(page.locator('#effort-slider').get_attribute('max'),'3')
        truth('暂按 Gemini 协议' in page.locator('#effort-tooltip').text_content())
        page.locator('#effort-slider').press('End');eq(state('draft.effort'),'high')
        truth(page.locator('[data-menu="effort"]').get_attribute('aria-label')=='思考档位：High')
    check('Unknown model efforts use provisional protocol defaults',fallback_effort)
    def known_effort():
        scene('reasoning');page.locator('#effort-slider').fill('2');eq(state('sessions.find(t=>t.id==="s1").effort'),'high')
    check('Reasoning changes use discrete declared efforts',known_effort)
    def ultra_effort():
        scene('home');page.evaluate('UAH.selectModel("codex")');click('[data-menu="effort"]');page.locator('#effort-slider').press('End')
        eq(state('draft.effort'),'ultra');truth(page.locator('.effort-slider-shell.is-ultra').count()==1)
        eq(page.locator('.effort-ticks i:not(.covered)').count(),0);truth('主动子代理编排' in page.locator('#effort-mode-note').text_content())
        page.locator('#effort-slider').press('ArrowLeft');truth(page.locator('.effort-slider-shell.is-ultra').count()==0)
        page.locator('#effort-slider').press('End')
        page.evaluate('UAH.selectModel("sonnet-api")');eq(state('draft.effort'),'medium')
        click('[data-menu="effort"]');eq(page.locator('#effort-slider').get_attribute('max'),'3')
    check('Ultra combines runtime orchestration with reasoning and stays unavailable to API-only models',ultra_effort)
    def compact_effort_card():
        scene('reasoning');truth(page.locator('[data-action="effort-detail"]').count()==0)
        truth(page.locator('[data-action="effort-reset"]').count()==0)
        eq(page.locator('.effort-help .icon').count(),1)
        truth('思考：' not in page.locator('[data-menu="effort"]').inner_text())
    check('Effort card has one slider and a help icon',compact_effort_card)
    def sidebar_cycle():
        scene('home');click('[data-action="toggle-sidebar"]');truth('collapsed' in page.locator('.sidebar').get_attribute('class'))
        page.wait_for_timeout(300);click('[data-action="toggle-sidebar"]');truth('collapsed' not in page.locator('.sidebar').get_attribute('class'))
    check('Collapsed sidebar can reopen after the transition',sidebar_cycle)
    def read_control():
        scene('browser');page.evaluate('UAH.getState().switches.browser=true; UAH.getState().sessions[0].mode="readonly"; UAH.render()');action('browser-action');truth('禁止写入' in page.locator('.modal').inner_text());eq(state('lease'),None)
    check('Readonly mode blocks browser writes even with global toggle enabled',read_control)
    def global_off():
        scene('browser');action('browser-action');truth('总开关尚未打开' in page.locator('#modal-title').inner_text());eq(state('lease'),None)
    check('Global computer/browser controls default off',global_off)
    def target_grant():
        scene('browser-auth');page.check('#remember-target');action('control-approve');truth(state('browserAllowed'));eq(state('lease'),'s1');truth('示例动作' in page.locator('.browser-log').inner_text());action('release-lease');eq(state('lease'),None)
    check('Target authorization is explicit, logged and revocable by Stop',target_grant)
    def stale():
        scene('browser-stale');truth('观察已过期' in page.locator('#modal-title').inner_text());action('refresh-observation');truth(not state('targetChanged'));eq(state('lease'),None)
    check('Stale observations cannot be used for actions',stale)
    def lease():
        scene('browser');page.evaluate('UAH.getState().switches.browser=true; UAH.getState().lease="s3"');action('browser-action');truth('另一任务' in page.locator('#modal-title').inner_text());eq(state('lease'),'s3')
    check('A second parent cannot steal the screen lease',lease)
    def mcp_scope():
        scene('mcp');click('[data-switch="mcp:filesystem"]');page.select_option('#mcp-project','notes');truth(page.locator('[data-switch="mcp:filesystem"]').get_attribute('aria-checked')=='false');click('[data-switch="mcp:filesystem"]');page.select_option('#mcp-project','agentapp');eq(page.locator('[data-switch="mcp:filesystem"]').get_attribute('aria-checked'),'false')
    check('MCP project switches are scoped independently',mcp_scope)
    def mcp_auth():
        scene('mcp-auth');truth('等待服务器授权' in page.locator('.page').inner_text());action('mcp-auth');action('mcp-auth-complete');eq(state('mcps.find(x=>x.id==="github").status'),'connected')
    check('Remote MCP authentication gates its declared tools',mcp_auth)
    def mcp_form():
        scene('mcp');action('mcp-new');page.fill('#mcp-form-name','测试远端 MCP');page.select_option('#mcp-form-transport','Streamable HTTP')
        page.fill('#mcp-form-url','https://mcp.example.test/mcp?token=demo');action('mcp-add-confirm');truth(state('mcps.length')==4)
        page.fill('#mcp-form-url','https://mcp.example.test/mcp');page.select_option('#mcp-form-auth','bearer');page.fill('#mcp-form-secret','DEMO-NOT-REAL-SECRET')
        action('mcp-add-confirm');truth(state('mcps.at(-1).name')=='测试远端 MCP');truth('DEMO-NOT-REAL-SECRET' not in json.dumps(state('mcps')))
        action('mcp-edit');truth(page.locator('#mcp-form-url').input_value()=='https://mcp.example.test/mcp')
    check('Structured MCP form switches transport and omits secret values',mcp_form)
    def mcp_cwd_picker():
        scene('mcp');action('mcp-new')
        eq(page.locator('#mcp-form-cwd').count(),0)
        page.fill('#mcp-form-name','本机示例')
        page.evaluate("window.showDirectoryPicker=async()=>({name:'McpWorkspace',kind:'directory'})")
        action('pick-mcp-cwd')
        page.wait_for_function("UAH.getState().mcpDraft.cwd==='McpWorkspace'")
        eq(page.locator('#mcp-form-name').input_value(),'本机示例')
        action('clear-mcp-cwd')
        eq(state('mcpDraft.cwd'),'')
    check('MCP working directory uses the folder picker and preserves form values',mcp_cwd_picker)
    def adapter():
        scene('runtime');action('runtime-adapter');truth('运行时适配' in page.locator('.page').inner_text())
        click('[data-adapter-mode="plan"]');truth('计划文件' in page.locator('.adapter-mapping').inner_text())
        click('[data-adapter-event="tool"]');truth('真实事件类型' in page.locator('.adapter-event-detail').inner_text())
    check('Official runtime adapter explains mode and tool event mapping',adapter)
    def provider():
        scene('provider-edit');page.fill('#provider-name','本地测试供应商');page.fill('#provider-key','DEMO-NOT-A-REAL-SECRET');action('save-provider');eq(state('providers[0].name'),'本地测试供应商');truth('DEMO-NOT-A-REAL-SECRET' not in json.dumps(state('providers')))
    check('Provider editing never puts API secrets in prototype state',provider)
    def new_provider():
        scene('models');action('provider-new');page.fill('#provider-name','本地接入');page.fill('#provider-endpoint','http://localhost:9999');action('save-provider');truth(state('providers[-1]') is None) if False else truth(not state('providers.at(-1).enabled'))
    check('A newly added provider starts disabled',new_provider)
    def runtime_login():
        scene('runtime');action('runtime-login');eq(page.locator('input[type="password"]').count(),0);action('login-complete');action('login-return');eq(state('runtimes.find(x=>x.id==="claude").account'),'demo@example.com')
    check('Official login UI manages one sample account without password capture',runtime_login)
    def hook():
        scene('plugin-detail');truth(not state('plugins[0].hookEnabled'));click('[data-switch="hook:vue"]');truth('允许这个 hook' in page.locator('#modal-title').inner_text());truth(not state('plugins[0].hookEnabled'));action('allow-hook');truth(state('plugins[0].hookEnabled'))
    check('Each executable hook requires a separate explicit grant',hook)
    def plugin_install():
        scene('plugins');action('plugin-import');action('plugin-install');eq(state('plugins.length'),4);truth(not state('plugins[3].hookEnabled'));truth(not state('plugins[3].enabled'))
    check('Installing a plugin neither enables its hooks nor silently activates it',plugin_install)
    def uninstall_restore():
        scene('plugin-detail');action('plugin-uninstall');action('plugin-uninstall-confirm');eq(state('plugins.length'),2);action('plugin-restore-uninstalled');eq(state('plugins.length'),3);truth(not state('plugins[2].enabled'));truth(not state('plugins[2].hookEnabled'))
    check('Plugin uninstall has a restore path without retained execution grants',uninstall_restore)
    def memory():
        scene('memory');action('memory-new');page.fill('#memory-title','新的项目约定');page.fill('#memory-body','<script>alert(1)</script> 这是普通文本');action('memory-save');eq(state('memories.length'),4);truth('<script>alert(1)</script>' in page.locator('.page').inner_text());eq(page.locator('.page script').count(),0)
    check('Memory CRUD safely renders text without executing HTML',memory)
    def file_toggle():
        scene('files');action('file-source');truth(page.locator('.file-preview-content pre').count()>0);action('file-source');truth(page.locator('.file-preview-content h1').count()>0)
    check('Project file preview and source are separate views',file_toggle)
    def import_skip():
        scene('import');before=state('sessions.length');page.locator('[data-import-key]').evaluate_all('(els)=>els.forEach(e=>{e.value="skip";e.dispatchEvent(new Event("change",{bubbles:true}))})');action('apply-import');eq(state('sessions.length'),before);eq(state('agents.length'),4)
    check('Import preview can skip every conflicting item without writes',import_skip)
    def import_copy():
        scene('import');action('apply-import');eq(state('agents.length'),5);eq(state('sessions.length'),6);eq(state('sessions.at(-1).state'),'stopped');action('undo-import');eq(state('sessions.length'),5);eq(state('agents.length'),4)
    check('Import copies are stopped and the previous state is recoverable',import_copy)
    def import_bad():
        scene('data');page.locator('#config-input').set_input_files({'name':'bad.json','mimeType':'application/json','buffer':b'{not json'});page.wait_for_timeout(100);truth('校验失败' in page.locator('#toast-root').inner_text());eq(state('agents.length'),4)
    check('Malformed import files are rejected before mutation',import_bad)
    def export_safe():
        scene('export');page.evaluate('window.__export=null; downloadJSON=(data,name)=>{window.__export=data}');action('perform-export');result=page.evaluate('window.__export');truth(result['format']=='uah-pc-ui-prototype');truth('apiKey' not in json.dumps(result));truth('credentials' not in json.dumps(result))
    check('Export serializer omits API keys, headers and runtime credentials',export_safe)
    def sensitive():
        scene('export');page.check('#export-sensitive');action('perform-export');truth('再次确认' in page.locator('#modal-title').inner_text())
    check('Sensitive export requests a second explicit confirmation',sensitive)
    def theme():
        command();page.evaluate('UAH.setTheme("dark")');eq(page.locator('html').get_attribute('data-theme'),'dark');truth(page.locator('details[data-detail="s1/command"]').evaluate('(e)=>e.open'));scene('appearance');click('[data-switch="reduce"]');truth(state('reduced'))
    check('Theme and reduced-motion changes preserve tool state',theme)
    def focus():
        scene('chat');page.keyboard.press('Control+k');truth(page.locator('.modal').count()==1);page.keyboard.press('Escape');eq(page.locator('.modal').count(),0);click('[data-menu="models"]');page.keyboard.press('Escape');eq(page.locator('.popover').count(),0)
    check('Keyboard search and Escape close their overlays',focus)
    def resize():
        scene('diff');handle=page.locator('[data-resize="right"]');bb=handle.bounding_box();before=page.locator('.right-panel').bounding_box()['width'];page.mouse.move(bb['x']+2,bb['y']+100);page.mouse.down();page.mouse.move(bb['x']-70,bb['y']+100);page.mouse.up();after=page.locator('.right-panel').bounding_box()['width'];truth(after>before);action('reset-layout') if page.locator('[data-action="reset-layout"]').count() else page.evaluate('UAH.action("reset-layout")')
    check('The right column is draggable',resize)
    def narrow_approval():
        page.set_viewport_size({'width':1024,'height':768});scene('plan-approval');truth(page.locator('.right-panel .panel-safety-strip').is_visible());truth(page.locator('.right-panel [data-action="stop-current"]').is_visible());click('.right-panel [data-action="scroll-approval"]');eq(page.locator('.right-panel').count(),1);truth(page.locator('.approval-card').is_visible());page.set_viewport_size({'width':1440,'height':1000})
    check('Narrow three-column layout keeps approval and Stop reachable',narrow_approval)
    def terminal():
        scene('terminal');page.fill('#terminal-input','Remove-Item C:\\ -Recurse');page.press('#terminal-input','Enter');truth('未执行' in page.locator('.terminal').inner_text());page.fill('#terminal-input','help');page.press('#terminal-input','Enter');truth('支持的演示命令' in page.locator('.terminal').inner_text())
    check('The demo terminal never executes arbitrary commands',terminal)
    def exit_test():
        scene('exit');action('exit-confirm');eq(state('sessions.filter(t=>["running","approval"].includes(t.state)).length'),0);action('reopen-app');eq(state('sessions.filter(t=>["running","approval"].includes(t.state)).length'),0)
    check('Exit stops active sessions and reopen does not auto-resume',exit_test)
    def management_return():
        scene('home');page.fill('#composer-input','保留这份草稿')
        click('[data-nav="mcp"]');action('mcp-new');action('back-chat')
        eq(state('page'),'home');eq(page.locator('#composer-input').input_value(),'保留这份草稿')
        click('[data-nav="models"]');action('back-chat');eq(state('page'),'home')
    check('Management pages return to their originating draft',management_return)
    def empty_sessions():
        scene('chat');page.evaluate('UAH.getState().sessions=UAH.getState().sessions.filter(t=>t.id==="s1"); UAH.getState().draftDefaults.project=null; UAH.render()')
        click('[data-menu="session"]');action('delete-session');action('delete-session-confirm')
        eq(state('sessions.length'),0);eq(state('page'),'home')
        action('new-chat');eq(state('sessions.length'),0)
        click('[data-nav="models"]');action('back-chat');eq(state('page'),'home')
    check('Deleting the last session keeps an empty usable workspace',empty_sessions)
    def pending_directory():
        scene('chat');page.evaluate('UAH.getState().draftDefaults.project=null; UAH.render()')
        click('[data-menu="session-projects"]');click('[data-bind-session-project="agentapp"]');action('close-modal')
        eq(state('pendingSessionProject'),None);action('new-chat')
        click('[data-menu="projects"]');click('[data-project-select="agentapp"]');click('[data-worktree="shared"]');action('worktree-confirm')
        eq(state('draft.project'),'agentapp');truth(state('draft.sharedDirectoryDecision'))
    check('Cancelled directory decisions cannot mutate another session',pending_directory)
    def late_conflict():
        scene('home');click('[data-menu="projects"]');click('[data-project-select="notes"]')
        page.evaluate('UAH.selectModel("sonnet-api"); UAH.getState().sessions.find(t=>t.project==="notes").state="running"')
        page.fill('#composer-input','并发检查');action('send');eq(state('page'),'home');truth(page.locator('.modal').is_visible())
    check('First send rechecks a newly active directory conflict',late_conflict)
    def context_scoping():
        scene('chat');action('context');action('compact-confirm');action('compact-do')
        truth('4%' in page.locator('.context-trigger').inner_text())
        page.evaluate('UAH.selectSession("s3")');truth('12%' in page.locator('.context-trigger').inner_text())
    check('Context compaction belongs to one session',context_scoping)
    def narrow_panel():
        page.set_viewport_size({'width':800,'height':900});scene('diff')
        truth(page.locator('.main').bounding_box()['width']>=350)
        truth(page.locator('.sidebar').bounding_box()['width']<60)
        action('toggle-sidebar');eq(page.locator('.right-panel').count(),0)
        truth(page.locator('.sidebar').bounding_box()['width']>180)
        page.set_viewport_size({'width':1440,'height':1000})
    check('Narrow split view stays readable and left navigation reopens',narrow_panel)
    def empty_agent_tools():
        scene('agent-edit')
        page.locator('input[name="agent-tool"]').evaluate_all('(items)=>items.forEach(i=>i.checked=false)')
        action('save-agent');eq(state('page'),'agent-edit')
        truth('至少选择' in page.locator('.toast').inner_text())
    check('Unchecked Agent tools never silently grant all tools',empty_agent_tools)
    def plan_consistency():
        scene('plan-approval')
        path=state('sessions.find(t=>t.id===UAH.getState().selected).workspace.planFile.path')
        truth(path in page.locator('#inline-approval').inner_text())
        click('[data-diff="planfile"]')
        truth(path in page.locator('.diff-meta').inner_text())
        truth('采集官方运行时' in page.locator('.diff-content').inner_text())
    check('Plan approval, changed file and diff refer to the same session plan',plan_consistency)
    def file_to_draft():
        scene('home');page.evaluate('UAH.getState().sessions=[]');action('toggle-shortcuts');click('[data-nav="files"]');action('file-attach')
        eq(state('page'),'home');truth(state('draft.attachments.length')>0)
    check('Project file attachment returns to its originating draft',file_to_draft)
    def errors():
        scene('error');truth('运行时连接中断' in page.locator('.transcript').inner_text());eq(state('sessions.find(t=>t.id==="s5").state'),'failed');action('resume');eq(state('sessions.find(t=>t.id==="s5").state'),'running')
    check('Failures remain explicit until the user manually resumes',errors)
    check('No page-level JavaScript errors',lambda: eq(REPORT['pageErrors'],[]))
    check('Prototype makes no external network requests',lambda:eq(REPORT['requests'],[]))
    REPORT['browserVersion']=browser.version
    browser.close()
server.shutdown();server.server_close()
REPORT['passed']=sum(x['pass'] for x in REPORT['checks']);REPORT['failed']=sum(not x['pass'] for x in REPORT['checks']);REPORT['total']=len(REPORT['checks'])
(ROOT/'tests'/'interactions.json').write_text(json.dumps(REPORT,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({k:REPORT[k] for k in ['total','passed','failed','pageErrors']},ensure_ascii=False,indent=2))
if REPORT['failed'] or REPORT['pageErrors'] or REPORT['requests']:
    sys.exit(1)
