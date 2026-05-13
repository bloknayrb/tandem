# Tandem Codebase Audit v2

## Context

Tandem is at v0.11.2. This audit follows the "report then fix" precedent of `docs/audit-v1.md` (v0.7.1) but with a wider lens: not just god-files and structure but also **dead code, dependency bloat, over-engineering, wrong-tool-for-the-job, and stale docs**.

The audit was run as a planned eight-step process (`/root/.claude/plans/i-want-you-to-lexical-pearl.md`):
1. Scoping interview
2. Tooling install (`knip` + custom audit scripts — PR #621, merged as Step 1)
3. Pre-scan greps
4. Mechanical scans → categorized candidate list
5. Domain reviewers validate / veto
6. Subtree judgment passes
7. Supplementary scans (MCP usage, bundle size, hooks, schema, deps, docs)
8. This synthesis

Three reviewers (annotation-model, CRDT, security) validated every dead-code candidate before it landed in this report. A fourth (svelte-migration) covered the React→Svelte 5 migration leftovers. Their job was to **veto bad deletion candidates**, not just rubber-stamp the scans.

---

## Status: all recommendations executed

All five recommendations below were executed in PR #621 (this report's home PR). 11 commits, ~250 LOC removed, all CI green:

| Item | Commit |
|---|---|
| Audit foundation (tooling) | `2a1c2ff` |
| Audit doc | `9bff594` |
| PR-C (audit:origins AST rewrite) | `002197d` |
| PR-A1 (reloadFromDisk → FILE_SYNC_ORIGIN) | `8300a33` |
| PR-A2 (tutorial note author) | `88273c8` |
| PR-A2b (useTutorial hook fix) | `373e58e` |
| PR-A3 (specific error codes) | `e78d34b` |
| PR-B (Y.Map keys + dep removals) | `5cd29d7` |
| PR-D1 (13 React-migration stubs) | `8a1f4c4` |
| PR-D2 (server unused exports + alias migration) | `0fff766` |
| PR-D3 (shared constants + types + doc refs) | `7b7b2a5` |
| PR-D4 (client unused exports) | `9249540` |
| PR-D5 (colors.ts + CLAUDE.md) | `e4c5de8` |
| Review-driven fixes (PR-A1 scope correction + 3 misc) | `8d9c0ce` |

### Post-merge review (full domain reviewer pass on PR diff)

Four domain reviewers (annotation-model, crdt, security, svelte-migration) reviewed the full PR end-to-end after all commits landed. Result: one blocker fixed in `8d9c0ce`, plus three small followups.

- **CRDT BLOCKER (fixed):** Original PR-A1 flipped *both* transactions in `reloadFromDisk` to `FILE_SYNC_ORIGIN`. The second transaction (line 854, the `RANGE_MOVED` textSnapshot-driven relocation pass) writes new range/relRange to the annotation Y.Map — those are real CRDT writes that must persist. With `FILE_SYNC_ORIGIN`, the durable-annotation sync observer skipped them; the relocation lived only in memory and would be lost on server restart. Fix: keep only the first transaction (content repopulate + awareness clear) as `FILE_SYNC_ORIGIN`; second transaction reverts to `MCP_ORIGIN`.
- **Annotation LOW (fixed):** `errorCodeToHttpStatus` in `src/server/mcp/routes/_shared.ts` didn't map the new codes (`NOT_FOUND` / `ANNOTATION_RESOLVED` / `INVALID_ARGUMENT`). Latent until any HTTP route surfaces them, but added now for forward-safety.
- **Svelte LOW (fixed):** Stale comment in `registry.svelte.ts:27` referenced removed `getActions()`; dead re-exports in `useEditorFont.svelte.ts` (only consumer was the removed `createEditorFont`).
- **Security LOW (deferred):** Awareness observer at `src/server/events/observers/awareness.ts:54` skips `MCP_ORIGIN` only. With PR-A1's correct scope (first transaction = `FILE_SYNC_ORIGIN`), the awareness clear during file-watcher reload now fires the observer. Current behavior is benign (no SSE event emitted; just clears the per-doc selection buffer). Adding `FILE_SYNC_ORIGIN` to the filter would be defense-in-depth — tracked as a v0.12 followup.

## Top 5 Recommendations (ranked)

The full findings appendix is below for engineers; the items here are the ones I recommend you approve now.

### 1. Fix the 3 bonus correctness findings the reviewers spotted (HIGH)
While validating dead-code candidates, the CRDT and annotation reviewers spotted three genuine correctness bugs the mechanical scans missed. These are not leanness items — they're real bugs.

- **`reloadFromDisk` uses `MCP_ORIGIN` where it should use `FILE_SYNC_ORIGIN`** (`file-opener.ts:798-811`). Per Critical Rule #2, file-watcher reloads should not echo through the channel as user-intent writes. The durable-annotation sync observer skips `FILE_SYNC_ORIGIN`, so MCP-tagging here can re-persist state just loaded from disk. **Needs deeper review** — may have been deliberate.
- **`tutorial-annotations.ts:85` writes `author: "claude"` for a user-private note.** The sanitize/filter pipeline gates on `type`, not `author`, so it's not a privacy leak — but the data model is inconsistent. Consider `author: "import"` or a `"system"` author.
- **`annotations.ts` returns `INVALID_RANGE` for non-range failures** (lines 478, 505, 530, 536, 541, 548 — e.g., "annotation not found", "cannot edit a dismissed annotation"). The reply helper at line 642 already uses correct codes (`NOT_FOUND`, etc.); these handlers should match.

**Effort:** ~1 day across all three. **Risk:** medium — the `MCP_ORIGIN` → `FILE_SYNC_ORIGIN` change touches event filtering; needs CRDT reviewer follow-up on the PR.

### 2. Tune `audit:origins` script + use it as a CI gate (MEDIUM)
The first run flagged 13 untagged `transact()` calls. The CRDT and annotation reviewers confirmed **all 13 are false positives** — the heuristic's 8-line lookahead window is too small (real transactions span 30-50 lines). The script needs proper brace-balanced scanning to be useful. Once it's accurate, graduate it to a pre-commit hook (the existing `.claude/hooks/check-ymap-keys.sh` is the same pattern).

**Effort:** ~2 hours. **Risk:** low.

### 3. Fix the 5 raw Y.Map key Rule #1 violations (LOW-MEDIUM)
Mechanical scan finding, all confirmed real by the annotation + security reviewers:
- `src/server/mcp/channel-routes.ts:60` — `"claude"` → `Y_MAP_CLAUDE`
- `src/server/mcp/document.ts:546` — `"claude"` → `Y_MAP_CLAUDE`
- `src/server/mcp/file-opener.ts:346, 686, 735` — `"readOnly"` → `Y_MAP_READ_ONLY`

All are functionally equivalent (string values match), so no behavior change — but Rule #1 exists to prevent silent drift. Single small PR. **Effort:** 15 minutes. **Risk:** none.

### 4. Remove 2 truly unused dependencies (LOW)
- `@tiptap/extension-unique-id` (prod dep) — zero imports anywhere
- `concurrently` (devDep) — superseded by `scripts/dev-standalone.mjs`; only the lock file references it

Removing both shrinks `node_modules` and the lock file. **Effort:** 5 minutes. **Risk:** none.

### 5. Remove confirmed-dead code (MEDIUM)
Svelte reviewer confirmed: of the 17 "unused files," **12 are `export {};` stubs** left over from the v0.10 React→Svelte 5 migration. The original React hooks were ported to parallel `.svelte.ts` files and the originals reduced to empty re-exports that were never deleted:
- `components/settingsStyles.ts`
- `hooks/useConnectionBanner.ts`, `useCoworkStatus.ts`, `useDragResize.ts`, `useFileDrop.ts`, `useNotifications.ts`, `useReviewCompletion.ts`, `useReviewKeyboard.ts`, `useSaveShortcut.ts`, `useTandemModeBroadcast.ts`, `useTutorial.ts`, `useWebViewZoom.ts`
- `panels/useAnnotationReview.ts`

Three flagged files are **KEEP** — knip's blind spot for lazy `() => import(...)` patterns (`svelte-harness/registry.ts`):
- `components/CoworkSettings.svelte` (also lazy-imported by `SettingsPopover.svelte:564`)
- `panels/DocumentHealth.svelte`
- `hooks/useModeGate.svelte.ts`

One needs a final caller check: `hooks/useReviewCompletion.svelte.ts` (CRDT reviewer found tests reference it but no production import — Svelte reviewer says verify before deletion).

Plus dead constants + types in `shared/`:
- 8 unused constants with zero non-decl uses: `MAX_WS_PAYLOAD`, `MAX_WS_CONNECTIONS`, `IDLE_TIMEOUT`, `OVERLAY_STALE_DEBOUNCE`, `SERVER_INFO_DIR`, `SERVER_INFO_FILE`, `EDITOR_WIDTH_MODE_KEY`, and one more (knip false positive on `COWORK_RESCAN_DEBOUNCE_MS`)
- 2 paired types: `WidthMode`, `ServerInfo`

Plus unused server exports: `killClaude`, `getHocuspocus`, `getClaudeStatus`, `AwarenessState`, `shutdownForTests` (deprecated alias).

Plus 3 unused client exports: `unregisterAction`, `unregisterByPrefix`, `getActions` from `actions/registry.svelte.ts` (`getActionsMap` is the public surface), and `createEditorFont` from `useEditorFont.svelte.ts` (`createRootEditorFont` is what App imports).

Plus the **`errorStateColors` / `successStateColors` / `suggestionStateColors` decision** (see Bonus findings — doc says they should be used; reality is no consumer).

**Effort:** ~2 hours, single PR or split by subtree. **Risk:** low — every item validated by domain reviewer; revert is trivial.

---

## Strengths

What's working well — honest, not just criticism. Mirroring v1's section.

- **Critical Rules are mostly held.** Only 5 raw Y.Map key violations across 33k LOC — and all functionally equivalent. Origin tagging discipline is strong (audit:origins flagged 13, reviewers veto'd all 13 as the heuristic's fault, not the code's).
- **ADR-027 privacy is intact.** Every `directedAt` reference is in deprecation/sanitization code; every server-side `type: "note"` emit is intentional and gated.
- **Position system is sound.** All low-level `flatOffsetToRelPos`/`relPosToFlatOffset` callers outside `positions.ts` are legitimate (docx-apply.ts: read-only collection during write batch; document.ts: re-exports for the public position API).
- **Security mitigations intact.** DNS rebinding (Host-header allowlist + auth middleware), CORS allowlist (`TAURI_HOSTNAME`), Hocuspocus WebSocket origin check — all verified by security-reviewer.
- **`tandem_convertToMarkdown`'s use of `extractMarkdown()` is a legitimate exception** to Critical Rule #5, not a violation. The rule targets coordinate-consuming paths; convert.ts is a one-shot format transformation that writes a fresh file.
- **Test coverage is healthy.** 1945 tests across 143 files pass on every push; pre-push hook also runs `cargo test` for the Tauri crate.
- **Documentation is exceptional** — CLAUDE.md, 29 ADRs, lessons learned, MCP tool reference. Rare for a project this size.

---

## Verified load-bearing despite appearance

These were flagged by knip but confirmed alive. Catalogued so audit-v3 doesn't re-flag them. Inspired by audit-v1's "Explicit deferrals" section.

| Symbol / File | Why knip flagged it | Why it's alive |
|---|---|---|
| `components/CoworkSettings.svelte` | Knip can't trace `() => import(...)` lazy imports | Lazy-imported via `SettingsPopover.svelte:564` and `svelte-harness/registry.ts` |
| `panels/DocumentHealth.svelte` | Same — knip dynamic-import blind spot | Registered in `svelte-harness/registry.ts:16` lazy map |
| `hooks/useModeGate.svelte.ts` | Svelte rune file with no static caller | Documented Svelte 5 port; tests reference by name; sibling `.ts` re-exports utilities |
| `warningStateColors` in `utils/colors.ts` | Not flagged — knip handles it correctly | Imported by `panels/SidePanel.svelte` for the held-annotations banner |
| `tutorial-annotations.ts:43` `type: "note"` emit | ADR-027 pre-scan flagged it | Tutorial intentionally seeds a user-private note (gated by observer's `type !== "comment"` filter) |
| `convert.ts` `extractMarkdown()` import | Critical Rule #5 pre-scan flagged it | Format-conversion tool, not coordinate-consuming. Output is a new .md file; annotations re-anchor on next open |
| `docx-apply.ts:104-105` raw `relPosToFlatOffset` | Critical Rule #4 pre-scan flagged it | Read-only collection during a write batch; can't mutate via `refreshRange` |
| `document.ts:65,68` raw position imports | Critical Rule #4 pre-scan flagged it | Re-exports for the public position API surface |

**The lazy-import pattern in `svelte-harness/registry.ts` is a permanent knip blind spot.** Any future `.svelte` file flagged by knip must be cross-checked against that registry before deletion. Worth adding the registry path to `knip.json` `ignore` entries explicitly so the rule is documented.

---

## Bonus correctness findings

Things the domain reviewers spotted *while validating dead-code candidates* — outside the audit's scan scope. These are the highest-value items in the entire audit.

| Finding | File | Reviewer | Severity |
|---|---|---|---|
| `reloadFromDisk` tagged `MCP_ORIGIN`, should likely be `FILE_SYNC_ORIGIN` | `src/server/mcp/file-opener.ts:798-811` | CRDT | HIGH |
| `textSnapshot` mismatch after CRDT-resolved offsets in `docx-apply.ts` | `src/server/mcp/docx-apply.ts:100-118` | CRDT | MEDIUM |
| Tutorial note has `author: "claude"` instead of user/system | `src/server/mcp/tutorial-annotations.ts:85` | Annotation | LOW |
| `INVALID_RANGE` error code used for non-range failures (6 sites) | `src/server/mcp/annotations.ts:478,505,530,536,541,548` | Annotation | MEDIUM |
| `notesExcluded` count uses already-filtered results | `src/server/mcp/annotations.ts:445` | Annotation | LOW |
| `use-review-completion.test.ts` doesn't exercise the actual hook (inline reimplementation) | `tests/client/use-review-completion.test.ts` | CRDT | LOW |
| **Doc/code discrepancy:** `CLAUDE.md:85` (and `docs/run-b-plan.md:179`) advertise `errorStateColors`/`successStateColors`/`suggestionStateColors` as an API to prefer, but no surface imports them. Either delete the constants + update docs, OR add knip ignore entries if a near-term refactor will use them. | `src/client/utils/colors.ts:10,19,37` + `CLAUDE.md:85` | Svelte | MEDIUM |

---

## Findings — appendix

### Mechanical scan results
*Run on commit `2a1c2ff`, knip 5.88.1.*

| Scan | Total | Confirmed real | False positives | Notes |
|---|---|---|---|---|
| Unused files | 17 | **13** (12 React stubs + 1 .svelte.ts to verify) | 3 (lazy-imported via `svelte-harness`) | Svelte reviewer validated each |
| Unused dependencies | 1 | 1 | 0 | `@tiptap/extension-unique-id` |
| Unused devDependencies | 1 | 1 | 0 | `concurrently` |
| Unlisted dependencies | 10 | low priority | TBD | Mostly type-only / transitive |
| Unused exports | 18 | **13** | 1 (`COWORK_RESCAN_DEBOUNCE_MS` has 2 non-decl uses) + 3 docs-advertised (colors) | 9 constants + 4 functions |
| Unused exported types | 6 | 2 confirmed (`WidthMode`, `ServerInfo`) | 1 needs-domain-review (`AwarenessState` — confirmed dead by CRDT review) | 3 still needs-human-check |
| Duplicate exports | 1 | 1 | 0 | `shutdownForTests` (deprecated alias) |
| `audit:origins` candidates | 13 | **0** | 13 | Heuristic too narrow — script needs fix |
| `audit:ymap-keys` candidates | 5 | 5 | 0 | All Rule #1 violations |
| `check:tokens` | clean | — | — | ✓ |
| `check:fonts` | clean | — | — | ✓ |

### Bundle composition (post-build)

| Bundle | Size | Notes |
|---|---|---|
| `dist/server/index.js` | **12 MB** | Self-contained, ships in Tauri sidecar. Largest by far — worth investigating composition |
| `dist/channel/index.js` | 1.7 MB | Self-contained |
| `dist/monitor/index.js` | 452 KB | Self-contained |
| `dist/cli/index.js` | 236 KB | External deps allowed (npm install path) |
| `dist/client` | 1.2 MB | Vite output (Tauri WebView) |

The 12 MB server bundle is the biggest leanness question in this audit. Tauri ships it to every desktop user; investigating what dominates (likely tiptap + y-prosemirror + remark) and whether any can move to lazy paths is worth a focused pass.

### MCP tool usage in `.claude/` automation

18 of 30 MCP tools have **zero references** in `.claude/skills/`, `.claude/agents/`, `.claude/hooks/`, or `.claude-plugin/`:

```
tandem_annotationReply, tandem_applyChanges, tandem_close, tandem_comment,
tandem_convertToMarkdown, tandem_ctrl, tandem_getActivity, tandem_getContext,
tandem_getOutline, tandem_getTextContent, tandem_listDocuments,
tandem_removeAnnotation, tandem_reply, tandem_resolveAnnotation,
tandem_resolveRange, tandem_restoreBackup, tandem_scratchpad, tandem_search,
tandem_suggest, tandem_switchDocument
```

**Caveat:** Many of these are meant to be called by Claude interactively in user workflows, not by Tandem's own skills. So "zero refs" doesn't equal "unused." But the 12 tools that *are* referenced (`tandem_checkInbox` 7, `tandem_status` 6, `tandem_exportAnnotations` 4, `tandem_edit` 3, `tandem_getAnnotations` 3, etc.) are clearly the core surface. The other 18 are candidates for runtime telemetry review.

### Hooks inventory

11 hooks in `.claude/hooks/`, all wired in `settings.json`:
- **PreToolUse:** `block-sensitive`, `block-no-verify`, `block-e2e-port-kill` (3)
- **PostToolUse:** `format-on-edit`, `typecheck-on-edit`, `check-ymap-keys`, `check-extract-markdown`, `check-console-log`, `svelte-check-on-edit`, `check-token-violation`, `related-test` (8)

No obvious overlap or staleness. The `check-ymap-keys.sh` hook is **independent of** the new `audit:ymap-keys` script — different scan strategies (the hook checks staged edits; the script does a repo-wide audit). Worth a follow-up: should they share logic?

---

## Proposed phases — appendix

### Phase 1 — Quick wins (HIGH leverage, LOW risk)
- Top-5 #3: 5 Y.Map key fixes (single PR)
- Top-5 #4: 2 unused-dep removals (single PR, can combine with #3)

**Effort:** ~30 min. **Verification:** `npm run typecheck && npm test` per PR.

### Phase 2 — Correctness fixes (HIGH leverage, MEDIUM risk)
- Top-5 #1.a: `reloadFromDisk` origin tag review and possible flip to `FILE_SYNC_ORIGIN` (CRDT reviewer must re-review)
- Top-5 #1.b: tutorial note `author` field
- Top-5 #1.c: `INVALID_RANGE` error code at 6 sites

**Effort:** ~1 day. **Verification:** Full test suite + manual smoke (file-watcher reload, tutorial open, annotation edit failures). PR diff goes through annotation-model-reviewer + crdt-reviewer.

### Phase 3 — Audit-tooling tuning (LOW risk)
- Top-5 #2: Fix `audit:origins` heuristic (brace-balanced scan instead of 8-line window). Re-run; expect ≤2 real findings or zero.
- Decide whether `audit:ymap-keys` graduates to a pre-commit hook (parallels existing `check-ymap-keys.sh`).

**Effort:** ~2 hr. **Verification:** Manual review of new audit output.

### Phase 4 — Dead-code sweep (MEDIUM risk)
- Top-5 #5: Remove the confirmed-dead files (CRDT-reviewer-confirmed + Svelte-reviewer-pending) + 8 unused constants + 2 paired types
- Remove unused server exports: `killClaude`, `getHocuspocus`, `getClaudeStatus`, `AwarenessState`, `shutdownForTests` alias

**Effort:** ~2 hr after Svelte reviewer returns. **Verification:** `npm run typecheck && npm test && npm run test:e2e`. Each removed export gets a final grep to confirm no dynamic-string use.

### Phase 5 — Bundle composition investigation (LOW risk, defer)
- Investigate 12 MB server bundle. Generate `tsup --metafile`, inspect top contributors.
- Decide if anything moves to lazy/dynamic import. Tauri sidecar size is end-user-visible.

**Effort:** ~half day. **Verification:** bundle size delta in MB.

---

## Explicit deferrals

Things surfaced but recommend NOT acting on (mirrors v1's section).

| Item | Decision | Rationale |
|---|---|---|
| **Knip config hints (14)** — remove redundant `entry` / `ignore` entries from `knip.json` | Defer | Explicit config reads as documented intent for maintenance. The hints don't break anything. |
| **8 of 30 MCP tools unused in `.claude/`** | Defer | Most are called by Claude interactively, not from .claude/ automation. Runtime telemetry would be a more reliable signal than static scan. |
| **`audit:strict` (`tsc --noUnusedLocals`)** | Defer (from plan Step 1) | Would fire on every WIP file. Only worth wiring as CI gate, not local. |
| **Unlisted dependencies (10)** | Defer most | Mostly type-only (`mdast`), transitive (`domhandler`, `prosemirror-state` via `@tiptap/pm`), or devDep-style (`@vitest/coverage-v8`). Add explicit `@types/mdast` if it's not already pulled. |
| **MCP tool deprecation pass** | Defer | Would need runtime usage data, not static analysis. Worth a separate effort. |
| **Phase 5 bundle investigation** | Defer to v0.12 | Won't block any user; lower leverage than correctness fixes. |

---

## What this audit is missing

Honest about gaps:

- **No runtime profiling.** "Leanness" is currently LOC + bundle bytes + dependency count. Runtime performance is uncharted; the user reported "nothing feels slow" so this is acceptable.
- **No Rust dead-code pass.** `src-tauri/` is 10 files; `cargo udeps` requires nightly and was skipped per the plan.
- **No test-quality review** beyond what came up incidentally (the `use-review-completion.test.ts` inline-reimpl finding). Test coverage is healthy; test quality is a separate audit.
- **MCP tool surface trim is signal-poor.** Without runtime call counts we can't reliably deprecate. The 18 zero-ref tools are *candidates for investigation*, not deletion.
- **Schema review didn't surface findings.** `Y_MAP_*` constants are clean (5 raw-key violations are the only signal). Session JSON shape and on-disk annotation format were not deeply audited — defer.

---

## Verification gate (for each fix PR)

`npm run typecheck && npm test && npm run test:e2e` must pass. For PRs touching `src/server/events/`, `src/server/positions.ts`, `src/server/mcp/annotations*`, or `src/server/file-io/`, the relevant domain agent re-reviews the diff. Audit doc updated to mark the finding DONE with PR link.
