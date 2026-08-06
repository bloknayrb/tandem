# Claude Design Response Prompt

Design: [Tandem Redesign](https://api.anthropic.com/v1/design/h/YkiJv2qQa82QG0GHUxce-g?open_file=Tandem+Redesign.html)

I had the Tandem codebase reviewed against this design by engineering. Here are the changes needed — please apply all of them:

## Data Model Corrections

1. **HANDOFF.md — Fix the annotation position type.** Replace `anchor: { from: number; to: number } // ProseMirror positions` with:

```
range: { from: number; to: number }  // flat text offsets (server coordinate system, includes heading prefixes)
relRange?: { from: RelativePosition; to: RelativePosition }  // CRDT-anchored positions (survive concurrent edits)
```

Add a warning: "ProseMirror positions are client-only. Server-side annotation data uses flat text offsets. See src/shared/positions/types.ts for the canonical types. Implementing ProseMirror positions here would reintroduce coordinate-system bugs fixed in #260 and #377."

2. **HANDOFF.md — Fix annotation type taxonomy.** The codebase uses 3 types, not 5. Change the type enum from `suggest | question | flag | comment | highlight` to `comment | flag | highlight`. Add a note: "Visual distinction for suggestions and questions is achieved through discriminator fields on the `comment` type: `suggestedText?: string` renders as a suggestion card, `directedAt?: 'claude'` renders as a question card. The data model must not be changed — the v0.8.0 simplification (#381, #382) was intentional. Render 5 visual variants from the 3-type model."
3. **imported****&#x20;field — use&#x20;****author: "import"****.** The design uses `imported?: boolean` as a discriminator. The codebase uses `author: "import"` as a third author enum value (alongside "user" and "claude"). Please update the design to use `author: "import"` instead of a separate boolean — keeps the discriminator consistent with the existing data model.
4. **heldInSolo****&#x20;field.** The design references `heldInSolo?: boolean` on `AnnotationBase` for Solo-mode annotation queuing. This field does not exist in the codebase type system yet. We will add it in v0.9.0. Note: the current Solo-mode hold mechanism is entirely client-side and derived at render time (`useModeGate` checks `author === "claude" && status === "pending"`). Whether `heldInSolo` becomes a persisted server-side field or remains derived is an open implementation question. The design's usage is correct.

## Settings Panel Corrections

5. **Remove "Named pipe" from the bind mode options.** Only stdio and HTTP exist. Named pipe is not implemented.
6. **"Rotate token" button — add a Tauri caveat.** Token rotation IS real (it's implemented in src/cli/rotate-token.ts), but add a note: "In Tauri desktop mode, token rotation requires the HTTP bridge which is not yet available. The button should be disabled or show a 'run `tandem rotate-token` from CLI' message when running in the desktop app."
7. **Fix the About section.** Replace all hardcoded values:

- "12 tools available" — should be "31 tools available" (or better: read dynamically from the server via `GET /api/info`)
- Delete "Tandem Pro · seat 1 of 5" entirely — no licensing tier exists
- "claude-sonnet-4.5 · MCP 0.7.2" — should be read dynamically from `/api/info`, not hardcoded
- "\~/Library/Tandem · 12.4 MB" — platform-dependent: `%LOCALAPPDATA%\tandem\Data\sessions\` on Windows, `~/Library/Application Support/tandem/sessions/` on macOS, `~/.local/share/tandem/sessions/` on Linux. Read dynamically from `/api/info`.
- "token rotated 3 days ago" — read actual timestamp from `/api/info`

8. **Selection dwell slider default.** The design initializes to \~180ms. The codebase default is 1000ms (1 second). Please change the default position to 1000ms and add a note: "Default is 1000ms per SELECTION\_DWELL\_DEFAULT\_MS. Lower values (like 180ms) cause Claude to react to nearly every accidental text selection."
9. **Eight new settings are phased.** We'll add the data model fields in v0.9.0, but the settings UI will be built in Svelte (v0.10.0+). The fields: accent hue, editor font, density, default mode, high contrast, annotation patterns, selection toolbar, plus the About panel (which requires the new `/api/info` server endpoint). The design for these settings is correct — just note they ship in two phases.

## Token and CSS Corrections

10. **Add&#x20;****--surface-2****&#x20;to the&#x20;****:root****&#x20;block.** It's referenced in `.rail-info` (styles.css line \~608) but never defined. It'll render transparent as-is.
11. **Add to the "Known incompatibilities" section of HANDOFF.md:**

- "All CSS custom properties must use `--tandem-*` prefix (not bare `--bg`, `--surface`, etc.) to avoid collisions with user content styles."
- "The `oklch(from var(...) l c h)` relative color syntax in the held-banner and imported-chip requires Chromium 119+. Provide `color-mix()` fallbacks for older WebView2 versions."

12. **Authorship decoration selectors.** The codebase will switch to `data-tandem-author` attributes (e.g., `[data-tandem-author="user"]`, `[data-tandem-author="claude"]`). Please ensure the design CSS targets these data-attribute selectors, not CSS classes.
13. **Editor width minimum confirmed at 40%.** Note that `editorWidthPercent` applies as `maxWidth` on the editor flex child after panels are subtracted, not on the full viewport. At 40% on a narrow viewport with two panels, the readable column can get as narrow as \~270px. The design's 40% minimum is accepted.

## Layout and Density

14. **Density controls spacing only.** The density setting must NOT write font-size CSS variables. `textSize` continues to control font size independently. Density should only affect padding, gaps, and margins. Please remove the `--editor-size` font-size override from the density levels in the design.
15. **Layout:&#x20;****tabbed-left****&#x20;is confirmed as a real feature.** We'll build `tabbed-left` as a new layout variant in v0.9.0 with its own render branch. The design's 3 swatches (tabbed-right, tabbed-left, three) are confirmed. Note: the `three` swatch should pin a specific `panelOrder` in its mapping so all users land on the same arrangement.

## Highlight Palette and Defaults

16. **Highlight palette: switching to the design's 4 colors** (yellow/green/blue/pink). The codebase currently has 5 (yellow/red/green/blue/purple) stored as string keys on annotation records. Existing annotations with `red` or `purple` keys need a migration strategy. **Please specify:** should `red` map to `pink`? Should `purple` map to `blue`? Or should unrecognized colors fall back to a default like `yellow`? This decision determines whether existing annotations are preserved or silently dropped.
17. **showAuthorship****&#x20;default confirmed as&#x20;****true****.** We'll change the codebase default to match the design. Note: existing users have been accumulating authorship ranges silently since installation (the plugin records all local edits unconditionally, visibility only gates rendering). Flipping to `true` on upgrade will expose their entire edit history's authorship. This is accepted.

## Missing States

18. **Add a note listing these undesigned states that exist in the codebase and must not regress:**

- Connection degradation banner (shows after 30s disconnect — different from the StatusBar dot)
- Empty states for: no annotations, no chat messages, no documents open
- Review mode summary panel (annotation counts by type/status)
- Onboarding tutorial flow (4-5 step overlay on sample/welcome.md)
- Toast notification placement and styling (auto-dismiss, per-severity timing)
- Reply thread display in annotation cards (existing replies, not just the input)
- Toolbar held-count badge (design moves this to SideRail only — is the toolbar badge intentionally removed?)
- Read-only info bar in side panel (design has RO tab badge but no info bar)
