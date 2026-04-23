# Tandem Codebase Audit — Full Quality Sweep

## Context

Tandem is at v0.7.1 heading toward v1.0. Before adding more features, we're auditing the entire codebase (24,370 LOC source, 23,548 LOC tests) for modularity, interface quality, cleanliness, and correctness. This is a "report then fix" approach: findings first, then we prioritize and execute together.

Plan reviewed by three independent agents against actual source code. Corrections applied.

---

## Part 1: Audit Findings

### Severity: HIGH — Modularity / God-Files

| # | File | LOC | Problem |
|---|------|-----|---------|
| 1 | `src/client/App.tsx` | 956 | Root god-component. Manages layout, panels, settings broadcast, drag-resize, keyboard shortcuts, review mode, connection banner, tandem mode — all inline. Also contains inline component definitions (`EmptyState`, `ConnectionBanner`) and three near-identical SidePanel+ChatPanel render sites. |
| 2 | `src/client/panels/SidePanel.tsx` | 911 | Mixes annotation filtering, review-mode navigation, bulk accept/dismiss, timed undo, reply handling, and scroll management in one component. |
| 3 | `src/server/mcp/file-opener.ts` | 625 | ~26 imports. `openFileByPath()` (~141 LOC) interleaves path validation, format detection, session restore, file loading, annotation wiring, and auto-save setup. |
| 4 | `src/server/mcp/api-routes.ts` | 584 | Mixes 11 Express route handlers with middleware factories, multipart parsing, file I/O coordination, and token rotation. |
| 5 | `src/server/events/queue.ts` | 602 | Manages annotation, reply, awareness, chat, and document-meta observers in one module, plus buffer management, file-sync context registry, selection dwell logic, and a shared `selectionBuffer` Map consumed across observer types. |
| 6 | `src/client/editor/toolbar/Toolbar.tsx` | 585 | Annotation creation UI, color picker, comment mode toggle, solo/tandem switch. |
| 7 | `src/client/components/SettingsPopover.tsx` | 590 | Layout, theme, text size, panel order, user name, dwell time, accessibility — all in one popover. |
| 8 | `src/client/panels/AnnotationCard.tsx` | 555 | Card display, inline edit mode, reply thread, action buttons, color logic. |

### Severity: HIGH — Layer Boundary Violations

| # | Finding | Impact |
|---|---------|--------|
| 9 | **Wire-protocol types in wrong layer.** `src/server/events/types.ts` exports runtime values (`parseTandemEvent`, `formatEventContent`, `formatEventMeta`) consumed by `src/channel/event-bridge.ts` and `src/monitor/index.ts`. These should live in `src/shared/`. | Channel and monitor self-contained bundles pull in `src/server/` code. Transitive leaks possible if `types.ts` ever imports other server modules. |
| 10 | CLI imports `getTokenFilePath` from `src/server/auth/token-store.ts` | Minor — function is pure, but crosses the server layer boundary. |

### Severity: HIGH — Missing Test Coverage

| # | Module | Gap |
|---|--------|-----|
| 11 | File-opener lifecycle phases | Existing tests (`file-opener-edge-cases.test.ts`, 198 LOC) cover validation/rejection only. No coverage for: session restore path (hit vs stale mtime), force-reload (annotation clear + content reload), annotation wiring on open, file-watcher setup. |

**Note:** Annotation durability (store.ts, sync.ts) has comprehensive test suites (~30+ test cases each covering lockfile, merge, tombstones, rev-counter, swap/close phases). Event queue has 44 test cases covering origin filtering, buffer eviction, observer lifecycle. Position system has 545 LOC of tests. These were initially flagged as untested but the review agents confirmed otherwise.

### Severity: MEDIUM — Interfaces / Performance / Config

| # | Finding | Location |
|---|---------|----------|
| 12 | **Excessive prop drilling** | SidePanel receives 14 props, ChatPanel 11. No React Context anywhere. |
| 13 | **useYjsSync.ts** at 350 LOC | Central state hub with 10 interleaved refs managing tabs, annotations, connection, providers. |
| 14 | **5 unused `@tauri-apps/plugin-*` npm packages** | `dependencies` in `package.json` — zero TypeScript imports in `src/`. Only used Rust-side via Cargo. Inflate self-contained server/channel/monitor bundles via tsup's `noExternal: [/.*/]`. |
| 15 | **`tsconfig.server.json` doesn't extend `tsconfig.json`** | Duplicates `target`, `module`, `moduleResolution`, `strict`, etc. Option drift risk. |
| 16 | **No `noUnusedLocals`/`noUnusedParameters`** in either tsconfig | Dead exports accumulate silently with no CI enforcement. |

