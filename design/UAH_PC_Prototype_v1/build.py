from pathlib import Path
import runpy
ROOT = Path(__file__).resolve().parent
source = ROOT / 'src'
css = (source / 'styles.css').read_text(encoding='utf-8')
js = '\n\n'.join((source / name).read_text(encoding='utf-8') for name in ['icons.js', 'data.js', 'app.js'])
html = (source / 'index.template.html').read_text(encoding='utf-8').replace('/*__STYLES__*/', css).replace('/*__SCRIPT__*/', js)
(ROOT / 'index.html').write_text(html, encoding='utf-8')
print(f'Built {ROOT / "index.html"}: {len(html.encode("utf-8")):,} bytes')
runpy.run_path(str(ROOT / 'tools' / 'copy_inventory.py'))['generate']()
