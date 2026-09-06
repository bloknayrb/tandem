# A-rest — #1797 `closeDocumentById` looks up by basename but tears down by the raw id

Branch `fix/restore-and-close-ids-1768`. Closes #1797. Ledger: `docs/reviews/2026-09-02-v1-review/areas/server-mcp.md:22`; track row `tracks/A-stop-the-bleeding.md:22`. Probe: `experiments/probe-tools.mts` case **H16** (`closeDocumentById("dir/h16")`, prints `still registered:`). Reviewer: `security-reviewer` (a route-reachable id).

## Problem

`src/server/mcp/document-service.ts`, `closeDocumentById`: `const safeId = path.basename(id)` resolves the registry entry (`openDocs.get(safeId)`) and is used for `getOrCreateDocument`, `isDirty` and the log lines — but four teardown steps still take the **raw** `id`:

- `clearFileSyncContext(id)` (`:1619`)
- `savingDocs.delete(id)` (`:1622`)
- `clearDirtyState(id)` (`:1625`)
- `closeDocument(id)` (`:1630`)

The steps keyed off `docState.filePath` (`unwatchFile`, `closeStore(docHash(filePath))`, `deleteSession`) run regardless. So `POST /api/close {"documentId":"x/<realId>"}` — `routes/close.ts:13` passes the body value through unnormalised, and `/api/close` is one of the six routes relying solely on the path-wide loopback invariant (CLAUDE.md, Security), so any loopback page can send it — unwatches the file, closes the durable annotation store and deletes the session while leaving the document registered, open in every tab, and still in `savingDocs`/dirty tracking. It also returns `success: true`. H16 reproduces it directly. `tandem_close` (`document.ts:1388`) already basenames before calling, so the MCP surface is unaffected.

Two of the four misses are worse than a cosmetic leak, which is why the tests below cover them rather than trusting inspection:

- **`savingDocs` is a save-blocking lock, and the mismatch is a latent-consistency defect — not data loss.** `saveDocumentToDisk` keys the lock on its **raw** argument: `savingDocs.has(docId)` (`:340`), `savingDocs.add(docId)` (`:348`), and it releases in its own `finally` — `savingDocs.delete(docId)` (`:667`). Add and delete are therefore symmetric on the same key and the release is unconditional, so a completed *or* thrown save can never leave an entry behind; the same shape holds at `:844`/`:847`/`:1031` (`saveDocumentAsToDisk`) and `:1201`/`:1216`/`:1536` (rename). Every caller today passes an already-resolved id, so no reachable state has a `savingDocs` entry that only the close can clear, and `:1622` is observationally a no-op in both builds. It is still wrong — the close claims to release the lock on the document it closed and does not — and it becomes observable the moment a save is **in flight across the close**, which is exactly the state spec 1 constructs so its assertion discriminates instead of restating the `finally`. **Do not call this silent data loss** in this spec, in the PR body or in the ledger: `areas/server-mcp.md:22` makes no such claim today and must not gain one.
- **`clearFileSyncContext` misses leave the observer attached.** The context stays registered (`src/server/events/file-sync-registry.ts:84-93`), keeping `tombstonesByDoc[hash]` and the per-doc observer alive — the very durability the comment at `:1606-1613` calls load-bearing.

## Fix

One resolved id for lookup **and** every cleanup step, exactly as the issue's second suggestion says: replace the four raw `id` arguments with `safeId`. Nothing else changes — `safeId` is already computed at the top, `openDocs`, `savingDocs`, the dirty map and the registry are all keyed by the registered id, and every downstream call already receives it.

- No new error code and no new refusal: a path-prefixed id that resolves now closes **fully** rather than half-closing, which keeps `path.basename` in its established role here (the same CodeQL taint-terminator technique `resolveExternalConflict` names at `reload-family.ts:399`) and leaves every legitimate caller byte-identical.
- The `success: false` message ("Document &lt;id&gt; not found.", `:1558`) keeps the caller's raw string. `routes/close.ts:18` basenames the same value before the log sink (citing CodeQL js/log-injection) while `:20` puts `result.error` verbatim into the 404 JSON. **That asymmetry is known and deliberate** — a JSON content-type response is not a log sink, and changing it here is unrelated churn. Recorded so a later reviewer does not re-litigate it as an oversight.
- Cross-platform note (CLAUDE.md, Windows gotchas): `path.basename` on Linux does not split a backslash path, so `x\<id>` stays whole, misses the registry and returns the not-found refusal. That is the fail-closed direction and needs no extra handling.

