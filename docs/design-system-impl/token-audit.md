# Token Audit — design-system-impl umbrella branch

> **Phase 0c deliverable.** Produced 2026-05-21 as part of the `feat/design-system-impl` umbrella branch. Reconciles the bundle's `colors_and_type.css` (398 lines) against production's `index.html` `:root` + `[data-theme="dark"]` + `[data-theme="warm"]` blocks. Resolution per **Conflict #6 / Option A** from the umbrella plan: *Production tokens win for shipped colors; bundle adds NEW tokens only.*

## Sources

- **Production:** [`index.html` lines 65–195 (`:root`), 291–353 (`[data-theme="dark"]`), 360–388 (`[data-theme="warm"]`)](../../index.html). Hand-tuned across PRs #556 (WCAG AA audit), #621 (dark-bg fix), #776 (calm-v7 dark canon).
- **Bundle:** OpenDesign project `Tandem Design System (1)` (UUID `2a0312b0-b34a-40e8-b9c8-306987dce4e2`), file `colors_and_type.css`. Generated 2026-05-21 10:30 during the React → Svelte 5 port.

## Resolution categories

| Category | Meaning |
|---|---|
| **PROD WINS** | Production value stays; bundle value rejected. Reason given. |
| **SAME ✓** | Identical in both; no action. |
| **ADOPT** | Bundle introduces a NEW token that doesn't conflict; add to production index.html during the listed Phase. |
| **PROTECTED** | Token must not change without an explicit per-token re-audit committed alongside the change. Listed in Phase 0c protected-tokens block below. |
| **DEFER** | Decision held pending a specific Phase. Re-evaluate then. |

## Protected tokens (cannot change in this umbrella branch)

Per the umbrella plan's Phase 0c, these tokens are load-bearing for shipped behavior (authorship decorations, audience-first model, WCAG audit) and any change requires a separate per-token re-audit committed in the same PR as the change. A vitest snapshot gate (see [token-protection.spec.ts](../../tests/design-system-impl/token-protection.spec.ts)) enforces this at CI time.