### Severity: LOW — Style / Standards / Polish

| # | Finding | Location | Tracked? |
|---|---------|----------|----------|
| 17 | Raw hex `rgba(99,102,241,…)` for Claude cursor. Fix requires `color-mix()` for alpha, not simple var replacement. | `awareness.ts` | #355 |
| 18 | ~120 lines of CSS in inline `<style>` tag | `Editor.tsx` | No |
| 19 | Missing `aria-selected` on tab toggle buttons | `App.tsx` | No |
| 20 | Resize handles are keyboard-inaccessible (have `tabIndex` + `role="separator"` but no `onKeyDown`) | `App.tsx` | No |
| 21 | No keyboard navigation for color picker | `Toolbar.tsx` | No |
| 22 | Tauri TODO: file path on second instance | `lib.rs:66` | No |
| 23 | E2E tests don't cover error recovery / network failure | `tests/e2e/` | No |
| 24 | No Rust integration tests for sidecar restart | `src-tauri/` | No |
| 25 | Stale git worktrees accumulating | `.claude/worktrees/` | No |
| 26 | Two `as any` casts are not Y.js workarounds: Hocuspocus internal access (`provider.ts:144`), Express 5 type gap (`server.ts:303`) | Server layer | No |

### Strengths (What's Working Well)

- **Architecture is sound.** Three-layer separation (Client → Server → Claude Code) with clean boundaries. Shared layer has zero `any` types and uses branded types for coordinate systems.
- **Security is thorough.** DNS rebinding protection, bearer token auth with rotation, loopback bypass, UNC path rejection, CSPRNG token generation, OS keyring (desktop) / file-based token storage (npm install).
- **Annotation durability is well-tested.** store.ts and sync.ts have comprehensive suites covering lockfile, merge semantics, tombstones, rev-counter, swap/close phase cleanup.
- **Event queue tests are excellent.** 44 test cases covering origin filtering, buffer eviction, swap/close phases, tombstone lifecycle, dwell timer — all critical CRDT invariants.
- **Position system is well-designed.** Branded types prevent coordinate-system confusion. Both server and client modules are well-tested (545 LOC).
- **CLI and Tauri layers are clean.** CLI is 1,177 LOC with good error handling. Tauri integration handles sidecar lifecycle, updates, and graceful degradation correctly.
- **Documentation is excellent.** Architecture docs, ADRs, lessons learned, MCP tool reference — rare for a project this size.
- **Test ratio is healthy.** 22k LOC of tests for 24k LOC of source (~1:1).
- **Error handling is consistent.** Auto-save, mode cache, and annotation observer all have proper error logging (initially suspected as silent failures but confirmed to have logging at all three sites).

---

## Part 2: Proposed Phases

### Phase 1: Shared / Foundation Cleanup — DONE

All 6 PRs merged 2026-04-22. Typecheck passes clean.

| PR | Finding | Branch |
|----|---------|--------|
| #384 | Wire-protocol types to shared (#9) | `refactor/wire-protocol-types-to-shared` |
| #385 | Token-store shared extraction (#10) | `refactor/token-store-shared-extraction` |
| #386 | awareness.ts semantic tokens, closes #355 (#17) | `refactor/awareness-semantic-tokens` |
| #387 | Editor CSS extraction (#18) | `refactor/editor-css-extraction` |
| #388 | tsconfig tightening (#15, #16) | `refactor/tsconfig-tightening` |
| #389 | Remove dead Tauri JS deps (#14) | `refactor/remove-dead-tauri-deps` |

### Phase 2: Server Mechanical Splits
**Why:** Break up server god-files while maintaining identical public interfaces.

