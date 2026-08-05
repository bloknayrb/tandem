# Accessibility gate — results

v1.0 exit criterion, `docs/roadmap.md` § "v1.0.0 Exit Criteria → Accessibility".
Run date: 2026-08-05. Branch: `feat/v10-accessibility-gate`.

Six criteria. **Four automated and passing, two unrun** — the two screen-reader
walkthroughs need a human at a real OS and are recorded as unrun rather than
inferred from the automated rows.

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| A1 | Windows Narrator full editor walkthrough | **Unrun** | Requires a human driving Narrator on Windows. No automated substitute; see §A1. |
| A2 | macOS VoiceOver full editor walkthrough | **Unrun** | Same, on macOS. |
| A3 | Forced-colors mode (Windows high contrast) | **Pass** | `tests/e2e/forced-colors.spec.ts` — 6 tests. |
| A4 | axe-core scan, zero CRITICAL findings | **Pass**, qualified | `tests/e2e/accessibility.spec.ts` — 30 tests (15 surfaces × 2 themes). Qualifier below. |
| A5 | Keyboard-only navigation | **Pass**, with fixes | `tests/e2e/keyboard-a11y.spec.ts` — 5 tests. Three defects found and fixed. |
| A6 | WCAG AA contrast across all status colours and themes | **Pass**, with fixes | `tests/e2e/token-contrast.spec.ts` (3) + `tests/e2e/editor-contrast.spec.ts` (3). Fourteen defects found and fixed. |

Total: 44 automated tests across four files, all passing.

---

## A1 / A2 — screen-reader walkthroughs (unrun)

Not run, and nothing here should be read as evidence about them. The automated
rows below check the *inputs* a screen reader consumes — landmark structure,
roles, names, focus order — but a walkthrough asks a different question: whether
the resulting spoken experience is usable end to end. That is not derivable from
the DOM.

What the automated work does contribute: the missing `main` landmark, the two
unlabelled rails, and the three `role="menu"` widgets that ignored arrow keys
(§A5) would each have been a finding in a walkthrough. Fixing them first means a
walkthrough spends its time on things only a walkthrough can find.

## A3 — forced-colors

Sixteen `@media (forced-colors: active)` blocks existed across the client and
`index.html`. **None had ever been executed.** A media query that never matches
is indistinguishable from one that matches and does nothing.

The suite now renders under the query and checks what survives it: the root
token remap in `index.html`, that shadow-bounded surfaces keep a real border
once `box-shadow` is dropped, that state-by-fill indicators keep an outline once
`background-color` is overridden, and that no visible SVG paints itself a fixed
colour.

Two findings about the instrument, both worth keeping:

- **`test.use({ forcedColors: "active" })` is inert** on Playwright 1.58 with
  bundled headless Chromium 145 — `matchMedia` reports false under it, verified
  on a blank page. It fails *silently*: every assertion would have run against
  ordinary rendering and passed. The suite drives `Emulation.setEmulatedMedia`
  over CDP instead.
- That failure was caught by the suite's own guard test, on its first run. The
  guard asserts the mode is active before anything else claims to measure it.

The first (unemulated) run also served as a free negative control: the boundary
and state-indicator assertions **failed** without the media query and pass with
it, so they are confirmed to measure the forced-colors blocks rather than
something true either way.

## A4 — axe-core

15 surfaces × 2 themes, zero violations at any severity (not merely zero
CRITICAL).

**Qualifier, stated inline because it changes what the row means:** the scans
exclude `[contenteditable]` / `.ProseMirror`. For a document editor that is the
surface users spend all their time in. The exclusion is deliberate — axe's
contrast rule cannot resolve text over CRDT-driven inline decorations — but it
means "axe passes" is a claim about the application chrome, not the document.
The three excluded classes of colour are measured directly instead, in
`editor-contrast.spec.ts` (see A6).

Also excluded, each with a rationale recorded at the exclusion site:
`nested-interactive`, `region`, `scrollable-region-focusable`.

Structural fixes made to reach zero: added the `main` landmark (the editor
scroll container previously carried `role="region"`), gave both rails
`role="complementary"` with distinct labels, and `role="banner"` on the title
bar. `role="contentinfo"` on the status bar was added and then **reverted** —
neither `contentinfo` (page-level footer metadata) nor `status` (a live region,
which would speak every word-count tick) describes what that bar is.

## A5 — keyboard-only

Five tests: arrow-key operability of composite widgets, visible focus
indication, no positive `tabindex`, and focus restoration on modal dismiss.
Retries are disabled for this file — a focus trap that fails once and passes on
retry is exactly the defect these tests exist to catch.

Three real defects, all found by the suite failing first:

