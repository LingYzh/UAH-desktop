from __future__ import annotations

import json
import unittest
from pathlib import Path

from export_originals import model_files, read_models, resolved_role, safe_model_name
from render_portable import SLOT, render

PACK = Path(__file__).resolve().parents[1]


class ToolTests(unittest.TestCase):
    def test_render(self):
        self.assertEqual(render('Hello {{NAME}}.', {'NAME': 'world'}), 'Hello world.')

    def test_repeated_slot(self):
        self.assertEqual(render('{{A}} {{A}}', {'A': 'x'}), 'x x')

    def test_missing_slot(self):
        with self.assertRaises(ValueError):
            render('{{A}}', {})

    def test_empty_slot(self):
        with self.assertRaises(ValueError):
            render('{{A}}', {'A': '  '})

    def test_non_string_slot(self):
        with self.assertRaises(ValueError):
            render('{{A}}', {'A': 1})

    def test_one_pass_only(self):
        self.assertEqual(render('{{A}}', {'A': '{{B}}', 'B': 'not-expanded'}), '{{B}}')

    def test_native_lowercase_template_preserved(self):
        self.assertEqual(render('{{connector_id}}', {}), '{{connector_id}}')

    def test_catalog_object(self):
        self.assertEqual(read_models(b'{"models":[{"slug":"x"}]}')[0]['slug'], 'x')

    def test_catalog_list(self):
        self.assertEqual(read_models(b'[{"slug":"x"}]')[0]['slug'], 'x')

    def test_invalid_catalog(self):
        with self.assertRaises(ValueError):
            read_models(b'{"data":42}')

    def test_unsafe_slug(self):
        with self.assertRaises(ValueError):
            safe_model_name('../outside')

    def test_explicit_empty_role_preserved(self):
        model = {'slug': 'x', 'model_messages': {'multi_agent': {'role': {'root': ''}}}}
        self.assertEqual(resolved_role(model, 'root'), ('', 'catalog'))

    def test_missing_role_uses_bundled(self):
        text, source = resolved_role({'slug': 'x'}, 'subagent')
        self.assertEqual(source, 'bundled')
        self.assertEqual(text.encode(), (PACK / 'original/bundled/subagent-role.md').read_bytes())

    def test_template_literal(self):
        model = {'slug': 'x', 'model_messages': {'instructions_template': 'Keep {{ personality }}\n', 'instructions_variables': {'personality': 'not-interpolated'}}}
        self.assertEqual(model_files(model)['base.md'], b'Keep {{ personality }}\n')

    def test_missing_base_flagged(self):
        files = model_files({'slug': 'x'})
        self.assertEqual(files['base.md'], b'')
        self.assertTrue(json.loads(files['provenance.json'])['base_missing'])

    def test_portable_module_assembly(self):
        root = PACK / 'portable'
        base = (root / 'shared-base.md').read_bytes()
        runtime = (root / 'runtime-context.md').read_bytes()
        for agent in ('main', 'subagent'):
            role = (root / f'{agent}-role.md').read_bytes()
            self.assertEqual((root / f'{agent}.system.md').read_bytes(), base + b'\n' + role + b'\n' + runtime)

    def test_all_full_prompt_slots_documented(self):
        bindings = json.loads((PACK / 'examples/bindings.empty.json').read_text(encoding='utf-8'))
        for agent in ('main', 'subagent'):
            text = (PACK / f'portable/{agent}.system.md').read_text(encoding='utf-8')
            self.assertTrue(set(SLOT.findall(text)).issubset(bindings))

    def test_no_hardcoded_codex_tools_in_portable(self):
        for file in (PACK / 'portable').glob('*.md'):
            text = file.read_text(encoding='utf-8')
            for hardcoded in ('functions.', 'codex_apps', 'spawn_agent', 'fork_turns', '$CODEX_HOME', 'mcp__'):
                self.assertNotIn(hardcoded, text)


if __name__ == '__main__':
    unittest.main(verbosity=2)
