# Validation

Checked on 2026-09-27.

- 18 local unit tests passed; see `evidence/local-tests.txt`.
- Full portable prompts match the documented shared-base + role + runtime composition.
- All 34 host placeholders are documented and present in the bindings skeleton.
- Portable prompts contain no hardcoded Codex tool namespaces, child-spawn tool names, fork parameter names, or Codex home variable.
- Native lowercase template text is preserved by the renderer; inserted content is not recursively expanded.
- Exporter preserves explicit empty role overrides and treats absent model templates as missing/empty rather than inventing another model's prompt.
- Example custom-agent TOML parses, and its required name/description/developer_instructions fields are strings.
- Markdown fences, UTF-8 decoding, and archive contents were checked.
- The copied upstream NOTICE matches Git blob `2805899d56d0332d175cfc613c67d45d6f006db7`.

## Not performed

No authenticated/live Codex invocation, no model-quality or equivalence benchmark, and no live parent/child integration test was performed. The execution environment had no Codex binary and could not resolve the public download host. Original text was transferred from complete official GitHub source reads, but no independent raw-catalog byte comparison was performed. Run `python scripts/export_originals.py --verify-pack` in a network-enabled environment, or pass a local official catalog with `--catalog`, to compare the three bundled Astra extracts independently.

`MANIFEST.sha256` verifies this bundle's file integrity only. It is not an upstream authenticity signature or proof of behavioral equivalence.
