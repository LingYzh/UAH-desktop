# UAH prompt adaptations

The legacy default.md snapshot and its encoded constant remain unchanged and are used to recognize old unmodified presets during migration.

The GPT presets now use the user-supplied portable adaptation in docs/codex-cli-0.157.1-prompts, derived from openai/codex rust-v0.157.1, commit 36650394c5b38c2990ccf2a3457165ca3e9d9726. The supplied adaptation changes host-specific wording into placeholders and adds a host compatibility contract; its detailed diffs and source notices remain in that directory.

UAH changes (2026-09-27): encode four portable modules without changing their non-placeholder text; bind host slots to UAH tools, permissions, communication and delegation contracts; insert versioned runtime context slots; compose a shared base, exactly one role, and runtime context. These are UAH presets, not an official OpenAI release or a reconstruction of a user's authenticated request.

See docs/CODEX-RUNTIME.md for source verification, limitations and future native-runtime boundaries. Retain LICENSE, NOTICE and this modification notice when distributing these derived prompt modules.

Conditional composition (UAH v8 presets, 2026-09-27): src/shared/conditional-prompts.ts derives an editable behavioral base from the portable shared template; host/tool/skill/plugin instructions are moved out of the always-present base. Original role template capability slots are left empty and filled instead by separate active runtime modules. The actual parent/child role is selected per request. src/runtime/prompt-assembler.ts provides UAH-specific conditional tool, permission, planning, delegation and data modules. The original and earlier bound texts remain intact for provenance and exact migration matching. See docs/CONDITIONAL-PROMPTS.md.
