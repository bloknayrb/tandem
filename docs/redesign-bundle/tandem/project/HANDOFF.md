# Tandem — Engineering Handoff

A redesign exploration for Tandem, the Markdown editor where Claude is a co-author. This document hands off to engineering. **Read carefully — several callouts below correct fidelity gaps between the visual design and the production data model, and the annotation model has shifted materially since the v1 handoff.**

> **What changed since `HANDOFF.v1.md`** — the annotation taxonomy has been redesigned from a "3 types, 5 variants" model to an **audience-first** model (Note vs. Comment), the artboard set has roughly tripled (9 → ~28 across 6 sections), and several "future surfaces" from v1 (find/replace, command palette, shortcuts modal, connection banner) are now first-class artboards. v1 is preserved verbatim for diffing.

---

## What's in this artboard set

`Tandem Redesign.html` is a design canvas with **~28 artboards across 6 sections**:

| Section | Artboard | Purpose |
|---|---|---|
| Main editor | `primary` | Default editing — selection mini-toolbar visible, annotations rail right |
| Main editor | `dark` | Dark mode + panel-on-left, demonstrates Claude's authorship gutter |
| Workflow states | `chat` | Chat panel with text-anchor preview |
| Workflow states | `solo` | Solo mode (default) — rail **hidden**, status bar carries `held: 3` badge |
| Workflow states | `solo-rail` | Solo mode (opt-in) — rail open showing only user-authored items + held banner |
| Workflow states | `outline` | Outline panel — H1–H3 nav with annotation counts per heading |
| Workflow states | `empty` | Empty document with slash menu |
| Workflow states | `word` | `.docx` opened — paged sheets with drop shadow |
| Workflow states | `compact` | Compact density · `.docx` review with RO badge |
| Close-ups | `settings` | Full settings dialog (Appearance section visible) |
| Close-ups | `tools` | Selection toolbar + slash menu detail |
| Surfaces | `find` | Find/Replace overlay above editor — 7/47 matches |
| Surfaces | `diff` | Apply-edit split diff view — 2/3 hunks accepted |
| Surfaces | `palette` | Command palette (⌘K) — searchable actions, recents, results |
| Surfaces | `thread` | Expanded annotation thread — 4 replies, reactions, status |
| Surfaces | `onboarding` | First-run — model select, default mode, key shortcuts |
| Surfaces | `settings-network` | Settings → Network panel — sidecar config, retries, telemetry |
| Surfaces | `mobile` | Narrow-window / mobile — single column, sheet drawer |
| Annotation system | `ar-popup` | Selection popup — the audience choice IS the design |
| Annotation system | `ar-decorations` | Editor decorations — five visual languages, ranked by loudness |
| Annotation system | `ar-sidebar` | Sidebar cards — note → comment promotion chain |
| Annotation system | `ar-states` | Card states — five canonical variants + selection + resolved |
| Annotation system | `ar-import` | Word import — comments arrive as private notes, batch convert |
| Annotation system | `ar-tutorial` | Tutorial annotations — `welcome.md` teaches the vocabulary |
| Future surfaces | `conn-banner` | Connection-degradation banner · sidecar offline >30s |
| Future surfaces | `shortcuts` | Keyboard shortcuts modal · ⌘/ from titlebar |

The Tweaks panel (bottom-right) toggles theme/accent/panel layout/density/editor type/rail width/editor size live across every artboard.

## Visual system — what to lift

- **Type**: Source Serif 4 for prose, Inter Tight for chrome, JetBrains Mono for status / timestamps.
- **Color**: Tokens live in `styles.css` under `[data-theme]`. Authorship colors are `--author-user` (blue) and `--author-claude` (coral). The accent variable `--accent` drives all active states. Annotation-system overrides live in `annotation-redesign.css` (`.ar-*` namespace) — they are additive, not a fork.
- **Authorship gutter**: a per-paragraph 2px thread on the left, colored by `data-tandem-author`. The gutter shows the *dominant* author per paragraph; **the underlying highlight is character-level** — every run of text inherits its writer's color tint, and the gutter reduces that to a single dominant indicator at the paragraph level for legibility (full per-character coloring is too noisy in body copy). **Use this attribute, not `data-author`** — `data-author` collides with libraries like Tiptap's collaboration cursor extension.

