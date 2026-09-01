# Derived-Surface Design Spec

> **Phase 0f.** This document is the design source of truth for every Phase 3
> sub-PR on the design-system-impl umbrella branch. Each cluster row below
> answers four prescriptive questions so a sub-PR author can build without
> re-litigating design. If a recipe is ambiguous, flag it here — do not
> re-design at PR time.

## Bundle references (cited throughout)

- **App stylesheet:** OD project "Tandem Design System" UUID
  `019e2685-a2d8-7b24-8d55-864b738f47be`, file `ui_kits/app/app.css`. Cited
  as `app.css:NNN` below.
  > **The `app.css:NNN` line numbers below are UNVERIFIED against this project.**
  > They were written against the superseded "Tandem Design System (1)" bundle
  > (`2a0312b0-…`), and repointing the project header does not make them resolve
  > here. The **selector names** are the reliable half; treat the line numbers as
  > hints until checked. Tracked with a date in
  > [#1712](https://github.com/bloknayrb/tandem/issues/1712).
- **Root tokens:** `colors_and_type.css` (same project). Token names
  reconciled against production in `token-audit.md`; the audit is the
  authority on which token wins when bundle and production differ.
- **Motion vocabulary:** `animations/anims.css` defines 10 scenes
  (`A1`–`A10`). Where a row says "motion: A4 (new annotation arrives)",
  the recipe is the named scene's keyframes + easing applied to the
  production surface element. Phase 4 (full motion thread-through) is
  out of scope for the umbrella — only inline-cited scenes per row land in
  Phase 3.
- **Coverage inventory:** `Coverage Inventory.md` (same project) enumerates
  every surface; this spec covers only the derived clusters (Phase 3.1–3.10
  of the umbrella plan).

## Cluster recipes

Each row:
- **Bundle ref** — file:line or Svelte component to mirror
- **Tokens** — semantic `--tandem-*` tokens used. "Family X" expands to
  `--tandem-X`, `-fg`, `-fg-strong`, `-bg`, `-border` per the audit
- **Motion** — `An (scene name)` or `—` for static
- **Anti-patterns** — concrete things the sub-PR must NOT do

### 3.1 Banner family — D2 Connection, D3 Updater, D4 Review-only

- **Bundle ref.** No dedicated bundle banner component; share the bundle's
  status-pill recipe (`app.css` `.a9 .pill` at L~480 in `animations/anims.css`
  for the colored-dot affordance) wrapped in a 36px-tall full-width strip
  with the banner family's color from below.
- **Tokens.** D2 → family `error` (lost connection is an error state).
  D3 → family `info` (updater is informational, non-blocking). D4 → family
  `info` (review-only is a mode notice). All three use
  `--tandem-shadow-1` for resting and pull `--tandem-text-sm` for body
  text.
- **Motion.** All three: 180ms ease-out slide-in from above per
  `README.md` "Banner slide-in" entry. Use `transform: translateY(-100%)`
  → `translateY(0)`; no opacity fade (so the dismiss animation is
  symmetrically reversible).
- **Anti-patterns.** Do NOT introduce a left-edge accent stripe — that
  recipe is reserved for annotation cards (Conflict #7 + the
  README "edge color" rule). Do NOT vary the height per banner; D2/D3/D4
  must stack predictably when more than one is visible. Do NOT add a
  CTA-button-as-banner-action — banners offer dismiss only; recovery
  actions belong inside the surface they describe.

### 3.2 Error / help / file modals — D6 ErrorBoundary, D8 HelpModal, D9 FileOpenDialog

- **Bundle ref.** `app.css:738` opens the "Overlay & Modals" block; modal
  shell pattern at `.palette-modal` (`app.css:792`) is the canonical recipe
  — 640px max-width, `var(--tandem-r-5)` corner radius (modals/larger
  cards), three-layer shadow (`shadow-3` per README L98). Backdrop is
  `color-mix(in srgb, var(--tandem-bg) 70%, transparent)` per README L127.
- **Tokens.** Surface = `var(--tandem-surface)`; border =
  `var(--tandem-border)`; close button follows `.settings-close-btn`
  (`app.css:762`). Title type = `--tandem-h2-*` (token family added in
  `token-audit.md`). Body type = `--tandem-body-*`.
- **Motion.** Modal enter = 140ms ease-out, opacity 0→1 + scale 0.96→1.
  No bounce. Backdrop fades in alongside. (Use the same recipe across
  all three so they feel like one modal family — palette already does this.)
- **Anti-patterns.** Do NOT use `r-3` corners (palette + settings modals
  use `r-5`; matching keeps the modal family coherent). Do NOT add a
  custom backdrop opacity per modal — the `bg 70%` mix is the standard.
  Do NOT shrink ErrorBoundary's reset/reload buttons below 36px height —
  they're an error-recovery affordance, must remain easy to hit.

### 3.3 Annotation conversation — C9 ReplyThreadOverlay, C10 CommentThread, C11 ImportedCard, C12 AnnotationEditForm

- **Bundle ref.** Card chrome follows `ui_kits/app/AnnotationCard.svelte`
  per Conflict #8 (five-file split preserved). The card shell is
  `.anno-card` (`app.css:491`): full surface + 1px border + 16px corner +
  9px vertical gap + three-layer ambient shadow (`app.css:501–504`),
  with hover-lifted shadow at `app.css:507–512`. Header is
  `.card-head` (`app.css:518`) holding a 6px `.author-dot`, an 11px
  600-weight `.author-name` (cobalt for user, gold for Claude;
  `app.css:521–523`), an optional `.type-badge` pill
  (`app.css:524–546`), and a right-aligned 9px monospace `.card-time`.
  Body uses `.card-body` (`app.css:548`) or, for suggestion rationale,
  `.card-rationale` (`app.css:549–556`: 11.5px italic serif at
  `--tandem-fg-subtle`). Suggestions render a `.diff-block` with
  `.diff-del`/`.diff-add` (`app.css:557–578`). Actions sit in
  `.card-actions` (`app.css:579–585`) using `.btn-sm` pills
  (`app.css:586–618`): `.primary`, `.ghost`, or `.send` (cobalt-tinted,
  reserved for the note's "Send to Claude" affordance).
  Thread overlay shell follows the cluster-3.2 modal recipe inset within
  the rail's available width.
- **Tokens.** Card surface = `var(--tandem-surface)`; border =
  `var(--tandem-border)`; radius = `var(--tandem-r-5)` (16px).
  Suggestion tint (background) = `oklch(0.985 0.008 295)` light /
  `oklch(0.24 0.04 295)` dark (`app.css:514, 516`). User-authored-comment
  tint = `oklch(0.987 0.005 250)` light / `oklch(0.24 0.03 250)` dark
  (`app.css:515, 517`). Notes, Claude-authored comments, imported, and
  highlights inherit the default surface — NO tint. Diff backgrounds use
  `color-mix(in srgb, var(--tandem-error) 7%, surface)` /
  `color-mix(in srgb, var(--tandem-success) 7%, surface)`. Edit form
  inputs use the shared `preview/components-inputs.html` recipe.
- **Motion.** Card hover-shadow transition = 200ms ease per `app.css:505`.
  New reply append = A4 (new annotation arrives) keyframes applied to
  the reply row. Suggestion accept = A1 (`animations/anims.css:13–86`)
  diff-collapse keyframes. Suggestion dismiss = A10 (`anims.css:~520`)
  fade-and-slide. Edit form open/close = no motion (form swap in place).
- **Anti-patterns.** **Do NOT use a left-border edge color for the card.**
  The visual taxonomy below is BACKGROUND TINT + HEADER (author dot +
  name + type icon), NOT a colored border. The README "Annotation card
  edge colors" line is stale text superseded by the current
  `AnnotationCard.svelte`. **Tint IS branched on author, deliberately** —
  a single `cardTint` in `AnnotationCard.svelte` reads `annotation.author`
  and returns one of three tokens. An earlier revision of this file said
  the opposite ("the discriminator is the production card variant, each
  owning its own background-tint class"); that instruction predates the
  author-tint change and following it now would reintroduce the
  contradiction the change removed, since two variants can share an
  author. Do NOT introduce a colored author-dot for the imported card —
  imported annotations carry a Word commentor byline ("Sarah · 2024-12-05"
  in italic at `--tandem-fg-subtle`), not the user/Claude authorship dot.
  Notes DO carry a type icon; what distinguishes them is a **hollow**
  author dot, keyed in CSS off `[data-annotation-type="note"]` on the card
  root. A prior instruction here said to suppress the badge on `NoteCard`;
  that was the text-pill era and no longer applies.

### 3.4 Batch + bulk actions — C7 BatchPromoteBar, C8 BulkActions

- **Bundle ref.** Sticky bar follows the bundle's status-pill shadow
  recipe (README "Pill shadow"). Use `.btn-sm.primary` (`app.css:603`)
  for the primary CTA, `.btn-sm.ghost` (`app.css:610`) for cancel.
- **Tokens.** Bar surface = `var(--tandem-surface)`, border =
  `var(--tandem-border)`, shadow = the three-layer pill shadow. Count
  badge uses `--tandem-text-2xs` with `--tandem-fg-subtle`.
- **Motion.** Bar enter = A3 (Sent toast) keyframes adapted —
  `translateY(8px)` → `translateY(0)` over 240ms ease-out. Sticky bar
  stays mounted until selection clears; selection-clear = reverse of
  enter, 200ms.
- **Anti-patterns.** Do NOT show count = 0 (hide instead). Do NOT add a
  third action button — the primary CTA is "Send N to Claude" (C7) or
  "Accept N" / "Dismiss N" (C8); a third action invites accidental
  destructive use. Do NOT block scroll under the bar — the bar sits over
  the editor, the editor must still scroll behind it.

### 3.5 Margin column (risky) — C4 MarginColumn

- **Bundle ref.** No bundle precedent for the leader-line + bubble
  layout. Recipe inherits from production's current implementation;
  this cluster's sub-PR proposes a design and waits for explicit review
  before any code lands per the plan's Phase 3.5 callout.
- **Tokens.** Bubble surface = `var(--tandem-surface)`, border =
  `var(--tandem-border)`, leader line = `var(--tandem-border-strong)`,
  shadow = `var(--tandem-shadow-1)`. Hover state lifts to
  `var(--tandem-shadow-2)` + `var(--tandem-accent-border)`.
- **Motion.** Hover = 140ms ease-out on border + shadow per README
  "Hover & Interaction States" L99. Card-to-text link on click = A6
  (Card ↔ text) anchor pulse.
- **Anti-patterns.** Do NOT route bubble visibility through a "hidden
  state" — collapse the bubble width to the leader-line stub, do not
  display: none (would collapse the leader-line geometry). Do NOT
  position bubbles by absolute pixel — use the rail-content scroll-sync
  pattern from lesson `feedback_dom_nested_overlay_scroll_sync`.

### 3.6 Settings tabs — E7 Collaboration, E8 Models, E9 ClaudeCode, E10 Shortcuts, E11 About

- **Bundle ref.** Tab content shell follows
  `ui_kits/app/Settings.svelte` from the bundle — sidebar nav on the
  left, scrolling content panel on the right. `.settings-nav-btn`
  (`app.css:750`) for sidebar items, `.settings-mode-btn` (`app.css:784`)
  for segmented controls inside tabs.
- **Tokens.** Tab labels = `--tandem-ui-*` (token family added in audit).
  Section dividers = `1px solid var(--tandem-border)` with 16px vertical
  rhythm. Footer link rows (used in About) = `.settings-close-btn` style
  for hover treatment.
- **Motion.** Tab switch = no animation. Settings modal as a whole
  follows the modal-family motion from cluster 3.2.
- **Anti-patterns.** Do NOT collapse to a different layout per tab — all
  five share the same shell so the sidebar-nav-to-content-panel
  relationship is unbroken. Do NOT introduce per-tab background colors —
  the tab content area is always `var(--tandem-surface)`.

### 3.7 Integration wizard — F1 FirstRunModelPicker, F2 ModelEditModal, F3 IntegrationWizardModal, F4–F6 Cowork trio

- **Bundle ref.** Wizard shell follows the cluster-3.2 modal recipe
  (palette + settings family). Step indicator follows the bundle's
  `.a9` status-pill state machine for `step-1 → step-2 → step-3` dot
  states (active vs done vs pending). Form fields follow
  `preview/components-inputs.html` from the bundle.
- **Tokens.** Wizard step dot active = `var(--tandem-accent)`; done =
  `var(--tandem-success)`; pending = `var(--tandem-border-strong)`.
  Continue button = `.btn-sm.primary`; back button = `.btn-sm.ghost`.
- **Motion.** Step transition = 200ms ease-out opacity fade on content
  area; step indicator dot transitions via A2 (Save) keyframes
  (dot → check, 200ms).
- **Anti-patterns.** Do NOT auto-advance past the secrets step — the
  user must explicitly press Continue (per ADR-027 + security review). Do
  NOT log secret values to the console even in error states. Do NOT
  remove the keychain-fallback banner — `integration-wizard-keychain-fallback`
  testid is asserted by E2E.

### 3.8 Settings primitives — F7 ApplyChangesButton, F8 CollapsibleSection

- **Bundle ref.** F7 = `.btn-sm.primary` (`app.css:603`) with a status
  dot prefix (A2 dot → check pattern at apply-success). F8 = the
  bundle's `<details>` recipe per `preview/components-cards.html`
  collapsible variant.
- **Tokens.** F7 idle = primary button colors; pending = primary +
  pulsing dot via A2 keyframes; success-flash = brief
  `--tandem-success-bg` background pulse. F8 summary text =
  `--tandem-ui-*`; rotation chevron uses `--tandem-fg-subtle`.
- **Motion.** F7 success-flash = 380ms ease-out per A1 `.accept-flash`
  keyframes. F8 open/close = 140ms ease-out `max-height` transition;
  reduced-motion skips height animation, snaps open.
- **Anti-patterns.** Do NOT use `<details><summary>` default disclosure
  triangle — strip via `::-webkit-details-marker { display: none }` per
  the existing pattern. Do NOT disable F7 while a save is in-flight
  without a pending indicator — the user must see why the button is
  unresponsive.

### 3.9 Find/Replace + Tabs — B4 FindReplaceBar, A3 DocumentTabs, A5 ModeToggle

- **Bundle ref.** Find bar = floating-pill recipe shared with command
  palette (`.palette-modal` shape + pill shadow). Tabs follow the bundle's
  `preview/components-tabs.html` recipe — pill-shaped, `--tandem-r-pill`
  corners. ModeToggle = `.a8 .seg` (`animations/anims.css` Solo↔Tandem
  scene) — segmented control with sliding thumb.
- **Tokens.** Find bar match-count chip = `var(--tandem-surface-sunk)` +
  `--tandem-fg-subtle`. Tab pill active = `var(--tandem-surface)` over
  `var(--tandem-surface-sunk)` strip background. ModeToggle thumb =
  `var(--tandem-surface)` + `var(--tandem-shadow-1)`.
- **Motion.** ModeToggle = A8 thumb-slide (220ms ease-out
  `transform: translateX`). Find bar enter = same modal-family fade.
  Tab close = A10 (dismiss) keyframes adapted — fade + slide-out, no
  collapse animation (the tab strip layout must stay stable).
- **Anti-patterns.** Do NOT broadcast find-bar matches to other tabs
  visually — cross-doc results are a separate UI region
  (`find-cross-doc-results` testid), not the per-tab match-count chip.
  Do NOT animate tab insertion — only tab close. Do NOT remove the
  ModeToggle's middle "Tandem" label on narrow viewports; the toggle is
  semantically a 2-position segmented control and label is the
  affordance. Do NOT let the ModeToggle thumb derive its own geometry
  from the track: the pill must be positioned by whatever mechanism
  sizes the segments, so the two cannot desync (#1383/#1384, one desync
  seen from two sides). Concretely, no percentage or `calc` **sizing or
  positioning** on the thumb, and no measured JS; `translateX(100%)` for
  the slide itself is not sizing and is fine. That ban is deliberately
  stricter than the requirement — a percentage thumb over an equalized
  track can be made correct — because it is the mechanism the two issues
  arrived through. The requirement is the invariant, not any particular
  mechanism.

### 3.10 Annotation decorations — B2 (inline marks)

- **Bundle ref.** Inline decorations in production already follow ADR-026
  (character-level `data-tandem-author` attributes, paragraph gutter
  aggregation). The bundle's Editor mockup is too small to render these
  faithfully; **production is the source for this surface.** Bundle
  contribution = only the color tokens via the audit (authorship +
  suggestion colors are protected per `token-audit.md`).
- **Tokens.** `--tandem-author-user`, `--tandem-author-claude`,
  `--tandem-claude-focus-bg`, `--tandem-claude-focus-border`,
  `--tandem-suggestion*` — all protected by `token-protection.test.ts`.
- **Motion.** Active-paragraph gutter = A5 (Claude editing) 2s ease-in-out
  infinite pulse. Honor `prefers-reduced-motion`: cluster 3.10 **added** the
  reduced-motion wrap (the pulse and the character-cursor blink were
  previously unwrapped). The guard covers both the OS pref (`@media
  (prefers-reduced-motion: reduce)`) and the in-app `reduceMotion` setting
  (`body.tandem-reduce-motion`), matching the dual mechanism `SidePanel`
  uses — preserve both.
- **Anti-patterns.** **Do NOT branch decoration color on
  `author === "claude"` for gutter aggregation policy** — see Conflict #7:
  the gutter is a paragraph-level reduction of character-level data; the
  reduction rule lives in `editor/extensions/authorship.ts`, the
  per-character color does NOT come from a flag-on-author predicate.
  Document the reduction policy (last-writer / majority / any-Claude
  wins) in the sub-PR description; add a unit + visual test that mixed
  paragraphs show both per-character tints under the gutter so users see
  the underlying authorship.

## Annotation card chrome — `{audience, author, suggestedText}` → variant

The bundle anchors the rule in `ui_kits/app/AnnotationCard.svelte` +
`app.css:491–618`: cards use a **background tint** for the primary
discriminator, a **header with author dot + name + type badge + time**
to signal authorship and kind, and a **`.card-actions` row** of `.btn-sm`
pills for the per-type affordances. The card border is the standard 1px
`var(--tandem-border)` — there is **no left-border edge color**. The
README L122–123 "edge color" line is stale text from an earlier design
and must not be the source.

The taxonomy below is **audience-first** per ADR-027 + Conflict #9 — who
the annotation is for picks the variant first, with author and
`suggestedText` as the refinement signals. The bundle's `cardType` values
(`note`, `comment-user`, `suggest`, `highlight` in `samples.ts:32–51`)
map to production's five-component split.

**Two axes, and they are separate on purpose.** *Author* picks the background
tint; *type* picks the header icon. The variant component picks neither — it
owns the body and the actions row. Before this split the tint was per-variant,
which put a user comment and a user note on different grounds while both
carried the same authorship dot, so the rail contradicted itself. Three tints,
three authors:

| `annotation.author` | Background tint |
| --- | --- |
| `user`   | `var(--tandem-author-user-bg)` |
| `claude` | `var(--tandem-author-claude-bg)` |
| `import` | `var(--tandem-author-import-bg)` (aliases `--tandem-surface-muted`) |

`isReviewTarget` overrides all three with `var(--tandem-accent-bg)`; that is a
state, not a taxonomy row.

The **type icon** is a 13×13 `<svg>` at `viewBox 0 0 16 16`, `stroke:
currentColor`, keyed on the *display* type — `comment`, `note`, `highlight` or
`replacement` (the last derived from `suggestedText !== undefined`, not
stored). It replaced a text pill: the pill spent horizontal room the 160px
narrow margin band does not have, and it repeated what the card body already
says. Only `highlight` is filled, and its fill is the user's picked highlight
colour — the one place that colour still appears now that the body is tinted
by author. The icon is hidden at stub density; its accessible name sits on the
wrapping `role="img"`, and a visually-hidden word is revealed under
`forced-colors: active`, where every tint collapses to `Canvas`.

| audience  | author   | suggestedText | Production variant | Bundle `cardType` | Background tint | Header (dot + name + icon) | Actions row |
| --------- | -------- | ------------- | ------------------ | ----------------- | --------------- | -------------------------- | ----------- |
| `private` | `user`   | —             | `NoteCard`         | `note`            | user tint | **hollow** cobalt dot · "You" · note icon | Send to Claude (neutral + coral disc) · Archive (ghost) |
| `claude`  | `user`   | —             | `CommentCard`      | `comment-user`    | user tint | cobalt dot · "You" · comment icon | Resolve (primary) · Edit (ghost) · Delete (ghost) |
| `claude`  | `claude` | —             | `CommentCard`      | (`comment`)       | claude tint | agent-coloured dot · "Claude" · comment icon | Resolve (primary) · Edit (ghost) · Delete (ghost) |
| `claude`  | `claude` | present       | `SuggestionCard`   | `suggest`         | claude tint | agent-coloured dot · "Claude" · replacement icon | Accept (primary) · Dismiss (ghost) · Edit (ghost) |
| `private` | `import` | —             | `ImportedCard`     | (production-only) | import tint | no author dot · italic byline "Sarah · 2024-12-05" (`--tandem-fg-subtle`) · note icon (accessible name "Private note") | Promote (primary) · Dismiss (ghost) |

Note the first column on that last row: imported Word comments land as
`type: "note"`, `audience: "private"`, `author: "import"`
(`src/server/file-io/docx-comments.ts:635-637`), and `BatchPromoteBar` is what
flips all three at once. An earlier revision of this table said `claude`, which
read as though an import were visible to the AI on arrival. It is not.

Privacy is carried by **three** header signals, not one, and which of them are
present depends on the row:

- the **hollow note dot** — user-authored notes only, since `ImportedCard` has
  no author dot at all;
- the **Private pill**, at full/compact/clamped density;
- the **note glyph**, whose accessible name is literally "Private note", and
  which is what `ImportedCard` relies on.

`getCardLabel` also prefixes the card's own aria-label with `private `, so the
signal survives even where every visual carrier is suppressed. The hollow dot
is deliberately zero-width-cost — it swaps `background` for a `border` on an
element that already exists, so it cannot disturb the stub-density width
budget. Do not replace it with a pill or an extra glyph without re-checking
that budget, and do not treat it as load-bearing on its own.

**Suggestions are Claude-only.** Users can author notes, comments, and
highlights; they cannot author suggestions. A `suggestedText` field on a
user-authored annotation is a data-model violation — `tandem_createAnnotation`
should not accept it from a user, and the UI should never render one.
The five rows above are the complete taxonomy.

**Highlights are a different surface entirely.** They render as inline
mark fills in the editor (no card body) and carry no chrome — color comes
from the user-picked highlight color in `HIGHLIGHT_COLOR_VARS`
(`src/client/utils/colors.ts`).

**Header chrome details (per `app.css:518–547`):**
- `.author-dot` = 6×6px circle, `var(--tandem-author-user)` or `var(--tandem-author-claude)` background, `flex-shrink: 0`
- `.author-name` = 11px, 600 weight; cobalt for user (`oklch(0.35 0.14 245)`), gold for Claude (`oklch(0.40 0.12 45)` light, `oklch(0.78 0.12 45)` dark)
- `.annotation-type-badge` = the 13×13 type-icon wrapper, `role="img"` with the type as its accessible name. It replaced the bundle's `.type-badge` 9px monospace pill, and the per-type *pill tints* (violet for `.suggest`, cobalt for `.comment`) went with it — the icon is `currentColor`, and the card's author tint carries the colour signal now.
- `.card-time` = 9px monospace at `--tandem-fg-faint`, right-aligned via `margin-left: auto`

**Anti-patterns:**
- **Do NOT use a left-border edge color** on any card — this is the
  load-bearing correction vs the older design. Background tint is the
  primary signal; the border is the standard 1px `var(--tandem-border)`
  all the way around.
- Do NOT move the tint back onto the card variants. It is keyed on
  `annotation.author` in exactly one place (`cardTint` in
  `AnnotationCard.svelte`) so that two variants sharing an author cannot
  disagree. An earlier revision of this list said the opposite; it
  predates the change.
- Do NOT change the protected tokens (`--tandem-author-user`,
  `--tandem-author-claude`, `--tandem-suggestion*`) without re-running
  `token-protection.test.ts`. The card chrome reads them through the
  audited values, not via local overrides.
- Do NOT show the author dot for `ImportedCard` — imported annotations
  came from a Word commentor, not a Claude/user author; the header
  byline replaces the dot. Imports do still get a tint of their own
  (`--tandem-author-import-bg`); "no dot" is about the dot only.
- Do NOT give the type icon a colour of its own. It is `currentColor`
  everywhere except the `highlight` fill, which carries the user's picked
  highlight colour. A second coloured element in the header competes with
  the author dot for the same signal.
- Do NOT add an `Accept` action to non-suggestion cards. The bundle's
  `card-actions` row is type-specific:
  - `note` → Send to Claude (neutral `.aca-btn--send` + coral destination disc), Archive (ghost)
  - `comment` → Resolve (primary), Edit (ghost), Delete (ghost)
  - `suggest` → Accept (primary), Dismiss (ghost), Edit (ghost)
  - `imported` → Promote (primary), Dismiss (ghost) (production-only)
  - `highlight` → no actions row at all

Visual rendering of all six taxonomy combinations in the bundle's actual
chrome: see `docs/design-system-impl/preview/annotation-edge-colors.html`
— OD picks it up from the watched directory.

## What this spec deliberately does NOT do

- It does not specify margin column geometry (Phase 3.5 needs an
  explicit design proposal per the plan).
- It does not thread motion through every surface; Phase 4 is the
  follow-up that handles full motion-language adoption.
- It does not enumerate per-state pixel measurements where the bundle's
  CSS already encodes them — the sub-PR reads the cited `app.css` line
  ranges directly.
