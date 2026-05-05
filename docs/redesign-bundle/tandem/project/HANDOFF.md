# Tandem — Engineering Handoff

A redesign exploration for Tandem, the Markdown editor where Claude is a co-author. This document hands off to engineering. **Read carefully — several callouts below correct fidelity gaps between the visual design and the production data model.**

## What's in this artboard set

`Tandem Redesign.html` is a design-canvas with **9 artboards** across 3 sections:

| Section | Artboard | Purpose |
|---|---|---|
| Main editor | `primary` | Default editing — selection mini-toolbar visible, annotations rail right |
| Main editor | `dark` | Dark mode + panel-on-left, demonstrates Claude's authorship gutter |
| Workflow states | `review` | Review mode — non-annotated text dimmed, accept/dismiss banner |
| Workflow states | `chat` | Chat panel with text-anchor preview |
| Workflow states | `solo` | **Solo mode** — Claude paused, held-annotations banner shows queue |
| Workflow states | `empty` | Empty document with slash menu |
| Workflow states | `compact` | Compact density · `.docx` review with RO badge + Apply changes |
| Close-ups | `settings` | Full settings dialog (8 sections, including About) |
| Close-ups | `tools` | Selection toolbar + slash menu detail |
| Close-ups | `cards` | Annotation card variants |

The Tweaks panel (bottom-right) toggles theme/accent/panel layout/density/editor type live across every artboard.

## Visual system — what to lift

- **Type**: Source Serif 4 for prose, Inter Tight for chrome, JetBrains Mono for status / timestamps.
- **Color**: Tokens live in `styles.css` under `[data-theme]`. Authorship colors are `--author-user` (blue) and `--author-claude` (coral). The accent variable `--accent` drives all active states.
- **Authorship gutter**: a per-paragraph 2px thread on the left, colored by `data-tandem-author`. The gutter shows the *dominant* author per paragraph; **the underlying highlight is character-level** — every run of text inherits its writer's color tint, and the gutter reduces that to a single dominant indicator at the paragraph level for legibility (full per-character coloring is too noisy in body copy). **Use this attribute, not `data-author`** — `data-author` collides with libraries like Tiptap's collaboration cursor extension.

---

## Data model — DO NOT REGRESS

