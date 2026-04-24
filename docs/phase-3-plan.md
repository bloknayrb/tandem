# Phase 3: Event Queue Observer Split

## Context

Tandem is at v0.7.1 heading toward v1.0. The pre-v1.0 codebase audit (`docs/audit-v1.md`, finding #5) identified `src/server/events/queue.ts` (602 LOC) as the most entangled server module: it owns five distinct Y.Map observer bodies, a circular event buffer, a per-document selection buffer shared across observer types, a file-sync context registry, and SSE subscriber management. Phase 1 (foundation cleanup, PRs #384–#389, merged 2026-04-22) and Phase 2 (server splits, PRs #391, #392, merged 2026-04-23) prepared the ground. Phase 3 is the audit's highest-risk refactor because it touches the two hardest CRDT correctness concerns in the server — Y.js transaction origin filtering and observer lifecycle across Hocuspocus doc swap.

This refactor is **mechanical**: no behavioral change, no new event types, no Y.js origin-string changes, no `TandemEvent` shape changes. The safety net is the existing test suite:

- `tests/server/event-queue.test.ts` — 1,124 LOC, ~44 test cases across 11 feature groups
- `tests/server/event-queue-dwell.test.ts` — 207 LOC, ~12 cases
- `tests/server/annotations/sync.test.ts` — 1,136 LOC, integrates `reattachObservers`
- `tests/server/file-opener-lifecycle.test.ts` — spies `setFileSyncContext` (added in PR #392)

**Effort:** ~1.5 days. **Single sequential PR**, one worktree agent.

**Why single PR:** Not because the modules are inseparable — `origins.ts` + `file-sync-registry.ts` (Steps 1–2) and the five observer factories (Steps 3–7) are cleanly separable. A 2-PR split would add branch-cut, CI wait, review, merge, and branch-update overhead (~1–2 hours) for a ~1.5-day mechanical reshuffle where each of the 8 steps is individually checkpoint-verified. For a refactor where velocity matters and the test suite is the safety net, single-PR is the lower-overhead path. A 2-PR split would not reduce risk.

**Branch:** `refactor/event-queue-observer-split`

---

## Target Structure

```
src/server/events/
  origins.ts               (~12 LOC)   MCP_ORIGIN, FILE_SYNC_ORIGIN only
  types.ts                 (existing)  + BufferedSelection type (new)
  queue.ts                 (~170 LOC)  buffer, pushEvent, subscribe, replaySince,
                                       selectionBuffer (owned), emittedPayloadIds,
                                       attachObservers / detachObservers / reattachObservers,
                                       attachCtrlObservers / reattachCtrlObservers,
                                       resetForTesting, barrel re-exports
  file-sync-registry.ts    (~110 LOC)  fileSyncContexts Map, safeCleanup,
                                       setFileSyncContext, clearFileSyncContext,
                                       reattachFileSyncObserver, resetForTesting (registry-scoped)
  observers/
    annotations.ts         (~85 LOC)   makeAnnotationsObserver
    replies.ts             (~55 LOC)   makeRepliesObserver
    awareness.ts           (~75 LOC)   makeAwarenessObserver, getDwellMs (private)
    ctrl-chat.ts           (~85 LOC)   makeCtrlChatObserver
    ctrl-meta.ts           (~80 LOC)   makeCtrlMetaObserver
```

LOC targets include imports, JSDoc, and `import type` lines. **Not a pass/fail gate.**

**Naming note — `make*` not `create*`:** Phase 2 (PRs #391, #392) established `makeXxxHandler` for dep-injected factories returning closures (`makeOpenHandler`, `makeSetupHandler`, `makeNotifyStreamHandler`, etc.). Observers are the same pattern. Use `make*` consistently.

**Naming note — `ctrl-chat.ts`, `ctrl-meta.ts`:** The `CTRL_ROOM` abbreviation is established (`shared/constants.ts`, `queue.ts`, `index.ts`). Add a one-line top-of-file JSDoc to both: `/** Observer for CTRL_ROOM's Y.Map('chat'). */` and `/** Observer for CTRL_ROOM's Y.Map('documentMeta'). */` — disambiguates from the keyboard modifier.

---

## Step 0 Architectural Note — Why `origins.ts` Exists

There is a **latent import cycle today**:

```
queue.ts           ──imports──> registerAnnotationObserver, SyncContext, ObserverCleanupPhase
                                   from annotations/sync.ts
annotations/sync.ts ──imports──> FILE_SYNC_ORIGIN
                                   from queue.ts
```

Verified: `src/server/annotations/sync.ts:61` reads `import { FILE_SYNC_ORIGIN } from "../events/queue.js";`. It works at runtime because both sides resolve at call time, but it is fragile. After this PR, `file-sync-registry.ts` owns the `registerAnnotationObserver` call site, so the cycle would become a 3-module chain (`queue → file-sync-registry → annotations/sync → queue`).

**Fix in Step 1**, before any other extraction: create `src/server/events/origins.ts` holding only the two origin string constants. `annotations/sync.ts` imports directly from `origins.ts`. `queue.ts` re-exports both for backward compat. Cost: a ~12 LOC file. Benefit: a true DAG for the rest of Phase 3.

---

## New Shared Type: `BufferedSelection`

Add to `src/server/events/types.ts`:

```ts
export type BufferedSelection = {
  from: number;   // FlatOffset
  to: number;     // FlatOffset
  selectedText: string;
};
```

The shape is currently duplicated inline at three sites in `queue.ts` (awareness observer writes, ctrl-chat observer reads, `getBufferedSelection` return type). After extraction it would be duplicated across three files. Extract the type so the three factory signatures and the `getBufferedSelection` return reference one canonical definition.

This is in-scope because it touches only files this PR already modifies.

---

## Factory Signatures

All five observer factories live in `src/server/events/observers/*.ts`, take a **struct**, and return a **plain `() => void` cleanup**. None uses the `(phase?: ObserverCleanupPhase) => void` shape — that belongs to `registerAnnotationObserver` in `annotations/sync.ts` (disk-persistence observer), called from `file-sync-registry.ts`. The channel-event observer for annotations (in `observers/annotations.ts`) is a distinct observer with no phase concern.

```ts
import type { BufferedSelection } from "../types.js";

// observers/annotations.ts
export function makeAnnotationsObserver(deps: {
  docName: string;
  doc: Y.Doc;
  pushEvent: (e: TandemEvent) => void;
}): () => void;

// observers/replies.ts
export function makeRepliesObserver(deps: {
  docName: string;
  doc: Y.Doc;
  pushEvent: (e: TandemEvent) => void;
}): () => void;

// observers/awareness.ts
export function makeAwarenessObserver(deps: {
  docName: string;
  doc: Y.Doc;
  selectionBuffer: Map<string, BufferedSelection>;
}): () => void;

// observers/ctrl-chat.ts
export function makeCtrlChatObserver(deps: {
  ctrlDoc: Y.Doc;
  pushEvent: (e: TandemEvent) => void;
  selectionBuffer: Map<string, BufferedSelection>;
}): () => void;

// observers/ctrl-meta.ts
export function makeCtrlMetaObserver(deps: {
  ctrlDoc: Y.Doc;
  pushEvent: (e: TandemEvent) => void;
}): () => void;
```

**Why structs, not positional args:** Dependency sets are inhomogeneous. A shared positional shape would over-supply (`pushEvent` to observers that never call it) or require optional handling everywhere.

**Why `pushEvent` is injected:** `queue.ts` remains sole owner of `buffer`, `subscribers`, and `emittedPayloadIds`. Observers emit via the injected function, which handles ref-counted dedup.

**Why `selectionBuffer` is passed by reference:** Shared between awareness (producer) and chat (consumer). Keeping one Map in `queue.ts` passed by reference preserves single ownership and makes coupling explicit.

**Where `ctrlDoc` comes from:** `attachCtrlObservers()` calls `getOrCreateDocument(CTRL_ROOM)` once at the top (current `queue.ts:442`), then passes the resulting `ctrlDoc` into both `makeCtrlChatObserver` and `makeCtrlMetaObserver`. Factories do NOT call `getOrCreateDocument` themselves.

---

## State Ownership Map

| State | Owner file | Exposed via |
|-------|------------|-------------|
| `buffer`, `subscribers` | `queue.ts` | Internal. `pushEvent`, `subscribe`, `unsubscribe`, `replaySince` are the public surface. |
| `emittedPayloadIds` (ref-counted dedup) | `queue.ts` | Mutated by `pushEvent` only (via `trackPayloadId` / `untrackPayloadId` on eviction). Read via `wasEmittedViaChannel`. |
| `selectionBuffer: Map<string, BufferedSelection>` | `queue.ts` | Passed by reference to `makeAwarenessObserver` (writes) and `makeCtrlChatObserver` (reads + deletes). `getBufferedSelection` exported for tests. |
| `docObservers` (per-doc cleanup registry) | `queue.ts` | Internal to `attachObservers` / `detachObservers` / `reattachObservers`. |
| `ctrlCleanups` | `queue.ts` | Internal to `attachCtrlObservers` / `reattachCtrlObservers`. Plain `let` array (matches current pattern). |
| `fileSyncContexts` Map, `safeCleanup` helper | `file-sync-registry.ts` | Public: `setFileSyncContext`, `clearFileSyncContext`, `reattachFileSyncObserver`. |
| `ObserverCleanupPhase` type | Stays in `annotations/sync.ts`. | Imported by `file-sync-registry.ts` only. |
| `getDwellMs()` | Private helper inside `observers/awareness.ts`. | Not exported. Only awareness calls it. |
| `MCP_ORIGIN`, `FILE_SYNC_ORIGIN` | `origins.ts` | `queue.ts` re-exports both for backward compat. |
| `EventCallback` type, `getTrackableId()` private fn | `queue.ts` | Internal; unchanged. |
| `BufferedSelection` type | `src/server/events/types.ts` (new addition) | Imported by `queue.ts` and by `observers/awareness.ts` + `observers/ctrl-chat.ts`. |

`queue.ts:reattachObservers(docName, newDoc)` calls `attachObservers(docName, newDoc)` then delegates the file-sync rebind via `reattachFileSyncObserver(docName, newDoc)` imported from `file-sync-registry.ts`.

**`queue.ts:resetForTesting()` delegation contract** — match current behavior (`queue.ts:583-601`) exactly, plus delegate:

```ts
// queue.ts:resetForTesting — target shape
export function resetForTesting(): void {
  // 1. Clear data-only collections (observer cleanups don't touch these)
  buffer.length = 0;
  subscribers.clear();
  emittedPayloadIds.clear();
  selectionBuffer.clear();

  // 2. Run per-doc observer cleanups, then clear the map that holds them
  for (const cleanups of docObservers.values()) {
    for (const cleanup of cleanups) cleanup();
  }
  docObservers.clear();

  // 3. Run CTRL cleanups, then reset the array that holds them
  for (const cleanup of ctrlCleanups) cleanup();
  ctrlCleanups = [];

  // 4. Delegate registry reset (CRITICAL — do not forget)
  fileSyncRegistry.resetForTesting();
}
```

**Why this order:** The four data-only collections (buffer, subscribers, emittedPayloadIds, selectionBuffer) are safe to clear first because observer cleanups never read or write them — cleanups only do `map.unobserve(handler)`. The critical ordering constraint is per-collection: cleanup iteration over a collection must precede `.clear()` on that same collection. That's what this target shape preserves.

And `file-sync-registry.ts:resetForTesting()` **must include the try/catch cleanup loop** — not just `fileSyncContexts.clear()`:

```ts
// file-sync-registry.ts:resetForTesting — target shape
export function resetForTesting(): void {
  for (const entry of fileSyncContexts.values()) {
    try { entry.cleanup("close"); } catch { /* swallow, matches queue.ts:596-599 defensive pattern */ }
  }
  fileSyncContexts.clear();
}
```

Forgetting the try/catch loop leaks any in-flight tombstone debounces across tests; the failure would be silent (tests stay green) because `safeCleanup` inside the cleanup function already swallows errors. This is the most seductive trap in the migration.

---

## Import Graph (strict DAG)

```
origins.ts  ── (leaf; imports nothing from our modules)
    ▲
    │
    ├── queue.ts ─────► observers/{annotations,replies,awareness,ctrl-chat,ctrl-meta}.ts
    │       │           │
    │       │           └── (yjs, shared/constants, shared/types, shared/sanitize,
    │       │                types.ts for BufferedSelection)
    │       │
    │       └─────► file-sync-registry.ts ─────► annotations/sync.ts
    │                                                  │
    └── (annotations/sync.ts also imports origins.ts) ─┘
```

Checks:
- `origins.ts` is a leaf.
- `observers/*.ts` import only from `yjs` (npm package), `../../yjs/provider.js` (for `getOrCreateDocument` in `observers/awareness.ts`), `../../shared/*`, `../types.js`, and `../origins.js`. No observer imports from `queue.ts` or from other observers.
- `file-sync-registry.ts` imports from `annotations/sync.ts`. It does **not** import from `queue.ts`.
- `queue.ts` imports from `observers/*.ts` and `file-sync-registry.ts`. It does **not** import from `annotations/sync.ts` at all after this PR.
- `annotations/sync.ts` imports from `origins.ts` only.

**Result:** strict DAG.

---

## Re-export Barrel Contract

External consumers import **15 symbols** from `src/server/events/queue.js`. Every one must resolve unchanged through the barrel.

| Symbol | After split, physically lives in | Re-exported from `queue.ts`? |
|--------|----------------------------------|------------------------------|
| `MCP_ORIGIN` | `origins.ts` | Yes |
| `FILE_SYNC_ORIGIN` | `origins.ts` | Yes |
| `attachObservers` | `queue.ts` | (native) |
| `detachObservers` | `queue.ts` | (native) |
| `reattachObservers` | `queue.ts` | (native) |
| `attachCtrlObservers` | `queue.ts` | (native) |
| `reattachCtrlObservers` | `queue.ts` | (native) |
| `setFileSyncContext` | `file-sync-registry.ts` | Yes |
| `clearFileSyncContext` | `file-sync-registry.ts` | Yes |
| `subscribe` | `queue.ts` | (native) |
| `unsubscribe` | `queue.ts` | (native) |
| `replaySince` | `queue.ts` | (native) |
| `wasEmittedViaChannel` | `queue.ts` | (native) |
| `getBufferedSelection` | `queue.ts` | (native) |
| `resetForTesting` | `queue.ts` | (native — internally delegates to the registry) |

External importers (barrel-only access confirmed sufficient):

| Consumer | Imports |
|----------|---------|
| `src/server/index.ts` | `attachCtrlObservers`, `detachObservers`, `reattachCtrlObservers`, `reattachObservers` |
| `src/server/events/sse.ts` | `replaySince`, `subscribe`, `unsubscribe` |
| `src/server/mcp/file-opener.ts` | `attachObservers`, `clearFileSyncContext`, `MCP_ORIGIN`, `setFileSyncContext` |
| `src/server/mcp/document-service.ts` | `clearFileSyncContext`, `MCP_ORIGIN` |
| `src/server/mcp/{document,channel-routes,navigation,awareness,tutorial-annotations,annotations}.ts` | `MCP_ORIGIN` |
| `src/server/positions.ts`, `session/manager.ts`, `file-io/docx-comments.ts` | `MCP_ORIGIN` |
| `src/server/annotations/sync.ts` | `FILE_SYNC_ORIGIN` — **change this one import** to `../events/origins.js` as part of Step 1 (eliminates the cycle) |

**14 source consumers + 5 test consumers = 19 import sites total.** Only `annotations/sync.ts:61` changes its specifier.

---

## Test Mock Paths

Goal: **zero test logic changes** where possible; **one pre-decided spy-target switch** for `file-opener-lifecycle.test.ts`.

| Test file | Imports from queue.js | Status after split |
|-----------|----------------------|---------------------|
| `tests/server/event-queue.test.ts` | Static: `attachCtrlObservers`, `attachObservers`, `detachObservers`, `FILE_SYNC_ORIGIN`, `getBufferedSelection`, `MCP_ORIGIN`, `reattachObservers`, `replaySince`, `resetForTesting`, `subscribe`, `unsubscribe`, `wasEmittedViaChannel`. Dynamic (lines 696, 699, 774): `setFileSyncContext`, `clearFileSyncContext`, `MCP_ORIGIN`. | All symbols re-exported from barrel. **No path change.** |
| `tests/server/event-queue-dwell.test.ts` | `attachObservers`, `detachObservers`, `getBufferedSelection`, `resetForTesting`, `subscribe`, `unsubscribe` | **No path change.** |
| `tests/server/annotations/sync.test.ts` | `FILE_SYNC_ORIGIN`, `MCP_ORIGIN` | **No path change.** |
| `tests/server/annotation-replies.test.ts`, `edit-annotation.test.ts`, `reload.test.ts` | `MCP_ORIGIN` | **No path change.** |
| `tests/server/file-opener-lifecycle.test.ts:142` | `vi.spyOn(queueModule, "setFileSyncContext")` where `queueModule = import * as from queue.js` | **Will fail after Step 2 (pre-decided).** In Vitest ESM mode, re-exports are live bindings; `vi.spyOn` on the re-exporting namespace does NOT intercept the originating module's live binding used at `file-opener.ts`'s import site. Pre-decided fix as part of Step 2 — make BOTH edits: (a) **add** a new import statement at the top of the test file: `import * as fileSyncRegistryModule from "../../src/server/events/file-sync-registry.js";` (do NOT remove the existing `queueModule` import — leave it unless other references to `queueModule` are also gone). (b) **change** the `vi.spyOn(queueModule, "setFileSyncContext")` call at line 142 to `vi.spyOn(fileSyncRegistryModule, "setFileSyncContext")`. The assertion at line 149 (`expect(spy).toHaveBeenCalled()`) stays the same. |

After each extraction step, run `npm test -- event-queue` and `npm test -- file-opener-lifecycle` to catch any spy-target regression immediately.

---

## Migration Order — Single Sequential PR

### Step-by-step with mandatory checkpoints

Every checkpoint: `npm run typecheck && npm test`. Do not batch two extractions before a checkpoint.

1. **Extract `origins.ts`.** Create `src/server/events/origins.ts` exporting `MCP_ORIGIN = "mcp"` and `FILE_SYNC_ORIGIN = "file-sync"`. In `queue.ts`, replace the two `export const` declarations with `export { MCP_ORIGIN, FILE_SYNC_ORIGIN } from "./origins.js";`. In `src/server/annotations/sync.ts:61`, change `from "../events/queue.js"` → `from "../events/origins.js"`. **Checkpoint.**

2. **Extract `file-sync-registry.ts`.** Move: `fileSyncContexts` Map, `safeCleanup` helper (including its try/catch + structured log), `setFileSyncContext`, `clearFileSyncContext`. Add new `reattachFileSyncObserver(docName, newDoc)` helper containing the logic from `queue.ts:342–353`, **including the `safeCleanup` wrapper — do not call `cleanup()` directly**. Add `resetForTesting()` that iterates `fileSyncContexts.values()`, calls each `entry.cleanup("close")` inside try/catch (matches `queue.ts:596–599` defensive pattern), then `fileSyncContexts.clear()`. In `queue.ts`: re-export `setFileSyncContext` and `clearFileSyncContext`; call `reattachFileSyncObserver` inside `reattachObservers`; call `fileSyncRegistry.resetForTesting()` from `queue.ts:resetForTesting`. Also in Step 2: **apply the pre-decided spy fix** in `tests/server/file-opener-lifecycle.test.ts` — add `import * as fileSyncRegistryModule from "../../src/server/events/file-sync-registry.js";` near the existing imports, then change `vi.spyOn(queueModule, "setFileSyncContext")` at line 142 to `vi.spyOn(fileSyncRegistryModule, "setFileSyncContext")`. Do NOT remove the `queueModule` import unless a grep confirms no other references remain. **Checkpoint.** `npm test -- file-opener-lifecycle` must pass — if it doesn't, the spy fix wasn't applied correctly.

3. **Extract `observers/annotations.ts`.** Move the body from `queue.ts:181–240` into `makeAnnotationsObserver({ docName, doc, pushEvent })`. `queue.ts:attachObservers` calls it and pushes the returned cleanup into its local `cleanups` array (preserve push order). **Checkpoint.**

4. **Extract `observers/replies.ts`.** Same pattern for `queue.ts:243–272`. The observer needs both the replies map (for `get` on the reply) and the annotations map (for parent-annotation `textSnapshot` lookup). Both are accessed from `doc` inside the factory. **Checkpoint.**

5. **Extract `observers/ctrl-meta.ts`.** Move `queue.ts:505–572` into `makeCtrlMetaObserver({ ctrlDoc, pushEvent })`. The local `lastActiveDocId` / `lastOpenDocIds` become closure state inside the factory — each call returns a fresh observer with its own history (matches current module behavior). Add file-top JSDoc: `/** Observer for CTRL_ROOM's Y.Map('documentMeta'). */`. **Checkpoint.**

6. **Extract `observers/awareness.ts`.** Move `queue.ts:277–316` into `makeAwarenessObserver({ docName, doc, selectionBuffer })`. Move `getDwellMs()` too, as a private helper inside the file. Preserve the `console.warn` at current `queue.ts:71` — it's correct (stderr-redirected in `index.ts`).

   Concrete imports `observers/awareness.ts` needs:
   ```ts
   import * as Y from "yjs";
   import { getOrCreateDocument } from "../../yjs/provider.js";
   import {
     CTRL_ROOM,
     SELECTION_DWELL_DEFAULT_MS,
     SELECTION_DWELL_MIN_MS,
     SELECTION_DWELL_MAX_MS,
     Y_MAP_DWELL_MS,
     Y_MAP_USER_AWARENESS,
   } from "../../shared/constants.js";
   import { MCP_ORIGIN } from "../origins.js";
   import type { BufferedSelection } from "../types.js";
   ```

   **Invariant:** the `setTimeout` callback reads `getDwellMs()` at schedule time, not fire time — preserve by keeping the exact call-site pattern `setTimeout(callback, getDwellMs())`. Cleanup must `clearTimeout(selectionDwellTimer)` AND `selectionBuffer.delete(docName)`. **Checkpoint.**

7. **Extract `observers/ctrl-chat.ts`.** Move `queue.ts:444–502` into `makeCtrlChatObserver({ ctrlDoc, pushEvent, selectionBuffer })`. `validateRange` stays inside the factory (imports from `../../positions.js`). `attachCtrlObservers` still does `const ctrlDoc = getOrCreateDocument(CTRL_ROOM)` once at the top and passes the same `ctrlDoc` to both meta and chat factories. Add file-top JSDoc: `/** Observer for CTRL_ROOM's Y.Map('chat'). */`. **Checkpoint.** `npm test -- event-queue` exercises the awareness→chat selection-attachment path.

8. **Final `queue.ts` sanity pass.** At this point `queue.ts` should be ~170 LOC. **Verify (do not re-remove)** that the following imports are already gone: `sanitizeAnnotation`, `generateEventId`, `getOpenDocs`, `validateRange`, `SyncContext`, `ObserverCleanupPhase`, `registerAnnotationObserver`. They should have traveled with the observers / registry in prior steps. Confirm `attachObservers` still calls `detachObservers(docName)` as its first line (unlisted invariant — see below). **Checkpoint.** `npm run typecheck && npm test && npm run test:e2e && npm run build`.

**Ordering rationale** (real data dependencies, not post-hoc):
- **Awareness (6) before chat (7):** chat consumes `selectionBuffer` produced by awareness; awareness first settles the "selectionBuffer passed by reference" convention.
- **Annotations (3) before replies (4):** annotations is the clean origin-filter pattern. Establishing the factory shape there de-risks replies (same filter + cross-map parent lookup).
- **Ctrl-meta (5) before awareness (6) / ctrl-chat (7):** meta has neither `selectionBuffer` nor complex state. It validates the `(ctrlDoc, pushEvent)` CTRL_ROOM factory pattern before the harder chat observer.

---

## Invariants and Mitigations

| # | Invariant | How preserved | Test evidence |
|---|-----------|---------------|---------------|
| 1 | `selectionBuffer` is shared between awareness (producer) and chat (consumer) — must be injected, not hidden | `queue.ts` owns the Map; passes the same reference to both observers. Never duplicated. | `event-queue.test.ts` selection-buffer-lifecycle group (chat event receives buffered selection; cleared after consumption). |
| 2 | `reattachObservers` is idempotent | `reattachObservers` still calls `detachObservers → attachObservers` first, then `reattachFileSyncObserver`. Registry rebind disposes the prior cleanup via `safeCleanup` before registering the new one. | `event-queue.test.ts:651-675` and `:761-765` (no-op on unbound doc). |
| 3 | File-sync cleanup phase `"swap"` vs `"close"` distinction (#333) | `file-sync-registry.ts:reattachFileSyncObserver` passes `"swap"`; `setFileSyncContext` (replace path) and `clearFileSyncContext` pass `"close"`. Identical to current behavior, only relocated. | `event-queue.test.ts:774+`; `annotations/sync.test.ts`. |
| 4 | Origin checks happen PER-observer, independently | Each factory contains its own `if (txn.origin === …) return;` guard. No shared guard, no delegation. | `event-queue.test.ts` origin-filter cases per observer type. |
| 5 | Dwell timer uses `getDwellMs()` at schedule time, not fire time | `observers/awareness.ts` preserves `setTimeout(callback, getDwellMs())`. Copy verbatim. | `event-queue-dwell.test.ts` — mid-dwell slider change case. |
| 6 | `wasEmittedViaChannel(payloadId)` survives buffer eviction | `emittedPayloadIds` stays in `queue.ts`. `pushEvent` (owned by `queue.ts`) handles track/untrack. Observers emit via injected `pushEvent`. | `event-queue.test.ts:358-400` ref-counted dedup test (pushes `CHANNEL_EVENT_BUFFER_SIZE + 10` filler events; confirms original evicted, new still tracked). |
| 7 | `setDocLifecycleCallbacks` fires before `startHocuspocus` | **Not touched by this PR.** `src/server/index.ts:21,227` remain byte-identical. | Manual smoke (doc open triggers attach — no warning from `yjs/provider.ts:114`). |
| 8 (new) | `attachObservers` always calls `detachObservers(docName)` as its first line | Preserve this line verbatim when refactoring `attachObservers`. Without it, a direct caller of `attachObservers` could double-attach. | `event-queue.test.ts:651-675` (implicitly — idempotency tests). |
| 9 (new) | In `resetForTesting`, each cleanup-holding collection must be iterated before it is `.clear()`ed | `queue.ts:resetForTesting` iterates `docObservers.values()` then calls `docObservers.clear()`; iterates `ctrlCleanups` then reassigns `ctrlCleanups = []`; registry iterates `fileSyncContexts.values()` then calls `.clear()`. Data-only collections (buffer/subs/dedup/selectionBuffer) can clear in any order — observer cleanups don't touch them. | Implicit — no test asserts order directly. |

---

## Verification

Run from project root after the final commit:

1. `npm run typecheck` — zero errors.
2. `npm test` — all existing tests pass unchanged (except the one pre-decided spy-target switch in `file-opener-lifecycle.test.ts:142`).
3. `npm run test:e2e` — end-to-end smoke passes.
4. `npm run build` — production bundles (server, channel, monitor) build clean.
5. **Import diff check in `src/server/index.ts`:** the file diff must be import-only (or zero). The `setDocLifecycleCallbacks(...)` call at line 227 and its argument expressions must be byte-identical.
6. **Module cycle audit:** manually trace (or `npx madge --circular src/server/events/` if available). Expected: zero cycles.

### Manual smoke test

Open .md → MCP-mutate → user-edit → save → external file edit reload → force-reload → close. Specifically verify:

- Channel events fire for user-originated edits only (no echo on MCP or file-sync origin writes).
- After a Hocuspocus reconnect (close browser tab, reopen), annotations persist — the reattach path. If tombstones silently drop, invariant #3 regressed.
- Selection dwell-gated buffering still attaches the selection to the next chat message.
- Document open/close/switch events fire correctly.
- Force-reload clears annotations without leaking observers (the `setFileSyncContext` replace path with phase `"close"`).

---

## Deliberately NOT in Scope

- **Not changing Y.js transaction origin string values.** `"mcp"` and `"file-sync"` stay verbatim.
- **Not introducing new `TandemEvent` types.** Emitted payloads are byte-identical.
- **Not refactoring `src/server/annotations/sync.ts`.** Only one line changes: the import specifier for `FILE_SYNC_ORIGIN`.
- **Not touching `src/server/index.ts` beyond import statements.**
- **Not changing the dedup algorithm for `emittedPayloadIds`.**
- **Not changing observer attach/detach ordering** inside `attachObservers` / `attachCtrlObservers`. Push order stays identical.

**Reversed exclusions** (now IN scope because the plan decided to):
- `BufferedSelection` type added to `src/server/events/types.ts` (see "New Shared Type" section above).
- `makeXxxObserver` naming (not `createXxxObserver`) to match Phase 2's `makeXxxHandler` convention.
- One pre-decided spy-target switch in `file-opener-lifecycle.test.ts:142`.

---

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Cycle re-introduction via `file-sync-registry` → `sync.ts` → `queue.ts` | Fragile resolution, possible TDZ errors | Step 1 (`origins.ts` extraction) dissolves the cycle before the registry is carved out. |
| `selectionBuffer` reference diverges between awareness and chat | Selection silently never attaches to chat messages | Single Map instance in `queue.ts`, passed by reference to both factories. Covered by `event-queue.test.ts` selection-attachment case. |
| Dwell timer reads `getDwellMs()` at fire time instead of schedule time | Mid-dwell slider changes affect in-flight timers (#188 class bug) | Preserve exact call site: `setTimeout(callback, getDwellMs())`. Covered by `event-queue-dwell.test.ts`. |
| `fileSyncRegistry.resetForTesting()` omits the try/catch cleanup loop | **Silent state leak** across tests; no test failure because `safeCleanup` swallows errors | Plan specifies the exact function body (see State Ownership Map). Reviewer must diff against the specified shape. |
| `reattachFileSyncObserver` calls `cleanup()` directly instead of through `safeCleanup` | Cleanup error crashes reattach instead of logging + continuing | Plan's Step 2 mandates `safeCleanup` wrapper. |
| `vi.spyOn(queueModule, "setFileSyncContext")` becomes a silent no-op after re-export | Test would fail (good — loud failure) | Pre-decided switch to `vi.spyOn(fileSyncRegistryModule, ...)` as part of Step 2. |
| Observer cleanup stash order changes, altering detach order | Ordering-dependent test flakes | Preserve exact push order in `attachObservers` / `attachCtrlObservers`. |
| `attachObservers` accidentally loses its leading `detachObservers(docName)` call | Double-attachment on direct callers | New invariant #8 codifies this. Verified in Step 8 sanity pass. |
| Hidden import in observer body not carried across | Build failure or runtime `undefined` call | Typecheck catches the first; tests catch the second. |

---

## Tests Worth Adding as a Follow-up PR (not blocking)

These address genuine coverage gaps the review surfaced. They are not prerequisites for this PR — the existing 56+ cases are sufficient to catch a mechanical slip — but they would lock down edges that a future refactor could regress:

1. **Mid-dwell detach:** Set selection → `detachObservers` before dwell fires → advance fake timers past dwell → assert `getBufferedSelection` is `undefined`. Validates the `clearTimeout` in the awareness cleanup — the exact scenario Step 6 is most likely to regress.
2. **Rapid distinct-doc swaps:** `attachObservers("doc", doc1)` → `reattachObservers("doc", doc2)` → `reattachObservers("doc", doc3)` — write to doc1 and doc2, assert no events; write to doc3, assert one event. Validates clean disposal across a 3-doc sequence (current idempotency test only covers same-doc).
3. **`resetForTesting` registry delegation:** Call `setFileSyncContext` with a spy cleanup → call `resetForTesting` → assert the spy was called with phase `"close"`. Turns "implicitly covered" into an explicit assertion.
4. **Confirm the spy-target switch locks down correctly:** After the switch lands, add a regression test that asserts `setFileSyncContext` is called once per `openFileByPath` invocation, via the new spy target.

Track these in a roadmap issue alongside this PR's merge.

---

## Execution

Single worktree agent. ~1.5 days. Sequential checkpoints per Step are **mandatory** — do not batch two extraction steps before `npm run typecheck && npm test`. If any step fails its checkpoint, revert only that step (not the cumulative diff) and diagnose before continuing.

Set up worktree:

```
git worktree add .claude/worktrees/refactor-event-queue-split -b refactor/event-queue-observer-split master
```

Symlink `node_modules` from the main repo (Windows junctions per user preference) so typecheck and tests run without a full re-install.

### Critical files touched

- `src/server/events/queue.ts` (extraction source)
- `src/server/events/origins.ts` (new)
- `src/server/events/types.ts` (existing; add `BufferedSelection`)
- `src/server/events/file-sync-registry.ts` (new)
- `src/server/events/observers/{annotations,replies,awareness,ctrl-chat,ctrl-meta}.ts` (new)
- `src/server/annotations/sync.ts` (one import line)
- `tests/server/file-opener-lifecycle.test.ts` (one spy-target switch)

### Critical files NOT touched (guard via diff check)

- `src/server/index.ts` — import-only changes acceptable; call-site invariant
- `src/server/yjs/provider.ts` — zero changes expected
- `src/server/events/sse.ts` — zero changes (imports 3 symbols, all natively in queue.ts post-split)
- All `tests/server/**` except the one spy-target switch above
- `CLAUDE.md` — Rule #2 wording remains accurate

### Commit structure

One branch, one PR. Commits may follow migration steps (one commit per checkpoint) for reviewer clarity, but this is reviewer ergonomics, not a functional requirement. PR description should cite this plan doc.