---

## Annotation system — NEW MODEL (supersedes v1 §"Data model — DO NOT REGRESS")

The annotation redesign (`annotation-redesign.{jsx,css}`) replaces the type-first model with an **audience-first** model. The selection popup asks *"who is this for?"* with two equal-weight buttons — **Note to self ⏎** (private) vs. **Send to Claude ⌘⏎** (outbound). This is the central design move; the rest of the annotation system follows from it.

### The five visual languages, ranked by loudness

Editor decorations communicate audience and authorship before the user reads any words:

1. **Highlight** — colored fill (yellow/green/blue/pink). One-click path that bypasses the audience question.
2. **Note** — dotted underline in muted ink. Quietest. Personal. Claude does not act on it unless promoted.
3. **Your comment** — dashed blue underline (`--author-user`). Outbound, Claude is notified.
4. **Claude's comment** — dashed coral underline (`--author-claude`). Inbound, reply / accept / dismiss.
5. **Suggestion** — coral inline diff (strikethrough delete + inserted text).

These map to sidebar card edge colors: slate (note) / cobalt (your comment) / coral (Claude's comment or suggestion).

### Note → Comment promotion is a first-class action

A note's overflow menu has **Send to Claude**. On promote, the underlying record's audience changes from `private` to `outbound`; the gutter color shifts from slate to cobalt; Claude is notified. The `ar-sidebar` artboard shows the before/after diagram.

This is the primary Word-import flow: imported `.docx` comments arrive as **private notes** with `From: <author>` attribution, and the user batch-selects which to convert into comments to Claude. See `ar-import`.

### Updated data model

```ts
interface Annotation {
  id: string;
  author: 'user' | 'claude' | 'import';
  audience: 'private' | 'outbound';        // NEW — drives the visual language
  type: 'note' | 'comment' | 'highlight' | 'flag';  // 'note' is new; 'flag' retained for legacy/import
  range: { from: number; to: number };
  relRange?: { from: RelativePosition; to: RelativePosition };
  snippet: string;
  body?: string;
  resolved: boolean;
  createdAt: number;

  // Discriminators that produce visual variants:
  suggestedText?: string;        // → renders as a suggestion (inline diff in editor, diff card in rail)
  directedAt?: 'claude';         // → renders as a question card (legacy; consider folding into audience='outbound')

  // v0.9.0:
  heldInSolo?: boolean;          // see "Solo / Tandem mode" below
  promotedFrom?: 'note';         // breadcrumb when a note becomes a comment
  importSource?: { author: string; file: string };  // populated when author === 'import'
}
```

**Migration from v1's 3-type model.** The audience field replaces the implicit "directedAt === 'claude'" discriminator. New `'note'` type is split out from `'comment'` because the editor decoration and sidebar card are visually distinct enough that a discriminator-only approach was leaking abstraction. **Existing `comment` records with `directedAt === 'claude'` and no `audience` should be migrated to `audience: 'outbound'`; everything else defaults to `audience: 'private'` and is reclassified as a `note` only if the body has no `@claude` mention.**

### Annotation taxonomy table

| Visual language | `type` | `audience` | `author` | Notes |
|---|---|---|---|---|
| Highlight | `highlight` | `private` | `user` | Color stored on record |
| Note (yours) | `note` | `private` | `user` | Promotable to comment |
| Your comment | `comment` | `outbound` | `user` | Claude notified |
| Claude's comment / question | `comment` | `outbound` | `claude` | `directedAt: 'claude'` is now a no-op when author is Claude |
| Suggestion | `comment` | `outbound` | `claude` | `suggestedText` set |
| Imported note | `note` | `private` | `import` | `importSource` populated; user can batch-promote |
| Flag | `flag` | `private` | `user` | Retained for legacy; consider deprecating |

### Five canonical card states

`ar-states` shows: empty input · note · your comment (sent · awaiting) · Claude comment · suggestion (with diff) · resolved. Plus selection state (checkbox visible) for batch-convert flows.

### Tutorial annotations

`welcome.md` ships with seeded annotations of every kind so users learn the vocabulary in situ. See `ar-tutorial`. Engineering owns the seed file path; design owns the copy.

### Render path consolidation

In v1 the main editor's `<SideRail>` rendered a legacy `<AnnotationCard>` (3-type) while the annotation-system artboards rendered the new `AR*` cards. **They have been unified.** `<AnnotationCard>` in `app.jsx` is now a thin dispatcher that delegates to the same `AR*` components used in the close-ups. The rail's filter chips (All / Highlights / Notes / Comments / Suggestions) are wired to live filter state, with counts derived from the audience-first taxonomy. Engineering should mirror this dispatcher pattern in the Svelte port — one card-component-per-variant, one dispatcher that picks based on `audience`/`author`/`suggestedText`/`type`.

The pre-redesign card layout is preserved in `app.jsx` as `LegacyAnnotationCard` (no longer rendered in any artboard) for visual diffing during the migration.

### `author: 'import'` — not a boolean

Earlier mocks used `imported?: boolean` as a discriminator. Corrected: the codebase uses **`author: 'import'`** as a third value alongside `'user'` and `'claude'`. Render the imported chip + lock affordances by checking `author === 'import'`.

### `heldInSolo` — v0.9.0, derivation strategy open

The field is referenced for queuing in Solo mode. **It does not exist in the codebase type system today.** Slated for v0.9.0. The current Solo-mode hold mechanism is entirely **client-side and derived at render time** (`useModeGate` checks `author === 'claude' && status === 'pending'`). Whether `heldInSolo` becomes a persisted server-side field or remains a derived client value is an open implementation question. The design's usage is correct either way.

### Solo / Tandem mode

```ts
type Mode = 'solo' | 'tandem';
```

In Solo, Claude is paused. New annotations are queued (`heldInSolo: true`) but not surfaced in the rail until the user flips back to Tandem (or hits "Show all" on the held banner).

**Solo → rail visibility (decision):** by default in Solo the side rail is **hidden entirely** — Solo means "writer-mode, get the chrome out of the way." The held queue still needs to be visible somewhere, so:

- Status-bar shows a `held: N` badge with a click target that flips back to Tandem and surfaces the held banner.
- A `Tweaks → Solo behavior → keep rail visible` toggle lets users opt into the older behavior (rail visible, just no Claude chatter). The `solo` artboard shows the default; the `solo-rail` artboard shows the opt-in path.

### ProseMirror positions are client-only

Server-side annotation data uses **flat text offsets**. See `src/shared/positions/types.ts` for the canonical types. Implementing ProseMirror positions in the persistence layer would reintroduce coordinate-system bugs fixed in **#260** and **#377**.

### `.docx` review

Read-only. The original file is never overwritten — Apply Changes exports a copy with Word tracked-changes alongside the source.

---

## New surfaces — data model & state requirements

These surfaces did not exist in v1. Each has implementation implications beyond visuals.

### Find / Replace (`find` artboard)

Overlay docked above the editor scroll area; does NOT take over the toolbar.

- State: `{ query, replacement, matches: Range[], activeIndex, options: { caseSensitive, wholeWord, regex } }`
- Hotkey ⌘F to open, ⌘G / ⇧⌘G to step through, Esc to close. Replacement is a **second row** that expands on ⌘⌥F.
- Match highlights live on a separate decoration layer from annotations so they don't visually compete. Active match gets the accent color.
- Suppress the selection mini-toolbar while the find bar has focus.

### Command palette (`palette` artboard, ⌘K)

Modal centered over the editor, ~640px wide. Sections: **Recent**, **Actions**, **Documents**, **Annotations**.

- Search index covers: every menu action, every open document, every annotation snippet.
- Annotation results jump-to-and-select the range. Document results open the doc.
- Up/Down to navigate, Enter to invoke, Esc to dismiss.
- Empty state surfaces 5 most-recent commands. Recents persist in localStorage.

### Apply edit / split diff (`diff` artboard)

Modal-ish surface that takes over the editor area when the user hits **Apply** on a Claude suggestion that spans multiple hunks.

- Hunks are individually accept/reject-able with a header showing `2/3 accepted`.
- Bottom bar: **Apply selected (2)** / **Apply all** / **Cancel**.
- Hunks are not committed to the document until the user confirms — the diff view is a staging surface.

### Outline (`outline` artboard, sidebar mode)

Lives in the side rail as a third mode (`SideRail mode="outline"`), peer of `annotations` and `chat`.

- Renders H1–H3 with annotation counts per heading.
- Click a heading to scroll the editor; the outline tracks scroll position with a subtle indicator.
- Counts are **filtered by the rail's annotation filters** when both are active — i.e. if filtering to "Comments" the heading counts show comments only.

### Mobile / narrow-window (`mobile` artboard)

Single-column at viewport widths below ~720px (final breakpoint TBD).

- Toolbar collapses to: brand · doc name · overflow `⋯`.
- Tabs become a horizontal scroller.
- Side rail becomes a **bottom sheet drawer**, summoned from a docked button.
- Selection mini-toolbar gets a slightly larger hit area (44px min).

### Onboarding (`onboarding` artboard)

First-run modal — three decisions: model selection, default mode (Solo / Tandem), and a "you should know these shortcuts" block. All three are also reachable post-run from Settings.

### Network settings panel (`settings-network` artboard)

New section in Settings — peer of Editor, Appearance, etc. Covers:

- Sidecar bind mode (`stdio` | `http`)
- Retry policy (max retries, backoff)
- Telemetry opt-in
- Token rotation status (read-only timestamp; rotate via CLI as before)

---

## Settings panel — production wiring notes

Mocks display values inline; production must read them dynamically. Anything marked `dyn` in the About panel is a placeholder.

| Field | Note |
|---|---|
| **Bind mode** | Only `stdio` and `http`. **No named-pipe transport** — design previously listed it; corrected. |
| **Rotate token** | The CLI command is real (`src/cli/rotate-token.ts`). In Tauri desktop the button is **disabled** because token rotation requires the HTTP bridge (not yet available). Show "run `tandem rotate-token` from CLI" tooltip. |
| **Selection dwell default** | **1000 ms** per `SELECTION_DWELL_DEFAULT_MS`. The original mock used 180 ms — corrected. Lower values cause Claude to react to nearly every accidental selection. |
| **MCP tools available** | Read live from server. `31` shown in mock as a placeholder; do not hardcode. |
| **Engine string** (`claude-sonnet-4.5 · MCP 0.7.2`) | Read live from running server. |
| **Storage path** | Platform-dependent. Resolve at runtime: <br/> · macOS `~/Library/Application Support/tandem/sessions/` <br/> · Linux `~/.local/share/tandem/sessions/` <br/> · Windows `%LOCALAPPDATA%\tandem\Data\sessions\` |
| **Token rotated timestamp** | Read actual timestamp from disk; do not hardcode. |
| **License row** | Removed. There is **no licensing tier**. |

### `showAuthorship` default — accepted, with a caveat

The design defaults `showAuthorship` to **`true`**; the codebase defaults to `false`. Engineering will flip the codebase default to match. **Caveat for upgrade:** the plugin has been recording authorship ranges unconditionally since installation (visibility only gates rendering). Flipping to `true` on upgrade will expose every existing user's full edit history. Accepted, but worth a one-time migration toast ("Authorship is now visible — toggle in Settings → Editor").

### Highlight color palette — migration decision required

- **Codebase**: yellow / red / green / blue / purple (5 colors; stored by name as keys on annotation records)
- **Design**: yellow / green / blue / pink (4 colors)

Moving to the design's 4-color set means existing annotations stored under `red` and `purple` keys need a migration. **Engineering must pick one** before any palette change ships:

| Strategy | Behavior |
|---|---|
| **Remap** | `red → pink`, `purple → blue`. Preserves intent best; recommended default. |
| **Fallback** | Unknown keys fall back to `yellow`. Safe but loses signal for existing users. |
| **Hold both** | Keep red/purple as legacy keys, render with closest design swatch, hide from picker. Most conservative. |

Default recommendation in this design: **Remap** (`red → pink`, `purple → blue`).

---

## Known incompatibilities & future work

1. **`data-author` rename in flight.** Existing builds use `data-author`. Rename to `data-tandem-author` before shipping — required for Tiptap collab plugin compat. Mechanical change, no logic.
2. **All CSS custom properties must use `--tandem-*` prefix.** This design uses bare `--bg`, `--surface`, `--ink` etc. They will collide with user content styles when rendered inside the editor. Rename before shipping. The `.ar-*` rules in `annotation-redesign.css` are already namespaced and safe.
3. **`oklch(from var(...) l c h)` relative color syntax** in the held-banner and imported-chip requires **Chromium 119+**. Provide `color-mix()` fallbacks for older WebView2 versions on Windows 10.
4. **Density × textSize collision.** The design has both a density setting (compact/cozy/spacious) and a textSize setting (s/m/l), and both write font-size CSS variables. Implementation must resolve: either density controls spacing only, or it subsumes textSize.
5. **Layout-swatch mapping is not 1:1.** The three layout swatches (`tabbed-right`, `tabbed-left`, `three`) map to **two orthogonal codebase settings**: `layout: 'tabbed' | 'three-panel'` and `panelOrder` (which side). Don't translate the swatch enum directly.
6. **Selection mini-toolbar collides with slash menu, find bar, and palette.** Suppress mini-toolbar while any of: a slash query is active, find bar has focus, command palette is open.
7. **Recent files menu reads disk on every hover.** Cache for 30s, invalidate on save.
8. **Settings dialog is single-column at <860px.** Add a hamburger fallback or make nav horizontal. The `mobile` artboard does not yet design Settings at narrow widths — punt to follow-up.
9. **Imported (`.docx`) annotations need a "Reveal in Word" arrow.** Punted until docx round-trip is settled. The new note-import flow (batch promote) supersedes the old "imported chip + lock" treatment for inbound comments — but the lock affordance is still right for when the user is in a read-only `.docx` and hasn't promoted anything yet.
10. **Authorship decoration selectors must use `data-tandem-author`** attribute selectors (e.g. `[data-tandem-author="user"]`, `[data-tandem-author="claude"]`), not class selectors. The CSS in `styles.css` already does this — preserve when porting to Svelte.
11. **Editor width minimum 40%** applies as `max-width` on the editor flex child *after* panels are subtracted, not on the full viewport. At 40% on a narrow viewport with two panels, the readable column can drop to ~270px. Accepted; document in the settings tooltip.
12. **Find-match decoration layer must paint below annotation decorations** but above text selection. Stacking order is: text → selection → find-matches → annotation underlines/highlights → cursor.
13. **Command palette annotation index** can be expensive on large docs. Index lazily on first ⌘K invocation; invalidate on annotation create/delete; debounce on body edits.
14. **Diff view is not undoable.** Once the user confirms Apply, the resulting edit lands as a single editor transaction. The diff staging surface is the undo boundary. Accepted.

## Phasing — what ships when

This design covers settings and surfaces that span three releases. Data-model fields land first, the Svelte UI follows, and the audience-first annotation rework ships as a coordinated server-side schema migration + client release.

| Release | Scope |
|---|---|
| **v0.9.0** | Data-model fields: `accentHue`, `editorFont`, `density`, `defaultMode`, `highContrast`, `annotationPatterns`, `selectionToolbar`, `heldInSolo`. New layout variant: `tabbed-left` (own render branch). New server endpoint: `GET /api/info` (powers the About panel). |
| **v0.10.0** | Svelte UI for all 8 settings + redesigned About panel reading from `/api/info`. Find/replace, command palette, outline panel mode, shortcuts modal — none of these need server changes. |
| **v0.11.0** | Audience-first annotation redesign (server schema migration, client UI rewrite, `welcome.md` tutorial seeding, Word-import batch-promote flow). Coordinated release because the schema migration is irreversible without backup. |

The `three` layout swatch must pin a specific `panelOrder` in its mapping so all users land on the same arrangement when they pick it (no "depends on previous state" surprises).

---

## States NOT YET DESIGNED — must not regress

These exist in the codebase. The design does not show them. Treat as **out of scope for this redesign**, but engineering must preserve the existing behavior and styling until follow-up work lands.

- **Review-mode summary panel** (annotation counts by type/status). The outline panel covers heading-level counts; document-level summary is still missing.
- **Toast notification placement and styling** (auto-dismiss, per-severity timing).
- **Reply thread display in compact card mode.** The `thread` artboard covers the expanded state; the collapsed state on the card itself is not redesigned.
- **Read-only info bar** in the side panel — design has the RO tab badge but no info bar; codebase has both.
- **Settings at mobile widths** — `mobile` artboard does not include the Settings dialog.

## Resolved from v1 — no longer "future work"

The following items in `HANDOFF.v1.md` were called out as future surfaces and are now first-class artboards. Reference for clarity:

- ~~Connection-degradation banner~~ → `conn-banner`
- ~~Empty states~~ → `empty` (document); chat empty state still TBD
- ~~Onboarding tutorial flow~~ → `onboarding` + `ar-tutorial`
- ~~Keyboard shortcuts modal~~ → `shortcuts`
- ~~Recent files menu~~ → in `app.jsx` `<DocTabs>`
- ~~Dirty-tab dot~~ → in `app.jsx` `<DocTabs>` (`dirty` prop)
- ~~Claude-thinking row in chat~~ → `chat` artboard

## Things explicitly NOT designed (and why)

To prevent scope creep, we deliberately did not design:

- **Document Groups (roadmap 7b)** — deferred until demand. Designing now would force premature decisions about group naming, persistence, and split-view layout.
- **Multi-user collaboration** — explicitly v1 scope boundary. Cursor stacking, presence colors, and conflict resolution all change shape.
- **PWA, .xlsx/.csv, freeform annotation** — v2+ surfaces.
- **MCP tool consolidation (#259)** — internal API change, no surface impact.
- **Frameless window vibrancy / multi-window / file explorer sidebar** — listed as deferred pending identity decisions. The frameless titlebar in this design is the floor; further OS-chrome work happens after v1.

---

## Files

- `Tandem Redesign.html` — entry point
- `app.jsx` — toolbar, tabs, editor body, side rail (annotations / chat / outline modes), status bar, sample data
- `surfaces.jsx` — Find/Replace, Diff, Command Palette, Thread, Onboarding, Network settings, Mobile
- `surfaces.css` — styles for the above
- `annotation-redesign.jsx` — audience-first annotation system (popup, cards, sidebar, import, tutorial)
- `annotation-redesign.css` — `.ar-*` namespaced styles for the annotation system
- `settings.jsx` — full settings dialog
- `settings.css` — settings dialog styles
- `design-canvas.jsx` — pan/zoom canvas wrapper (provided)
- `tweaks-panel.jsx` — live tweaks (provided)
- `icons.jsx` — inline SVG icon set
- `styles.css` — design tokens + component styles
- `HANDOFF.v1.md` — previous handoff, preserved for diffing

## Questions?

bryan@anthropic — co-design lead.