1. **Three `role="menu"` widgets had no arrow-key handling** — the brand menu,
   the decorations menu, and the formatting toolbar's heading dropdown. Each
   declared the role, wired `Escape`, and stopped. Per the WAI-ARIA APG a menu
   is a composite widget operated with arrow keys; these announced themselves as
   menus and then did not respond to the keys a menu is operated with.

   This survived the axe audit for a structural reason: **the markup was
   correct.** axe cannot see that a `keydown` handler has no `ArrowDown` branch.
   A Tab-only traversal misses it too, because the items are `<button>`s and so
   the menu is *reachable* — just not *operable as a menu*. `CommandPalette`
   implemented the pattern correctly all along, which is the positive control
   that this was an oversight and not an unknown.

   Fixed by a shared `src/client/utils/menuKeys.ts`.

2. **The command palette stranded focus on `<body>` when dismissed.** Its input
   unmounts on close and nothing claimed focus, so a keyboard user's next Tab
   restarted from the top of the document. Now the opener is captured on open
   and restored on dismiss — dismiss only; running a result moves focus
   deliberately and must not be undone.

3. Not a product defect but recorded because it shaped the file: the first test
   in the suite pays for Vite's cold module compile and exceeded the default
   30s. Fixed with a longer timeout, **not** retries — retries would also have
   masked the flake class the file guards.

## A6 — WCAG AA contrast

Two suites, because axe alone cannot answer the criterion as written. axe
evaluates only elements *painted at scan time*: an error banner, a success
toast, a suggestion annotation are not on screen during a normal run, so an
axe-only pass says nothing about them. It would report green on a palette where
every error colour was unreadable, purely because nothing had errored.

`token-contrast.spec.ts` resolves the declared token pairs per theme and runs
the contrast formula over them directly. `editor-contrast.spec.ts` covers the
three classes axe structurally cannot reach inside the excluded editor:
authorship colours, highlight fills (alpha-composited over the editor
background, since what the eye receives is the composite, not the token), and
annotation underlines.

### Fixes

- **Twelve components paired `-fg` with `-bg`** — e.g. `--tandem-error-fg`
  (literally `#ffffff` in light mode, the text colour for a *filled* button) on
  the pale `--tandem-error-bg`. White on white. Three were `role="alert"` error
  messages. These states only render when something has already gone wrong,
  which is exactly why an axe scan of a healthy app never saw them. All changed
  to `-fg-strong`.
- **`--tandem-warning-fg`** `#ffffff` → `#0f172a` (3.76:1 → 4.75:1 on amber).
- **`--tandem-info`** `oklch(0.58 …)` → `oklch(0.55 …)` (4.41:1 → 4.97:1).
- **De-emphasis ladder retuned** in light and warm (`fg-muted` 0.42,
  `fg-subtle` 0.455, `fg-faint` 0.50) and `fg-faint` in dark (0.67). Recorded
  per-token in `docs/design-system-impl/token-audit.md`, as the protected-token
  gate requires.

### A deliberate non-assertion: `-border` against `-bg`

An earlier revision asserted 3:1 there and **every** family failed. That was the
test being wrong, not the palette, and the measured values are recorded here so
the decision stays visible rather than becoming a silent omission (measured
2026-08-05 by the same canvas-readback path the suites use):

| Family | Light | Dark | Warm |
|---|---|---|---|
| success | 1.80 | 1.64 | 1.72 |
| warning | 1.73 | 1.65 | 1.66 |
| error | 1.95 | 1.61 | 1.85 |
| info | 1.87 | 1.59 | 1.80 |
| suggestion | 1.93 | 1.39 | 1.85 |
| accent | 1.44 | 1.77 | 1.44 |

SC 1.4.11 requires 3:1 for visual information needed to **identify** a component
or its state. A status banner is identified by its tinted fill and its text,
both of which pass. The hairline is refinement on an already-distinguishable
surface. Forcing 3:1 would mean hard saturated outlines on soft banners — worse
design bought with no accessibility gain, in service of a criterion that does
not apply. Where a border *is* the sole state indicator (focus rings), that is
covered by A5's focus-visible assertions, against the colours the ring actually
sits between.

### Three instrument errors worth recording

Each produced confident, wrong findings before being caught. All three were
caught by noticing a causally impossible reading, not by review.

1. **Mid-transition sampling.** The first audit reported 133 violations across
   ~30 pairs, including a *dark*-theme foreground on a *light*-theme background
   — impossible once settled. The theme was being set after opening each
   surface. With `addInitScript` before first paint and a settle on
   `document.getAnimations()`: 108 violations, **6** real pairs. About four
   fifths of the first run was fiction.
2. **Parsing `oklch()`.** Chromium serialises it as `color(srgb 0.55 0.55 0.56)`;
   reading those 0–1 floats as 0–255 reported near-black for everything and
   produced a confident "this token passes at 6.22:1" against axe's 2.88.
   Rebuilt on canvas readback, with a control that had to reproduce axe's
   numbers exactly before being trusted.
3. **Raw token vs rendered colour.** The authorship probe reported 2.66 / 2.99 /
   4.09 failures. `editor.css` paints `color-mix(author 58–64%, fg)`, not the raw
   token. Measuring the token would have sent someone to retune brand colours
   that render fine.
