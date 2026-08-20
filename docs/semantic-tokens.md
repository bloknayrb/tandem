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

- `npm run check:tokens` runs `scripts/check-semantic-tokens.ts` against `src/client/**/*.{ts,tsx,js,jsx,svelte,css,html}` — `.css` is where 10 of the 12 current warnings live. Raw hex in client code is a regression; lint rule tracked in #356.
- `rgba(0,0,0,...)` / `rgba(255,255,255,...)` alpha values for shadows and overlays are **exempt** — they're neutral, not semantic.
- **An issue reference is not a color (#1534).** `#1364` is a valid `#RGBA`, and the CSS-context test is a line-level substring match that `forced-colors`, `borderline` and `styles` all satisfy — so a four-digit issue number in a live string used to be reported as a raw color. The hex pass therefore skips a match whose body is **all decimal digits** *and* which sits in no color-value position. An all-digit body of 5 or 7 characters is skipped outright — not a valid CSS color length in any browser. **Both narrowings are gated on all-decimal-digit bodies**, so any hex carrying an `a`-`f` character is unaffected at every length — including a 5- or 7-digit typo like `#abcdef1`, which is not a CSS color but is the shape of a mistyped one — and an all-digit gray like `#333333` is still caught wherever a color can actually appear.
- **The color-value test asks "which string literal is this in?", not "which token precedes it?"** That is the whole design, and the reason is that a per-token test is wrong in both directions at once and cannot be fixed in one: loosening it enough to see `#333` in `el.style.boxShadow = "0 0 0 #333"` (a unitless `0` is still a length) necessarily also makes it report `console.log("border shifted 4px #1364")`. Deciding per-literal separates them, because a prose string is prose all the way through. In code — that is, outside any literal — a hex counts as a color when the declaration walk-back to the last `;`/`{`/`}` finds a property colon, when it follows a bare `attr=`, or when it sits in a named CSS color function that closes on the line. Inside a literal, the **literal as a whole** is judged, by any of: what precedes the opening quote makes it a CSS value (`style=`, `style:prop=`, `.style.*=`, `setProperty("--x", …)`, a **CSS-ish** object property, a CSS-in-JS tag); every word in it is a CSS **value** word (`"1px solid #333"`); it **opens with** a CSS property colon (`` `border: ${w}px solid #333` ``); it is a color-function argument, where the call must also **close inside the same literal**; or the hex is the literal's entire contents. Anything else in a literal is prose.
- **The literal decision survives a line break, for templates and attribute values only.** A wrapped `style="…"` attribute (six of them in `CommandPalette.svelte`) and a multi-line template literal are carried forward with their governor and their text so far, so a continuation line is still judged as part of one literal rather than falling back to the per-token walk-back. Nothing else is carried, and that restriction is the safety argument: **103 lines in `src/client` end mid-`'` or mid-`"` purely from prose apostrophes** (`AppearanceSettings.svelte`'s "document's"), and carrying those would poison every following line of the file. An attribute quote is preceded by `=`; an apostrophe in prose is preceded by a letter. A line ending mid-`${…}` is not carried either.
- Three deliberate asymmetries are load-bearing, and "completing" any of them re-opens #1534. **CSS property names are absent from the value-word list** — prose about CSS names the property (`"border shifted"`, `"color hidden"`), a real value never does, and that absence is the discriminator. **A color function must close inside its literal** — `console.warn("border rgba( parse fail #1364")` has an open `rgba(` before the hex, but it is a sentence containing a bracket, not a call. And **the object-property governor accepts only CSS-ish names**, in either spelling (`borderColor`, `box-shadow`): the loose "any identifier" form reported `label: "Toggle authorship colors (#1364)"`, and `src/client` holds 121 `label: "…"` shapes.
- Residuals, accepted and enumerated. Inside a literal: one that **opens** with a real CSS property name and a colon (`"background: still wrong, see #1364"`) reports — the same shape the raw-CSS walk-back accepts, so the two agree. One whose every word happens to be a CSS **value** word (`title="scroll to end #1364"` — `scroll`, `to`, `end` all are) reports. Outside those, a string whose words include a font-family name or a `url()` filename is not recognised as a CSS value, so a raw gray in `"bold 12px Helvetica, #333"` is missed; a word list cannot fix that class. Note also that `CSS_PROPERTY_WORDS` is wider than the six `CSS_KEYWORDS` the line gate matches on, so a name like `outline` or `caret` only ever fires when one of the six is *also* on the line — do not "fix" the narrower list to match.
- The **bundle blocklist (#799) is deliberately outside that narrowing** — it matches on exact value, so `#222222` is caught in any position.
