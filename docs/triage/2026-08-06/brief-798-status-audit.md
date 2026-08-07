# #798 status audit — motion scenes A1–A29

**Issues:** #798 (GA-gating), #964, #832   **Decision needed:** GA gates on the *shipped* subset —
close #798 with A6b and A16b written off as documented exemptions, and A17 already carried by #964 —
yes or no?

## Method

Two independent sources, cross-checked: the scene matrix in `docs/design-system-impl/motion.md:116-190`
(committed in #956), and the actual `src/client` tree plus `git log --grep=798`. Every commit cited
below was verified on `origin/master` with `git merge-base --is-ancestor`. The matrix's "Production
status" column records the *pre-Phase-4* state (ADD = motion did not exist yet), so it is the scope
list, not the progress list — the progress evidence is the commits and the code.

The DoD checklist at `motion.md:347-356` is **stale**: six of its eight boxes are unchecked, and the
work behind three of them demonstrably shipped. Do not read it as status.

## Scene table

| Scene | Shipped? | Evidence | GA-required? |
|---|---|---|---|
| A1 accept | yes | `c142ed3` (A4/A10/A1 rail cluster) | — |
| A2 save pip | yes | `4cdda29` | — |
| A3 | RETIRED | matrix:A3 (superseded by A27) | no |
| A4 arrival | yes | `c142ed3`, `078a0b6` (editor gutter ping) | — |
| A5 Claude gutter/caret | yes | `f5b3c5f` | — |
| A6a anchor pulse | yes | `e87c1e9` (`.tandem-annotation-active`, `editor.css:259`) | — |
| **A6b rail SVG connector** | **no** | zero connector code outside margin leaders (`marginLeaderGeometry.ts`) | **no — exempt** |
| A7 (full popup) | RETIRED | matrix:A7 — dwell-gate principle absorbed into A28 | no |
| A8 mode toggle | yes | `1e42293`, `f34a69f` | — |
| A9 connection bloom (REPLACE) | yes | `67ee424` | — |
| A10 dismiss | yes | `c142ed3` | — |
| A11 palette | yes | `7b8a2cb` | — |
| A12 rail collapse | yes | `f34a69f` (A8·A12 hover-reveal float); `PeekStrip.svelte` ships | — |
| A13 reply disclosure (REPLACE) | yes | `c62fd83` | — |
| A14 activity rows | yes | as-built; matrix marks SHIPPED; `ActivityTray.svelte` | — |
| A15 sliding-thumb filter (REPLACE) | yes | `964b6c2` (`ChipGroup.svelte`) | — |
| A16a swatch pulse | DROPPED | matrix:A16 — picker auto-closes, pulse never visible | no |
| **A16b highlight L→R wash** | **no** | zero `wash` / `background-size` hits in `src/client` | **no — exempt** |
| A17 streaming words | no | matrix:A17 — no substrate; deferred to **#964** | no — separate issue |
| A18 find hop | yes | `e87c1e9` (`.tandem-find-active`, `editor.css:206`) | — |
| A19, A21 | RETIRED | matrix (2026-05-31 / 2026-05-28) | no |
| A20 slash menu | yes | `e87c1e9` (`index.html:357`) | — |
| A22 stepper | yes | `5f32e08` | — |
| A23 activity morph | yes | `896ee44` | — |
| A24 batch bar / A25 bulk | yes | `5f32e08` | — |
| A26 annotate morph | yes | `a6a5f9b`, `c2e2f53` | — |
| A27 fly-to-margin | yes | `c3b738c` | — |
| A28 popup entrance | yes | `c2e2f53` | — |
| A29 new-tab morph | yes | `f833ef0` (`NewTabMenu.svelte`) | — |
| s3 tab close | yes | `1ff45fb` | — |
| C4 settle leader | yes | `3b20fee` (`marginLeaderGeometry.ts`) | — |

Foundations shipped too: `--tandem-ease-out` / `--tandem-ease-standard` at `index.html:279-280`, and
the dual-mechanism reduced-motion guard (`body.tandem-reduce-motion`, 51 references across
`src/client` + `index.html`).

**Count: of 29 scenes plus s3 — 5 retired/dropped (A3, A7-full, A19, A21, A16a), 1 deferred to its
own issue (A17), 2 partial scene-halves outstanding (A6b, A16b). Everything else ships.**

## Does GA need all of them?

No. The two outstanding items are the two the canon doc itself flags as least load-bearing:

- **A6b** is the doc's own "most complex" scene (`motion.md:304`+, runtime SVG positioned via
  `getBoundingClientRect()` against `#root`). Its *purpose* — showing the card↔text link — already
  ships twice over: A6a's anchor pulse on card click, and the margin-view leader lines (C4). A third
  mechanism would be redundant chrome with a live-layout coordinate problem attached.
- **A16b** is a decorative wash on an interaction whose sibling half (A16a) was already dropped
  because the picker closes before the animation could be seen.

#798's own Definition of Done permits this: *"Every animated production surface either consumes a
motion scene **or has a documented exemption** in `motion.md`."* A6b and A16b are exemption-shaped,
not backlog-shaped. #832 (PeekStrip content pips) is a content feature, not a motion scene.

## Recommendation

Close #798 for GA on the shipped subset. Concretely: write the A6b and A16b exemptions into
`motion.md` with the reasoning above, tick the DoD boxes that are actually satisfied, confirm A17's
handoff to #964 is the last cross-reference, and close. The GA-required subset is "everything except
A6b, A16b, A17" — and that subset is already on master.

## If yes / If no

**If yes:** one docs-only PR to `docs/design-system-impl/motion.md` (two exemption paragraphs +
DoD checkbox reconciliation + a note that the matrix's status column is pre-Phase-4), then close #798.
No `src/` changes, no release needed. #964 stays open on its own merits.

**If no:** A6b is a genuine implementation project — a runtime SVG connector tracking two moving DOM
nodes across scroll, rail resize, and margin/rail mode switches, with its own reduced-motion story —
plus A16b's wash. Both would need design review before code, and a GA gate would then sit on the two
lowest-value scenes in the language.
