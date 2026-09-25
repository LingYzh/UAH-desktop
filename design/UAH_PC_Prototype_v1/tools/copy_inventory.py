"""Index prototype copy for handoff; never inspect or filter user-provided content."""
from pathlib import Path
import json
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
TERMS = re.compile(r'原型|演示|示例|模拟|固定样本|正式(?:版本|桌面版|应用|客户端)|适配层|待实现|不是你电脑的屏幕')
FIXTURES = {'PROJECTS', 'MODELS', 'AGENTS', 'PROVIDERS', 'RUNTIMES', 'SESSIONS', 'FILES', 'DIFF_LINES', 'MCPS', 'PLUGINS', 'MEMORIES', 'SESSION_WORKSPACE', 'RUNTIME_ADAPTERS'}

def annotate():
    path = ROOT / 'src/app.js'
    text = path.read_text(encoding='utf-8')
    # Only literal HTML written by the prototype author, never runtime DOM/user text.
    def mark(match):
        tag, attrs, body = match.groups()
        if TERMS.search(body) and 'data-copy-scope' not in attrs:
            attrs += ' data-copy-scope="mixed" data-copy-action="split"'
        return f'<{tag}{attrs}>{body}</{tag}>'
    text = re.sub(r'<(p|span|div|small|strong|h[1-4])\b([^<>]*?)>([^<>]*)</\1>', mark, text)
    text = re.sub(r"\btoast\(('(?:[^'\\]|\\.)*')", lambda m: ('prototypeToast(' if TERMS.search(m[1]) else 'toast(') + m[1], text)
    for class_name in ['assistant-message', 'file-preview-content prose', 'screen-preview', 'terminal-output', 'scene-grid']:
        scope, action = ('prototype', 'remove') if class_name == 'scene-grid' else ('fixture', 'replace')
        text = re.sub(r'<([\w-]+)\b([^<>]*\bclass="'+re.escape(class_name)+r'"[^<>]*)>',
            lambda m: m[0] if 'data-copy-scope=' in m[2] else f'<{m[1]}{m[2]} data-copy-scope="{scope}" data-copy-action="{action}">', text)
    path.write_text(text, encoding='utf-8')

def generate():
    entries = []
    for relative in ['src/app.js', 'src/data.js', 'src/index.template.html']:
        for line_number, line in enumerate((ROOT / relative).read_text(encoding='utf-8').splitlines(), 1):
            declaration = re.match(r'const (\w+)\s*=', line)
            fixture = relative == 'src/data.js' and declaration and declaration[1] in FIXTURES
            if fixture or TERMS.search(line) or 'data-copy-scope=' in line:
                entries.append({'file': relative, 'line': line_number,
                    'scope': 'fixture' if fixture else 'mixed',
                    'action': '替换该常量的全部样本值，保留真实数据结构' if fixture else '按行内 DOM 标记清理；混合行只移除开发/演示部分，保留真实操作与权限文案',
                    'source': line.strip()})
    (ROOT / 'COPY_INVENTORY.json').write_text(json.dumps(entries, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    lines = ['# 原型文案源码索引', '',
        '由 `python tools/copy_inventory.py` 生成。只扫描原型源码，不扫描、删除或改写用户输入。', '',
        '`prototype/remove`：删除说明或演示入口；`fixture/replace`：替换假数据及假结果；`mixed/split`：拆分文案，保留用户需要的权限、错误、操作说明。', '',
        '索引按源码行定位；一行可能包含多个组件。JSON 保留完整源码，下面的摘录仅便于查找。关键词扫描是新增遗漏检查，不是自动发布清理器；未命中不等于可直接发布。', '',
        f'当前共 {len(entries)} 个源码位置。详见 COPY_GUIDE.md 的发布门槛。', '',
        '| 来源 | 处置 | 摘录 |', '| --- | --- | --- |']
    for item in entries:
        excerpt = item['source'].replace('|', '&#124;').replace('`', '&#96;')
        lines.append(f"| {item['file']}:{item['line']} | {item['scope']} | {excerpt[:220]}{'…' if len(excerpt)>220 else ''} |")
    (ROOT / 'COPY_INVENTORY.md').write_text('\n'.join(lines)+'\n', encoding='utf-8')
    print(f'Indexed {len(entries)} copy-review locations')

if __name__ == '__main__':
    if '--annotate' in sys.argv:
        annotate()
    generate()
