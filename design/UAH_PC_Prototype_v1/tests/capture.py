"""Capture actual rendered prototype states, not generated concept images."""
import json, os, shutil, runpy
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'screenshots'
OUT.mkdir(exist_ok=True)
manifest=[]; errors=[]; layout=[]
with sync_playwright() as p:
    executable=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('google-chrome')
    browser=p.chromium.launch(**({'executable_path':executable} if executable else {}),headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1440,'height':1000},device_scale_factor=1)
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.set_content((ROOT/'index.html').read_text(encoding='utf-8'),wait_until='load')
    page.emulate_media(reduced_motion='reduce')
    page.evaluate('document.fonts.ready')
    scenes=page.evaluate('UAH.scenes')
    for theme in ['light','dark']:
        for index,(scene,title,desc) in enumerate(scenes,1):
            page.evaluate('([theme,id])=>{UAH.setTheme(theme);UAH.scene(id)}',[theme,scene])
            page.wait_for_timeout(50)
            name=f'{index:02d}-{scene}-{theme}.png'
            page.screenshot(path=str(OUT/name),animations='disabled')
            manifest.append({'file':'screenshots/'+name,'scene':scene,'title':title,'description':desc,'theme':theme,'width':1440,'height':1000,'variant':'default'})
            metrics=page.evaluate('({rootOverflow:document.documentElement.scrollWidth>innerWidth, mainWidth:document.querySelector(".main").getBoundingClientRect().width, panel:document.querySelector(".right-panel")?.getBoundingClientRect().width||0})')
            layout.append({'scene':scene,'theme':theme,**metrics})
            scroller=page.locator('.page-scroll')
            if scroller.count() and scroller.evaluate('(e)=>e.scrollHeight-e.clientHeight>120'):
                scroller.evaluate('(e)=>e.scrollTop=e.scrollHeight')
                page.wait_for_timeout(40)
                extra=f'{index:02d}-{scene}-{theme}-bottom.png'
                page.screenshot(path=str(OUT/extra),animations='disabled')
                manifest.append({'file':'screenshots/'+extra,'scene':scene,'title':title+' · 下半页','description':desc,'theme':theme,'width':1440,'height':1000,'variant':'bottom'})
    responsive=[(1366,768,'home'),(1366,768,'diff'),(1366,768,'approval'),(1024,768,'home'),(1024,768,'plan-approval'),(1024,768,'diff'),(800,900,'home'),(800,900,'diff'),(1920,1080,'diff'),(1920,1080,'browser')]
    for width,height,scene in responsive:
        page.set_viewport_size({'width':width,'height':height})
        page.evaluate('(id)=>{UAH.setTheme("light");UAH.scene(id)}',scene)
        page.wait_for_timeout(60)
        name=f'responsive-{width}x{height}-{scene}.png'
        page.screenshot(path=str(OUT/name),animations='disabled')
        title=next(s[1] for s in scenes if s[0]==scene)
        manifest.append({'file':'screenshots/'+name,'scene':scene,'title':f'{title} · {width}×{height}','description':'响应式布局与占位分栏','theme':'light','width':width,'height':height,'variant':'responsive'})
        layout.append({'scene':scene,'width':width,'height':height,**page.evaluate('({rootOverflow:document.documentElement.scrollWidth>innerWidth,mainWidth:document.querySelector(".main").getBoundingClientRect().width})')})
    browser.close()
(ROOT/'SCREENSHOTS.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
(ROOT/'SCENES.json').write_text(json.dumps([{'id':s[0],'title':s[1],'description':s[2]} for s in scenes],ensure_ascii=False,indent=2),encoding='utf-8')
runpy.run_path(str(ROOT/'tools'/'update_gallery.py'))['update']()
(ROOT/'tests'/'visual.json').write_text(json.dumps({'scenes':len(scenes),'screenshots':len(manifest),'errors':errors,'layout':layout},ensure_ascii=False,indent=2),encoding='utf-8')
for f in OUT.glob('preview-*.png'):f.unlink()
print(json.dumps({'sceneCount':len(scenes),'screenshots':len(manifest),'errors':errors,'rootOverflows':[r for r in layout if r['rootOverflow']]},ensure_ascii=False,indent=2))
