# Tandem — Motion Language (Phase 4 / #798 canon)

> **What this is.** The canonical, repo-resident specification for threading the
> Tandem design-system motion language across production surfaces. This is the
> work tracked by [issue #798](https://github.com/bloknayrb/tandem/issues/798)
> and gated by **Conflict #9** in
> [`conflicts-resolved.md`](conflicts-resolved.md) (animation deferred to Phase 4;
> Phases 1–3 sub-PRs shipped *static* visuals only and must not introduce new
> choreography).
>
> **Provenance.** Ported and adapted from the Claude Design handoff bundle's
> `project/MOTION.md` (re-export dated 2026-05-31). The bundle is a design-side
> prototype (`ui_kits/app`, `animations/anims.css`, `animations/scenes/*.svelte`,
> `Motion Wiring - *.html` specimens) and is **not committed** to this repo. This
> document is the committed source of truth and is **self-contained** — you do not
> need the bundle to implement against it. Where the bundle's `MOTION.md` says a
> scene is "✅ Wired," that refers to the *prototype*, not `src/client`. This doc's
> status column reflects the **real `src/client` repo** as of `master` (verified
> against the branch this doc landed on).

---

## Release gate — SATISFIED (verified against current master)

#798 prerequisite 3: motion thread-through should not begin until the
design-system re-skin's CHANGELOG entries have **shipped in a release**, so motion
lands in a clean version block rather than on top of an in-flight re-skin.

State as of this doc landing (`CHANGELOG.md` on current `master`, `package.json`
`0.13.5`):

- The **Phase 1 umbrella re-skin** (sub-PRs 1.1–1.13: TitleBar, FormatBar, Editor
  body + outline rail, peek strip, AnnotationCard, CommandPalette, Settings,
  StatusBar, NewTabMenu, ActivityCenter, SlashMenu, Decorations control, Selection
  surface) **shipped in `[0.13.0]`**.
- The **Phase 3 cluster re-skin** (clusters 3.1, 3.2, 3.3, 3.4, 3.6, 3.7, 3.8, 3.9,
  3.10, 3.11, R side-rail collapse, W0, annotation-selection QA, empty states)
  **shipped in `[0.13.5]`** — all under that version's `### Changed`.

**Both re-skin phases have shipped in releases. The gate is met; motion-code
sub-PRs are unblocked.** The current `[Unreleased]` block is unrelated *post*-re-skin
feature work (inline images #153, session-management UI, agent-agnostic display,
settings-migration hardening) — not design-system motion's concern. Motion entries
landing alongside that feature work in `[Unreleased]` is normal CHANGELOG operation;
the specific risk the gate guards against (interleaving motion into an *in-flight
re-skin* block) no longer exists.

> **Correction history:** an earlier read of this gate (off the stale umbrella-merge
> HEAD `c87d8aa`, before the `v0.13.5` cut) concluded the Phase-3 re-skin was still
> unreleased and a release needed cutting first. That was wrong — `master` had
> already shipped `v0.13.5` with the full Phase-3 cluster. No release cut is needed.

---

## Easing tokens

Two curves carry the entire vocabulary. They do **not** exist in the repo yet —
`index.html` defines 314 `--tandem-*` custom properties but zero easing tokens and
zero `@keyframes`. The foundations sub-PR adds them to `index.html`'s `:root`
(the same block that owns every other `--tandem-*` token), so they theme-compose
with the rest of the system.

| Token | Curve | Use |
|---|---|---|
| `--tandem-ease-out` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | All entrance/exit. Fast into position, soft settle. **Primary** easing for the Tandem vocabulary — the default for any new transition. |
| `--tandem-ease-standard` | `cubic-bezier(0.4, 0.0, 0.2, 1)` | Material-style standard curve. Reserved for longer layout transitions; used by the A16 highlight wash. Defined alongside `--tandem-ease-out`. |

> **Naming note.** The bundle calls these `--ease-out` / `--ease-standard`. In the
> repo they take the `--tandem-` prefix to match the existing token namespace and
> to keep the semantic-token CI gate (`scripts/check-semantic-tokens.ts`) coherent.
> Reference them as `var(--tandem-ease-out)`.

---

## Foundations: where shared motion lives (the coexistence question)

The foundations sub-PR is **not** a blank-slate install — production already ships
incidental, component-local motion that the canon must compose with or replace,
not clobber:

- `StatusBar.svelte` ships `@keyframes tandem-reconnect-pulse`,
  `tandem-status-pulse`, and `tandem-claude-working-pulse` inline. The **A9 bloom
  state machine replaces these** (see canon decision 4).
- `CommandPalette.svelte` ships only an ~80 ms row-background transition. **A11
  adds** scale-in + cascade on top (no conflict).
- The 10 client files with existing `prefers-reduced-motion` blocks
  (`ApplyChangesButton`, `CollapsibleSection`, `tandem-banner.css`,
  `editor/editor.css`, `AnnotationCard`, `AnnotationCardActions`, `PeekStrip`,
  `SidePanel`, `StatusBar`, plus the `reduceMotion` setting in
  `hooks/useTandemSettings.ts`) already honor reduced motion for what they animate.
  New per-surface motion must extend these, not introduce an unguarded animation.

**The inert-and-shared core of foundations** is the two easing tokens + the
dual-mechanism reduced-motion scaffold. Both are genuinely global, theme-composing,
and consumed by every later sub-PR — they belong in `index.html`'s `:root`/global
stylesheet. Foundations wires nothing into a surface and carries zero interaction
risk.

**Open decision for the foundations plan — keyframe placement.** Whether to port
*all* `@keyframes` into the global layer upfront, or add each scene's keyframes in
the sub-PR that threads it, is a deliberate call to settle when planning
foundations:

- *Global-upfront* is simplest to reference but leaves dead CSS until each
  threading PR consumes it, and forces foundations to remember to **skip the
  retired scenes' keyframes** (A7, A19, A21 have no production consumer).
- *Per-surface* keeps each keyframe co-located with its only consumer and avoids
  dead CSS, at the cost of no single catalogue.

Either way: component-local keyframes that a canon scene *replaces* (the three
`StatusBar` pulses) are removed in the sub-PR that lands the replacement — never in
foundations.

---

## Scene inventory (A1–A29)

Each scene maps to a production surface. The **Production status** column reflects
the real `src/client` repo, not the design prototype. Classification:

- **ADD** — production ships the static surface; this scene adds motion that does
  not exist today.
- **REPLACE** — production ships a *different* interaction; this scene supersedes
  it (a design decision, not pure wiring — see canon decisions).
- **MATCHES** — production already does the right thing; no change.
- **RETIRED** — scene dropped from the language; no production consumer.

Durations/easing are the locked spec values. `--ease-out` below means
`var(--tandem-ease-out)`.

| # | Scene | Production target | Key spec | Production status |
|---|---|---|---|---|
| A1 | Accept suggestion — del block collapses, add settles into prose, success flash | `SuggestionCard` / annotation accept | del `200ms`; flash `380ms`; press `200ms` (all `--ease-out`) | **ADD** — static accept ships; motion new |
| A2 | Save pip — unsaved dot → check → fade out, sharing the tab's trailing close-× slot | `unsaved-indicator-{id}` pip on the tab | dot-out `140ms`; check-in `140ms +60ms`; scale `200ms` | **ADD** — pip state ships; morph new |
| A3 | ⛔ "Sent to Claude" status-pill toast | — | — | **RETIRED** — superseded by A27 (fly-to-margin) + inline note-popover feedback + D1 toasts. No status-pill consumer. |
| A4 | New annotation arrives — gutter ping + ring ripple + card slot-in | annotation rail incoming card | ping `260ms`; ring `700ms`; card `220–280ms +200ms` | **ADD** — arrival is instant today |
| A5 | Claude is editing — paragraph gutter breathing pulse + ghost caret blink (looping ambient) | `authorship.ts` block gutter decoration (`data-tandem-author-block`) | gutter `2s ease-in-out ∞`; caret `900ms ease-in-out ∞` | **ADD** — no thinking-state motion today |
| A6 | Card ↔ text link — rail-card click flashes anchored text + dashed connector | editor text ↔ `AnnotationCard` focus sync | anchor pulse `1.2s`; card lift `140ms`; link `1.2s` | **ADD** (most complex — runtime SVG connector; see impl guide) |
| A7 | Selection-toolbar reveal (pre-1.11 compact toolbar) | selection mini-toolbar | dwell gate `360ms`; scale `0.92→1` + rise | **RETIRED for the full popup** — superseded by A28; A7's *dwell-gate principle* is retained inside A28. (Retirement candidate as a standalone scene.) |
| A8 | Solo ↔ Tandem toggle — segmented thumb slides, annotation rail reveals/hides | `ModeToggle` + `SidePanel` reveal | thumb `220ms`; doc width `220ms`; rail width `220ms` + opacity `180ms +60ms` | **ADD** — toggle ships; thumb-slide + rail reveal deferred to #798 (per CHANGELOG 3.9) |
| A9 | MCP connection state machine — offline→reconnecting→connected | `StatusBar` connection dot | pulse `900ms ease-in-out ∞`; bloom `500ms --ease-out` | **REPLACE** — see canon decision 4 |
| A10 | Dismiss annotation — card slides right + fades; cards below translate up | `AnnotationCard` dismiss/resolve | exit `240ms`; collapse `280ms +120ms`; reflow `280ms +120ms` | **ADD** — dismiss is instant today |
| A11 | Command palette open — scrim fade, modal scale-up, rows cascade, ⌘K hint floats out | `CommandPalette` overlay+modal | scrim `200ms +200ms`; modal `260ms +280ms`; rows `180ms` 60ms stagger | **ADD** — only an 80ms row-bg transition ships |
| A12 | Side rail → peek strip — width collapses while content fades out / pips fade in | `SidePanel` + `PeekStrip` (always-mounted dual-layer shell) | collapse `480ms cubic-bezier(0.4,0,0.6,1)`; expand `380ms`; pips `180ms` | **ADD** — shell ships always-mounted; "collapse is a snap; width-slide + crossfade deferred to #798" (CHANGELOG R) |
| A13 | Reply thread — chevron rotate + max-height unfold + cascade | `ReplyThread.svelte` / `AnnotationCard` | arrow `220ms +200ms`; unfold `380ms +200ms`; replies `220ms` 120ms stagger | **REPLACE** — see canon decision 3 |
| A14 | Toast appears, pushes the stack up, swipes right to dismiss; progress bar | Activity tray `.toast-row` | in `280ms`; stack-up `240ms`; out `280ms ease-in`; progress `2400ms linear` | **ADD/verify** — confirm whether prod `ActivityTray` already ships `rowIn`/`rowOut`; align to canon if so, else add |
| A15 | Rail filter — icon-gated chip bar, sliding thumb, non-matching rows collapse out | `FilterBar.svelte` | bar unfold `260ms`; pill slide `240ms`; card collapse `280ms`; pip bump `280ms` | **REPLACE** — see canon decision 5 |
| A16 | Highlight wash — selected swatch pulses, color washes L→R across selection | highlight color picker → A8 popup annotate row | swatch `240ms`; wash `540ms --ease-standard` (background-size 0→100%) | **A16a swatch-pulse DROPPED** (2026-06-01) — the picker auto-closes on select (`handleColorSelect` sets `showColorPicker=false`), so the pulse is never visible; A16b L→R wash remains in the morph family (coordinate-adjacent) |
| A17 | Claude streams a reply — words fade in at cursor, coral caret blinks | `authorship.ts` streaming decoration | word `60ms`; caret `700ms ease-in-out ∞` | **DEFERRED → #964** (2026-06-01) — no substrate: replies go through ChatPanel, not the Tiptap editor; no word-by-word insertion path. Gated on a streaming-insertion feature, out of Phase 4 scope |
| A18 | Find — all matches lit, active match's coral outline hops between hits | find/replace bar (`B4`) | outline `160ms`; background `160ms` | **ADD** |
| A19 | ⛔ Selection-popup no-dwell pop | — | — | **RETIRED** (2026-05-31) — redundant with A28 entrance + A26 morph |
| A20 | Typing `/` shows a caret chip; block picker drops in; rows cascade | slash menu (`B3`) | chip `200ms`; menu `240ms +520ms`; rows `180ms` 60ms stagger | **ADD** |
| A21 | ⛔ Connection banner slide | — | — | **RETIRED** (2026-05-28) — banner surface dissolved; connection state moved to the A9 status pill |
| A22 | Onboarding stepper — progress line extends, next dot pops, panels cross-fade | onboarding tutorial (`D7`) | fill `280ms`; dot `200ms` scale 1.08; panel cross `220ms` | **ADD** |
| A23 | Activity pill — idle→info→warning→error LED state machine; pill *is* the tray (single-shell two-phase morph) | Activity tray `.activity-shell` | P1 width/radius `340ms`; P2 max-height `540ms +340ms`; row cascade `420ms` staggered; LED `1.4–1.6s ∞` | **ADD/verify** — single-shell morph; confirm prod `ActivityTray` shape, then wire the morph |
| A24 | Batch promote bar rises from rail bottom; persists; slides down on clear/send | `BatchPromoteBar.svelte` | enter `280ms`; exit `200ms cubic-bezier(.4,0,.2,1)`; spinner `700ms ∞`; hold LED `1.4s ∞` | **ADD** — implement as a class-toggled *transition*, not a re-firing animation |
| A25 | Bulk mode — checkboxes cascade onto cards (40ms stagger), toolbar slides up; exit snappy | `BulkActions.svelte` | cascade `220ms` 40ms stagger; toolbar `280ms`; exit `180ms` no stagger | **ADD** |
| A26 | Annotate button → note popover, two-stage single-shell morph (widen → unfurl) | selection popover (`editor/toolbar/`) | P1 width+radius+translate `340ms`; P2 height `440ms` sequenced; reverses on close | **ADD** — use CSS transitions on `width`/`border-radius`/`height` (Phase 2 = delayed `max-height`), **not** a JS rAF loop |
| A27 | Annotation fly-to-margin — on submit, card launches from popover footprint into its margin slot | A8 submit → `MarginColumn.svelte` left/right | fly `480ms` (FLIP translate+scale, opacity ramps); underline `220ms` | **ADD** for the motion — two-margin layout already ships; the side split is the fixed C3 lock in `panels/marginSides.ts`: **LEFT = private notes** (`type === "note"`), **RIGHT = outbound comments + imported Word comments** (`author === "import" || type === "comment"`). Imports render **RIGHT from arrival** (by `author`), not left-until-promoted; highlights are inline (neither side) |
| A28 | Selection-popup entrance — origin-anchored unroll + unfurl + cascade | A8 popup (`popup-format-row` + `popup-annotate-row`) | dwell `360ms`; lead-row unroll `360ms`; cascade `200ms` staggered; trail row `320ms +170ms`; selection deepen `240ms` | **ADD** — **supersedes A7**; unroll = animate `width` + `overflow:hidden`, **never `clip-path`** (clips box-shadow) |
| A29 | New-tab menu morph — `+` tab button *is* the menu, single-shell two-stage | `NewTabPopover` + `.pop-anchor` | P1 width+radius `340ms`; P2 height `440ms +P1dur`; rows cascade `200ms` 60ms stagger | **ADD** — replaces the old 160ms `popIn` scale. **Homonym:** A29 is *surface* A7's morph, distinct from *motion-scene* A7 |
| — (s3) | Tab close — active tab fades + collapses, adjacent tabs reflow | `DocumentTabs.svelte` close | CSS lives only in the bundle's Svelte scene | **ADD** — extract the CSS from the scene before porting |

---

## Five canon decisions Phase 4 must adopt

These were locked by the design lane (2026-05-31, reconciled against
`bloknayrb/tandem@master`) and **re-verified here against current `master`**. Four
of the five *replace shipped behavior/interaction* — they are design-change PRs
that need design review, kept off the mechanical-threading lane. Decision 2 is
already satisfied.

1. **C4 leader shape → "settle."** A horizontal-tangent cubic (k = 0.62), adopted
   in `marginLeaderGeometry.ts` — chosen over **both** an old straight `<line>`
   **and** production's existing `bezierLeaderPath`. *Verified:*
   `src/client/panels/marginLeaderGeometry.ts` ships `bezierLeaderPath` today;
   "settle" replaces that path geometry. **REPLACE (geometry).**
2. **C4 leader tint → by author.** `leaderColorForAuthor`: Claude coral / user
   cobalt / import neutral `--tandem-fg-subtle`. *Verified:* the same file already
   exports `leaderColorForAuthor` and tints by author. **MATCHES — no change.**
3. **A13 reply → disclosure model.** "N replies" → chevron-rotate + max-height
   unfold + 120 ms cascade, in `ReplyThread.svelte`. *Verified:* `ReplyThread.svelte`
   renders an **inline** thread today (`isReplying` / `replyText` state + an inline
   textarea form, not a collapsed disclosure). The disclosure model **replaces** the
   inline thread. **REPLACE.**
4. **A9 connection → bloom state machine.** offline→reconnecting→connected: red
   static → amber ring-pulse → green bloom → coral engaged-pulse, in
   `StatusBar.svelte`. *Verified:* `StatusBar.svelte` ships `tandem-reconnect-pulse`
   + `tandem-status-pulse` + a separate three-dot `tandem-claude-working-pulse`
   today. The bloom state machine **replaces** the ad-hoc pulses (the
   `claude-working` presence pulse is a separate concern — reconcile, don't
   silently drop). **REPLACE.**
5. **A15 filter → sliding-thumb chip bar.** Icon-gated chip bar + count pip-bump in
   `FilterBar.svelte`; extra axes (author/status) fold in as further chip rows.
   *Verified:* `FilterBar.svelte` ships three `FilterSelect` **dropdowns** today (4
   refs). The chip bar **replaces** the dropdowns. **REPLACE.**

---

## Surface-entrance principles (locked with A28)

How an **anchored** surface (selection/cursor/trigger-anchored popup, toolbar, or
menu) arrives. These compose with the single-shell morph backlog below.

1. **Originate at the anchor.** A surface pointing at a selection/cursor enters
   *from* that point. `transform-origin` and every vertical translate **flip with
   the surface's above/below position**, so motion grows *away* from the text,
   never toward it. Read the same above/below decision the positioner already makes.
2. **Dwell before reveal.** Selection-triggered surfaces wait the user's
   `dwellTime` (~360 ms default) before appearing. Reuse
   `animation-delay: calc(dwellTime * 1ms)` so entrance and gate stay in sync.
3. **Tie the tool to the text.** The selection highlight **deepens** as the surface
   arrives (accent 22→32 % + a bottom underline) and holds while active. Entrance
   is a reciprocal cue, not a one-way reveal.
4. **Lead with the nearest part.** In a multi-row/part surface, the part closest to
   the anchor leads; the rest unfurl away in sequence with a stagger. Never animate
   all parts uniformly when one edge is anchored.
5. **Unroll = `width` + `overflow:hidden`, never `clip-path`.** Growing a pill open
   animates its `width` with `overflow:hidden` so the capsule *and its drop-shadow*
   stay intact and contents reveal L→R. `clip-path` clips the box-shadow into a
   hard edge — do not use it on shadowed chrome.
6. **Compose, don't invent.** A28 is literally A26-ph1 (width unroll) + A26-ph2
   (height unfurl) + the control cascade + the dwell/deepen. Recombine the
   established vocabulary over authoring new motion — keeps easing (`--ease-out`)
   uniform.
7. **Production uses CSS transitions, not JS tweens.** The bundle's in-canvas
   prototypes interpolate by hand off `performance.now()` only because the
   Claude-preview env doesn't advance the CSS-transition / WAAPI clock. Production
   Svelte must use plain CSS transitions (Phase 2 via a delayed `max-height`).

---

## Single-shell morph — candidate consumers (Phase 4 backlog)

Reach for the **A23 / A26 single-shell two-stage morph** (a small persistent
trigger expands *in place* into a panel sharing its anchor — width+radius, then
height+content; reverses phase order on close) **only when the panel is anchored to
the control that opens it.** Centered / scrim surfaces use **A11** (scale-from-
center) instead.

**Tier 1 — true trigger → anchored-panel morphs** (full two-stage):

| Surface | Trigger → panel |
|---|---|
| **A29** New-tab menu | `+` tab button → new-tab popover (spec'd; `NewTabPopover` impl pending) |
| **A4-pill** Status pill | status pill → connection/detail panel (pill grows upward, stays as the bottom edge/handle) |
| **Brand menu** | Tandem icon → brand-menu popover (there is **no gear button**; Settings is an item *inside* the brand menu — the Settings *modal* stays a centered A11 modal) |
| **B4** Find & Replace | find icon → find field (P1) → unfurl Replace row + toggles + scope pills (P2) |

**Tier 2 — Phase-2-only (height unfurl)**, reuse the `max-height` mechanics +
`--ease-out`: **F8** collapsible section (chevron-rotate only today), **A13/C9**
reply & comment thread expand, **C12** annotation inline edit form, **E8** "Add
model" inline form.

**Explicit non-fits (do not morph):** centered modals (D6, D8, D9, F1, F2, E1 →
**A11**); C7/C8 batch & bulk bars (own slide-ups, **A24/A25**).

**Throughline:** anchored to its trigger → morph; centered/scrim → A11.

---

## `prefers-reduced-motion` policy

Apply **per-surface**, not via a single global override (the global
`animation/transition-duration: 0.001ms !important` is too blunt for surfaces with
functional state feedback). Honor **both** the OS `prefers-reduced-motion: reduce`
media query **and** the in-app `reduceMotion` setting (`body.tandem-reduce-motion`)
— the dual-mechanism pattern already used in clusters 3.10 / 3.8.

| Surface category | Reduced-motion rule |
|---|---|
| **Looping / ambient** (A5 gutter pulse, A9 dot pulse, A17 caret) | Remove animation entirely — show the static final state |
| **State feedback** (A2 save tick, A9 connect bloom) | Shorten to `0.001ms` — the state change still registers visually |
| **Entry/exit** (A4 arrival, A10 dismiss, A8 rail reveal, A11/A28/A29 entrances) | Jump to the final state; avoid `display:none` flicker — set end values (`opacity:1` / final `max-height`) directly |
| **Tab close** (s3) | Collapse immediately, no slide |

---

## Implementation guide & sequencing

**Lane discipline:** keep the four REPLACE canon decisions (A9, A13, A15, C4-shape)
off the mechanical-threading lane. They change shipped interaction and need design
review; the pure-ADD threading (A4, A10, A1, A11, A2, A5, A8, A12, A16…) can move
faster.

Recommended order (each is a direct-to-master sub-PR; the release gate above is
already satisfied, so code is unblocked):

1. **Foundations** (zero interaction risk, unblocks everything): add
   `--tandem-ease-out` / `--tandem-ease-standard` to `index.html`'s `:root` and
   scaffold the dual-mechanism reduced-motion helper. Keyframe placement
   (global-upfront vs per-surface) is the open decision noted above — settle it in
   the foundations plan. Wires nothing into a surface.
2. **Pure-ADD threading**, surface by surface, each reading its keyframes from
   foundations: A4 arrival, A10 dismiss, A1 accept, A11 palette, A2 save pip, A12
   rail collapse, A8 mode toggle, A5 thinking gutter, A16 highlight wash, A18 find,
   A20 slash menu, A22 stepper, A24 batch bar, A25 bulk, s3 tab close.
3. **REPLACE canon decisions** (design-review gated, one PR each): C4 settle
   geometry, A13 reply disclosure, A9 connection bloom, A15 sliding-thumb filter.
4. **Complex / morph family** (likely last, larger restructures): A6 runtime SVG
   connector, A26 annotate→popover morph, A27 fly-to-margin, A28 entrance, A29
   new-tab morph, A23 activity-pill morph.

**Per-scene notes:**

- **A6 (card↔text link)** is the most complex — a runtime SVG connector positioned
  absolutely between the editor DOM node and the rail card. Coordinate system:
  `getBoundingClientRect()` relative to `#root`.
- **A7 dwell sync** — the entrance delay must read `dwellTime` from settings
  (`1s` default, user-adjustable) via `animation-delay: calc(dwellTime * 1ms)`, so
  the reveal stays in sync with the existing selection dwell-gate.
- **A24 / A25 / A23 / A26 / A28 / A29** — use class-toggled CSS **transitions**
  with persistent DOM identity, never re-firing `animation`s (re-renders restart
  animations and flicker). Phase-2 unfurl = a delayed `max-height` transition.
- **A23 / A26 / A28 / A29 unroll** — animate `width` + `overflow:hidden`, never
  `clip-path` (clips the drop-shadow into a hard edge).

---

## Definition of done (#798)

- [x] This canon doc lands in the repo (`docs/design-system-impl/motion.md`) — was
  the missing prerequisite the issue named.
- [ ] #798 rescoped from its stale 9-scene framing to the A1–A29 reality.
- [x] Release gate met — Phase-1 re-skin shipped in `v0.13.0`, Phase-3 cluster
  re-skin shipped in `v0.13.5`. No release cut needed; motion code is unblocked.
- [ ] Foundations sub-PR (easing tokens + keyframes + reduced-motion scaffold).
- [ ] Per-surface threading sub-PRs (pure-ADD).
- [ ] Canon-decision sub-PRs (A9, A13, A15, C4-shape — design-review gated).
- [ ] Morph-family + A6 connector sub-PRs.
- [ ] v1.0 GA gate: motion language coherent across all surfaces.