No Y.Doc write, no Y.Map key, no new tool or route, no `NON_LOOPBACK_ALLOWED` change, no `data-testid`.

**Files touched:** `src/server/mcp/document-service.ts`, `tests/server/document-service.test.ts`.

## Tests

`tests/server/document-service.test.ts`, in the existing `describe("closeDocumentById")`. The file currently mocks the session manager, `file-io/index.js`, `file-watcher.js`, notifications, `doc-backup.js` and `fs/promises`, and keeps `documents/dirty.js` real. **Add one more partial mock** — `vi.mock("../../src/server/events/queue.js", …)` spreading `importOriginal` (so `attachObservers` and everything else stays real) and replacing `clearFileSyncContext` with a `vi.fn()`. `document-service.ts:42` imports both from that module, so the spy is what the close path calls.

**Where the symbols come from**, because the file does not import three of them today: `markDirty` / `isDirty` / `clearDirtyState` are exported from `../../src/server/documents/dirty.js` (`dirty.ts:181`, `:195`, `:201`) and are **not** re-exported by `document-service.ts` — the test file currently takes only `registerDirtyObserver` and `resetForTesting` from that module (`:6-9`). `clearFileSyncContext` comes from `../../src/server/events/queue.js`, the same specifier `document-service.ts:42` uses, which is what makes the partial mock land on the call.

