# Implementation Plan: ADR-031 through ADR-037 (revised v2)

**Date:** 2026-05-15
**Revision:** v2 — incorporates multi-angle agent review findings (crdt-reviewer, annotation-model-reviewer, security-reviewer, svelte-migration-reviewer, general-purpose sequencing) plus Bryan's decisions on (a) `withReload` as a 5th origin, (b) imports enter as notes (ADR-027 revised), (c) bug fixes ship as v0.12.x patches first.
**Scope:** Architectural deepening pass surfaced by `/improve-codebase-architecture`. Seven ADRs (031-037) covering origin tagging, position result variants, document registry, file-open pipeline, annotation lifecycle, format adapter capabilities, and the client layout model.
**Pre-reqs:** v0.12.0 released (master at 77d7378); three bug-fix patches shipped first (see Stage 0).

This plan sequences the seven ADRs plus three targeted bug fixes into PRs, defines each PR's scope, sequencing, test strategy, rollback shape, and risk class. It is **not** a step-by-step coding guide — the ADRs themselves describe the target shape. The plan answers "how do we ship this without breaking the running system" and "in what order does each piece become safe to land."

## Reviewer-driven revisions from v1

1. **Five origins, not four** (CRDT reviewer B1, Bryan's call). Add `withReload(doc, fn)` for the `reloadFromDisk` path — channel skips, durable-sync persists. ADR-031 updated.
2. **Imports enter as notes** (annotation reviewer B1, Bryan's call). ADR-027 revised: `author: "import"` records use `type: "note"`, gated through the existing `promoteNoteToComment` flow. `tandem_checkInbox` continues to ignore notes; imports are not auto-surfaced to Claude. Production behaviour change — call out in v0.13.0 CHANGELOG.
3. **Tombstone observer skip-set widened** (CRDT reviewer B2). `file-sync` and `internal` deletes do NOT produce tombstones, or eviction-and-reopen loses annotations. `mcp` / `reload` / `browser` deletes do produce tombstones.
4. **`ChannelEligible` brand has runtime defense-in-depth** (security reviewer B2). `narrowForChannel` re-asserts `audience === "outbound" && type === "comment"` at runtime; `pushEvent`'s annotation-payload field is typed to require `ChannelEligible`, blocking direct-push bypasses at compile time.
5. **`block-raw-transact` is grep + Biome AST rule** (security reviewer B3). Two layers; grep alone is bypassable by dynamic dispatch.
6. **Bug fixes ship as v0.12.x patches first** (general reviewer #7, Bryan's call). #694, #695, #696 land as targeted patches before PR 1. Subsequent ADR PRs remove the interim fixes.
7. **Sanitize `rev` passthrough stays until sync.ts normalize widens** (annotation reviewer B2). Either keep `rev` in `sanitizeAnnotation` until PR 9 cleanup, or land sync.ts widening in the same PR 6 commit. Plan chooses the latter — sync.ts normalize widening is now PR 6 scope.
8. **Layout model uses getters wrapping `$derived.by`** (svelte reviewer B1). Mirrors the `useTandemSettings.svelte.ts` pattern.
9. **Orphan-rail rule: block-toggle** (svelte reviewer B2, decided here). Matches current App.svelte:916 behaviour; less surprising than force-other-visible.
10. **Stage C is a small DAG, not three independent tracks** (general reviewer #1). PR 6 depends on PR 5; PR 7 depends on PR 4; PR 8 is the only fully independent track. Prose fixed.
11. **Release cadence compressed** (general reviewer #5). Two minor releases, not four. v0.13.0 = Stage 0 + Stage A + PR 5; v0.14.0 = Stage B + Stage C + cleanup.
12. **`file-opener.ts` shim dropped** (general reviewer #2). PR 4 migrates callers directly. Only the `MCP_ORIGIN` / `FILE_SYNC_ORIGIN` re-export shim (2 lines) survives until PR 9.
13. **`.claude/agents/` reviewer prompts updated in PR 1** (general reviewer #7). Otherwise reviewers flag every helper call as a violation.
14. **`docs/architecture.md` updates listed per PR** (general reviewer #8).
15. **Refined refreshRange variant naming** (CRDT reviewer S1). The "no relRange + lazy-attach fails" arm is `degraded`, not `ok`.
16. **Observer skip-set widening lands in PR 1's first commit** (security reviewer S1). Migration window safety.

## Sequencing principles

1. **Bug fixes first.** Three v0.12.x patches before the ADR pass starts.
2. **Foundational types before consumers.** ADR-031 (origin wrappers) and ADR-032 (position variants) are pure type-and-helper additions. Land first.
3. **No mid-PR contract straddling.** Each PR is internally consistent.
4. **Adversarial-agent review on every PR before human review.** Specialist agents pinned per PR below.
5. **Every PR runs the full E2E suite locally and in CI before merge.**

## PR sequence

### Stage 0 — targeted bug fixes (v0.12.x)

Each PR is small, fast to review, ships user-visible fixes within days. Stage 0 is independent of Stage A — does not wait on architectural work.

#### PR 0a: fix #694 — re-accept precondition

Runtime check at `tandem_resolveAnnotation` (`src/server/mcp/annotations.ts:491`). Reject non-pending annotations with `ANNOTATION_NOT_PENDING`. PR 6 later removes this in favour of `acceptPending`'s structural rejection.

**Scope:** ~20 LOC + 2 unit tests. **Risk:** Trivial.

#### PR 0b: fix #695 — tombstone observer widening (narrower form)

Widen `src/server/annotations/sync.ts` to snapshot pre-delete state via `YMapEvent.changes.keys`. Remove `recordTombstone` call from `src/server/mcp/annotations.ts:78`. Skip-set for tombstone records: skip `FILE_SYNC_ORIGIN` deletes (eviction-reopen invariant). `MCP_ORIGIN` records (and the to-be-added `internal` / `reload`) handled cleanly in PR 1.

**Scope:** ~80 LOC + 3 unit tests + 1 integration test (stale-tab merge resurrection regression). **Risk:** Medium — the eviction-skip rule is load-bearing; test explicitly.

**Reviewer:** crdt-reviewer.

#### PR 0c: fix #696 — .docx comment failure notification

Replace silent `.catch(() => [])` at `src/server/file-io/index.ts:50-56` with a notification push via `src/server/notifications.ts` ("Reviewer comments could not be extracted from this .docx file. The document loaded successfully.", 8s error toast). PR 7 later supersedes with structural `LoadResult.partial`.

**Scope:** ~30 LOC + 1 unit test (corrupt comments.xml fixture). **Risk:** Trivial.

---

### Stage A — foundational types (v0.13.0)

Stage 0 must merge first. PR 1 and PR 2 are parallelisable (zero file overlap except `src/server/mcp/annotations.ts`, where merge conflicts are mechanical).

#### PR 1: ADR-031 origin-tagged transaction wrappers

**Scope:**
- Add `src/shared/origins.ts` with **five** helpers (`withMcp`, `withFileSync`, `withInternal`, `withReload`, `withBrowser`) and five origin constants. Export a `transactForTest(doc, fn, origin)` escape hatch for fixtures.
- **First commit of PR 1**: widen the observer skip-sets in `src/server/events/queue.ts`, `src/server/events/observers/*.ts`, `src/server/annotations/sync.ts`. Channel + durable-sync skip-sets become canonical per the ADR-031 matrix. Land this BEFORE any callsite migrates, so a callsite that migrates before the skip-set widens doesn't fire spurious channel events.
- Re-export `MCP_ORIGIN` and `FILE_SYNC_ORIGIN` from `src/server/events/queue.ts` for shim compatibility through PR 9.
- Migrate all ~40 server `transact` callsites to the helpers in one mechanical pass. Per-file commit recommended for review:
  - `reloadFromDisk` → `withReload` (per the ADR matrix; channel skips, durable-sync persists, re-anchored relRanges survive).
  - `awareness.ts:103` (`refreshRange` loop in `tandem_checkInbox`) → `withMcp` (MCP-tool-driven, surfaces to Claude).
  - `document.ts:381/405/438` (`tandem_edit` and post-edit authorship) → `withMcp`.
  - `tutorial-annotations.ts:61`, `session/manager.ts:128`, `docx-comments.ts:185`, `file-opener.ts:563/643/792/859/923/964` → `withInternal`.
  - All other server callsites currently passing `MCP_ORIGIN` → `withMcp`.
  - Browser callsite (`src/client/editor/toolbar/highlight-toggle.ts:88`) → `withBrowser`.
- Update tombstone observer (from PR 0b) skip-set: skip `file-sync` and `internal` deletes; record `mcp` / `reload` / `browser` deletes.
- Add `.claude/hooks/block-raw-transact.sh` (block-exit-2 grep) + Biome AST rule for `MemberExpression(property.name === "transact")` outside `src/shared/origins.ts`. Allowlist: `tests/**`, `**/*.test.ts`, and the helpers' implementation file.
- Update `.claude/agents/annotation-model-reviewer.md`, `crdt-reviewer.md`, and `security-reviewer.md` prompts to recognise the helpers (otherwise reviewers flag every helper call as a violation).
- Rewrite Critical Rule #2 in `CLAUDE.md` (already done in the grilling pass — verify it survived the rebase and includes the 5-origin matrix).
- Update `docs/architecture.md` Y.Map observer ownership table to reference the new helpers and skip-set.

**Test additions:**
- Unit: each helper wraps `transact` with the correct origin constant.
- Unit: channel-event observers do not emit for `mcp` / `file-sync` / `internal` / `reload`; emit for `browser`.
- Unit: durable-sync observer does not persist for `file-sync` / `internal`; persists for `mcp` / `reload` / `browser`.
- Unit: tombstone observer does not record for `file-sync` / `internal`; records for `mcp` / `reload` / `browser`.
- Unit: a `withReload`-wrapped clear-then-repopulate does not produce orphan tombstones (eviction-reopen invariant).
- Integration: stale-tab CRDT merge that deletes an annotation does not resurrect the annotation on next session reload.
- Integration: origin-spoofing — a synthetic `Y.applyUpdate(doc, update, "mcp")` from a non-server path is observed; assert the channel observer correctly applies the string-equality skip even for non-server-initiated tagged transactions. Document the result. (Hocuspocus's normal path sets origin to a provider instance, not the string `"mcp"`, so this test asserts the boundary, not the bypass.)

**Adversarial review:** crdt-reviewer (echo prevention + tombstone correctness) + security-reviewer (hook bypass surface, origin spoofing boundary).

**Risk:** Medium-high. Largest mechanical migration in the plan; the pre-commit + AST hook is the load-bearing safety net.

**Rollback:** Mechanical revert. Helpers are additive; reverting restores the prior state. But: the observer skip-set first-commit means a partial revert (just the helpers, not the skip-set widening) would leave callsites unable to produce `reload` events anywhere — revert in full or not at all.

#### PR 2: ADR-032 position results as tagged variants

**Scope:**
- Update `src/shared/positions/types.ts` with `RefreshResult`, `PmRangeResult`, `AnchoredRangeResult`, and the new `RangeValidation`.
- Rewrite `src/server/positions.ts` to return the new variants from `refreshRange`, `refreshAllRanges`, `anchoredRange`, `validateRange`.
- Rewrite `src/client/positions.ts` to return `PmRangeResult` from `annotationToPmRange`.
- **`refreshRange` variant mapping** (CRDT reviewer S1):
  - `ok` — relRange present, resolves cleanly to same offsets.
  - `updated` — relRange present, resolves to new offsets.
  - `attached` — no relRange, lazy-attach succeeds.
  - `repaired` — relRange dead, re-anchor from flat offsets succeeds.
  - `degraded` — relRange dead, re-anchor fails (strip relRange so next refresh tries lazy-attach again); **and** no-relRange-lazy-attach-fails (annotation has no CRDT anchor and we can't make one).
  - `failed` — inverted range (newFrom > newTo); current path silently returns input unchanged and masks data corruption.
- Migrate ~10 caller sites. "Don't care" callers destructure `.annotation` / `.from` / `.to`. "Should care" callers (margin overlay, side-panel review state, MCP error responses) switch on `kind`.
- Remove `console.warn` / `console.error` from inside position functions; the variant carries the information.
- Update `docs/architecture.md` coordinate-systems section to reference the variant pattern.

**Test additions:**
- Unit: each variant arm of `refreshRange` is reachable and returns the expected shape (synthetic Y.Doc fixtures for healthy, updated, attached, repaired, degraded, failed).
- Unit: `annotationToPmRange` returns `kind: 'rel' | 'flat' | 'failed'` correctly across inverted, missing-relRange, and dead-relRange cases.
- Unit: TypeScript exhaustiveness — a switch missing one variant fails compilation (use `expect-error` or `tsd`).

**Adversarial review:** crdt-reviewer.

**Sequencing constraint:** Parallel with PR 1. Both must merge before Stage B. Expected merge conflict in `src/server/mcp/annotations.ts` (transact migration in PR 1, refreshRange caller migration in PR 2); mechanical resolution.

**Risk:** Low-to-medium. Variant migration is mostly mechanical; position module is heavily tested.

#### PR 5: Observer factory (no ADR — internal factoring)

**Why in Stage A:** Foundational for PR 6 (annotation lifecycle). PR 5 doesn't depend on Stage B, so landing it in v0.13.0 reduces v0.14.0 risk.

**Scope:**
- Add `src/server/events/observer-factory.ts` — declarative factory taking `{ ydoc, mapKey, project }`. Owns: subscribe, origin-skip (`mcp` + `file-sync` + `internal` + `reload`), iteration, envelope construction.
- Rewrite `src/server/events/observers/annotations.ts`, `replies.ts`, `ctrl-chat.ts`, `ctrl-meta.ts` as projection functions only.
- `awareness.ts` stays bespoke (state-mutating, not event-emitting).
- Factory JSDoc documents the projection contract.
- Update `.claude/agents/annotation-model-reviewer.md` to recognise the factory's projection function as the new privacy-enforcement seam (currently flags the inline observer cascade).

**Test additions:**
- Unit: factory correctly skips all four non-`browser` origins.
- Unit: factory invokes projection with `(change, raw, oldRaw, docName)` and emits each returned `TandemEvent` via `pushEvent`.
- Existing observer tests rewritten to test projection functions in isolation (no Y.Map roundtrip required).

**Adversarial review:** crdt-reviewer (observer-attachment correctness) + annotation-model-reviewer (privacy invariant placement check ahead of PR 6).

**Sequencing constraint:** PR 1 must merge (uses origin constants).

**Risk:** Low. Behaviour-preserving refactor.

---

### Stage B — registry + file-open (v0.14.0)

Sequenced: PR 3 before PR 4. Stage A must merge.

#### PR 3: ADR-033 document registry + named Hocuspocus lifecycle interface

**Scope:**
- Add `src/server/yjs/lifecycle.ts` — `HocuspocusLifecycle` interface (`shouldKeep`, `onLoad`, `onUnload`).
- Add `src/server/documents/registry.ts` — `DocumentRegistry` singleton implementing `HocuspocusLifecycle`. Owns `openDocs`, `activeDocId`, broadcast-on-mutation, CTRL_ROOM exemption.
- Refactor `src/server/yjs/provider.ts` to accept a `HocuspocusLifecycle` instance. Remove `setShouldKeepDocument`, `setDocLifecycleCallbacks` setters.
- Migrate `src/server/mcp/document-service.ts` state-management section to registry calls.
- Wire registry into `src/server/index.ts` startup.
- Add CI grep that fails on `const \w+\s*=\s*\w+\.getYDoc\(` followed by `await` (CRDT reviewer S3 — guards against caching swapped Y.Doc refs across awaits).
- Update `docs/architecture.md` Y.Map observer ownership and document-lifecycle sections.

**Test additions:**
- Unit: opening a doc via registry sets active and broadcasts to `Y.Map(Y_MAP_DOCUMENT_META)` on CTRL_ROOM.
- Unit: closing the active doc clears active and broadcasts.
- Unit: `shouldKeep` returns true for tracked ids and CTRL_ROOM; false otherwise.
- Integration: stale-tab reconnect (Hocuspocus calls `onLoad` for an unknown room) doesn't crash and doesn't create an `OpenDoc` entry.
- Integration: cold-start (open before HTTP bind) still produces a `documentMeta` map a reconnecting client sees correctly.

**Adversarial review:** crdt-reviewer.

**Risk:** Medium-high. Registry sits in the hot path; CTRL_ROOM exemption is a load-bearing edge case.

#### PR 4: ADR-034 file-open pipeline

**Scope:**
- Add `src/server/documents/open.ts` — four public entry points (`openFromDisk`, `openFromUpload`, `openScratchpad`, `openFromRestore`) + internal pipeline.
- Pipeline writes through the registry (PR 3) and uses `withInternal` (PR 1) for population, `withReload` for the force-reload force-reload path.
- Implement `OpenResult` tagged variant.
- Migrate six callers of `openFileByPath`, `routes/upload.ts`, and session restore (`document-service.ts:411` — dynamic-import workaround removed).
- Delete `src/server/mcp/file-opener.ts` — no shim, no re-export. Callers migrate to `src/server/documents/open.ts` in this PR.
- Update `docs/architecture.md` file-open and lifecycle sections.

**Test additions:**
- Unit: each entry point returns the correct `OpenResult` variant for its happy paths.
- Unit: `openFromDisk` with `force: true` on an open doc returns `reloaded-from-disk`.
- Unit: `openFromDisk` on a non-existent path returns `failed`.
- Integration: cold-start file-association path opens before HTTP bind.
- Integration: warm-start (POST `/api/open`) works through the new entry point.
- Integration: session restore on startup populates the registry correctly.

**Adversarial review:** crdt-reviewer (eviction-reopen correctness) + general-purpose for cold-start invariant.

**Sequencing constraint:** PR 3 must merge.

**Risk:** Medium-high. File-open is the user-perceived "the app works" path.

---

### Stage C — annotation lifecycle + format capabilities + layout (v0.14.0 if cycle holds; v0.15.0 if it splits)

Internal DAG: PR 6 depends on PRs 5, 4, 1, 2. PR 7 depends on PR 4. PR 8 is independent (client-only, localStorage-backed). PR 6 and PR 7 can land in parallel after PR 4. PR 8 can land any time after Stage A.

#### PR 6: ADR-035 annotation lifecycle module + ADR-027 import-as-note migration

**Scope:**
- Add `src/server/annotations/lifecycle.ts` — public seam (`createComment`, `createHighlight`, `createNote`, `importNote`, `editPending`, `acceptPending`, `dismissPending`, `replyToPending`, `promoteNoteToComment`).
- Add `src/server/annotations/projection.ts` — `narrowForChannel(ann): ChannelEligible | null`. Branded type. Predicate is `audience === "outbound" && type === "comment"` (security reviewer S2). Runtime guard re-asserts both conditions for defense-in-depth against JS-level brand bypass (security reviewer B2).
- `src/server/events/queue.ts` `pushEvent`'s annotation-payload field is typed to require `ChannelEligible`, not `Annotation` — direct-push paths fail to typecheck (annotation reviewer S1).
- Refactor `src/server/mcp/annotations.ts` (668 LOC) — handlers become thin adapters. Should shrink to ~300 LOC.
- Refactor channel projection (in the observer factory from PR 5) to consume `ChannelEligible` from `narrowForChannel`.
- Consolidate `sanitizeAnnotation` to the lifecycle's reader path.
- Move `rev` bump ownership to the lifecycle. **Land sync.ts `normalizeAnnotation` fast-path widening in the same PR** (annotation reviewer B2) — once lifecycle bumps rev pre-write, sync's fast-path predicate stays satisfied; the `rev` passthrough in `sanitizeAnnotation` can be removed in the same commit.
- **ADR-027 import migration**: `sanitizeAnnotation` migrates `author: "import", type: "comment"` → `type: "note"` on read (emits `import-comment-to-note` migration-log event). Reverses the v0.9.1 revert per the revised ADR-027.
- `importNote` callsite in the .docx adapter (`docx-comments.ts:234`) updates to `withInternal` via lifecycle — confirms the migration is happening at the right origin layer (annotation reviewer S2).
- Remove the runtime re-accept precondition from PR 0a — superseded by `acceptPending`. Test asserts the MCP error code string (`ANNOTATION_NOT_PENDING`) remains stable (annotation reviewer C1).
- Update `docs/architecture.md` annotation flow section.

**Test additions:**
- Unit: each lifecycle method's success/failure variants are exhaustive.
- Unit: `acceptPending` on a non-pending annotation returns `LifecycleResult.failed`.
- Unit: `promoteNoteToComment` emits an `annotation:created` channel event.
- Unit: a `note` annotation cannot pass `narrowForChannel` (returns null).
- Unit: `pushEvent({ payload: rawAnn })` is a TypeScript compile error (`tsd` / `expect-error` test).
- Unit: legacy `author: "import", type: "comment"` records migrate to `type: "note"` on read.
- Integration: `tandem_comment` round-trips through the lifecycle and produces the same Y.Map state.
- Integration: imported `.docx` comments enter via `importNote`, surface to `tandem_getAnnotations`, do NOT surface to `tandem_checkInbox`.
- Integration: a user `promoteNoteToComment` on an imported note surfaces it to `tandem_checkInbox` after promotion.

**Adversarial review:** annotation-model-reviewer + security-reviewer (security reviewer S3 — privacy regression is a PR 6 risk, not just PR 1).

**Sequencing constraint:** PRs 1, 2, 4, 5 must merge.

**Risk:** Very high. The densest change in the plan. Run all adversarial reviewers before requesting human review.

#### PR 7: ADR-036 format adapter as capability set

**Scope:**
- Update `src/server/file-io/types.ts` — capability-set interface, `LoadResult` / `SaveResult` variants, `LoadIssue` type.
- Migrate adapter definitions. `.docx`'s `extractComments` and `applyTrackedChanges` move into the adapter as optional methods.
- Update file-open pipeline (PR 4) to probe capabilities, surface `LoadResult.partial` issues.
- Replace PR 0c's interim `pushNotification` with structural `LoadResult.partial` flow.
- Update `mcp/convert.ts` to consume `applyTrackedChanges` through the adapter.

**Test additions:**
- Unit: `'save' in markdownAdapter === true`; `'save' in docxAdapter === false`.
- Unit: `.docx` `extractComments` on corrupt comments XML throws; pipeline catches and produces `LoadResult.partial`.

**Adversarial review:** crdt-reviewer (file-open population correctness).

**Sequencing constraint:** PR 4 must merge.

**Risk:** Low.

#### PR 8: ADR-037 layout model — rune store

**Scope:**
- Add `src/client/layout/model.svelte.ts` — `layoutModel` rune store. Public surface uses **getters wrapping `$derived.by(...)` in a class** (svelte reviewer B1), mirroring `src/client/hooks/useTandemSettings.svelte.ts`'s pattern.
- Operations: `toggleRail(side)`, `moveTabToRail(tab, side)`, `setActiveTab(side, tab)`. **`moveTabToRail` issues a single `settingsState.updateSettings` call combining both rail mutations** (svelte reviewer S1) — never two separate calls that could expose intermediate dual-rail state.
- **Orphan-rail rule: block-toggle** (svelte reviewer B2, decided). Matches current App.svelte:916 behaviour. `toggleRail('left')` is a no-op if the other rail is empty.
- Migrate App.svelte:461-510 derivations + move handlers. App.svelte:916 disable rule reads from the model. App.svelte:401-416's `untrack`-wrapped cross-tab activation sync migrates into the model.
- Migrate TitleBar.svelte toggle handlers.
- JSDoc `@reactive` notes on each getter; component-level test asserts staleness on destructuring (proves the getter-destructuring gotcha by demonstration).
- Mark `disabledLeftTabs` / `disabledRightTabs` as render-only; add separate `canMoveTabTo(tab, side)` method for action-side checks (svelte reviewer S4).

**Test additions:**
- Unit: mutual-exclusion invariant — `moveTabToRail` issues exactly one updateSettings call and the resulting state has the tab on exactly one rail.
- Unit: orphan-rail rule — `toggleRail` is a no-op when the other rail is empty.
- Unit: `effectiveRightVisible` is false when `rightPanelVisible: true` and `rightRailTabs.length === 0`.
- Unit: destructuring `const { effectiveLeftVisible } = layoutModel` returns a stale snapshot (proves the reactivity gotcha so contributors don't undo it).
- Component (Svelte 5 + `@testing-library/svelte`): after `layoutModel.toggleRail('left')` + `flushSync()`, TitleBar's `data-testid="titlebar-toggle-left"` `aria-pressed` flipped. Uses `flushSync`/`tick`/`rerender` per `feedback_svelte_onmount_async_test_flush.md` and `feedback_svelte_rerender_not_component_assign.md` (svelte reviewer S3).
- E2E: rail-tab drag-between-rails preserves invariants.

**Adversarial review:** svelte-migration-reviewer.

**Sequencing constraint:** Independent of all other PRs (client-only, localStorage-backed). Recommended to land last to minimise concurrent client churn.

**Risk:** Medium.

---

### PR 9: shim cleanup (v0.14.0 end-of-cycle if all PRs landed; v0.15.0 otherwise)

**Scope:**
- Remove `MCP_ORIGIN` / `FILE_SYNC_ORIGIN` re-exports from `src/server/events/queue.ts`.
- CI grep assertions: no `from "./mcp/file-opener.js"` imports remain (file deleted in PR 4); no `MCP_ORIGIN` / `FILE_SYNC_ORIGIN` imports outside `src/shared/origins.ts`.

**Risk:** Trivial.

---

## Cross-PR test strategy

- **Every PR runs `npm test` and `npm run test:e2e` locally and in CI.**
- **The `block-raw-transact.sh` + Biome AST rule from PR 1 is the single biggest correctness safety net.**
- **Adversarial-agent review on each PR before human review.** Reviewers pinned per PR above. PR 6 runs all four specialist reviewers (annotation-model, crdt, security, plus general-purpose for sequencing).
- **No PR merges with a failing E2E.**

## Release sequencing

- **v0.12.x** (within days): Stage 0 (PRs 0a, 0b, 0c — three targeted patches).
- **v0.13.0**: Stage A (PRs 1, 2, 5). Behaviour change: none beyond the Stage 0 patches.
- **v0.14.0**: Stage B + Stage C + PR 9 cleanup (PRs 3, 4, 6, 7, 8, 9). Behaviour change: **imported `.docx` comments enter as `type: "note"` and require explicit user promotion to surface to Claude** (ADR-027 revised, called out prominently in CHANGELOG).

If v0.14.0 slips, the natural stretch point is between PR 4 (Stage B end) and PR 6 (densest PR). Split there → v0.14.0 ships PRs 3, 4, 7, 8 (no annotation lifecycle); v0.15.0 ships PR 6 + PR 9.

## Risks and mitigations (v2)

| Risk | PR | Mitigation |
|------|----|-------------|
| Pre-commit hook + Biome rule has a false negative | PR 1 | Grep + AST; manual audit of all ~40 callsites; CI grep job fails on any `\.transact\(` outside `src/shared/origins.ts` (with allowlist). |
| Migration-window safety — callsite migrates to a `with*` helper before observers learn about the new origin | PR 1 | Observer skip-set widening lands in PR 1's FIRST commit, before any callsite migrates. |
| Origin spoofing from browser via Hocuspocus | PR 1 | Test asserts a synthetic `Y.applyUpdate(doc, update, "mcp")` from non-server origin fires the skip correctly; documents the boundary (Hocuspocus sets origin to provider instance, not the string). |
| `ChannelEligible` brand bypassable at runtime | PR 6 | Runtime guard inside `narrowForChannel`; `pushEvent` payload typed to require the brand; `tsd`/`expect-error` test asserts direct-push fails to compile. |
| Tombstone widening tombstones `file-sync` eviction deletes → resurrection regression | PR 0b / PR 1 | Tombstone observer skip-set explicitly excludes `file-sync` and `internal`; test asserts eviction-then-reopen produces no orphan tombstones. |
| CTRL_ROOM exemption regression | PR 3 | Dedicated unit test for `shouldKeep(CTRL_ROOM) === true`; integration test that closes the last user doc and verifies CTRL_ROOM survives. |
| Cold-start file-association invariant broken | PR 4 | E2E test for cold-start path with TANDEM_OPEN_FILE; JSDoc on entry points documents the ordering requirement. |
| ADR-027 privacy regression — a note (or import) leaks to channel | PR 6 | `narrowForChannel` is the only producer of `ChannelEligible`; predicate is `audience === "outbound" && type === "comment"`; runtime guard + compile-time brand; integration test confirms imports never surface via `checkInbox` until promoted. |
| `rev` ownership transfer breaks sync.ts fast-path during migration | PR 6 | Lifecycle bumps rev pre-write AND sync.ts normalize widening lands in the same PR — same commit if possible. Test sync's fast-path predicate stays satisfied. |
| Rune-store reactivity bug — destructured getter loses reactivity | PR 8 | JSDoc `@reactive` notes + a unit test that demonstrates the failure mode so contributors don't undo it; svelte-migration-reviewer pass. |
| Shim removal in PR 9 breaks a forgotten consumer | PR 9 | CI greps assert no `MCP_ORIGIN` / `FILE_SYNC_ORIGIN` imports outside `src/shared/origins.ts`. |

## What this plan deliberately does not do

- **No upstream API changes.** MCP tool surface is unchanged (except the deliberate `tandem_checkInbox` import-surfacing behaviour change in v0.14.0).
- **No new tests for behaviour the existing suite already covers.**
- **No deferral of ADR-035 privacy enforcement.** Brand + runtime guard + payload typing all ship with PR 6.
- **No skipping E2E on Stage C PRs.**
- **No combining Stage A PRs.** PR 1 (origins) and PR 2 (position variants) stay separate.

## Sign-off criteria

The plan is ready to start PR 0a when:

- [x] Multi-angle agent review of v1 complete; v2 incorporates findings.
- [ ] Bryan reviews v2 and signs off.
- [x] v0.12.0 released.
- [ ] No higher-priority work claims the v0.13.0 milestone.