These are the canonical types. The mocks above intentionally render multiple visual variants from a smaller real type set. **Do not "fix" the design back to a 5-type model — the simplification was intentional (#381, #382).**

### Annotation positions

```ts
interface Annotation {
  id: string;
  author: 'user' | 'claude' | 'import';   // 'import' is the third author enum value — NOT a separate boolean
  type: 'comment' | 'flag' | 'highlight'; // 3 types only — see below
  range: { from: number; to: number };    // flat text offsets (server coords, includes heading prefixes)
  relRange?: { from: RelativePosition; to: RelativePosition };  // CRDT-anchored, survive concurrent edits
  snippet: string;
  body?: string;
  resolved: boolean;
  createdAt: number;

  // Discriminator fields on the `comment` type produce visual variants:
  suggestedText?: string;       // → renders as a "suggestion" card with diff
  directedAt?: 'claude';        // → renders as a "question" card

  // v0.9.0 (open question — see note below):
  heldInSolo?: boolean;
}
```

**⚠️ ProseMirror positions are client-only.** Server-side annotation data uses **flat text offsets**. See `src/shared/positions/types.ts` for the canonical types. Implementing ProseMirror positions in the persistence layer would reintroduce coordinate-system bugs fixed in **#260** and **#377**.

### Annotation taxonomy — 3 types, 5 visual variants

The codebase uses **3 types**, not 5. The renderer derives visual variant from discriminator fields:

| Visual variant | Underlying type | Discriminator |
|---|---|---|
| Suggestion | `comment` | `suggestedText` is set |
| Question | `comment` | `directedAt === 'claude'` |
| Comment | `comment` | (neither) |
| Flag | `flag` | — |
| Highlight | `highlight` | — |

The data model **must not be changed**. Render 5 visual cards from the 3-type model.

### `author: 'import'` — not a boolean

Earlier mocks used `imported?: boolean` as a discriminator. Corrected: the codebase uses **`author: 'import'`** as a third value alongside `'user'` and `'claude'`. Render the imported chip + lock affordances by checking `author === 'import'`.

### `heldInSolo` — v0.9.0, derivation strategy open

The field is referenced on `AnnotationBase` for queuing in Solo mode. **It does not exist in the codebase type system today.** Slated for v0.9.0. Note: the current Solo-mode hold mechanism is entirely **client-side and derived at render time** (`useModeGate` checks `author === 'claude' && status === 'pending'`). Whether `heldInSolo` becomes a persisted server-side field or remains a derived client value is an open implementation question. The design's usage is correct either way — the renderer can read either the persisted field or the derived value.

### Solo / Tandem mode

```ts
type Mode = 'solo' | 'tandem';
```

In Solo, Claude is paused. New annotations are queued (`heldInSolo: true`) but not surfaced in the rail until the user flips back to Tandem (or hits "Show all" on the held banner).

**Solo → rail visibility (decision):** by default in Solo the side rail is **hidden entirely** — Solo means "writer-mode, get the chrome out of the way." The held queue still needs to be visible somewhere, so:
- Status-bar shows a `held: N` badge with a click target that flips back to Tandem and surfaces the held banner.
- A `Tweaks → Solo behavior → keep rail visible` toggle lets users opt into the older behavior (rail visible, just no Claude chatter). The `solo-rail-hidden` artboard shows the default; the existing `solo` artboard shows the opt-in path.

### `.docx` review

Read-only. The original file is never overwritten — Apply Changes exports a copy with Word tracked-changes alongside the source.

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
2. **All CSS custom properties must use `--tandem-*` prefix.** This design uses bare `--bg`, `--surface`, `--ink` etc. They will collide with user content styles when rendered inside the editor. Rename before shipping.
3. **`oklch(from var(...) l c h)` relative color syntax** in the held-banner and imported-chip requires **Chromium 119+**. Provide `color-mix()` fallbacks for older WebView2 versions on Windows 10.
4. **Density × textSize collision.** The design has both a density setting (compact/cozy/spacious) and a textSize setting (s/m/l), and both write font-size CSS variables. Implementation must resolve: either density controls spacing only, or it subsumes textSize.
5. **Layout-swatch mapping is not 1:1.** The three layout swatches (`tabbed-right`, `tabbed-left`, `three`) map to **two orthogonal codebase settings**: `layout: 'tabbed' | 'three-panel'` and `panelOrder` (which side). Don't translate the swatch enum directly.
6. **Held annotations need a status-bar counter.** The held-banner only appears in the rail today. When the rail is hidden, the user has no visibility into the held queue. Surface a count next to the Solo/Tandem toggle in the toolbar.
7. **Selection mini-toolbar collides with slash menu** if both could be open. Suppress mini-toolbar while a slash query is active.
8. **Recent files menu reads disk on every hover.** Cache for 30s, invalidate on save.
9. **Settings dialog is single-column at <860px.** Add a hamburger fallback or make nav horizontal.
10. **Imported (`.docx`) annotations need a "Reveal in Word" arrow.** Punted until docx round-trip is settled.
11. **Authorship decoration selectors must use `data-tandem-author`** attribute selectors (e.g. `[data-tandem-author="user"]`, `[data-tandem-author="claude"]`), not class selectors. The CSS in `styles.css` already does this — preserve when porting to Svelte.
12. **Editor width minimum 40%** applies as `max-width` on the editor flex child *after* panels are subtracted, not on the full viewport. At 40% on a narrow viewport with two panels, the readable column can drop to ~270px. Accepted; document in the settings tooltip.

## Phasing — what ships when

This design covers settings and surfaces that span two releases. The data-model fields land first, the Svelte UI follows.

| Release | Scope |
|---|---|
| **v0.9.0** | Data-model fields: `accentHue`, `editorFont`, `density`, `defaultMode`, `highContrast`, `annotationPatterns`, `selectionToolbar`, `heldInSolo`. New layout variant: `tabbed-left` (own render branch, parallel to `tabbed-right`). New server endpoint: `GET /api/info` (powers the About panel). |
| **v0.10.0+** | Svelte UI for all 8 new settings + the redesigned About panel reading from `/api/info`. |

The `three` layout swatch must pin a specific `panelOrder` in its mapping so all users land on the same arrangement when they pick it (no "depends on previous state" surprises).

---

## States NOT YET DESIGNED — must not regress

These exist in the codebase. The design does not show them. Treat as **out of scope for this redesign**, but engineering must preserve the existing behavior and styling until follow-up work lands.

- **Connection-degradation banner** (shows after 30s disconnect — distinct from the StatusBar dot)
- **Empty states** for: no annotations, no chat messages, no documents open
- **Review-mode summary panel** (annotation counts by type/status)
- **Onboarding tutorial flow** (4–5 step overlay on `sample/welcome.md`)
- **Toast notification placement and styling** (auto-dismiss, per-severity timing)
- **Reply thread display** in annotation cards (existing replies, not just the input)
- **Toolbar held-count badge** — design moves the counter into SideRail only. **Confirm**: is the toolbar badge intentionally removed? See incompatibility #6.
- **Read-only info bar** in the side panel — design has the RO tab badge but no info bar; codebase has both.

---

## Future-proofing — design surfaces reserved for roadmap items

These are surfaces where the design has either reserved space, scaffolded a stub, or made a deliberate decision so engineering doesn't have to invent placement when picking up an issue. **When you start one of these issues, this is the canonical placement** — no need to reopen the design discussion.

### Mapped to open issues

| Issue | Where it lands in this design |
|---|---|
| **#435** Show app version in UI | About panel header (`v0.8.0-rc.4` line) and Settings footer (`.settings-version`). Already wired to display whatever string the build provides. |
| **#437** "View Changelog" button | Settings footer next to version. Same row as Bug report and About. |
| **#440** `heldInSolo` field | Solo-mode held-annotations banner in SideRail; chip on cards rendered when `heldInSolo === true`. See "Solo / Tandem mode" above for the persisted-vs-derived open question. |
| **#441** `/api/info` endpoint | Powers the About panel. Every value marked with the `dyn` pill or `.setting-dyn` class reads from this endpoint at runtime. Schema needed: `{ engine, mcpVersion, toolsCount, storagePath, tokenRotatedAt, version, channel }`. |
| **#442** Settings data-model fields | All 8 fields (`accentHue`, `editorFont`, `density`, `defaultMode`, `highContrast`, `annotationPatterns`, `selectionToolbar`, `heldInSolo`) have UI in `settings.jsx`. Land the data model in v0.9.0; UI ports to Svelte in v0.10.0+. |
| **#443** `data-tandem-author` attribute selectors | All authorship CSS in `styles.css` already targets `[data-tandem-author=...]`. Mechanical attribute swap on the editor side. |
| **#444** Editor width minimum 40% | Slider `min=40` in `settings.jsx`; HANDOFF #12 documents the column-width math at narrow viewports. |
| **#445** `tabbed-left` layout variant | Third swatch in the layout picker. Maps to `layout: 'tabbed', panelOrder: 'left'`. The "three" swatch must pin a specific `panelOrder` so the choice is deterministic (HANDOFF #5). |

### Anticipated surfaces (no issue yet — file when picked up)

These are gaps in the codebase the design covers preemptively. They came out of the UX-opportunities review and are worth filing as issues if not already on the backlog.

| Surface | Where in this design | UX-opps ref |
|---|---|---|
| **Dirty-tab dot** | `.tab .dirty` element in `app.jsx` `<DocTabs>`; CSS in `styles.css`. Single 6px warning-colored dot when `dirty=true`. | §5 — "no unsaved-changes indicator" |
| **Claude-thinking row in chat** | `.chat-typing` row in `<ChatPanel>` — three-dot animation under a Claude byline. Shows whenever the chat client knows Claude has accepted but not yet responded. | §4 — "no typing indicator" |
| **Keyboard shortcuts modal** | `<ShortcutsModal>` in `app.jsx`, opened from the `?` button in the titlebar trailing edge. Bind to ⌘/. Four groups: Editing, Annotations, Review, App. | §1 — "keyboard shortcuts are hidden" |
| **Connection-degradation banner** | `.conn-banner` inside `<EditorBody>` when `connection === 'degraded'`. Inline banner, not a modal — non-blocking. Includes "Retry now" affordance. Trigger after 30s offline (matches the existing distinct-from-StatusBar behavior). | §8 — "vague connection errors" |
| **Recent files menu** | Already present: hover the `+` in DocTabs → recent menu drops down. Reads from localStorage with 30s cache (HANDOFF #8). | §5 — "no recent files" |
| **Word comments → Tandem annotations** | Imported chip + lock affordance via `author === 'import'`. Roadmap marks #85 done — the visual treatment is here when the engineering side surfaces them. | §7 — ".docx workflow" |

### Things explicitly NOT designed (and why)

To prevent scope creep, we deliberately did not design:

- **Document Groups (roadmap 7b)** — deferred until demand. Designing now would force premature decisions about group naming, persistence, and split-view layout.
- **Multi-user collaboration** — explicitly v1 scope boundary. Cursor stacking, presence colors, and conflict resolution all change shape.
- **PWA, .xlsx/.csv, freeform annotation** — v2+ surfaces.
- **MCP tool consolidation (#259)** — internal API change, no surface impact.
- **Frameless window vibrancy / multi-window / file explorer sidebar** — listed as deferred pending identity decisions. The frameless titlebar in this design is the floor; further OS-chrome work happens after v1.

---

## Files

- `Tandem Redesign.html` — entry point
- `app.jsx` — toolbar, tabs, editor body, side rail, status bar, sample data
- `settings.jsx` — full settings dialog
- `design-canvas.jsx` — pan/zoom canvas wrapper (provided)
- `tweaks-panel.jsx` — live tweaks (provided)
- `icons.jsx` — inline SVG icon set
- `styles.css` — design tokens + component styles
- `settings.css` — settings dialog styles

## Questions?

bryan@anthropic — co-design lead.