1. **A path-prefixed id closes fully — all four teardown steps.** `addDoc("close-prefixed", …)`, `setActiveDocId("close-prefixed")`, `markDirty("close-prefixed")`, then `await closeDocumentById("dir/close-prefixed")` → `success: true`, and:
   - `hasDoc("close-prefixed") === false`, `docCount() === 0`, `getActiveDocId() === null` — kills the half-close, covers `closeDocument` (`:1630`).
   - `isDirty("close-prefixed") === false` — covers `clearDirtyState` (`:1625`) and genuinely discriminates: `clearDirtyState` deletes the map entry (`src/server/documents/dirty.ts:180-184`) and `isDirty` returns false only when the entry is gone (`:201-205`).
   - `expect(vi.mocked(clearFileSyncContext)).toHaveBeenCalledWith("close-prefixed")` — **not** `"dir/close-prefixed"`. Covers `:1619`.
   - `savingDocs` observably, **with a save held in flight across the close**. `savingDocs` is module-private (`:127`) with no test seam, so assert it through its effect — but the effect exists only while an entry is live, and `saveDocumentToDisk` empties the set in its own `finally` (`:667`). A save driven **to completion** before the close therefore leaves the set empty; the buggy `savingDocs.delete("dir/close-prefixed")` and the fixed `savingDocs.delete("close-prefixed")` are then both no-ops on an empty set and the post-close save returns not-`SAVE_IN_PROGRESS` **on master too**. That was round 1's construction: it is green either way and must not ship. The fixture that discriminates hangs the write instead. The file already spies `atomicWrite` in its `file-io/index.js` partial mock (`:54-66`, reached in specs as `const { atomicWrite } = await import("../../src/server/file-io/index.js")`), so: `let release!: () => void;` / `vi.mocked(atomicWrite).mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));` — then `const inFlight = saveDocumentToDisk("close-prefixed");` **without awaiting**, `await closeDocumentById("dir/close-prefixed")`, then, still before releasing, `addDoc("close-prefixed", …)` and assert the next `await saveDocumentToDisk("close-prefixed")` does **not** come back with `skipCode === "SAVE_IN_PROGRESS"`; finally `release(); await inFlight;`. Unfixed, `savingDocs` still holds `"close-prefixed"` at the moment of the second save → `SAVE_IN_PROGRESS` → red. Covers `:1622`. The fixture's doc must be a saveable text doc (`makeOpenDoc` defaults to `/tmp/<id>.md`) so the save actually reaches `atomicWrite`, and the spec must leave the spy clean for its neighbours (`mockImplementationOnce` self-consumes; `vi.mocked(atomicWrite).mockClear()` as the first line is the file's idiom, `:803`).
     *(Sanctioned alternative, same guarantee, if the indirect assertion proves brittle against the save path's other skip codes: add a test-only `savingDocs` reader beside the existing `registry-testing.ts` seam and assert `.has("close-prefixed") === false` immediately after the close. **It needs the same in-flight fixture** — a completed save leaves nothing to observe, so the reader replaces the indirect assertion, not the deferred write. Assert it one way or the other; do not leave it to inspection.)*
   Round 0 covered only the first two bullets and wrote off the other two as "covered by inspection, same line-group". Inspection is precisely what failed the first time: these four lines already sit in one group and three of them were missed. A 3-of-4 conversion must go red here.
2. **The refusal is unchanged.** `closeDocumentById("dir/no-such-doc")` → `success: false`, error contains "not found". Kills a "normalise then close whatever is active" reading of the fix. If the spec also asserts `unwatchFile` was not called, it **must** `vi.mocked(unwatchFile).mockClear()` as its first line: `unwatchFile` is a module-level `vi.fn()` (`:79`), the file's `beforeEach` (`:120`) clears only open docs + dirty state, and `vitest.config.ts` sets no `clearMocks`/`restoreMocks`, so every earlier spec in this `describe` (`:364-436`) has already called it and a bare `not.toHaveBeenCalled()` is a guaranteed false red. Note the clause is weak even repaired — the not-found early return at `:1557` precedes `unwatchFile` at `:1574`, so it cannot fail on a real regression; `success: false` + "not found" are the real discriminators. The file's own idiom for this is an explicit clear (`:431`, `:442`).

Existing specs at `:363-430` (plain ids, active-doc reassignment, session delete, `stopAutoSave`) must stay green unchanged — they are the proof the fix is a no-op for valid callers.

Probe H16 re-run: expected `success: true` with `still registered: false` (today: `still registered: true`).

## Done when

The four teardown calls take `safeId`; both specs green with all four teardown steps asserted in spec 1; the existing `closeDocumentById` specs untouched and green; `npm run typecheck` + the touched suites green.

## Not in scope

Validating `documentId` shape in `routes/close.ts` (the other five loopback-only routes in the CLAUDE.md inventory are the K-sec-server group's business). Any change to `tandem_close`. The `Document ${id} not found.` message text and the `routes/close.ts:18` vs `:20` sanitize-for-log / raw-in-JSON asymmetry.

**What this PR hands the K-sec-server group, stated rather than left implicit.** `routes/close.ts:7-14` takes `documentId` from the body with only a non-empty-string check and passes it straight to `closeDocumentById`, and `/api/close` is one of the six routes that call neither `assertLoopbackForMutation` nor `assertOriginAllowlisted` and rely solely on the path-wide `enforceLoopbackMutation` invariant. After this fix, `{"documentId":"any/prefix/<realId>"}` performs a **complete** close — unwatch, store close, session delete, dirty clear, lock release **and** untrack — where today it does the first three only. **This is not an escalation**: the same loopback caller can send the bare id and get exactly that. But it does change what an unvalidated value achieves there, so `routes/close.ts` shape validation is inherited by the K-sec-server group with that context. Say the same in the PR body so the handoff is tracked.

**No route-level spec.** Both specs are unit-level on `closeDocumentById`. Route-level specs are a normal shape here (`tests/server/routes/response-path-scrub.test.ts`), and one posting `{documentId: "dir/close-prefixed"}` and asserting `hasDoc("close-prefixed") === false` would be cheap — but `handleClose` applies no normalisation of its own (`close.ts:13` passes the body value through verbatim), so the route is covered transitively and the reader should not assume the stated attack surface was itself exercised.

## Review corrections (round 1)

**Adopted**

- **BLOCKING — the specs discriminated only 2 of the 4 corrected call sites.** Spec 1 now asserts all four: registry (`closeDocument`), `isDirty` (`clearDirtyState`), a `clearFileSyncContext` spy called with `"close-prefixed"` and not `"dir/close-prefixed"`, and an observable `savingDocs` check (reopen, then assert the next save is not `SAVE_IN_PROGRESS`). The "by inspection, same line-group" phrasing is removed and replaced with a note that inspection is what failed the first time. The Problem section now states why `savingDocs` (a persistent save-blocking lock, `:340-348`) and `clearFileSyncContext` (observer + tombstone-ledger leak, `file-sync-registry.ts:84-93`) are not cosmetic.
- The new partial `vi.mock` of `../../src/server/events/queue.js` (spreading `importOriginal`, wrapping `clearFileSyncContext`) is written into the Tests preamble — the file does not mock that module today.
- Spec 2's `unwatchFile` clause: `vi.mocked(unwatchFile).mockClear()` required as its first line (guaranteed false red otherwise — module-level `vi.fn()` at `:79`, no `clearMocks`, earlier specs in the same `describe` call it), plus a note that the clause is structurally weak even repaired because the not-found return at `:1557` precedes `unwatchFile` at `:1574`.
- The `routes/close.ts:18` vs `:22` sanitize-for-log / raw-in-JSON asymmetry is recorded in the Fix section and in "Not in scope" as known and deliberate, so it is not re-litigated later.
- Added a "Files touched" line.

**Not adopted**

None.

## Review corrections (round 2)

**Adopted**

- **BLOCKING (×3, one defect) — the `savingDocs` premise was false and the assertion it justified was green on master.** Verified against source: `saveDocumentToDisk` keys the lock on its **raw** argument (`document-service.ts:340`, `:348`) and releases it in its own `finally` (`:667`); the same add/release-in-`finally` shape holds at `:844`/`:847`/`:1031` and `:1201`/`:1216`/`:1536`. So a completed save leaves the set empty, and round 1's "drive `saveDocumentToDisk` to completion, then assert the post-close save is not `SAVE_IN_PROGRESS`" passes identically whether `:1622` reads `savingDocs.delete(id)` or `savingDocs.delete(safeId)`. Two edits: (a) the Problem bullet is rewritten to the truth and the phrase **"persistent, silent data loss" is deleted** from the spec, with an explicit instruction not to carry it into the PR body or the ledger (`areas/server-mcp.md:22` makes no such claim and must not gain one); (b) spec 1's fourth bullet now mandates an **in-flight** fixture — hang `atomicWrite` on a deferred promise (already a `vi.fn` in the file's `file-io/index.js` partial mock, `:54-66`), start the save without awaiting, close, reopen, assert the next save is not `SAVE_IN_PROGRESS`, then release — which is red on master and green after. The `registry-testing.ts`-style test-only reader stays as a sanctioned alternative, now with its precondition stated: it needs the **same** in-flight fixture, because a completed save leaves nothing to observe.
- The Tests preamble now names the import specifiers for `markDirty` / `isDirty` / `clearDirtyState` (`documents/dirty.js` — not re-exported by `document-service.ts`, and the file currently imports only `registerDirtyObserver` / `resetForTesting` from it) and `clearFileSyncContext` (`events/queue.js`).
- "Not in scope" gains the widening handoff: the fix turns a prefixed `documentId` on `POST /api/close` from a partial close into a complete one, this is not an escalation (the same loopback caller can send the bare id), and `routes/close.ts` shape validation is inherited by K-sec-server **with that context** — to be said in the PR body too.
- "Not in scope" also records that no route-level spec exists, that one would be a normal shape here (`tests/server/routes/response-path-scrub.test.ts`), and that the route is covered transitively because `handleClose` applies no normalisation of its own — so the reader does not assume the stated surface was exercised.
- Line-number re-anchoring, partially: the 404 JSON in `routes/close.ts` is at `:20`, not `:22` (corrected in two places). The review's other two re-anchorings were **not** applied because the spec was already right and the review was wrong: `unwatchFile: vi.fn()` is at `tests/server/document-service.test.ts:79` (the review said `:78`) and `beforeEach(` is at `:120` (the review said `:113`). The stale `:120-127` range is narrowed to `:120`.

**Not adopted**

None.
