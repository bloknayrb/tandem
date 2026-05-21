## Redesign Bundle

> **Superseded 2026-05-21.** The redesign bundle that previously lived here (the calm-v1 through calm-v5 React JSX corpus + `bundle.tar.gz`) has been replaced by the Svelte 5 **Tandem Design System** delivered through OpenDesign.

### Canonical sources

- **OpenDesign project:** `Tandem Design System (1)` (UUID `2a0312b0-b34a-40e8-b9c8-306987dce4e2`). Pull via `mcp__open-design__*` tools.
- **Source zip:** `C:\Users\blokn\Downloads\Tandem Design System (1).zip` (2026-05-21, 141 files; ~37 Svelte components + 3 `.svelte.ts` hooks across 4 prototypes; root `colors_and_type.css`; 4 local font woff2/ttf; 3 static HTML specs).
- **Bundle rules:** see the bundle's own `CLAUDE.md` (Svelte 5, Vite 6, plain CSS custom properties, local `@font-face`, `.svelte.ts` per-instance factory hooks, lowercase DOM events).

### Where the historical material went

- **Calm-v1 → calm-v5 chat transcripts** (design rationale, WHY decisions were made): archived to `docs/design-history/calm-v1-v5-chats/`.
- **React JSX corpus + `bundle.tar.gz`:** deleted (see commit on `feat/design-system-impl`). Recoverable from git history if ever needed.

### Where the current work lives

- **Umbrella branch:** `feat/design-system-impl` — comprehensive re-skin of all app surfaces against the new bundle.
- **Phase 0 deliverables:** `docs/design-system-impl/` (token audit, testid manifest, tutorial-anchor manifest, derived-surface spec, conflicts resolved, CHANGELOG strategy, perf baseline, motion notes).
- **Visual snapshot baselines:** `tests/e2e/__snapshots__/design-system-impl-baseline/`.

This file remains as a pointer; expect future cleanup to fold it into `docs/design-system-impl/README.md` once the umbrella branch merges to master.
