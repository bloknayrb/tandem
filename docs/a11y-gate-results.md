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
| A4 | axe-core scan, zero CRITICAL findings | **Pass**, qualified | `tests/e2e/accessibility.spec.ts` — 45 tests (15 surfaces × 3 themes). Qualifier below. |
| A5 | Keyboard-only navigation | **Pass**, with fixes | `tests/e2e/keyboard-a11y.spec.ts` — 7 tests. Four defects found and fixed. |
| A6 | WCAG AA contrast across all status colours and themes | **Pass**, with fixes | `tests/e2e/token-contrast.spec.ts` (3) + `tests/e2e/editor-contrast.spec.ts` (3). Fifteen defects found and fixed, one recorded as a non-assertion. |

Total: 64 automated tests across four files.

> **Revised 2026-08-06 (post-review).** The first version of this table said "44
> automated tests … all passing", and both halves were wrong. The arithmetic did
> not add up against its own rows, and the branch was CI-red at the time on
> `accessibility.spec.ts` "dark mode > annotation card" — axe reporting
> `.ach-time` at 4.44:1 (`#94959a` on the `--tandem-author-claude-bg` card tint).
> That is fixed (the span moved from `--tandem-fg-faint` to `--tandem-fg-subtle`,
> 4.96:1) and A4 now runs the warm theme as well, which is where the retuned
> ladder's margins are thinnest. The A6 changes are described under "The
> underline probe measured tokens nothing paints" below.

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

Seven tests: arrow-key operability of the three composite widgets, visible focus
indication, no positive `tabindex`, and focus restoration on modal dismiss and on
outside dismiss. Retries are disabled for this file — a focus trap that fails once
and passes on retry is exactly the defect these tests exist to catch.

Four real defects, all found by the suite failing first:

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

3. **The menus' own dismiss paths stranded focus the same way** (found
   2026-08-06, and *caused* by fix 1). The new focus-in effects put focus on a
   menu item; the brand menu's item handlers and all three menus' outside-click
   handlers then unmounted that element while assigning `open = false` directly,
   bypassing the `close*()` functions that restore focus. Benign before this
   branch, real after it. All five paths now route through the close function.

   The restore is **guarded** on focus still being inside the menu (or already
   lost to `<body>`): `clickOutside` fires on `mousedown`, i.e. *before* the
   browser's own focus transfer, so an unguarded restore would override wherever
   the user was actually heading. That matters most for the heading menu, whose
   close calls `editor.commands.focus()` — which restores the ProseMirror
   selection and can scroll the document.

   Not fixed here, and reported instead: the focus-in effect also pulls focus out
   of the editor when the heading menu is opened by a plain mouse click, since
   that trigger deliberately `preventDefault`s to keep focus in ProseMirror.
   Gating the effect on keyboard-initiated opens needs a pointer-vs-keyboard
   intent signal these components do not have.

4. Not a product defect but recorded because it shaped the file: the first test
   in the suite pays for Vite's cold module compile and exceeded the default
   30s. Fixed with a longer timeout, **not** retries — retries would also have
   masked the flake class the file guards.