- `--tandem-author-user`
- `--tandem-author-claude`
- `--tandem-author-claude-fg`
- `--tandem-claude-focus-bg`
- `--tandem-claude-focus-border`
- `--tandem-suggestion`
- `--tandem-suggestion-fg-strong`
- `--tandem-suggestion-bg`
- `--tandem-suggestion-border`
- `--tandem-fg-subtle` (light + dark — both backed off after the #556 audit; light at oklch 0.54, dark at oklch 0.70)
- `--tandem-fg-muted` (light + dark — symmetric WCAG-AA pair with `-subtle`)

## Light mode

| Token | Production | Bundle | Resolution |
|---|---|---|---|
| `--tandem-bg` | `oklch(0.985 0.004 80)` | same | **SAME ✓** |
| `--tandem-surface` | `oklch(1 0 0)` | same | **SAME ✓** |
| `--tandem-surface-muted` | `oklch(0.975 0.005 80)` | same | **SAME ✓** |
| `--tandem-surface-sunk` | `oklch(0.96 0.006 80)` | same | **SAME ✓** |
| `--tandem-fg` | `oklch(0.22 0.012 280)` | same | **SAME ✓** |
| `--tandem-fg-muted` | `oklch(0.48 0.008 280)` | same | **SAME ✓** (PROTECTED) |
| `--tandem-fg-subtle` | `oklch(0.54 0.008 280)` | same | **SAME ✓** (PROTECTED; backed off from 0.44 per #556) |
| `--tandem-fg-faint` | `oklch(0.64 0.005 280)` | same | **SAME ✓** |
| `--tandem-border` | `oklch(0.92 0.005 280)` | same | **SAME ✓** |
| `--tandem-border-strong` | `oklch(0.86 0.006 280)` | same | **SAME ✓** |
| `--tandem-accent-h` | `275deg` | same | **SAME ✓** |
| `--tandem-accent` | `oklch(0.52 0.16 var(--tandem-accent-h))` | same | **SAME ✓** |
| `--tandem-accent-fg` | `oklch(0.99 0.005 var(--tandem-accent-h))` | same | **SAME ✓** |
| `--tandem-accent-bg` | `oklch(0.95 0.03 var(--tandem-accent-h))` | same | **SAME ✓** |
| `--tandem-accent-fg-strong` | `oklch(0.42 0.18 var(--tandem-accent-h))` | same | **SAME ✓** |
| `--tandem-accent-border` | `oklch(0.84 0.10 var(--tandem-accent-h))` | same | **SAME ✓** |
| `--tandem-author-user` | `oklch(0.55 0.14 245)` | same | **SAME ✓** (PROTECTED) |
| `--tandem-author-claude` | `#d97757` | same | **SAME ✓** (PROTECTED) |
| `--tandem-author-claude-fg` | `oklch(0.24 0.03 55)` | same | **SAME ✓** (PROTECTED) |
| `--tandem-claude-focus-bg` | `color-mix(in srgb, var(--tandem-author-claude) 10%, transparent)` | same | **SAME ✓** (PROTECTED) |
| `--tandem-claude-focus-border` | `color-mix(in srgb, var(--tandem-author-claude) 40%, transparent)` | same | **SAME ✓** (PROTECTED) |
| `--tandem-success` | `oklch(0.55 0.14 150)` | same | **SAME ✓** |
| `--tandem-success-fg` | `#ffffff` | same | **SAME ✓** |
| `--tandem-success-fg-strong` | `#166534` | same | **SAME ✓** |
| `--tandem-success-bg` | `color-mix(in srgb, var(--tandem-success) 10%, var(--tandem-surface))` | same | **SAME ✓** |
| `--tandem-success-border` | `color-mix(in srgb, var(--tandem-success) 40%, var(--tandem-border))` | same | **SAME ✓** |
| `--tandem-warning` | `oklch(0.62 0.16 65)` | same | **SAME ✓** |
| `--tandem-warning-fg` | `#ffffff` | same | **SAME ✓** |
| `--tandem-warning-fg-strong` | `#92400e` | same | **SAME ✓** |
| `--tandem-warning-bg` | color-mix derived | same | **SAME ✓** |
| `--tandem-warning-border` | color-mix derived | same | **SAME ✓** |
| `--tandem-error` | `oklch(0.55 0.18 25)` | same | **SAME ✓** |
| `--tandem-error-fg` | `#ffffff` | same | **SAME ✓** |
| `--tandem-error-fg-strong` | `#991b1b` | same | **SAME ✓** |
| `--tandem-error-bg` / `-border` | color-mix derived | same | **SAME ✓** |
| `--tandem-info` | `oklch(0.58 0.2 258)` | same | **SAME ✓** |
| `--tandem-info-fg` | `#ffffff` | same | **SAME ✓** |
| `--tandem-info-fg-strong` | `oklch(0.38 0.16 258)` | same | **SAME ✓** |
| `--tandem-info-bg` / `-border` | color-mix derived | same | **SAME ✓** |
| `--tandem-suggestion` | `oklch(0.52 0.18 305)` | same | **SAME ✓** (PROTECTED) |
| `--tandem-suggestion-fg-strong` | `#5b21b6` | same | **SAME ✓** (PROTECTED) |
| `--tandem-suggestion-bg` | color-mix derived | same | **SAME ✓** (PROTECTED) |
| `--tandem-suggestion-border` | color-mix derived | same | **SAME ✓** (PROTECTED) |
| `--tandem-highlight-yellow/green/blue/pink` | `rgba(..., 0.30)` | same | **SAME ✓** |
| `--tandem-editor-font-family` | `var(--tandem-font-sans)` | `var(--tandem-font-serif)` | **PROD WINS** — per 2026-05-20 commit ("changed default serif→sans"); bundle's serif default is a regression. Bundle's separate `--tandem-h1/h2` serif heading tokens (see ADOPT below) cover the case where serif IS wanted. |
| `--tandem-editor-font-size` | `17px` | `17px` | **SAME ✓** |
| `--tandem-page-bg` | `#e8e8e8` | (missing) | **PROD WINS** — paged-docx feature surface |
| `--tandem-page-paper` | `#ffffff` | (missing) | **PROD WINS** |
| `--tandem-page-shadow` | `0 2px 8px rgba(0,0,0,0.15)` | (missing) | **PROD WINS** |
| `--tandem-r-circle` | `50%` | (missing) | **PROD WINS** — bundle gap; consumers exist |
| `--tandem-scrollbar-track` | `oklch(0.96 0.006 80)` | (different recipe — scrollbars hidden) | **PROD WINS** — bundle hides scrollbars system-wide ("fade-mask instead"); production uses themed scrollbars. Deliberate divergence; revisit in v1.1+ if the fade-mask recipe wins. |
| `--tandem-scrollbar-thumb` | `oklch(0.82 0.005 280)` | (different recipe) | **PROD WINS** |
| `--tandem-rail-shadow-left` | directional | (missing) | **PROD WINS** — Wave 6 rail behavior |
| `--tandem-rail-shadow-right` | directional | (missing) | **PROD WINS** |
| `--tandem-status-clearance-total` | `calc(...)` | (missing) | **PROD WINS** — Wave 6 PanelSlot dep |
| `--tandem-selection-blurred-bg` | `color-mix(in srgb, var(--tandem-accent) 22%, transparent)` | same | **SAME ✓** |

## Dark mode

| Token | Production | Bundle | Resolution |
|---|---|---|---|
| `--tandem-bg` | `oklch(0.22 0.012 280)` | `oklch(0.18 0.012 270)` | **PROD WINS** — calm-v7 canon hue 280° (#776), bundle hue 270° is pre-v7 |
| `--tandem-surface` | `oklch(0.27 0.012 280)` | `oklch(0.22 0.012 270)` | **PROD WINS** |
| `--tandem-surface-muted` | `oklch(0.25 0.012 280)` | `oklch(0.20 0.012 270)` | **PROD WINS** |
| `--tandem-surface-sunk` | `oklch(0.20 0.012 280)` | `oklch(0.16 0.012 270)` | **PROD WINS** |
| `--tandem-fg` | `oklch(0.94 0.006 280)` | `oklch(0.94 0.005 80)` | **PROD WINS** — hue 280° matches dark canvas hue (warm 80° clashes) |
| `--tandem-fg-muted` | `oklch(0.74 0.008 280)` | `oklch(0.72 0.008 80)` | **PROD WINS** (PROTECTED) |
| `--tandem-fg-subtle` | `oklch(0.70 0.008 280)` | `oklch(0.70 0.008 80)` | **PROD WINS** (PROTECTED, lightness same but hue differs) |
| `--tandem-fg-faint` | `oklch(0.58 0.008 280)` | `oklch(0.58 0.010 270)` | **PROD WINS** |
| `--tandem-border` | `oklch(0.34 0.010 280)` | `oklch(0.30 0.012 270)` | **PROD WINS** |
| `--tandem-border-strong` | `oklch(0.42 0.012 280)` | `oklch(0.38 0.014 270)` | **PROD WINS** |
| `--tandem-accent` | `oklch(0.72 0.14 var(--tandem-accent-h))` | same | **SAME ✓** |
| `--tandem-accent-fg` | `oklch(0.15 0.01 var(--tandem-accent-h))` | same | **SAME ✓** |
| `--tandem-accent-bg` | `oklch(0.30 0.05 var(--tandem-accent-h))` | same | **SAME ✓** |
| `--tandem-accent-fg-strong` | `oklch(0.85 0.14 var(--tandem-accent-h))` | same | **SAME ✓** |
| `--tandem-accent-border` | `oklch(0.45 0.14 var(--tandem-accent-h))` | same | **SAME ✓** |
| `--tandem-author-user` | `oklch(0.72 0.13 245)` | same | **SAME ✓** (PROTECTED) |
| `--tandem-author-claude` | `#e89a78` | same | **SAME ✓** (PROTECTED) |
| `--tandem-claude-focus-bg` / `-border` | color-mix derived | same | **SAME ✓** (PROTECTED) |
| `--tandem-success` | `#22c55e` | same | **SAME ✓** |
| `--tandem-success-fg` | `#0f172a` | same | **SAME ✓** |
| `--tandem-success-fg-strong` | `#bbf7d0` | same | **SAME ✓** |
| `--tandem-success-bg` | `#052e16` | same | **SAME ✓** |
| `--tandem-success-border` | `#14532d` | same | **SAME ✓** |
| `--tandem-warning` | `#fbbf24` | same | **SAME ✓** |
| `--tandem-warning-fg` | `#0f172a` | same | **SAME ✓** |
| `--tandem-warning-fg-strong` | `#fde68a` | same | **SAME ✓** |
| `--tandem-warning-bg` | `#451a03` | same | **SAME ✓** |
| `--tandem-warning-border` | `#78350f` | same | **SAME ✓** |
| `--tandem-error` | `#ef4444` | same | **SAME ✓** |
| `--tandem-error-fg` | `#0f172a` | same | **SAME ✓** |
| `--tandem-error-fg-strong` | `#fca5a5` | same | **SAME ✓** |
| `--tandem-error-bg` | `#450a0a` | same | **SAME ✓** |
| `--tandem-error-border` | `#7f1d1d` | same | **SAME ✓** |
| `--tandem-info` | `#3b82f6` | same | **SAME ✓** |
| `--tandem-info-fg` | `#0f172a` | same | **SAME ✓** |
| `--tandem-info-fg-strong` | `#bfdbfe` | same | **SAME ✓** |
| `--tandem-info-bg` | `#0c4a6e` | same | **SAME ✓** |
| `--tandem-info-border` | `#0369a1` | same | **SAME ✓** |
| `--tandem-suggestion` | `#a78bfa` | same | **SAME ✓** (PROTECTED) |
| `--tandem-suggestion-fg-strong` | `#ddd6fe` | same | **SAME ✓** (PROTECTED) |
| `--tandem-suggestion-bg` | `#2e1065` | same | **SAME ✓** (PROTECTED) |
| `--tandem-suggestion-border` | `#4c1d95` | same | **SAME ✓** (PROTECTED) |
| `--tandem-highlight-yellow/green/blue/pink` | `rgba(..., 0.38)` | same | **SAME ✓** |
| `--tandem-selection-blurred-bg` | `color-mix(in srgb, var(--tandem-accent) 32%, transparent)` | same | **SAME ✓** |

## Warm theme

Both production and bundle define `[data-theme="warm"]` with the same OKLCH values (`--tandem-bg: oklch(0.945 0.012 70)`, `--tandem-surface: oklch(0.975 0.005 75)`, etc.). All **SAME ✓**.

The bundle's pill-shadow `--c7-pill-shadow` for warm is identical to production. **SAME ✓**.

## NEW tokens to adopt

These tokens exist in the bundle but not production. They're additive (no conflict with existing values) and improve semantic naming. **Adoption is per-Phase**: a token enters production only when the first sub-PR that consumes it lands. The `index.html` token block is the canonical home for adopted tokens.

### Semantic type roles

The bundle defines `--tandem-h1-font` / `--tandem-h1-size` / `--tandem-h1-weight` / `--tandem-h1-leading` / `--tandem-h1-tracking` (and mirrors for h2, body, ui, code). Today, production uses raw `font-size`/`font-family` declarations inline at consumer sites; adopting these named roles centralises the type scale.

| Token | Bundle value | Adoption sub-PR |
|---|---|---|
| `--tandem-h1-font` | `var(--tandem-font-serif)` | Phase 1.3 Editor |
| `--tandem-h1-size` | `calc(var(--tandem-text-lg) * 2)` (~34px) | Phase 1.3 |
| `--tandem-h1-weight` | `600` | Phase 1.3 |
| `--tandem-h1-leading` | `1.15` | Phase 1.3 |
| `--tandem-h1-tracking` | `-0.02em` | Phase 1.3 |
| `--tandem-h2-font` | `var(--tandem-font-serif)` | Phase 1.3 |
| `--tandem-h2-size` | `calc(var(--tandem-text-lg) * 1.4)` (~24px) | Phase 1.3 |
| `--tandem-h2-weight` / `-leading` / `-tracking` | (per bundle) | Phase 1.3 |
| `--tandem-body-font` / `-size` / `-leading` | `var(--tandem-font-serif)` / 17px / 1.65 | Phase 1.3 |
| `--tandem-ui-font` / `-size` / `-leading` | `var(--tandem-font-sans)` / 13px / 1.4 | Phase 1.1–1.10 (any chrome sub-PR) |
| `--tandem-code-font` / `-size` | `var(--tandem-font-mono)` / 12px | Phase 1.x as needed |

### Utility classes (port into `index.html` style block)

| Class | Purpose | Adoption sub-PR |
|---|---|---|
| `.tandem-h1` | Heading 1 helper | Phase 1.3 Editor |
| `.tandem-h2` | Heading 2 helper | Phase 1.3 |
| `.tandem-body` | Body prose | Phase 1.3 |
| `.tandem-ui` | UI chrome label | Phase 1.x |
| `.tandem-mono` | Code/timestamps | Phase 1.x |
| `.tandem-label` | Uppercase mono label | Phase 1.x |
| `.tandem-fade-y` | Vertical scroll-fade mask | Phase 1.4 SideRail |
| `.tandem-fade-x` | Horizontal scroll-fade mask | Phase 1.4 |
| `--tandem-fade-dist` | Distance for `.tandem-fade-*` (16px) | ADOPT alongside above |

These do not exist in production today. Adding them is additive.

## DEFER decisions

| Token | Bundle stance | Deferred to |
|---|---|---|
| `--tandem-font-sans-editor` | Bundle splits chrome (Inter) vs editor body (SN Pro). Production's recent 2026-05-20 commit explicitly moved editor to sans-serif (SN Pro). Bundle's value `"SN Pro", "Nunito", ...` is compatible with production's current default; bundle's `--tandem-font-sans: "Inter", ...` is NOT compatible (Inter ≠ SN Pro chrome). Decision: keep production's `--tandem-font-sans` (SN Pro primary) and DO NOT add `-sans-editor` yet. | Phase 1.3 Editor sub-PR (revisit if the chrome/editor font split has visible value) |
| Bundle's scrollbar-hidden recipe | Bundle hides scrollbars and uses `.tandem-fade-*` instead. Production uses themed scrollbars. | v1.1+ — adopt fade-mask alongside scrollbars rather than as a replacement |

## Enforcement

Two CI gates protect this audit's decisions across the 46+ sub-PRs in the umbrella branch:

1. **Existing semantic-tokens lint** (`scripts/check-semantic-tokens.ts`): blocks raw hex/rgba in `src/client/**/*.{ts,svelte}` outside the approved exemption list (neutral-shadow rgba). Unchanged by this audit; continues to enforce that component code references only `var(--tandem-*)`.
2. **NEW: protected-token snapshot gate** (`tests/design-system-impl/token-protection.test.ts`): vitest test that reads `index.html`, extracts the `:root` and `[data-theme="dark"]` token blocks, and asserts each protected token value matches a snapshot. Changing a protected token requires updating the snapshot in the same PR with an explicit per-token WCAG re-audit committed alongside.

Snapshot update is intentionally noisy: it surfaces every protected-token change for human review during PR review. No "auto-update on `--update-snapshots`" allowance for these tokens.

## Visual comparison artifact

The text-form audit above is paired with a swatch comparison HTML at [`preview/token-comparison.html`](preview/token-comparison.html). It renders the dark-mode bundle vs production values side-by-side so the divergences (hue 270° vs 280°, lightness shift) are visible. Bryan: this can be imported into OpenDesign as a side-by-side reference if you want to compare the two darks more concretely.

## Open items

- **Apply WCAG re-audit if a future PR wants to adopt bundle's hue 270° dark canon.** Production at hue 280° passed the audit; switching hue would need fresh contrast checks against every text-on-surface combination in the dark theme. Not in scope for this umbrella branch.
- **Bundle's `--tandem-font-sans` ("Inter") vs production's ("SN Pro, Inter Tight"):** the bundle treats Inter as primary chrome font; production treats SN Pro as primary. If we want to reconsider, that's a single-purpose PR (chrome font swap with screenshot baselines), not part of this umbrella.
