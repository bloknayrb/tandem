# Run B — Tandem v0.8.0 Implementation Plan

## Context

Phases 1-4 of the pre-v1.0 codebase audit just completed (merged 2026-04-24), decomposing 8 god-files into clean modules. Run B is the next milestone: a batch of 9 issues covering bugs, UI simplification, theme tokens, and observability. The codebase is clean and ready for feature work.

Run B targets v0.8.0 — the "token hygiene + annotation correctness" release. Each issue becomes one PR via the `/issue-pipeline` skill. #260 was pulled into scope after #377 investigation revealed three compounding coordinate system bugs.

---

## Issues At a Glance

| # | Title | Category | Effort | Risk |
|---|-------|----------|--------|------|
| **377** | Annotation offset resolves to wrong text | Bug (investigation) | M | HIGH — may pull #260 into scope |
| **376** | Monitor not pushing events to Claude Code | Bug (wiring gap) | S | MED — needs plugin schema research |
| **340** | Extract `--tandem-suggestion*` token family | Theme | S | LOW |
| **381** | Remove Accept/Reject from user annotations + add Remove | UI simplification | S-M | LOW |
| **382** | Remove Replace/@Claude checkboxes from toolbar | UI simplification | S | LOW |
| **308** | Flash animation: color-mix alpha wash | Visual fix | XS | LOW |
| **351** | Surface normalizeAnnotation drop counts | Observability | S | LOW |
| **356** | Enforce semantic tokens via lint rule | Tooling | S | LOW |
| **415** | Make annotation undo persistent until reload | UX | S | LOW |
| **260** | Coordinate system bug fixes + encapsulation | Bug (3 bugs) | M-L | HIGH — client+server coordinate changes |

---

## Wave Structure

### Wave 1 — Six Parallel Issues (no file collisions)

All six touch completely independent files. Run as parallel subagents in worktree isolation.

#### #377 — Position Bug Investigation
**Investigation-first. No code until RCA is complete.**

