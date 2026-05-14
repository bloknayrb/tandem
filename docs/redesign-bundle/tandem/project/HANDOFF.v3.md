# Tandem — Engineering Handoff v3

**Date:** 2026-05-13
**Status:** Supersedes v2 (`HANDOFF.md`) for all items listed below. v2 is preserved verbatim for diffing. v1 (`HANDOFF.v1.md`) also preserved.
**Design file:** `Tandem Redesign v3.html` (6 sections, ~20 artboards across categories A–F)
**Contact:** bryan@anthropic — co-design lead

---

> **What changed since `HANDOFF.md` (v2)** — Three A-category artboards updated to reflect deliberate engineering divergences from the v2 design. Five B-category decisions locked (previously punted). Seven C-category surfaces designed for the first time (they shipped in v0.11.0 without artboards). Five D-category partial specs resolved. One E-category hazard remediated. Five F-category speculative artboards added for v0.12.0 pipeline work.

---

## A — Shipped differently than the design

### A1. Authorship visualization — character-level only, no paragraph gutter

**What changed:** The v2 handoff proposed a 2px paragraph-left gutter colored by `data-tandem-author` (dominant author per paragraph). Production shipped character-level only. The gutter artboard has been removed and replaced with a refined character-level treatment.

**Why:** Bryan and Claude alternate at the sentence level within a single paragraph. A dominant-author gutter hides co-authorship granularity — which is precisely what the product is selling.

**How (visual treatment):**
The shipped CSS (`editor.css:133`) uses `color: color-mix(in srgb, author-color 58%/64%, --fg)` — a text-color tint approach. This reads as dense in long passages. The proposed v3 refinement reduces the mix to **~28% (user) / ~32% (Claude)**, keeping the character-level pattern visible in aggregate without dominating the reading experience.

On hover, an author chip appears above the run: `Bryan · 2m ago` or `Claude · 4m ago`. This is the only affordance for reading exact authorship.

```css
/* v3 — refined character-level authorship */
[data-tandem-author="user"] {
  /* fallback for older WebView2 (Chromium <111) */
  color: rgba(68, 90, 160, 0.82);
  /* preferred */
  color: color-mix(in srgb, var(--tandem-author-user) 28%, var(--tandem-fg));
}
[data-tandem-author="claude"] {
  color: rgba(160, 88, 52, 0.82);
  color: color-mix(in srgb, var(--tandem-author-claude) 32%, var(--tandem-fg));
}
[data-tandem-author="user"]:hover {
  background: color-mix(in oklch, var(--tandem-author-user) 10%, transparent);
}
[data-tandem-author="claude"]:hover {
  background: color-mix(in oklch, var(--tandem-author-claude) 12%, transparent);
}
```

**Artboard:** `a1-authorship` — shows RFC-007 editor body with inter-leaved user/Claude runs. One run shown in simulated hover state with author chip visible.

**Updated sections in v2:** Removed §"Visual system → Authorship gutter". Updated §"CSS custom properties" with split color-mix values. Updated authorship decorator CSS in `styles.css`.

---

### A2. Selection mini-toolbar — two peers, not one strip

**What changed:** The v2 design proposed a single BubbleMenu-style strip with formatting controls + annotation creation together. Production shipped two separate surfaces: (1) a formatting bar (B/I/U/H1/H2/link) above the selection, (2) a separate audience-first popup (`data-testid="popup-annotation-input"`) for annotation creation below.

**Why:** Conflating text transformation and annotation creation into one strip made the audience decision ambient. The popup makes the audience question explicit and equal-weight — which is the whole thesis of the annotation redesign.

**How:**
Two surfaces, same selection event, separate components:

| Surface | Position | Contents | z-index |
|---|---|---|---|
| `BubbleMenu` (Tiptap) | above selection | B / I / S / H▾ / link / ··· | 51 |
| `ARSelectionPopup` | below selection | textarea + swatches + Note ⏎ + Comment ⌘⏎ | 52 |

When both are visible, popup z-index wins overlap. Popup suppresses when slash menu, find bar, or command palette is active (see D3). Formatting bar suppresses only when find bar has focus (find takes full keyboard).

