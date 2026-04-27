# Post-Merge Review Fixes — PR #451 (Schema Foundations)

## Context

PR #451 (`feat(schema): schema foundations for v0.9.0 redesign`) merged to master at `ddef462`. It bundles #440, #442, #444, and #450 into one PR covering the data model layer for v0.9.0. Typecheck clean, 1599 tests pass (4 pre-existing skips).

This plan addresses issues discovered during post-merge review.

**Reviewed by 2 independent agents.** Corrections applied: F2 overstatement fixed (unit tests cover clamping, not UI slider), F3 spec lines specified, F8 added (MCP input boundary rejects old colors), F9 added (client render fallback for stale colors).

---

## Findings

### F1: Issues #442, #444, #450 not auto-closed

The merge commit body contains `Closes #442, #444, #450` and #440 closed correctly, but the other three remain OPEN on GitHub. Likely a GitHub parsing quirk (the keywords were in the PR body, not individual commit messages, and GitHub sometimes fails to auto-close when multiple issues are listed in a single `Closes` line).

**Fix:** Manually close #442, #444, #450 with a comment linking to PR #451.

**Effort:** 2 minutes.

### F2: Three unchecked manual test items

The PR test plan has three unchecked manual items:
- `[ ] Manual: editor width slider goes down to 40%`
- `[ ] Manual: load annotation file with color: "red" → loads as yellow`
- `[ ] Manual: fresh profile → showAuthorship is true`

These are verification items, not code changes. Unit tests cover clamping behavior (`editorWidthPercent` clamps to 40), migration logic (`migrateToV1` maps red→yellow), and defaults (`showAuthorship` defaults to true). However, the manual tests verify the actual UI — the slider reaching 40%, the visual rendering of migrated colors, and the authorship decorations appearing on a fresh profile. Clamping tests don't prove the slider `min` attribute is correct.

**Fix:** Execute the manual tests (start dev server, verify each item in the browser), then update the PR body checklist.

**Effort:** 15 minutes.

### F3: Stale references in `docs/v090-plan.md`

