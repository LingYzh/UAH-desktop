"""Refresh the gallery's embedded manifest after screenshot capture."""
from pathlib import Path
import json
import re

ROOT = Path(__file__).resolve().parents[1]

def update():
    shots = json.loads((ROOT / 'SCREENSHOTS.json').read_text(encoding='utf-8'))
    scenes = json.loads((ROOT / 'SCENES.json').read_text(encoding='utf-8'))
    path = ROOT / 'gallery.html'
    html = path.read_text(encoding='utf-8')
    start = html.index('const shots=') + len('const shots=')
    end = html.index(';const $=', start)
    html = html[:start] + json.dumps(shots, ensure_ascii=False, separators=(',', ':')) + html[end:]
    html = re.sub(r'\d+ 个场景 · \d+ 张实际浏览器截图', f'{len(scenes)} 个场景 · {len(shots)} 张实际浏览器截图', html)
    path.write_text(html, encoding='utf-8')
    print(f'Gallery refreshed: {len(scenes)} scenes, {len(shots)} screenshots')

if __name__ == '__main__':
    update()