**PR 2a — api-routes.ts decomposition (finding #4):**
- Extract 11 route handlers to `src/server/mcp/routes/{open,close,save,upload,setup,convert,mode,apply-changes,annotation-reply,rotate-token,notify-stream}.ts`
- Each exports a handler factory: `(deps) => (req, res) => void`
- `api-routes.ts` becomes orchestration: `registerApiRoutes()` wires handlers, keeps middleware factories (`createApiMiddleware`, `apiMiddleware`, `sendApiError`, `errorCodeToHttpStatus`)
- Re-export all public symbols so existing tests don't break

**PR 2b — file-opener.ts internal helpers (finding #3):**
- Extract from `openFileByPath()`:
  - `resolveAndValidatePath(filePath)` → `{ resolved, ext, stat, format, id }`
  - `handleAlreadyOpen(id, existing, force)` → early result or null
  - `maybeRestoreSession(resolved, doc)` → `{ restoredFromSession, session }`
  - `loadContentIntoDoc(doc, format, filePath)` → loads via adapter
  - `finalizeDocOpen(id, doc, ...)` → wire annotations, broadcast, auto-save
- Orchestration becomes ~40 lines calling these in sequence
- No export signature changes
- Also add `tests/server/file-opener-lifecycle.test.ts` (finding #11): session restore hit vs stale mtime, force-reload, annotation wiring

**Effort:** ~2 days. Both PRs parallelizable.
**Verification:** `npm run typecheck && npm test && npm run test:e2e`. All existing test imports unchanged.

### Phase 3: Event Queue Observer Split (finding #5)
**Why:** Break the 602-LOC monolith into focused observer modules. Highest-risk refactor — touches origin-tag filtering and observer lifecycle invariants.
**Prerequisite:** Existing queue + annotation tests serve as safety net (1,331 + 1,531 LOC of existing tests).

**Target structure:**
```
src/server/events/
  queue.ts              — buffer, pushEvent, subscribe, replaySince, selectionBuffer (~120 LOC)
  file-sync-registry.ts — fileSyncContexts Map, set/clear/reattach (~80 LOC)
  observers/
    annotations.ts      — annotation Y.Map observer factory
    replies.ts           — reply Y.Map observer factory
    awareness.ts         — awareness observer factory (receives selectionBuffer)
    ctrl-chat.ts         — CTRL_ROOM chat observer (receives selectionBuffer)
    ctrl-meta.ts         — CTRL_ROOM document meta observer
```

**Migration approach:**
1. Extract `file-sync-registry.ts` first (cleanest boundary)
2. Extract each observer as `(docName, map, pushEvent, selectionBuffer?) => cleanup` — the `selectionBuffer` Map lives in `queue.ts` and is passed to both `awareness.ts` (populates) and `ctrl-chat.ts` (consumes + clears). This coupling is explicit and injected, not hidden.
3. `queue.ts` retains origins, buffer, selectionBuffer, subscribe, attach/detach orchestration
4. Re-export everything from `queue.ts` — no downstream import changes

**Effort:** ~1.5 days. Sequential (single agent, high risk).
**Verification:** Existing event-queue tests (44 cases) as regression suite. Manual smoke: open .md, MCP-mutate, user-edit, save, external file edit reload, force-reload, close.

### Phase 4: Client Component Splits
**Why:** Break up client god-components into focused hooks and sub-components.

**PR 4a — App.tsx extractions (finding #1):**
- Extract `EmptyState` and `ConnectionBanner` inline components to `src/client/components/`
- Extract `useDragResize.ts` — drag handler logic + listener setup/cleanup. Takes `{ panelLayout, setPanelLayout }` as input (coupled to layout state — not independently extractable).
- Extract `useTandemModeBroadcast.ts` — tandem mode + dwell-ms localStorage persistence + Y.Map broadcast
- Extract `useConnectionBanner.ts` — disconnect banner state + timeout
- Deduplicate three SidePanel+ChatPanel render sites into a `<PanelSlot>` component
- **Realistic target: App.tsx drops from 956 → ~750 LOC.** (Hooks extract ~100 LOC of logic; component extraction + dedup saves another ~100 LOC. The JSX layout, which is the core job, stays.)

**PR 4b — SidePanel.tsx decomposition (finding #2):**
- `useAnnotationReview.ts` — reviewIndex, navigation, accept/dismiss, undo timers, bulk actions. Note: `resolveAnnotation` is shared between review and non-review callers; pass ydocRef + editorRef via hook params, expose resolveAnnotation in return value.
- `FilterBar.tsx` — three FilterSelect components + Clear button
- `BulkActions.tsx` — bulk accept/dismiss confirmation UI
- **Realistic target: SidePanel.tsx drops from 911 → ~400-450 LOC.**

**PR 4c — Toolbar.tsx + SettingsPopover.tsx (findings #6, #7):**
- Extract `HighlightColorPicker`, `ModeToggle` from Toolbar
- Extract `AppearanceSettings`, `EditorSettings`, `AccessibilitySettings` from SettingsPopover

**PR 4d — AnnotationCard.tsx (finding #8):**
- Extract `AnnotationCardActions`, `AnnotationEditForm`, `ReplyThread`

**Effort:** ~3 days. All 4 PRs parallelizable via worktree agents.
**Verification:** `npm run typecheck && npm test && npm run test:e2e`. Visual check in editor for layout/interaction regressions.

### Phase 5: Prop-Drilling Evaluation (Conditional)
**Why:** After Phase 4, re-evaluate SidePanel's prop count. Currently 14 props; post-Phase 4b, likely 8-10. If still >8, introduce `DocumentContext` (editor, ydoc, documentId, format) and `ReviewContext` (reviewMode, toggleReviewMode, exitReviewMode, activeAnnotationId).
**Effort:** ~0.5 day if needed.

### Phase 6: Polish (Post-v1.0, Individual Small PRs)
- Accessibility: keyboard-accessible resize handles (#20), `aria-selected` on tab toggles (#19), keyboard nav for color picker (#21)
- E2E: error recovery tests — server disconnect, concurrent edits, save timeout (#23)
- Tauri: second-instance file path forwarding (#22), Rust integration tests (#24)
- Repo hygiene: clean stale `.claude/worktrees/` (#25)

---

## Part 3: Explicit Deferrals

These are things the audit surfaced where I'm recommending we **don't** act. Override any of these if you disagree.

| Item | Decision | Rationale |
|------|----------|-----------|
| **useYjsSync.ts** (350 LOC) — split into separate hooks | **Don't split.** | 10 interleaved refs (`bootstrapRef`, `generationIdRef`, `tabsRef`, `pendingIdsRef`, `pendingProvidersRef`, `observersRef`, `tabMetaCleanupsRef`, `handleDocumentListRef`, `hadConnectionRef`, `restartTimerRef`). The re-entrant `handleDocumentListRef.current` callback means any split would need to thread the entire ref bag across hook boundaries. 350 LOC of working code with good naming is better than 3 hooks with subtle timing bugs. |
| **mcp/server.ts** (331 LOC) — extract middleware factories | **Defer to post-v1.0.** | 331 LOC total is manageable. The setup function reads linearly. Extraction gains little and risks breaking the startup sequence. |
| **shared/types.ts** (274 LOC) — split into per-domain type files | **Defer.** | 274 LOC is reasonable for a shared types barrel. Split only if it grows past ~400 LOC. |
| **React.memo** on ChatPanel/SidePanel | **Measure first.** | Both components observe Y.Maps and use refs. Parent re-renders come from props that change meaningfully (`annotations`, `activeTabId`). Adding memo without React Profiler data is speculative. Profile first; wrap only if excessive re-renders confirmed. |
| **Biome linter rules** | **Defer.** | ESLint handles linting. Enabling Biome linter alongside ESLint risks rule conflicts. Consolidate to one tool post-v1.0. |

---

## Dependency Graph

```
Phase 1 (shared/foundation, 6 parallel PRs)
   |              \
   v               v
Phase 2           Phase 4 (client splits, 4 parallel PRs) --> Phase 5 (context, if needed)
   |                                                              |
   v                                                              v
Phase 3 (queue observer split, sequential)                   Phase 6 (polish)
```

Phases 1, 2, and 3 are sequential in dependency but internally parallelizable. Phase 4 can start once Phase 1 lands (no server dependency). Phase 3 no longer blocks on a separate Phase 0 — existing test suites provide the safety net.

## Effort Summary

| Phase | Effort | Parallelism | PRs |
|-------|--------|-------------|-----|
| 1 | ~2 days | 6 parallel | 6 |
| 2 | ~2 days | 2 parallel | 2 |
| 3 | ~1.5 days | Sequential | 1-2 |
| 4 | ~3 days | 4 parallel | 4 |
| 5 | ~0.5 day | If needed | 0-1 |
| 6 | Incremental | Individual | 5-7 |
| **Total** | **~9 days parallel, ~14 serial** | | **~18-22 PRs** |

**To scope down:** Phases 1-2 alone (foundation + server splits) are the highest-value work at ~4 days and directly improve the foundation everything else builds on.