The v0.9.0 plan (which was written before PR #451 shipped) still describes PR 2 work as **unfinished**. Now that PR #451 has merged, several sections are stale:

1. **Line 30–31:** `#440` described as "no field exists yet" — field now exists.
2. **Lines 35–37:** `#442` and `#444` described as unfinished with specific line numbers that have shifted.
3. **Lines 41:** Highlight palette described as "not tracked as an issue yet" — #450 exists and is implemented.
4. **Lines 78–109:** Full PR 2 spec is now a historical record of completed work — should be marked as DONE.
5. **Dependency graph (lines 201–213):** PR 2 shown as pending — should show completed.

**Fix:** Update `docs/v090-plan.md`:
- Mark PR 2 as **DONE** (merged as PR #451 on 2026-04-27).
- Update the "What's Unfinished" section: move #440, #442, #444 out of the unfinished list. Mark #450 as done.
- Mark spec lines 92 (`min={50}` → `min={40}`) and 102 ("change expected minimum from 50 to 40") as completed — these describe work that shipped, not outstanding items.
- Update the dependency graph to show PR 2 as complete.
- Keep the PR 2 spec text as a record of what was done (don't delete).

**Effort:** 15 minutes.

### F4: Stale references in `docs/redesign-review.md`

Three references to the old 5-color palette:
- Line 90: "5 colors — yellow, red, green, blue, purple"
- Line 382: "yellow/red/green/blue/purple (5 colors)"
- Line 394: "5 entries (yellow/red/green/blue/purple)"

These are in a historical review document written before the palette migration. However, they describe the *codebase* state, which has now changed.

**Fix:** Add a note or strikethrough to each stale line indicating the palette was updated to 4 colors (yellow/green/blue/pink) in PR #451. Don't rewrite the review — it's a point-in-time artifact — but add inline correction so readers don't mistake it for current state.

**Effort:** 5 minutes.

### F5: CHANGELOG.md stale reference

Line 168 says "all 5 highlight colors listed (yellow, red, green, blue, purple)." This is historical (describes what shipped in an earlier version), so it's technically accurate — it describes what was true at that point. No fix needed.

**Effort:** None — no action.

### F6: `tabbed-left` renders as `tabbed` (right-side panel)

The `App.tsx` render logic has two branches: `three-panel` (explicit check) and else (handles both `tabbed` and `tabbed-left`). Selecting `tabbed-left` in settings currently renders a right-side tabbed layout. This is intentional per the PR description ("render logic deferred to PR 7 (#445)"), but worth noting:

- `getRightWidth(layout)` returns `PANEL_DEFAULT_WIDTH` (300) for `tabbed-left` — this is fine since the panel renders on the right regardless.
- `useDragResize` would create `{ kind: "tabbed", right: latestWidth }` if someone drags the handle while on `tabbed-left` — a minor state inconsistency. Not user-facing since there's no UI to select `tabbed-left` yet (settings UI deferred to Svelte).

**Fix:** No fix needed now. The v0.9.0 plan already tracks PR 7 (#445) for the render branch. Document the known state-transition edge case in the issue.

**Effort:** 2 minutes (comment on #445).

### F7: Roadmap `docs/roadmap.md` should reflect PR #451 as shipped

The roadmap lists #440, #442, #444 as v0.9.0 scope. Now that PR #451 merged, the roadmap should note these items shipped.

**Fix:** Update `docs/roadmap.md` v0.9.0 scope section to mark #440, #442, #444, #450 as shipped (PR #451). The roadmap already has a line for #444 and #450 at line 444+ but may need a "shipped" annotation.

**Effort:** 10 minutes.

### F8: MCP input boundary rejects old color values (review-caught)

`tandem_highlight` validates the `color` argument via `HighlightColorSchema.describe(...)` at `src/server/mcp/annotations.ts:286`. Now that `HighlightColorSchema` is `["yellow", "green", "blue", "pink"]`, any Claude Code session with a cached old tool schema could call `tandem_highlight` with `color: "red"` and get a Zod validation error. The color migration in `schema.ts` only applies to on-disk annotation files — it does not coerce colors at the MCP input boundary.

**Risk assessment:** Low. The risk window is sessions connected before a server restart. Once the server restarts (required to pick up PR #451's code), Claude Code reconnects and receives the new `tools/list` schema. Pre-v1.0, this is acceptable behavior — the tool returns a clear validation error, not a crash or silent data corruption.

**Fix:** No code change needed. Add a note to the PR 7 (#445) or next-PR scope: if MCP-input color coercion is desired (defensive), it would go in the `tandem_highlight` handler before annotation creation. For now, schema cache clears on server restart.

**Effort:** None (documentation only, folded into F6 comment on #445).

### F9: Client render fallback for stale old-color annotations (review-caught)

If a stale CRDT merge re-introduces an annotation with `color: "red"` before file-reload migration runs, the client rendering paths have fallbacks:
- `annotation.ts`: `HIGHLIGHT_COLORS[color] || HIGHLIGHT_COLORS.yellow`
- `AnnotationCard.tsx`: `HIGHLIGHT_COLORS[annotation.color] || "var(--tandem-border)"`

The annotation renders but with a degraded visual (border color instead of highlight background in the card). This is self-healing — the next file reload or server restart triggers migration. No user-facing action needed.

**Fix:** No code change. The fallback behavior is correct and self-healing.

**Effort:** None.

---

## Implementation Sequence

All fixes are independent. Execute in a single PR or as inline commits to master.

| # | Finding | Type | Action |
|---|---------|------|--------|
| 1 | F1 | Housekeeping | Close #442, #444, #450 via `gh issue close` |
| 2 | F2 | Verification | Run manual tests in browser, update PR body |
| 3 | F3 | Docs | Update `docs/v090-plan.md` — mark PR 2 done, spec lines as completed |
| 4 | F4 | Docs | Add correction notes to `docs/redesign-review.md` |
| 5 | F6+F8 | Docs | Comment on #445 about state-transition edge + MCP color note |
| 6 | F7 | Docs | Update `docs/roadmap.md` with shipped status |
| — | F5, F9 | No action | Historical changelog accurate; client fallbacks self-healing |

Doc fixes (F3, F4, F7) should be a single commit: `docs: mark PR #451 items as shipped in v0.9.0 plan and roadmap`.

**Total effort:** ~45 minutes.

---

## Verification

After fixes:
1. `gh issue view 442 444 450 --json state` — all CLOSED
2. PR #451 body checklist — all items checked
3. `docs/v090-plan.md` — PR 2 marked DONE
4. `docs/roadmap.md` — #440, #442, #444, #450 annotated as shipped
5. `docs/redesign-review.md` — stale palette references annotated
6. #445 — comment noting `tabbed-left` state-transition edge case