> **Amendment 2026-08-20 (#1452).** An **eighth** test was added to this file:
> *"the rail's panel switcher exposes which panel is selected"*. The counts above
> are left at their 2026-08-05 values because this table records that run.
>
> The gap it closes is the same class as defect 1 — correct markup that an axe
> scan cannot fault. The right rail's Annotations/Chat switcher distinguished the
> active panel with a CSS class and nothing else, so a screen reader announced two
> identically-shaped buttons with no selected state between them. axe reports no
> violation for that: an unmarked button is valid markup, just uninformative.
>
> Fixed with `aria-current="page"` on the active button, following the Settings
> sidebar switcher (`SettingsModal.svelte`) rather than the APG tabs pattern —
> `role="tab"` obliges a roving tabindex, which would take one of the two buttons
> out of the tab order and is a keyboard behaviour change rather than an additive
> fix. #1452 records the full pattern as still available if it is ever wanted.

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

> **Correction, 2026-08-06.** The sentence above claimed underline coverage that
> the suite did not have when it was written; see "The underline probe measured
> tokens nothing paints". It is accurate now.

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
- **`.ach-time` moved `fg-faint` → `fg-subtle`** (`AnnotationCardHeader.svelte`).
  It was the only faint-tier text in the app landing on a tinted surface, at
  4.44:1 on the dark Claude card tint; both sibling spans in the same header were
  already on `fg-subtle`. This is the axe failure that had the branch CI-red.
- **Four composited-opacity sites** where alpha spent the AA margin the token
  guarantees. A composite is invisible to every instrument here by construction,
  which is why these needed finding by hand: `.margin-pin-btn`
  (`--tandem-fg-subtle` at 0.55 → 2.54:1, under SC 1.4.11's 3:1 for a control's
  identifying graphic) now expresses its rest/hover/pinned ramp as three colour
  rungs; `NewTabMenu`'s `.ntl-path` / `.ntl-when` focus rules (4.32 / 3.84) and
  `.ntl-action-primary .ntl-kbd` (3.64) drop their alpha and land at 7.74 / 7.74
  / 5.63. Two of the three were `:focus`-only states, which axe never renders.

  Adjacent and deliberately **not** swept, because nobody measured them and they
  are pre-existing: `.margin-bubble [data-testid^="edit-btn-"]` at 0.55 (text, so
  a 4.5 floor), `.ntl-search-clr` (measured at 3.83:1 — passes the icon floor),
  and `.ntl-glyph` at 0.65.

### Known cost of the ladder retune — accepted 2026-08-05

Adversarial visual review confirmed a real loss: `fg-muted` and `fg-subtle` now
sit 0.035 L apart in light/warm and are hard to tell apart on screen, so the
ladder reads as two steps rather than three. In dark all three rungs
(0.74 / 0.70 / 0.67) render as effectively one colour. Helper copy no longer
recedes from the labels it annotates.

This is mostly forced rather than chosen. On a near-white surface, AA 4.5:1 for
small text caps how light de-emphasised text can be — the pre-gate ladder bought
its visible spread with a bottom rung at 3.2:1 (light) / 2.9 (warm) / 4.0 (dark),
i.e. by failing the criterion this gate exists to meet. There is no setting that
restores the old spread *and* passes.

There is real headroom, though, and it is a trade rather than a fix. Body
`--tandem-fg` is 0.22 and `faint` is pinned near 0.50, so 0.28 of range is
legal while the three rungs occupy 0.08 of it. Spreading evenly
(≈0.34 / 0.42 / 0.50) restores a 0.16 span — the pre-gate magnitude, all three
rungs AA — but only by darkening `muted` toward body text, which makes the
*first* step of de-emphasis weaker even as the ladder as a whole becomes
legible. Three distinguishable rungs versus one strongly-receding rung.

**Decision (Bryan, 2026-08-05): keep the shipped values.** The reasoning that
settles it is that how far `muted` recedes from body text is what actually makes
helper copy read as secondary — a legible three-rung ladder whose top rung has
stopped receding buys nothing the interface uses. Two visible tiers with a
strong first step beats three visible tiers with a weak one. Recorded as a known
cost rather than a defect; revisit only if a surface appears that genuinely needs
to distinguish `subtle` from `muted`.

Second-order effect, also confirmed: `fg-faint` is not only a text token. It
paints the EmptyState illustration strokes, the ActivityTray idle LED, and a
CommandPalette icon stroke. Those are not text and are not governed by the AA
floor, so darkening the token for legibility makes the empty-state illustration
read firmer than the soft sketch it was designed as.

### `--tandem-warning-fg` — accepted 2026-08-05

Flipping it white → `#0f172a` takes the one surface that uses it (the `Private`
pill in `NoteCard.svelte:33` — the token's **only** consumer) from 3.76:1 to
4.75:1. Visual review's verdict: legible but muddier than the white it replaced,
because dark theme pairs that same near-black with a genuinely light amber
(`#fbbf24`) while light theme pairs it with a mid-dark ochre
(`oklch(0.62 0.16 65)`). The change copied dark's decision without dark's
precondition; the token that is arguably out of step is light's
`--tandem-warning` fill, not its foreground.

**Decision (Bryan, 2026-08-05): keep the near-black foreground.** White fails AA
outright, so reverting would turn this row into a pass-with-exception; and the
fill is shared with borders, status dots and the find-hop highlight, so moving it
is a wider change than an accessibility gate should make. The muddiness is real
but contained to one small pill, and belongs to a later design pass on light
theme's amber rather than to this branch.

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

### The underline probe measured tokens nothing paints (found 2026-08-06)

`editor-contrast.spec.ts`'s "annotation underlines" block probed
`--tandem-accent` (comment), `--tandem-warning` (note) and `--tandem-suggestion`
(suggestion) against `--tandem-bg`. `annotation.ts` paints none of those for a
comment or a note: a Claude comment underline is `--tandem-author-claude`, a
user/import comment is `--tandem-author-user`, a note is `--tandem-fg-muted`, and
the suggestion span sets its own `--tandem-suggestion-bg` background, so
`--tandem-bg` was the wrong surface for that row too. The block reported 5.52:1
for a colour no code path writes, while the real Claude underline sat at 2.99:1.
A probe that measures a token nothing paints is worse than no probe, because it
reports the criterion covered.

The block now mirrors `annotation.ts` and names it as its source. Measured:

| Underline | Token | Light | Dark | Warm |
|---|---|---|---|---|
| Claude comment | `--tandem-author-claude` vs `--tandem-bg` | **2.99** | 7.70 | **2.65** |
| user/import comment | `--tandem-author-user` vs `--tandem-bg` | 4.60 | 7.06 | 4.09 |
| note | `--tandem-fg-muted` vs `--tandem-bg` | 8.11 | 7.51 | 7.20 |
| suggestion | `--tandem-suggestion` vs `--tandem-suggestion-bg` | 5.22 | 5.60 | 4.87 |

**The Claude row is recorded as a non-assertion, not asserted at 3:1** — the same
reasoning already applied to `-border` vs `-bg` above. SC 1.4.11 governs what is
needed to *identify* a component, and an annotated span is identified by its
side-panel card, its margin bubble and its own `aria-label`; the hairline is a
locator on top of that. It is also a pre-existing value, unchanged by this
branch, so moving it is a brand-identity call rather than an accessibility-gate
one. Two options are measured and ready if it is taken: wrapping the underline in
the same `color-mix(… 64%, var(--tandem-fg))` `editor.css` already uses for
authorship *text* (5.50 / 9.71 / 4.88), or `--tandem-author-claude-border`
(`#c2613e`, hand-tuned for exactly this job — 3.96 light / 3.52 warm).

### The ladder loop swept only neutral surfaces (found 2026-08-06)

`token-contrast.spec.ts` asserted the four de-emphasis tiers against `bg`,
`surface` and `surface-sunk` — the three neutrals — while every *tinted* surface
the ladder lands on sat outside the instrument, including the `--tandem-accent-bg`
that `index.html` names as dark's binding constraint. That is the blind spot that
let dark `--tandem-fg-faint` ship at 4.44:1 on the Claude card tint with no signal
but an axe scan that happened to render one annotation card in one theme.

The loop now sweeps twelve surfaces (four neutrals, `accent-bg`, both author
tints, five status fills) × four tiers × three themes. Light and warm clear 4.5
everywhere; four dark pairs do not, and are carried as named waivers with their
measured numbers next to the loop rather than being omitted:

| Pair (dark) | Ratio | Why waived |
|---|---|---|
| `fg-muted` on `info-bg` | 4.10 | no consumer pairs a de-emphasis tier with `#0c4a6e` |
| `fg-subtle` on `info-bg` | 3.54 | same |
| `fg-faint` on `info-bg` | 3.16 | same; already recorded in `index.html` |
| `fg-faint` on `author-claude-bg` | 4.43 | consumer removed (see A4 note); removing it does not raise the ratio |

Retuning `--tandem-info-bg` would close three of these and is worth doing, but it
reaches into every info banner — wider than this gate should go. Tracked, not
silently dropped.

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