**Artboard:** `a2-dual-surface` — both surfaces visible on the same selection with annotation callout badges ① and ②.

---

### A3. Custom titlebar — single strip, separate formatting bar

**What changed:** The v2 design proposed a merged `TopToolbar` containing brand + mode toggle + panel controls. Production shipped (PR #602) a separate `TitleBar.svelte` via `tauri-plugin-decorum` overlay titlebar, with all app chrome consolidated into one draggable strip. The secondary toolbar row is deleted.

**Why:** Tauri WebView hit-testing requires window controls to be siblings of the drag region, not descendants. Merging titlebar + toolbar broke drag affordance. The "all chrome in titlebar" pattern achieves the visual goal (one chrome strip) without the technical conflict.

**New structure:**

```
[TitleBar.svelte — 44px, -webkit-app-region: drag]
  [traffic lights] [brand] [doc-tabs...] [stretch] [mode-seg] [claude-dot] | [theme] [shortcuts] [settings] [win-controls]

[FormattingBar.svelte — 36px, separate, editor-focus-gated]
  [panel-toggles] | [undo/redo] | [H▾] | [B I S </>] | [lists blockquote] | [link code —] | [swatches] | [Comment Note]
```

**Tauri drag region:** The entire titlebar is `data-tauri-drag-region`. All interactive children (tabs, buttons, seg control) are `data-no-drag`. Doc tabs are the only tabbable elements inside the drag region; they must each carry `-webkit-app-region: no-drag`.

**Artboard:** `a3-titlebar` — full editor window with annotation callouts on the titlebar strip (①) and formatting bar (②).

**Updated artboards in v2:** `primary`, `dark`, `chat`, `solo`, `solo-rail`, `outline`, `empty`, `word`, `compact` — all now show the merged titlebar pattern in the v3 canvas.

---

## B — Design decisions locked

### B1. Density × textSize: two orthogonal axes ✓ CONFIRMED

**Decision: (a) — Density controls spacing only; textSize controls font-size.**

The v2 handoff §#4 identified this collision. Confirmed that the correct model is two orthogonal axes with no overlap. The existing `styles.css` already implements this correctly:

```css
/* density — spacing only, never writes --editor-size */
.app[data-density="compact"] { --s-3: 8px; --s-4: 12px; --s-5: 18px; }
.app[data-density="cozy"]    { --s-3: 10px; --s-4: 14px; --s-5: 20px; }
.app[data-density="spacious"] { --s-3: 14px; --s-4: 20px; --s-5: 28px; }

/* textSize — font-size only, never writes spacing vars */
/* --tandem-editor-font-size controlled separately */
```

Engineering must not introduce any cross-writes. The settings artboard shows two independent sliders/controls.

---

### B2. Layout swatch ↔ codebase setting: keep 3 swatches ✓ CONFIRMED

**Decision: (b) — Keep three swatches; `three` always pins right panel order.**

The three swatches (`tabbed-right`, `tabbed-left`, `three`) map to two codebase settings (`layout` + `panelOrder`). Rather than surface the full 2×2 grid (4 states), we keep three swatches and accept that `three` always sets `panelOrder: 'right'`. The `solo-rail` artboard already implies left/right rail toggle within `tabbed` layout — that interaction remains unchanged.

Mapping:

| Swatch | layout | panelOrder |
|---|---|---|
| `tabbed-right` | `tabbed` | `right` |
| `tabbed-left` | `tabbed` | `left` |
| `three` | `three-panel` | `right` (pinned) |

---

### B3. heldInSolo derivation — three transitions designed ✓

**Decisions:**

1. **Prior session held annotations:** Yes, the banner appears. `heldInSolo: true` annotations from a prior Solo session survive doc close (server-persisted since v0.11.0). On reopening the doc in Solo mode, the held banner re-fires with "from a prior Solo session" copy variant.

2. **Solo → Tandem transition:** Held annotations do **not** unhide instantly. A review surface appears first — "Surface now" (reveals all) or "Dismiss all" (clears queue). Prevents annotation-flood UX on mode switch.

3. **heldInSolo survival across sessions:** Yes — field is server-persisted. Only cleared on explicit "Dismiss all" action. Silent clearing on doc close would drop Claude's work.

**Filter chips in Solo rail:** Behave normally — they filter the held queue too.

**Artboard:** `b3-solo-held` — three banner states (new-held / prior-session / transition) plus the **review surface drawn in full**: the rail mock shows the per-item card with `Surface` / `Dismiss` / `Reveal in editor` actions, and a sticky bulk-action bar at the bottom. Confirm dialog required if queue > 5 items at "Dismiss all." `testid: held-review-surface`.

---

### B4. showAuthorship default flip — silent flip accepted ✓

**Decision: (b) — Accept the silent flip; remove the migration toast suggestion.**

The default flipped (`false` → `true`) in v0.11.0. No toast shipped. The feature is benign (authorship data was already being recorded; this only gates rendering). A toast would be noise. Removing the suggestion from the handoff.

**Removed from v2:** §"Settings panel → showAuthorship default" caveat about migration toast.

---

### B5. Diff view irreversibility — inline warning in bottom bar ✓

**Decision: Option A — inline warning text in the bottom bar.**

> "Apply creates a single undo step — individual hunks cannot be undone separately after confirmation."

This warning appears in the diff staging surface bottom bar, left of the Apply button. No modal confirmation required. The diff staging surface itself is the undo boundary — the warning communicates this before the user commits.

Option B (dashed amber border framing the whole surface as "staging") adds visual noise for a constraint that only matters at the moment of confirmation. Rejected.

**Artboard:** `b5-diff-irrev` — side-by-side comparison of Option A and Option B with decision summary.

---

## C — New surfaces

### C1. Changelog on upgrade

Distinct from regular read-only `.docx` review. Key differences:

- **Banner:** Version chip + "Read-only · opened automatically on first launch after upgrade · not saved to history" + **Got it** CTA (dismisses and closes the tab) + "Don't show again" ghost link.
- **Tab title:** `v0.11.1 Release Notes` (version string). Tab ext badge: `★` (distinct from `M` / `W`).
- **No annotation rail** — the rail is hidden (`data-rail="hidden"`). Changelog is a one-time read surface, not an annotation target.
- **No dirty dot** — `readOnly: true`, autosave skipped (PR #603).
- This is a temporary state — the "opened automatically" copy makes it clear the tab is not a permanent fixture.

**Artboard:** `c1-changelog`

---

### C2. Scratchpad (Ctrl+N / tandem_scratchpad)

Ephemeral in-memory document; never written to disk; synthetic `upload://` URI.

**Tab title:** `Scratchpad` with a dashed-circle clock icon replacing the file-ext badge (communicates ephemerality without a text label). No dirty dot (always "dirty" in intent, but the concept doesn't apply to an in-memory doc).

**Ephemeral notice bar:** A thin bar below the formatting bar carrying: `Ephemeral — not written to disk. Content is lost when the tab closes.` + **Save As… ⌘⇧S** ghost button + right-aligned `upload:// · in-memory · no path` monospace label.

**Save-as affordance:** Yes. The whole point of scratchpad is frictionless ephemeral drafting; Save As is the graduation path to a real file. No auto-save prompt on tab close — content is silently discarded per the product intent.

**Annotation rail:** Behaves normally (annotations are also in-memory; they discard with the tab).

**Filter chips:** No behavioral changes vs. regular documents.

**Artboard:** `c2-scratchpad`

---

### C3. Store-readonly banner

Two severity tiers:

| Severity | Condition | Dismiss | Actions |
|---|---|---|---|
| Warning | Disk full or permissions (recoverable) | Yes (dismissible, persists in localStorage) | Retry · Open Settings |
| Error | Store cannot open at all | No (persistent until resolved) | Retry · Open Settings · View logs |

**Placement:** Top of rail body, above annotation cards. Below held-in-Solo banner if both are active. `testid: store-readonly-banner` (matches shipped testid from closes #506).

**Body copy (warning):** "The annotation store is read-only (disk full or permissions). New annotations are buffered in memory."

**Body copy (error):** "The annotation store cannot be opened (permissions error). Your annotations exist in memory but will be lost on close."

**Artboard:** `c3-store-readonly`

---

### C4. Connection-degradation banner — complete 4-state sequence

The existing `conn-banner` artboard showed only the >30s offline state. Full sequence:

| State | Trigger | Copy | CTA | Severity |
|---|---|---|---|---|
| 1 · Offline >30s | sidecar unreachable >30s | "Claude offline — sidecar unreachable. Your edits are saved locally." | Retry now | Warning |
| 2 · Reconnecting | auto-retry active, countdown | "Reconnecting in 5s…" + spinner | Skip wait | Warning |
| 3 · Lost (manual) | auto-retries exhausted | "Connection lost — edits saved locally, not synced." | Retry | Error |
| 4 · Reconnected | connection restored | "Reconnected — Claude is back online." | × (dismiss) | Success (toast) |

State 4 is a **toast**, not a rail banner — appears top-right, auto-dismisses after 4s (see D4).

**Artboard:** `c4-conn-states` — 2×2 grid of all four states.

---

### C5. Settings dialog at <860px

**Pattern: hamburger collapses sidebar nav.**

At ≤640px (shipped breakpoint from closes #515), the dialog shifts to single-column. At 640px–860px, the dialog is still multi-column but the sidebar nav can be hidden via a hamburger button in the header.

- Hamburger button (three-line icon) in dialog header, left of title.
- When nav is open: full-height nav overlay replaces content area. Click any nav item to navigate and close nav.
- When nav is closed: content panel full-width. Dialog header shows current section name as breadcrumb.
- Dialog footer (Cancel / Save) always visible.

No horizontal nav pattern — the sidebar items don't fit horizontally at <860px widths without truncation.

**Artboard:** `c5-narrow-settings` — 560px dialog at narrow width, both nav-open and nav-closed states.

---

### C6. Reply thread — collapsed card state

The `thread` artboard covers the expanded state. Collapsed state:

- **Avatar stack:** Max 3 participant avatars, 16px diameter, 5px negative overlap, author-colored backgrounds. Order: most-recent responder first (left).
- **Reply count:** `{N} replies` or `1 reply` (singular). Full count, not capped.
- **Last-responder border:** Left border color = last responder's `--tandem-author-{user|claude}` color.
- **Time:** `lastReply.timestamp` formatted as `just now` (<60s), `{N}m ago`, `{N}h ago`, or date.
- **Expand affordance:** Chevron icon, right-aligned. Rotates 180° when expanded. Click anywhere on card to expand.

**Interaction:** Clicking collapsed card expands inline (same card grows). No navigation or modal. The expanded state is the existing `thread` artboard's card design.

`testid: thread-collapsed`

**Artboard:** `c6-thread-collapsed` — three examples (3 replies/Claude last, 1 reply/user last, expanded state) + interaction spec.

---

### C7. Document-level annotation summary

**Decision: Option A — StatusBar slot.**

A compact pill row in the status bar, peer of word count and held-count:

```
● Connected  ·  1,842 words  ·  [4 notes] [2 comments] [1 suggestion]  …  held: 3  ·  Bryan · Solo
```

Counts are filtered to the active annotation type filter when the rail is open. Zero-count types are hidden. Clicking a pill opens the rail filtered to that type.

Option B (rail header row above filter chips) is heavier — adds 32px to the rail header for a summary that's useful but not rail-specific. Rejected as secondary option.

**Artboard:** `c7-anno-summary` — both options shown with decision rationale.

---

## D — Partial specifications resolved

### D1. Imported (`author: "import"`) attribution chip

`AnnotationCard.svelte:54` currently labels imported annotations as just `"Imported"`. Full spec:

**Where the author name appears:** A `From:` byline directly below the card head row (not in the chip itself, not hover-only). Always visible when `importSource.author` exists.

**Where file provenance appears:** Monospace badge immediately right of the author name, using Word-blue token. `importSource.file` truncated to basename. Hidden when `importSource.file` is absent.

**Fallbacks:**

| importSource | Display |
|---|---|
| `{ author, file }` | `From: Sarah Chen · PRD-v2.docx` |
| `{ author }` only | `From: Sarah Chen` |
| absent | "Imported" chip only |

**Interactive?** No — the chip and byline are display-only. No filter-by-source-author. The `ar-import` batch-promote flow is the correct surface for source-author filtering.

**Artboard:** `d1-import-chip` — three card variants (full / author-only / no attribution).

---

### D2. Highlight palette legacy-key fallback

**Shipped (v0.11.0):** `red → pink`, `purple → blue` remapped in `sanitize.ts` on every read. Legacy keys are never written again. This is the correct and complete migration — no action required.

**Unknown key fallback:** Any color key not in `{yellow, green, blue, pink}` falls back to `yellow` at render time. Unknown keys that arrive from external imports (beyond the red/purple migration) are silently normalized.

**Picker:** Hard-cut to 4 colors. No legacy keys are selectable.

**Design tokens unchanged.** `--hl-yellow`, `--hl-green`, `--hl-blue`, `--hl-pink` are the canonical set.

**Artboard:** `d2-legacy-hl` — 6-swatch grid showing the 4 current colors and 2 legacy keys with migration arrows.

---

### D3. Mini-toolbar collision rules — transition spec

When the command palette, find bar, or slash menu opens over an active selection:

| Trigger | Mini-toolbar behavior | Reverse (on close) |
|---|---|---|
| Command palette (⌘K) | Fade to opacity 0 in **140ms** | Fade back in 140ms if selection still active |
| Find bar (⌘F) | Instant hide (find takes keyboard focus immediately) | Re-appear on find bar close if selection still active |
| Slash menu (/) | Instant hide | Re-appear when slash menu dismissed |

Never snap-replace — always crossfade or sequential. The selection highlight in the editor stays visible during all transitions (it's a ProseMirror decoration, not tied to the toolbar visibility).

**Artboard:** `d3-collision` — 3-frame sequence showing palette-opens-over-selection transition.

---

### D4. Toast notification placement and per-severity timing

**Position:** Top-right. `testid: toast-container`. `position: fixed; top: 16px; right: 16px`.

**Stacking:** Newest on top. Max 4 visible; overflow collapses to `+N more` badge on the oldest visible toast.

**Per-severity timing:**

| Severity | Auto-dismiss | Dismissible |
|---|---|---|
| Info | 3s | No |
| Success | 4s | No |
| Warning | 6s | Yes (× button) |
| Error | Persistent | Yes (× button) |

State 4 of the connection-degradation sequence (reconnected) uses Success severity → 4s auto-dismiss.

**Artboard:** `d4-toast` — all four severities + position diagram + stacking behavior.

---

### D5. Read-only info bar in side panel

**Decision: Keep both tab badge + rail info bar.**

They serve different user contexts:
- **Tab badge (`RO`):** Glanceable, always visible regardless of rail state. Answers "is this file editable?" at a glance.
- **Rail info bar:** Actionable, format-specific context. Answers "what does read-only mean for this file type?" Carries the "Apply Changes → Export copy…" affordance for DOCX review.

Dropping the info bar would lose the Apply Changes affordance from its expected location. Dropping the badge would make the RO state invisible when the rail is closed.

**Artboard:** `d5-ro-bar` — tab badge close-up + rail info bar close-up + decision rationale.

---

## E — Hazards discovered during build

### E1. Suggestion token contrast — WCAG AA split

The `--tandem-suggestion` (violet) and `--tandem-warning` tokens fail WCAG AA for text on white backgrounds:

| Token | Role | Contrast | WCAG AA |
|---|---|---|---|
| `--tandem-suggestion` (oklch 0.52 0.18 305) | Fill/border | 3.1:1 | ✗ Fail |
| `--tandem-warning` (oklch 0.62 0.16 65) | Fill/border | 3.4:1 | ✗ Fail |
| `--tandem-error` (oklch 0.55 0.18 25) | All uses | 4.5:1 | ✓ Pass |
| `--tandem-success` (oklch 0.55 0.14 150) | All uses | 4.6:1 | ✓ Pass |

**Action:** Add two new tokens to `styles.css`:

```css
--tandem-suggestion-fg-strong: oklch(0.35 0.22 305); /* 4.8:1 on suggestion-soft bg */
--tandem-warning-fg-strong: oklch(0.42 0.18 65);     /* 5.1:1 on warning-soft bg */
```

In annotation card text that uses suggestion or warning color (card labels, diff labels), switch from `--tandem-suggestion` / `--tandem-warning` to the `fg-strong` variant. Use the original tokens only for fills and borders.

Dark mode requires a separate audit (different luminance threshold). Not blocked on this handoff — track as follow-up.

**Artboard:** `e1-wcag` — 8-row token audit table, light theme only.

### E2. Tutorial annotation anchor co-ownership

PR #607 fixed two tutorial annotations that silently failed since March 2026 because `welcome.md` copy changed but `targetText` anchors didn't.

**Decision: (a) — Design owns welcome.md copy; engineering owns the anchors. Co-version them.**

Process: when welcome.md copy changes (design-initiated), a paired PR must update the `targetText` constants in `tutorial-annotations.ts`. Neither can change independently. The precision of "highlight this exact phrase" is worth the coordination cost.

This is a process decision, not a UI decision. No artboard needed.

### E3. CHANGELOG round-trip noise

PR #603 fixed the immediate user-visible symptom (CHANGELOG opened read-only). The underlying `remark-stringify` over-escape is tracked as #605 for v0.12.0.

**Design implication:** No user signal for "structurally fragile" documents is warranted for v0.12.0. The fix is engineering-side (configuring remark-stringify defaults). If the fix lands before v0.12.0 ships, no user-facing surface is needed. If it doesn't land, accept the noise as an internal artifact — users never see CHANGELOG raw markdown directly.

No artboard needed.

---

## F — Speculative artboards

All F-category artboards are marked with confidence labels. Do not block v0.12.0 planning on these.

### F1–F3. Document Groups (confidence: medium)

Three artboards in the v3 canvas:

**F1 — List view:** Left rail "Groups" mode. Collapsible group rows (folder icon + chevron + doc count). Ungrouped files section below. "New group" button in rail header. Works alongside the existing annotations/chat/outline rail tabs via a new "Groups" tab.

**F3 — Drag-to-add:** 3-state drag sequence. Ghost follows cursor. Group row highlights with accent border + `color-mix(in oklch, accent 10%, transparent)` background on hover. Drop adds file as last item in expanded group. Pulse animation on successful drop (scale 1 → 1.01 → 1, 200ms).

**F2 — Expanded group** is covered by F1's expanded row state.

**Open questions before building:**
- Where does the group name live on disk? (localStorage? sidecar? a `.tandem-groups.json` in the directory?)
- Does drag-to-add work from the tab bar (dragging a tab) or only from the groups rail?
- Can a document be in multiple groups?

### F4. Apply-edit diff — hunk staging interaction (confidence: medium)

The existing `diff` artboard shows the static state. F4 proposes the interaction:

**Keyboard model:** **No letter-key bindings** — the diff surface lives immediately adjacent to the editor and reflexive typing (Y/N/A/R) could mutate the staged set without the user realizing focus has shifted. Final mapping:

| Key | Action |
|---|---|
| `↑` / `↓` (or `J` / `K`) | Navigate between hunks |
| `↵` (Enter) | Accept focused hunk |
| `⌫` (Backspace) | Reject focused hunk |
| `⌘↵` | Apply all accepted hunks |
| `Esc` | Cancel — release focus, keep staging area open |

A **focus-trap pill** ("Keyboard captured · Esc to release") is shown in the header so the capture state is visible. Without that affordance, users hitting Enter to add a paragraph in the editor below would unknowingly accept a hunk.

**Partial-hunk selection:** Not proposed in this pass. Hunk granularity is the unit of staging. Sub-hunk selection introduces significant editor complexity for marginal UX gain.

**Interactive artboard:** F4 is a live React prototype — accept/reject buttons update state in real time. Demonstrates the interaction before engineering builds it.

### F5. Chat empty state (confidence: high)

First-time opening of the chat panel, or after clearing history.

**Elements:** Claude avatar (coral circle with icon) + "Claude is ready" heading + one-sentence guidance + 4 suggestion chips (pre-written prompts the user can tap to start). Suggestion chips are full-width, left-aligned text, ghost border.

**Suggestion copy (subject to revision):**
- "Summarize what we've written so far"
- "What's the strongest argument in this draft?"
- "Suggest a better opening paragraph"
- "Flag any claims that need a citation"

This is confidence: high — the pattern is well-established and the empty state is already a gap in the shipped product.

### F6. Outline panel — heading-level annotation creation (confidence: low)

Section-level note from the outline panel. A "+ Note" button appears on the active/hovered outline item. Tapping it creates a `note` (private) anchored to the heading's section span (heading start → next same-or-higher level heading).

**Blocker:** Section-level anchors require a new coordinate type server-side. The existing annotation schema uses flat text offsets for character-level ranges; heading-section ranges would need to be derived from document structure at annotation creation time and re-derived on each load (headings can be inserted/deleted). This is non-trivial. Confidence: low — do not design further until demand is confirmed.

---

## Constraints (unchanged from v2, reproduced for completeness)

- **BSL 1.1 license** shipped in v0.11.0. License row removed from About. Do not reintroduce.
- **Tauri WebView** is the primary form factor; design targets Chromium 119+. All `oklch(from var(...))` relative color syntax requires `color-mix()` fallbacks for older WebView2 on Windows 10.
- **CSS custom properties** must use `--tandem-*` prefix throughout. Bare `--bg`, `--surface`, `--ink` in the v2 design files are not acceptable in production — rename before porting to Svelte.
- **`data-tandem-author`** is the convention (not `data-author`, not `data-annotation-author`). Tiptap collab plugin compat.
- **`extractText()` flat-offset coordinates** are the canonical annotation coordinate system. Do not use ProseMirror positions or Yjs RelativePositions in persistence.
- **Source Serif 4 / Inter Tight / JetBrains Mono** font stack is settled.

---

## Files

| File | Purpose |
|---|---|
| `Tandem Redesign v3.html` | v3 entry point — 6 sections, ~20 artboards |
| `v3-chrome.jsx` | A1 / A2 / A3 artboard components |
| `v3-surfaces.jsx` | C1–C7 new surface components |
| `v3-specs.jsx` | B3 / B5 / D1–D5 / E1 spec components |
| `v3-speculative.jsx` | F1 / F3 / F4 / F5 / F6 speculative components |
| `Tandem Redesign.html` | v2 artboards — preserved verbatim |
| `HANDOFF.md` | v2 handoff — preserved verbatim |
| `HANDOFF.v1.md` | v1 handoff — preserved verbatim |
| `HANDOFF.v3.md` | This document |
| `styles.css` | Design tokens + base styles (shared v2/v3) |
| `app.jsx` | App shell components (shared) |
| `surfaces.jsx` | v2 surface components (shared) |
| `annotation-redesign.jsx` | Annotation system components (shared) |
| `settings.jsx` | Settings dialog (shared) |

---

## Phasing — v0.12.0 candidates

Based on this revision pass, the following items are design-ready for v0.12.0:

| Item | Type | Confidence |
|---|---|---|
| A1 — Refined authorship tint (28%/32%) | Design correction | High |
| C1 — Changelog upgrade surface | Artboard complete | High |
| C2 — Scratchpad artboard | Artboard complete | High |
| C3 — Store-readonly two-severity | Artboard complete | High |
| C4 — Connection banner 4 states | Artboard complete | High |
| C5 — Narrow settings (<860px) | Artboard complete | High |
| C6 — Thread collapsed card | Artboard complete | High |
| C7 — Annotation summary (StatusBar) | Decision: Option A | High |
| D4 — Toast placement + timing | Spec complete | High |
| E1 — WCAG fg-strong token split | CSS tokens ready | High |
| F5 — Chat empty state | Artboard complete | High |
| F4 — Diff hunk keyboard shortcuts | Speculative prototype | Medium |
| F1/F3 — Document Groups | Speculative artboards | Medium |
| F6 — Outline heading annotation | Speculative spec | Low |

---

Questions? bryan@anthropic — co-design lead.