Root cause candidates from exploration:
1. **Stale CRDT relRange** — the roadmap.md was recently revised (PR #375), which could have deleted/reinserted text. Old `RelativePosition` anchors now point to deleted Y.js items, causing `refreshRange()` to fall back to flat offsets that no longer match the current document.
2. **Dual `resolveToElement()` implementations** — `src/server/positions.ts:47-90` and `src/server/mcp/document-model.ts:190-230` (`resolveOffset()`) are structurally identical but separately maintained. Divergence risk.
3. **`\n` boundary edge case** — both use `>` not `>=` at the separator check, meaning a flat offset landing exactly on a `\n` falls through to the next element.

**Phase 1 (RCA):** Write a test that loads `docs/roadmap.md` into a Y.Doc, places an annotation at the PWA section, and verifies `extractText().slice(from, to)` returns the expected text. If the test passes with a fresh Y.Doc, the bug is CRDT-related (stale relRange). If it fails, the bug is in the offset math.

**Phase 2 (Fix):** Depends on Phase 1 findings:
- If stale relRange → fix `refreshRange()` fallback behavior + add test
- If offset math → fix the specific boundary condition + add test
- If systemic → file a comment on #260 and consult Bryan before expanding scope

**Key files:** `src/server/positions.ts`, `src/server/mcp/document-model.ts`, `src/shared/offsets.ts`

---

#### #376 — Monitor Event Push Gap
**HIGH PRIORITY — Bryan's primary surface is Claude Code CLI.**

The root cause is clear from exploration: the monitor binary (`src/monitor/index.ts`) is built and distributed, but `.claude-plugin/plugin.json` doesn't declare a `monitor` entry to tell Claude Code to spawn it. The file still lists the old `tandem-channel` channel shim, which `tandem setup` no longer writes by default.

**Changes:**
1. `.claude-plugin/plugin.json` — Research the Claude Code plugin `monitor` entry syntax (WebFetch plugin docs or check `context7`). Add the monitor declaration. Keep `tandem-channel` in `mcpServers` for backward compatibility (users who explicitly set up the channel shim should not break). Also bump `"version"` from stale `"0.6.2"` to current version.
2. `package.json` — `dist/monitor/` is already covered by the `"dist/"` entry in `files`. No change needed (confirmed by review).
3. Consider: should `dev:standalone` also spawn the monitor for local dev? Currently it doesn't, which means event push doesn't work during development. If adding it, use `concurrently` to add a third process.

**Key files:** `.claude-plugin/plugin.json`, possibly `package.json` (scripts), possibly `src/cli/start.ts`

**Verification:** Start Tandem, create annotation in browser, confirm Claude Code receives push notification.

---

#### #382 — Remove Replace/@Claude Checkboxes from Toolbar
**Fully contained to `Toolbar.tsx`.**

**Intent (stated explicitly):** After this change, users can no longer create annotations with `suggestedText` or `directedAt: "claude"` from the UI. Those become Claude-only actions (created via MCP tools). This is intentional — user annotations are notes to Claude, not replacement suggestions. The server-side annotation schema and MCP tool parameters are unchanged; only the UI entry point is removed.

Remove from `src/client/editor/toolbar/Toolbar.tsx`:
- State variables: `showReplacement`, `setShowReplacement`, `replacementText`, `setReplacementText`, `sendToClaude`, `setSendToClaude`
- The `secondaryInput` JSX block (both checkbox labels + replacement text input, lines ~262-328)
- The `extras.suggestedText` and `extras.directedAt` branches in `handleModeSubmit`
- The ternary submit label → hardcode `"Add"`
- The ternary `canSubmit` → simplify to `!!modeText.trim()`
- The ternary `placeholder` → simplify to `"Add a comment..."`

**Note:** The `filterType === "with-replacement"` filter in SidePanel still works for Claude-created suggestions. No dead code to remove there — Claude-authored suggestions remain a first-class concept.

**Key file:** `src/client/editor/toolbar/Toolbar.tsx`

---

#### #415 — Make Undo Persistent Until Page Reload

Remove from `src/client/panels/useAnnotationReview.ts`:
- The `setTimeout(10_000)` at lines 124-135
- The `undoTimersRef` ref and its cleanup `useEffect` (lines 82-89)
- Timer cleanup in `undoResolveAnnotation` (lines 181-185)

Keep:
- `recentlyResolved` Set — IDs stay indefinitely (session-scoped)
- `lastResolvedRef` — for keyboard Z-key undo

Remove from `src/client/panels/AnnotationCardActions.tsx`:
- The countdown progress bar div (lines 88-97) and its `@keyframes undo-countdown-shrink` style block (lines 98-103)

**UX note — session-only undo:** `recentlyResolved` starts empty on page load and is populated only on `resolveAnnotation` calls during the current session. Annotations that were already resolved before this session will NOT show an Undo button. This is the intended behavior ("until page reload" = current session only). The Undo button's presence on resolved cards is itself the affordance — no countdown bar needed.

**Edge case — suggestion undo after text changed (lines 159-162):** Currently silently `console.warn`s and returns. With permanent undo, this becomes worse — the user clicks Undo and nothing happens.

**Pinned approach:** Change `undoResolveAnnotation` to return `false` when the text-changed guard fires. In the `AnnotationCardActions` component, when the Undo click handler receives `false`, show a brief inline error message below the Undo button: "Can't undo — text has changed." Use a local `useState` in the component; auto-clear after 3 seconds. Do NOT expand `useNotifications` or add server-side toast infrastructure for this — keep it purely local to the component.

**Memory concern (review finding):** The `recentlyResolved` Set grows without bound in a long session with hundreds of resolutions. In practice this is a non-issue — each entry is a short string ID, and hundreds of string references is negligible memory. No mitigation needed.

**Key files:** `src/client/panels/useAnnotationReview.ts`, `src/client/panels/AnnotationCardActions.tsx`

---

#### #351 — Surface normalizeAnnotation Drop Counts

In `src/server/annotations/sync.ts`, `snapshot()` function (lines 153-179):
- Add counters: `let annDrops = 0; let replyDrops = 0;`
- Increment when `normalizeAnnotation`/`normalizeReply` returns null
- After both loops, if either > 0: `console.error(\`[ANNOTATION-STORE] snapshot: dropped ${annDrops} annotation(s), ${replyDrops} reply(ies) in ${docHash}\`)`
- Follow the existing `[ANNOTATION-STORE]` log style (matches #330 pattern)
- No return-signature changes (avoids cascade)

**Test:** In `tests/server/annotations/sync.test.ts`, add a test that inserts one valid + one non-object record into the Y.Map, calls `snapshot()`, and asserts the console.error was emitted with drop count = 1.

**Key file:** `src/server/annotations/sync.ts`

---

#### #308 — Flash Animation Alpha Wash
**One-line fix.**

In `src/client/panels/SidePanel.tsx` line 492, change:
```css
0% { background-color: var(--tandem-accent-bg); }
```
to:
```css
0% { background-color: color-mix(in srgb, var(--tandem-accent) 20%, transparent); }
```

**Verification:** In both light and dark themes, accept an annotation and confirm the flash is a translucent wash, not an opaque color block.

**Key file:** `src/client/panels/SidePanel.tsx`

---

### Wave 1 Gate
- All 6 PRs pass `npm run typecheck && npm test`
- #376: manual push test confirmed
- #308: visual flash check in both themes
- #377: RCA complete — scope decision made (standalone fix vs #260 escalation)
- Merge all to master before Wave 2

---

### Wave 2 — Theme Tokens + Coordinate Fixes (#340, #260)

**Runs after Wave 1 merges.** #340 and #260 touch completely disjoint file sets and can run in parallel:
- #340: `index.html`, `annotation.ts`, `AnnotationCard.tsx`, `colors.ts`, `CLAUDE.md`
- #260: `document-model.ts`, `positions.ts` (server), `positions.ts` (client)

Both #340 and #381 touch `AnnotationCard.tsx`, so #340 must merge before Wave 3.

#### #340 — Extract `--tandem-suggestion*` Token Family

New tokens (violet, distinct from indigo `--tandem-accent`):

**`index.html` `:root`:**
- `--tandem-suggestion: #7c3aed`
- `--tandem-suggestion-bg: color-mix(in srgb, var(--tandem-suggestion) 10%, var(--tandem-surface))`
- `--tandem-suggestion-border: color-mix(in srgb, var(--tandem-suggestion) 40%, var(--tandem-border))`
- `--tandem-suggestion-fg-strong: #5b21b6`

**`index.html` `[data-theme="dark"]`:** Hand-picked dark variants (per CLAUDE.md: `color-mix` produces washed-out surfaces against dark neutrals).

**Rewire:**
- `src/client/editor/extensions/annotation.ts` lines 63-65: `var(--tandem-accent-bg)` → `var(--tandem-suggestion-bg)`, wavy underline `var(--tandem-accent)` → `var(--tandem-suggestion)`
- `src/client/panels/AnnotationCard.tsx` `getBorderColor()` line 62: suggestion branch → `return "var(--tandem-suggestion)"`
- `src/client/utils/colors.ts`: Add `suggestionStateColors` export following the existing `errorStateColors`/`successStateColors`/`warningStateColors` pattern: `{ background: "var(--tandem-suggestion-bg)", border: "var(--tandem-suggestion-border)", color: "var(--tandem-suggestion-fg-strong)" }`

**Note:** `CLAUDE_PRESENCE_COLOR` does NOT exist in the codebase. Issue description is outdated on this — skip that part entirely.

**Update CLAUDE.md:** Add `--tandem-suggestion-*` family to the Semantic Tokens section (between `--tandem-info-*` and `--tandem-accent-border`).

**Key files:** `index.html`, `src/client/editor/extensions/annotation.ts`, `src/client/panels/AnnotationCard.tsx`, `src/client/utils/colors.ts`, `CLAUDE.md`

---

#### #260 — Coordinate System Bug Fixes + Encapsulation

**Three bugs, phased in order of increasing blast radius. Single branch (`fix/260-coordinate-bugs`), sequential commits, one PR.**

**Prerequisite:** Wave 1 must be merged first. The #377 branch contains diagnostic test files that Phase B updates.

**Phase A — Strip Inline Markup from Flat Text (server only):**
- `getElementText()` uses `Y.XmlText.toString()` which emits `<bold>text</bold>` — fix to use `toDelta()` with `\n` for embeds
- Server-only: ProseMirror's `textContent` already strips markup
- Self-healing for existing annotations with `relRange`; no migration needed

**Phase B — Nested Structure Support (server + client):**
- Bug A: `findXmlText()` only searches immediate children → new recursive `findXmlTextAtOffset()`
- Bug C: `getElementText()` joins nested blocks without separators → add `FLAT_SEPARATOR` between child XmlElements
- New helpers: `getElementTextLength()`, `collectXmlTexts()`, `findXmlTextAtOffset()`
- Client: recursive `flatOffsetToPmPos()`, `pmPosToFlatOffset()`, `xmlTextIndexToPmPos()` with `pmNodeFlatTextLength()` + `textblockFlatLength()` for hardBreak consistency
- All four server functions use `hasPriorContent` boolean for separator predicate consistency

**Phase C — Code Consolidation:**
- Remove duplicate `resolveOffset()` from `document-model.ts` (re-export alias for backward compat)
- Move coordinate functions (`getElementText`, `getHeadingPrefixLength`, `findXmlTextAtOffset`, `collectXmlTexts`) to `positions.ts`
- Update `document.ts` re-exports

**Key files:** `src/server/mcp/document-model.ts`, `src/server/positions.ts`, `src/client/positions.ts`, `src/server/mcp/document.ts`

**Full spec:** See `.claude/plans/dynamic-sniffing-russell.md` for exact code changes, edge cases, review findings, and test plan.

---

### Wave 2 Gate
- #340 merged, visual check: suggestions render in violet (not indigo) in both themes
- #260 merged: `npm run typecheck && npm test` pass, list content annotations produce `fullyAnchored: true`
- Typecheck + tests pass

---

### Wave 3 — User Annotation UX (#381)

**Runs after #340 merges** (both touch AnnotationCard.tsx).

#### #381 — Remove Accept/Reject from User Annotations + Add Remove

Three parts:

**Part 1 — Remove Accept/Reject:** In `src/client/panels/SidePanel.tsx` lines 458-459, guard the handlers:
```tsx
onAccept={ann.author !== "user" ? review.handleAccept : undefined}
onDismiss={ann.author !== "user" ? review.handleDismiss : undefined}
```
When both are `undefined`, `AnnotationCardActions` already renders nothing for that section (line 20 guard). The Edit button (AnnotationCard.tsx line 177) is gated on `onEdit` which is passed to all pending annotations regardless of author — this remains correct (user annotations should still be editable).

**Part 2 — Server endpoint for annotation removal:** A bare client-side `Y.Map.delete()` is **insufficient** because:
- The durable-annotation system requires `recordTombstone()` to prevent stale peers from resurrecting deleted annotations via `loadAndMerge`
- Replies in `Y_MAP_ANNOTATION_REPLIES` must be cleaned up transactionally (the server's `tandem_removeAnnotation` at `src/server/mcp/annotations.ts:512-522` does both)

**Approach:** Add a `POST /api/remove-annotation` HTTP endpoint (in the same pattern as `POST /api/close`) that wraps the existing `removeAnnotationById()` logic from `annotations.ts`. The client calls this endpoint; the server handles tombstone recording, reply cleanup, and Y.Map deletion in a single `MCP_ORIGIN` transaction.

New route in `src/server/mcp/api-routes.ts` (or a dedicated `annotation-routes.ts` file if preferred):
```ts
app.post("/api/remove-annotation", (req, res) => {
  const { annotationId, documentId } = req.body;
  // Resolve document, call removeAnnotationById, return result
});
```

**Part 3 — Client-side Remove button:**
- `onRemove?: (id: string) => void` prop on `AnnotationCard` and `AnnotationCardActions`
- In `AnnotationCardActions`: new render branch for `isPending && !isEditing && onRemove` — render a "Remove" button with `data-testid="remove-btn-${annotationId}"` (follows existing `accept-btn-${id}` / `dismiss-btn-${id}` pattern per CLAUDE.md convention)
- In `SidePanel.tsx`: pass `onRemove` only for `ann.author === "user"`. The handler calls `POST /api/remove-annotation` with the annotation ID and active document ID
- No confirmation dialog — user annotations are notes to self, low blast radius. No undo path for deletion (deletion is a permanent action, distinct from the accept/dismiss undo in #415)

**E2E test (required):** Add one test to the annotation lifecycle spec: create a user annotation via the Toolbar UI, assert Accept/Reject buttons are absent, assert Remove button is present (`data-testid="remove-btn-*"`), click Remove, assert annotation card is gone.

**Key files:** `src/client/panels/SidePanel.tsx`, `src/client/panels/AnnotationCard.tsx`, `src/client/panels/AnnotationCardActions.tsx`, `src/server/mcp/api-routes.ts` (or new `annotation-routes.ts`), `src/server/mcp/annotations.ts` (reuse `removeAnnotationById`), `tests/e2e/annotation-lifecycle.spec.ts`

---

### Wave 3 Gate — DONE
- [x] #381 merged (PR #429, 2026-04-26)
- [x] Manual test: user annotations show Edit + Remove only; Claude/import annotations show Accept/Reject
- [x] E2E test for user-annotation lifecycle passes
- [x] Remove correctly deletes annotation AND its replies (verified via unit tests)
- [x] Typecheck + tests pass

---

### Wave 4 — Lint Enforcement (#356) — LAST — DONE

**Must run after all 8 others merge.** Its purpose is preventing regressions. All predecessors merged; #356 shipped as PR #430 (2026-04-26).

#### #356 — Enforce Semantic Tokens via CI Check

Biome linter is disabled (`linter.enabled: false`) — don't enable it globally (cascading unrelated warnings). Use a standalone script instead.

**New file `scripts/check-semantic-tokens.ts`:**

**Concrete regex strategy (pinned):** Scan line-by-line. For each line in `src/client/**/*.{ts,tsx}`:
1. **Skip comment lines** — lines starting with `//` or inside `/* */` blocks (simple heuristic: skip lines containing only `//` or `*` prefixed content)
2. **Raw hex check:** Match `/#[0-9a-fA-F]{3,8}\b/` — but only on lines that also contain a CSS property indicator (`:`, `color`, `background`, `border`, `fill`, `stroke`, `style`). This eliminates `#root-node` CSS selectors and arbitrary ID strings while catching inline style objects and template literals used for styling.
3. **Raw rgba check:** Match `/\brgba?\s*\(/` — exempt lines where the match is followed by `0,0,0` or `255,255,255` within 20 chars (neutral shadows/overlays per CLAUDE.md)
4. **Exclude files:** `src/client/utils/colors.ts` (token definition site), all `*.test.*` and `*.spec.*` files
5. **Output:** `file:line: <matched text>` per violation. Exit 1 on any violation, exit 0 on clean.

- **`package.json`:** Add `"check:tokens": "tsx scripts/check-semantic-tokens.ts"`
- **lint-staged:** Add to `.lintstagedrc` for `*.{ts,tsx}` files — the script is fast (file scan only, no AST parsing), acceptable for pre-commit

**Verification:** Run on clean main → exit 0. Add a temporary `color: #ff0000` to any client file → exit 1. Add `const id = "#my-element"` → exit 0 (no CSS property indicator on line).

**Key files:** `scripts/check-semantic-tokens.ts` (new), `package.json`

---

## Dependency Graph

```
Wave 1 (parallel):  #377  #376  #382  #415  #351  #308
                      |     |     |     |     |     |
                      v     v     v     v     v     v
                    ─────────── merge all ───────────
                                  |
Wave 2 (parallel):          #340         #260
                              |           |
                    ──────── merge both ────────
                                  |
Wave 3:                         #381
                                  |
                                merge
                                  |
Wave 4:                         #356
```

## Verification Strategy

| Check | When | How |
|-------|------|-----|
| Typecheck | Every PR | `npm run typecheck` |
| Unit tests | Every PR | `npm test` |
| E2E tests | After Wave 1 + final | `npm run test:e2e` |
| Visual: flash animation | After #308 | Browser, both themes |
| Visual: suggestion tokens | After #340 | Browser, both themes |
| Manual: event push | After #376 | Create annotation in browser, verify Claude Code receives it |
| Manual: user annotation UX | After #381 + #382 | Create user annotation, verify no Accept/Reject/Replace/@Claude |
| Lint check | After #356 | `npm run check:tokens` exits 0 |
| Position regression | After #377 | Test against docs/roadmap.md offsets |
| Coordinate bugs fixed | After #260 | `anchoredRange` on list content → `fullyAnchored: true` |
| No markup in flat text | After #260 | Unit test: bold text → clean `extractText` |
| Client/server round-trip | After #260 | `flatOffset → relPos → flatOffset` for list items |

## CLAUDE.md / Documentation Updates

Each PR must include relevant doc updates:
- **#340:** Add `--tandem-suggestion-*` family to CLAUDE.md Semantic Tokens section
- **#356:** Add `npm run check:tokens` to CLAUDE.md Quick Reference
- **#381:** Update CLAUDE.md Key Patterns to note that user annotations show Edit + Remove (not Accept/Reject)
- **#382:** Note in CLAUDE.md that suggestions and `directedAt: "claude"` are now Claude-only annotation features (created via MCP tools, not UI)
- **#260:** Add `getElementText()` behavior to Key Patterns; add `getElementText()` stripping/separator gotcha to Y.js/CRDT section

## Notes

- Use sonnet subagents for all implementation work (preserve Opus context/usage)
- Worktree isolation for all Wave 1 parallel agents
- #377 has a hard gate: Bryan decides scope if investigation reveals systemic issue
- #376 needs plugin schema research before editing plugin.json — use `context7` or WebFetch
- The `CLAUDE_PRESENCE_COLOR` mentioned in #340's issue description does not exist — skip that part
- #381 is the most complex issue: server endpoint + client UI + E2E test. The Remove button MUST route through the server to preserve tombstone recording and reply cleanup — bare Y.Map.delete is a correctness bug
- #382 intentionally removes user ability to create suggestions/@Claude annotations — this is a design decision, not a regression
- #260 is NOT parallelizable internally — Phase A → Phase B → Phase C are sequential. But #260 runs in parallel with #340 (disjoint files)
- #260 surfaces two pre-existing bugs to file as separate issues: (1) `tandem_edit` `toString().length` at `document.ts:350`, (2) `getOrCreateXmlText` on container nodes
