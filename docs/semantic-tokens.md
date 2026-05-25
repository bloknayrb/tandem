# Semantic Tokens

Full reference for Tandem's CSS custom property families. The summary lives in `CLAUDE.md > Semantic Tokens`; this document is the full enumeration.

Token families are defined in `index.html` `:root` (light theme) and `[data-theme="dark"]` (dark theme) blocks. Lint: `npm run check:tokens` (also runs on pre-commit via lint-staged) scans `src/client/` for raw hex/rgba violations.

## Status families

Each family exposes `--tandem-{name}`, `-fg`, `-fg-strong`, `-bg`, `-border` variants.

- **`--tandem-success-*`** — green. Success toasts, completion states.
- **`--tandem-warning-*`** — amber. Warnings, held-annotation banners, unsaved indicators.
- **`--tandem-error-*`** — red. Error banners, destructive actions, flag annotations.
- **`--tandem-info-*`** — blue. Informational banners, review-only mode.
- **`--tandem-suggestion-*`** — violet. Replacement/suggestion annotations. Visually distinct from indigo accent. Exposes `--tandem-suggestion`, `-fg-strong`, `-bg`, `-border`.

## Accent / authorship

- **`--tandem-accent-border`** — single token for accent-family bordered elements.
- **`--tandem-author-user`** / **`--tandem-author-claude`** — authorship colors. Blue/orange in light, adjusted in dark. Authorship decorations use `data-tandem-author` attributes (not CSS classes) per ADR-026.
- **`--tandem-claude-focus-bg`** / **`--tandem-claude-focus-border`** — Claude focus paragraph indicator. Derived from `--tandem-author-claude` via `color-mix` (10% / 40% opacity against transparent). Used in `awareness.ts` for the paragraph gutter decoration.

## Scales

Use these instead of raw px literals in client surfaces:

- **Spacing:** `--tandem-space-1..7`
- **Radius:** `--tandem-r-1..5`, `--tandem-r-pill`, `--tandem-r-circle`
- **Type:** `--tandem-text-2xs..3xl`
- **Elevation:** `--tandem-shadow-1..4`
- **Stacking:** `--tandem-z-base..tooltip`

## Highlights

CSS-facing highlight fills use `--tandem-highlight-yellow|green|blue|pink`. Keep `HIGHLIGHT_COLORS` raw rgba values for non-CSS export/runtime paths; Svelte surfaces should use `HIGHLIGHT_COLOR_VARS`.

## Light vs dark derivation

- **Light mode:** `--tandem-success-bg`, `--tandem-warning-bg`, and `--tandem-error-bg` are derived via `color-mix(in srgb, var(--tandem-{color}) 10%, var(--tandem-surface))`. `--tandem-accent-bg` (`#eef2ff`) and `--tandem-info-bg` (`#eff6ff`) use hand-picked hex. `--tandem-suggestion-bg` uses `color-mix` like the other status families.
- **Dark mode:** all `*-bg` tokens use hand-coded saturated hex (e.g. `#052e16`, `#451a03`, `#450a0a`). `color-mix` produces washed-out surfaces against the dark neutral; hand-picked values read as intentionally colored.

## Color utilities

`src/client/utils/colors.ts` exports `warningStateColors` — import it instead of inlining all three CSS vars when you need the full set (e.g. `SidePanel.svelte` held-banner). Error/success/suggestion variants were removed in audit v2 (zero consumers); re-add the same shape if a future surface needs them.

## Lint enforcement

- `npm run check:tokens` runs `scripts/check-semantic-tokens.ts` against `src/client/**/*.{ts,svelte}`. Raw hex in client code is a regression; lint rule tracked in #356.
- `rgba(0,0,0,...)` / `rgba(255,255,255,...)` alpha values for shadows and overlays are **exempt** — they're neutral, not semantic.
