# Tandem Redesign — Gap & Conflict Review

Design source: [Claude Design handoff bundle](https://api.anthropic.com/v1/design/h/YkiJv2qQa82QG0GHUxce-g?open_file=Tandem+Redesign.html) (9 artboards, 3 JSX components, full CSS token system, chat transcript, HANDOFF.md)

## Context

The design package proposes a comprehensive visual and UX redesign of the Tandem editor. This review identifies every gap, oversight, and future conflict between the design and the existing v0.8.0 codebase, organized by decision urgency rather than category. The goal is to ensure nothing gets lost or silently regressed during implementation.

---

## 1. Blocks Integration (would cause bugs or regressions if built as-specified)

### 1a. HANDOFF.md declares wrong position type

**Design says:** `anchor: { from: number; to: number } // ProseMirror positions`
**Codebase uses:** flat text offsets (including heading prefixes) in `range: DocumentRange` + optional CRDT-anchored `relRange: RelativeRange` (both from `src/shared/positions/types.ts`)

Implementing from HANDOFF.md verbatim would reintroduce the exact class of coordinate-system bugs that #260 and #377 just fixed. The annotation interface also omits `relRange` entirely, which is the primary survival mechanism for edits.

**Action:** Replace the `anchor` definition in HANDOFF.md with `range: DocumentRange` + `relRange?: RelativeRange` from `src/shared/positions/types.ts:44-53`. Add a warning that ProseMirror positions are client-only and must never appear in server-side annotation data.

### 1b. Annotation type taxonomy regression

**Design models 5 first-class types:** `suggest`, `question`, `flag`, `comment`, `highlight`
**Codebase uses 3 types (v0.8.0):** `highlight`, `comment`, `flag` — where `comment` with `suggestedText` = suggestion, `comment` with `directedAt: "claude"` = question

This is the biggest conceptual conflict. The v0.8.0 simplification (#381, #382) was intentional: `suggest` and `question` are just `comment` with discriminator fields, validated by Zod schemas in `src/shared/types.ts`. The design re-elevates them to separate types, which would:

- Require changing the Zod discriminated union (breaking wire format)
- Require migrating all existing annotations
- Conflict with every MCP tool that creates/reads annotations
- Conflict with `FilterBar.tsx` which filters by `"with-replacement"` and `"for-claude"` subtypes

**Resolution:** The visual distinction (different card styles per subtype) can be achieved without changing the data model — render differently based on `suggestedText`/`directedAt` discriminators. The design's *visual* treatment is good; the *data model* must not change. Note: `tandem_suggest` is already flagged as legacy in `src/server/mcp/annotations.ts:380` ("Legacy shim — prefer tandem\_comment with suggestedText"). New "Ask Claude" UX should wire to `tandem_comment` with `directedAt: "claude"`, not `tandem_suggest`.

### 1c. oklch relative color syntax requires Chromium 119+

The design uses `oklch(from var(...) l c h)` (relative color syntax) in two places:

- Held-in-Solo banner background
- Imported chip styling

This syntax requires Chromium 119+. Tauri's WebView2 on Windows auto-updates, but:

- Users on managed/enterprise Windows may have pinned WebView2 versions
- The current codebase uses zero oklch anywhere (confirmed: no matches in `src/`)

**Action:** Test against the minimum WebView2 version Tauri ships with. For safety, provide `color-mix()` fallbacks (which are already used in the current token system and have broader support). The rest of the oklch usage in the design (non-relative) is fine — basic oklch() support landed in Chromium 111.

### 1d. No drag-resize in design — regression from shipped behavior

The design uses a fixed `--rail-w: 340px` for the side panel. The current codebase ships `useDragResize` (`src/client/hooks/useDragResize.ts`) used in `App.tsx` for user-adjustable panel widths. In three-panel mode, the codebase renders *two* independent resize handles (left and right) with separately stored widths (`loadPanelWidth("left")` and `loadPanelWidth("right")` at `App.tsx:368-389` and `430-451`). The design's single `--rail-w` variable doesn't account for this.

**Action:** Keep `useDragResize`. Use `--rail-w` as the default/minimum width, not a fixed constraint. Three-panel mode requires two independent CSS variables or inline width styles. Panel width localStorage keys (`"tandem-panel-width"`, `"tandem-left-panel-width"`) are a stable persistence contract per `constants.ts:30-37` and must not change.

### 1e. Density vs textSize collision — last-write-wins bug

`styles.css:140-142` sets `--editor-size` per density level (15/16/18px for compact/cozy/spacious). The codebase already has `TEXT_SIZE_PX = { s: 14, m: 16, l: 18 }` in `useTandemSettings.ts:28`, and `App.tsx:153-158` writes `--tandem-editor-font-size` from it on every `textSize` change.

If both density and textSize are implemented as designed, whichever state update fires last wins the font size. Density cannot be purely additive to textSize without either removing textSize or making density operate only on non-font spacing tokens.

**Action:** Decide before implementation: density controls spacing only (padding, gaps, margins) while textSize controls font size — OR — density subsumes textSize entirely. Don't ship both writing the same CSS variable.

### 1f. Layout enum collision — data model conflict — RESOLVED

**Design proposes 3 layout swatches:** `tabbed-right`, `tabbed-left`, `three`
**Codebase uses 2 orthogonal settings:** `layout: "tabbed" | "three-panel"` + `panelOrder: "chat-editor-annotations" | "annotations-editor-chat"` (per `useTandemSettings.ts:10-19`)

The mapping isn't 1:1. The design's `tabbed-left` has no direct equivalent — the codebase uses `panelOrder` to control side, not `layout`. Additionally, the design's toolbar (`app.jsx:35-37`) exposes a separate `left | right | hidden` control, while `settings.jsx:189-194` shows a layout swatch picker — two UI controls expressing the same axis inconsistently within the design itself.

**Decision (#439):** Build `tabbed-left` as a real `LayoutMode` variant in v0.9.0 with its own render branch. The design's 3 swatches are confirmed. The `three` swatch should pin a specific `panelOrder`. Tracked in #445.

---

## 2. Requires Product Decision (no single right answer)

### 2a. Claude brand color: coral vs orange

**Design:** `--author-claude: #D97757` (coral-amber, warm reddish)
**Codebase:** `--tandem-author-claude: #ea8a1e` (orange, warm yellowish)
**Dark mode codebase:** `#fbbf24` (amber/gold)

These are significantly different hues. The design's coral reads as more sophisticated and distinct from warning colors, but this is a brand identity decision.

**Decision needed:** Pick one. If coral, update both light and dark tokens. If orange, update the design. Either way, the dark-mode variant needs explicit design attention — the design only shows light mode for this token.

### 2b. Highlight swatch palette

**Design mini-toolbar:** 4 colors — yellow, green, blue, pink
**Codebase&#x20;****HIGHLIGHT\_COLORS****:** 5 colors — yellow, red, green, blue, purple (`src/shared/constants.ts:16-22`)

Differences: design drops red and purple, adds pink. The codebase colors are referenced in `AnnotationCard.tsx`, `annotation.ts` (decorations), and `HighlightColorPicker.tsx`.

**Decision (#439): Switch to design's 4-color palette** (yellow/green/blue/pink). Migration strategy for existing `red`/`purple` annotation keys delegated to Claude Design (see `docs/claude-design-response-prompt.md` item 16). Risk: `HighlightColorSchema` is a strict Zod enum; removed keys cause annotation drops in `migrateToV1` unless migration logic is added.

### 2c. Typography: web fonts vs system stack

**Design introduces 3 font families:** Source Serif 4 (prose), Inter Tight (chrome), JetBrains Mono (status/code)
**Codebase uses:** system font stack only (no web font loading)

Web fonts add load time, FOUT risk, and \~200-400KB of assets. The design's settings panel lets users choose serif/sans/mono for the editor, which is good. But the chrome font (Inter Tight) would apply everywhere else.

**Decision needed:** Ship web fonts bundled in the Tauri app (no network cost) and loaded via `@font-face` for the browser path? Or keep system fonts and adapt the design's spacing to system metrics? The Tauri bundle size increase is negligible; the browser install path is the concern.

### 2d. Density setting (compact / cozy / spacious)

The design introduces a density setting that doesn't exist in the current `TandemSettings` interface. See 1e for the collision with textSize that must be resolved first.

**Decision needed:** Is density a v0.9.0 feature or deferred? It touches every component's spacing. If included, resolve the textSize collision and add `density: "compact" | "cozy" | "spacious"` to `TandemSettings`.

### 2e. Accent hue customization

The design settings include a 9-swatch accent hue picker (oklch-based). The current codebase has a single fixed accent (`--tandem-accent: #4f46e5` / indigo). Note: `--tandem-accent-border` already exists at `index.html:60` (light: `#c7d2fe`) and `index.html:106` (dark: `#4338ca`) — any accent hue system must derive this token too.

**Decision needed:** Is this v0.9.0 scope? Implementing requires all accent-derived tokens to use relative calculations from a single hue variable.

### 2f. Selection mini-toolbar — new feature, not a redesign

The mini-toolbar (floating Word-style toolbar on text selection with formatting, highlights, Comment, Ask Claude, Flag) is the design's headline UX improvement. It doesn't exist at all in the current codebase. The chat transcript confirms this was the user's primary ask: "buttons are all far away from where the user is already working."

**Decision needed:** This is clearly wanted, but it's a significant new feature:

- Needs a selection-aware floating component (position near selection, avoid viewport edges)
- "Ask Claude" creates a `comment` with `directedAt: "claude"` via the client Y.Map path (not MCP — MCP tools are called by Claude, not the UI)
- "Comment" needs inline input or opens side panel
- Toggle in settings (`selectionToolbar: boolean` per design)
- Accessibility: keyboard-accessible, screen-reader announced

### 2g. Slash command menu

Design includes a slash menu (H1/H2/Bullet/Numbered/Quote/Code block) triggered by `/` in the editor. Not present in current codebase.

**Decision needed:** v0.9.0 scope or later? Tiptap has a `Suggestion` extension that handles this pattern.

### 2h. Selection dwell default: 180ms vs 1000ms

Design's slider (`settings.jsx:339`) initializes to \~180ms. Codebase default is `SELECTION_DWELL_DEFAULT_MS = 1000` (`src/shared/constants.ts:56`). CLAUDE.md documents "default 1s."

180ms would make Claude react to nearly every accidental text selection. This is either a deliberate UX retuning or a copy error in the design.

**Decision needed:** Which default? If 180ms is intentional, update the constant and CLAUDE.md. If not, fix the design.

### 2i. Editor width paradigm: percentage vs character measure

**Codebase:** `editorWidthPercent` (50-100%, applied as `maxWidth` in `App.tsx:203-205`)
**Design:** `--editor-measure: 68ch` (character-based measure, `styles.css:55`); settings slider operates on 40-100% range (lower minimum than codebase's 50%)

These are different mental models. `68ch` is a typography convention for readability; percent-based is about spatial layout. Both can coexist (ch clamps the prose column, percent clamps the container) but this needs a conscious mapping decision.

**Decision needed:** Keep both (ch for readability max-width, percent for container), pick one, or map between them?

---

## 3. Mechanical (clear translation, no ambiguity)

### 3a. Token namespace: `--*` → `--tandem-*`

Design uses bare names (`--bg`, `--surface`, `--ink`, `--accent`). Codebase uses prefixed names (`--tandem-bg`, `--tandem-surface`, `--tandem-fg`, `--tandem-border`). The prefix exists to avoid collisions with user content styles.

**Translation:** Rename all design tokens to `--tandem-*` during implementation. This is a find-replace operation on `styles.css`. The prefix convention is non-negotiable.

### 3b. Color space: oklch → hex (with oklch progressive enhancement)

Design uses oklch() throughout. Codebase uses hex + `color-mix()`. Since oklch is well-supported in modern Chromium (111+), the base oklch values are fine. Only the relative color syntax (`oklch(from ...)`) needs fallbacks (see 1c).

**Translation:** Adopt oklch for new tokens but keep hex fallbacks where Tauri WebView2 floor version is uncertain. Update `index.html` `:root` block.

### 3c. Spacing scale: design `--s-1` through `--s-7` → codebase hardcoded px

Design introduces a systematic spacing scale and border-radius scale (`--r-1` through `--r-pill`). Codebase uses hardcoded pixel values.

**Translation:** Add the spacing/radius tokens to `:root`. Migrate components to use them. This is mechanical but touches many files — do it as a dedicated pass, not sprinkled across feature work.

### 3d. Layout: CSS Grid vs Flexbox

Design uses `grid-template-rows: toolbar tabs 1fr status`. Codebase uses flexbox (`App.tsx:301` root container is `display: "flex", flexDirection: "column"`).

**Translation:** Grid is cleaner for this layout. Migrate `App.tsx` shell to CSS Grid. Keep flexbox for inner component layout where it's already correct. Must support both `tabbed` and `three-panel` layout modes (see 1f).

### 3e. Dark mode token values

Design only includes light-mode oklch values. The codebase has hand-picked dark-mode hex values in `[data-theme="dark"]` (`index.html:50-87`).

**Translation:** Every new/changed light token needs a corresponding dark-mode value. Per CLAUDE.md: "Dark mode `*-bg` tokens use hand-coded saturated hex. `color-mix` produces washed-out surfaces against the dark neutral."

### 3f. High contrast mode

Design settings include a "High contrast" toggle. Codebase already has a `forced-colors` media query fallback in `index.html` (lines 112-138) that maps tokens to system colors.

**Translation:** Wire the toggle to a `[data-high-contrast]` attribute. Map tokens to higher-contrast variants. Ensure it composes with `forced-colors` media query.

### 3g. Annotation pattern fills (accessibility)

Design settings include "Annotation patterns" toggle for colorblind accessibility. Not in current codebase.

**Translation:** Add pattern-fill SVG backgrounds for annotation decorations, toggled by a CSS class. Reference the existing `showAuthorship` toggle pattern for implementation.

### 3h. SettingsPopover → SettingsDialog — full component replacement

The existing `SettingsPopover.tsx` is a \~320px-wide flat popover with five inline sections. The design proposes a full-screen two-column dialog with a six-section sidebar nav. This is a complete component replacement, not an in-place expansion — the focus-trap, keyboard-dismiss logic, and component shell all change.

**Translation:** Replace `SettingsPopover` entirely. Reuse the individual setting controls (toggles, sliders) but build a new shell with section navigation.

### 3i. Review-mode paragraph decoration

`styles.css:1009-1016` implements review-mode dimming by targeting `.has-anno` on paragraphs. The ProseMirror decoration system currently marks annotated ranges but doesn't add `.has-anno` to containing paragraph elements. This CSS class must be applied by new decoration logic.

**Translation:** Add a ProseMirror plugin that applies `.has-anno` to paragraphs containing annotations. This must land before the annotation card visual refresh depends on review-mode styling.

---

## 4. Design-Side Gaps (missing from design, present in codebase)

These are features/states the design doesn't cover that currently exist and must not regress:

### 4a. Connection status banner

Codebase has `ConnectionBanner.tsx` (dismissible, triggers after 30s via `useConnectionBanner`). Design's `StatusBar` shows a green/yellow dot but no banner for degraded states.

### 4b. Empty states

No empty state shown for: no annotations, no chat messages, no documents open.

### 4c. Review mode summary

Codebase has review summary (annotation counts by type/status). Design shows a "Review" tab but no summary view.

### 4d. Help / onboarding

Codebase has `useTutorial` hook (4-5 steps) and tutorial annotations on `sample/welcome.md`. `OnboardingTutorial` rendered at `App.tsx:659`. Design has no onboarding flow.

### 4e. Toast notifications

Codebase has `ToastContainer` with `useNotifications` (auto-dismiss per severity). Design doesn't show toast placement or styling.

### 4f. Reply threads

Codebase has `ReplyThread.tsx` and `CommentThread.tsx` for annotation replies (`AnnotationCard.tsx:306` renders `ReplyThread`). Design's annotation card shows a reply input but no thread display for existing replies.

### 4g. Document health / diagnostics

Codebase has `npm run doctor` and health indicators. Not represented in design.

### 4h. Read-only info bar

Design shows "RO" badge on tabs but no read-only info bar. Codebase shows a read-only info strip in the side panel. Note: design CSS references `var(--surface-2)` in `.rail-info` (`styles.css:608`) but this token is undefined in the `:root` block — would render transparent.

### 4i. Multi-document "open files" dropdown

Design shows a "Recent files" dropdown on tabs. Codebase has a file-open dialog (`data-testid="file-open-dialog"`). These may need reconciliation.

### 4j. Toolbar held-count badge

`Toolbar.tsx:242-256` renders a held-count badge in the toolbar. Design moves held-annotation state exclusively into the `rail-banner.held` inside SideRail. Either the toolbar badge is removed, kept in both places, or moved — not addressed.

### 4k. Tauri-specific zoom persistence

`useWebViewZoom` + Tauri zoom persistence (`App.tsx:46`, `constants.ts:130-133`) must be preserved through any layout changes.

### 4l. showAuthorship default divergence — RESOLVED

Design defaults `showAuthorship` to `true`. Codebase defaults to `false` (`useTandemSettings.ts:46`). **Decision (#439): change to `true` to match design.** Note: existing users have been accumulating authorship ranges silently since installation (the plugin records all local edits unconditionally, visibility only gates rendering). Flipping to `true` on upgrade will expose their entire edit history's authorship. Tracked in #442.

---

## 5. Design-Side Errors (factually incorrect in design)

### 5a. "Named pipe" bind mode

Settings dialog offers stdio / HTTP / Named pipe. Only stdio and HTTP exist in the codebase. Named pipe would require new transport code in both `@modelcontextprotocol/sdk` and the server.

**Action:** Remove "Named pipe" from the design.

### 5b. "Rotate token" — real feature, but with Tauri caveat

~~Previously marked as fictional.~~ **Correction:** Token rotation is fully implemented in `src/cli/rotate-token.ts` with atomic writes, a 60-second server grace window for old tokens, and MCP config updates. The design's "Rotate token" button maps to the real `tandem rotate-token` CLI command.

**Caveat:** The Tauri desktop path uses `TANDEM_AUTH_TOKEN` env variable injection. Rotation from the desktop app requires the HTTP bridge, which has an explicit TODO at `rotate-token.ts:101-107`. A settings panel button needs a guard for Tauri/env-token mode (disable or show "run from CLI" message).

### 5c. About panel fictions

The design's About section (`settings.jsx:454-471`) contains several hardcoded values that don't match reality:

- **"12 tools available"** — codebase has 31 MCP tools per CLAUDE.md
- **"Tandem Pro · seat 1 of 5"** — no licensing tier exists in the codebase
- **"claude-sonnet-4.5 · MCP 0.7.2"** — hardcoded model name and MCP version that will rot immediately
- **"\~/Library/Tandem · 12.4 MB"** — macOS path only; Windows is `%LOCALAPPDATA%\tandem\Data\sessions\`; Linux is `~/.local/share/tandem/sessions/`
- **"token rotated 3 days ago"** — stale copy; needs to read actual rotation timestamp

**Action:** All About-panel values must be dynamic (read from `APP_VERSION`, tool count from server, storage path from `env-paths`, etc.) or removed. "Tandem Pro" licensing copy must be deleted entirely.

### 5d. Settings keyboard shortcut count

Design shows 13 shortcuts. Needs verification against actual registered shortcuts in the codebase. Unverified — flag for manual audit during implementation.

---

## 6. Implementation Sequencing Recommendation

If this redesign proceeds, the suggested order is:

1. **Token system migration** (3a, 3b, 3c, 3e) — foundation everything else depends on
2. **Layout shell + review-mode decoration** (3d, 3i, 1f) — Grid migration of App.tsx, `.has-anno` plugin, support both layout modes
3. **Selection mini-toolbar** (2f) — headline feature, drives user value, can ship independently
4. **Annotation card visual refresh** — use existing 3-type data model, render design's 5 visual variants via discriminators (resolves 1b without data model changes)
5. **Settings replacement** (3h, 2d, 2e, 3f, 3g) — new SettingsDialog shell, density, accent, high-contrast, patterns
6. **Typography** (2c) — web font loading, editor font picker
7. **Slash menu** (2g) — nice-to-have, lower priority
8. **Gap coverage** (section 4) — ensure no regressions

---

## 7. Authorship Decoration Note — RESOLVED

The verification checklist originally stated `data-tandem-author` is "not used in client code." **Correction:** Authorship decoration already exists via `authorshipPluginKey` (imported at `App.tsx:17`, dispatched at `App.tsx:132-138`). **Decision (#439): switch from CSS classes (`.tandem-authorship--user`) to `data-tandem-author` data attributes.** The ProseMirror plugin outputs the attribute name; design CSS targets `[data-tandem-author="user"]` / `[data-tandem-author="claude"]` selectors. Tracked in #443.

---

## Claude Design Response Prompt

> **Note (2026-04-26):** This original prompt has been superseded by the full response prompt in `docs/claude-design-response-prompt.md`, which incorporates all #439 gap audit decisions (ADR-026). Use that file instead.

Copy the following into Claude Design to have it apply the recommended corrections:

---

```
I had the Tandem codebase reviewed against this design by engineering. Here are the changes needed — please apply all of them:

## Data Model Corrections

1. **HANDOFF.md — Fix the annotation position type.** Replace `anchor: { from: number; to: number } // ProseMirror positions` with:
```

range: { from: number; to: number }  // flat text offsets (server coordinate system, includes heading prefixes)
relRange?: { from: RelativePosition; to: RelativePosition }  // CRDT-anchored positions (survive concurrent edits)

```
Add a warning: "ProseMirror positions are client-only. Server-side annotation data uses flat text offsets. See src/shared/positions/types.ts for the canonical types. Implementing ProseMirror positions here would reintroduce coordinate-system bugs fixed in #260 and #377."

2. **HANDOFF.md — Fix annotation type taxonomy.** The codebase uses 3 types, not 5. Change the type enum from `suggest | question | flag | comment | highlight` to `comment | flag | highlight`. Add a note: "Visual distinction for suggestions and questions is achieved through discriminator fields on the `comment` type: `suggestedText?: string` renders as a suggestion card, `directedAt?: 'claude'` renders as a question card. The data model must not be changed — the v0.8.0 simplification (#381, #382) was intentional. Render 5 visual variants from the 3-type model."

## Settings Panel Corrections

3. **Remove "Named pipe" from the bind mode options.** Only stdio and HTTP exist. Named pipe is not implemented.

4. **"Rotate token" button — add a Tauri caveat.** Token rotation IS real (it's implemented in src/cli/rotate-token.ts), but add a note: "In Tauri desktop mode, token rotation requires the HTTP bridge which is not yet available. The button should be disabled or show a 'run `tandem rotate-token` from CLI' message when running in the desktop app."

5. **Fix the About section.** Replace all hardcoded values:
- "12 tools available" → "31 tools available" (or better: note it should be read dynamically from the server)
- Delete "Tandem Pro · seat 1 of 5" entirely — no licensing tier exists
- "claude-sonnet-4.5 · MCP 0.7.2" → note these should be read dynamically from the running server, not hardcoded
- "~/Library/Tandem · 12.4 MB" → note this is platform-dependent: `%LOCALAPPDATA%\tandem\Data\sessions\` on Windows, `~/Library/Application Support/tandem/sessions/` on macOS, `~/.local/share/tandem/sessions/` on Linux. Should be read dynamically.
- "token rotated 3 days ago" → note should read actual timestamp from disk

6. **Selection dwell slider default.** The design initializes to ~180ms. The codebase default is 1000ms (1 second). Please change the default position to 1000ms and add a note: "Default is 1000ms per SELECTION_DWELL_DEFAULT_MS. Lower values (like 180ms) cause Claude to react to nearly every accidental text selection."

## Token & CSS Corrections

7. **Add `--surface-2` to the `:root` block.** It's referenced in `.rail-info` (styles.css line ~608) but never defined. It'll render transparent as-is.

8. **Add to the "Known incompatibilities" section of HANDOFF.md:**
- "All CSS custom properties must use `--tandem-*` prefix (not bare `--bg`, `--surface`, etc.) to avoid collisions with user content styles."
- "The `oklch(from var(...) l c h)` relative color syntax in the held-banner and imported-chip requires Chromium 119+. Provide `color-mix()` fallbacks for older WebView2 versions."
- "The density setting and textSize setting both write font-size CSS variables. Implementation must resolve the collision — density should control spacing only, or subsume textSize entirely."
- "The design's three layout swatches (tabbed-right, tabbed-left, three) map to TWO orthogonal settings in the codebase: `layout: 'tabbed' | 'three-panel'` and `panelOrder` (controls which side). The mapping is not 1:1."

## Missing States (add to design or note in HANDOFF.md as "not designed yet")

9. **Add a note listing these undesigned states that exist in the codebase and must not regress:**
- Connection degradation banner (shows after 30s disconnect — different from the StatusBar dot)
- Empty states for: no annotations, no chat messages, no documents open
- Review mode summary panel (annotation counts by type/status)
- Onboarding tutorial flow (4-5 step overlay on sample/welcome.md)
- Toast notification placement and styling (auto-dismiss, per-severity timing)
- Reply thread display in annotation cards (existing replies, not just the input)
- Toolbar held-count badge (design moves this to SideRail only — is the toolbar badge intentionally removed?)
- Read-only info bar in side panel (design has RO tab badge but no info bar)

10. **showAuthorship default.** The design defaults this to `true`. The codebase defaults to `false`. Note in HANDOFF.md which is intended — changing to `true` would show authorship decorations to all users on upgrade.

11. **Highlight colors.** Note in HANDOFF.md that the codebase palette is yellow/red/green/blue/purple (5 colors, stored by name as keys), while the design shows yellow/green/blue/pink (4 colors). Changing colors requires migrating existing annotations. Flag which palette is intended.
```

---

## Verification Summary

- Annotation types: 3-type discriminated union confirmed in `src/shared/types.ts` (highlight/comment/flag)
- `tandem_suggest` is legacy-flagged at `annotations.ts:380`; "Ask Claude" = `tandem_comment` with `directedAt: "claude"`
- UI creates annotations via client Y.Map path, not MCP tools (MCP tools are called by Claude)
- No oklch usage in current `src/` — net-new color space introduction
- `useDragResize` confirmed with two independent resize handles in three-panel mode
- `HIGHLIGHT_COLORS`: 5 entries (yellow/red/green/blue/purple) in `src/shared/constants.ts:16-22`
- `ReplyThread.tsx` and `CommentThread.tsx` exist; `AnnotationCard.tsx:306` renders `ReplyThread`
- Authorship tokens: `--tandem-author-user: #3b82f6`, `--tandem-author-claude: #ea8a1e` in `index.html`
- Authorship decoration exists via `authorshipPluginKey` (`App.tsx:17, 132-138`) — translation task, not new build
- `TandemSettings` has 9 fields; design adds \~6 new ones
- Token rotation is real (`src/cli/rotate-token.ts`) with Tauri env-token mode caveat
- `TEXT_SIZE_PX` at `useTandemSettings.ts:28` collides with density's `--editor-size`
- Layout model is 2-axis (`layout` + `panelOrder`), not 3-enum
- `SELECTION_DWELL_DEFAULT_MS = 1000` at `src/shared/constants.ts:56`
- Panel width localStorage keys are a stable contract per `constants.ts:30-37`
