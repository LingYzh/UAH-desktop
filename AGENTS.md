# UI-first implementation workflow

- For a project with a highly consistent custom visual style and no existing third-party UI library, first derive tokens, shared components and interaction states from its prototype.
- Build the reusable UI library and an interactive preview/documentation HTML page before implementing business/system screens. Examples must use the real library components.
- Complete visual acceptance of component states, typography, icons, spacing, transitions, light/dark themes, keyboard interaction and responsive/zoom layouts before starting system implementation. Record evidence and unresolved items; functional tests alone are not visual acceptance.
- Later shared visual changes belong in the UI library and its demos first, then flow into consuming screens. Preserve this sequence even when a headless dependency is introduced later.
- Root owns visual specifications and final acceptance. Follow the user's explicit model choice for delegated work; this session's documentation task is explicitly assigned to GPT-6 Sol high.
- UAH retains its own tokens and styles over `@vuetify/v0` headless behavior. Do not add Material themes or bypass Electron isolation to integrate UI libraries.
