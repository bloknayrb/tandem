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

- **`savingDocs` is a save-blocking lock.** It is populated with the **resolved** docId by `saveDocumentToDisk` (`:340-348`), so a `savingDocs.delete(rawPrefixedId)` no-op leaves a live entry; once the document is reopened, every later save short-circuits as `{ status: "skipped", skipCode: "SAVE_IN_PROGRESS" }` at `:340`. That is persistent, silent data loss, not tidiness.
- **`clearFileSyncContext` misses leave the observer attached.** The context stays registered (`src/server/events/file-sync-registry.ts:84-93`), keeping `tombstonesByDoc[hash]` and the per-doc observer alive — the very durability the comment at `:1606-1613` calls load-bearing.

## Fix

One resolved id for lookup **and** every cleanup step, exactly as the issue's second suggestion says: replace the four raw `id` arguments with `safeId`. Nothing else changes — `safeId` is already computed at the top, `openDocs`, `savingDocs`, the dirty map and the registry are all keyed by the registered id, and every downstream call already receives it.

- No new error code and no new refusal: a path-prefixed id that resolves now closes **fully** rather than half-closing, which keeps `path.basename` in its established role here (the same CodeQL taint-terminator technique `resolveExternalConflict` names at `reload-family.ts:399`) and leaves every legitimate caller byte-identical.
- The `success: false` message ("Document &lt;id&gt; not found.", `:1558`) keeps the caller's raw string. `routes/close.ts:18` basenames the same value before the log sink (citing CodeQL js/log-injection) while `:22` puts `result.error` verbatim into the 404 JSON. **That asymmetry is known and deliberate** — a JSON content-type response is not a log sink, and changing it here is unrelated churn. Recorded so a later reviewer does not re-litigate it as an oversight.
- Cross-platform note (CLAUDE.md, Windows gotchas): `path.basename` on Linux does not split a backslash path, so `x\<id>` stays whole, misses the registry and returns the not-found refusal. That is the fail-closed direction and needs no extra handling.

No Y.Doc write, no Y.Map key, no new tool or route, no `NON_LOOPBACK_ALLOWED` change, no `data-testid`.

**Files touched:** `src/server/mcp/document-service.ts`, `tests/server/document-service.test.ts`.

## Tests

`tests/server/document-service.test.ts`, in the existing `describe("closeDocumentById")`. The file currently mocks the session manager, `file-io/index.js`, `file-watcher.js`, notifications, `doc-backup.js` and `fs/promises`, and keeps `documents/dirty.js` real. **Add one more partial mock** — `vi.mock("../../src/server/events/queue.js", …)` spreading `importOriginal` (so `attachObservers` and everything else stays real) and replacing `clearFileSyncContext` with a `vi.fn()`. `document-service.ts:42` imports both from that module, so the spy is what the close path calls.

1. **A path-prefixed id closes fully — all four teardown steps.** `addDoc("close-prefixed", …)`, `setActiveDocId("close-prefixed")`, `markDirty("close-prefixed")`, then `await closeDocumentById("dir/close-prefixed")` → `success: true`, and:
   - `hasDoc("close-prefixed") === false`, `docCount() === 0`, `getActiveDocId() === null` — kills the half-close, covers `closeDocument` (`:1630`).
   - `isDirty("close-prefixed") === false` — covers `clearDirtyState` (`:1625`) and genuinely discriminates: `clearDirtyState` deletes the map entry (`src/server/documents/dirty.ts:180-184`) and `isDirty` returns false only when the entry is gone (`:201-205`).
   - `expect(vi.mocked(clearFileSyncContext)).toHaveBeenCalledWith("close-prefixed")` — **not** `"dir/close-prefixed"`. Covers `:1619`.
   - `savingDocs` observably: `savingDocs` is module-private (`:127`) with no test seam, so assert it through its effect. Before the close, drive `saveDocumentToDisk("close-prefixed")` to completion so the lock has been taken and released on the resolved id; after the close, `addDoc("close-prefixed", …)` again and assert the next `saveDocumentToDisk("close-prefixed")` does **not** come back with `skipCode === "SAVE_IN_PROGRESS"`. Covers `:1622`. (If that proves brittle against the save path's other skip codes, the sanctioned alternative is a test-only reader alongside the existing `registry-testing.ts` seam — but assert it one way or the other; do not leave it to inspection.)
   Round 0 covered only the first two bullets and wrote off the other two as "covered by inspection, same line-group". Inspection is precisely what failed the first time: these four lines already sit in one group and three of them were missed. A 3-of-4 conversion must go red here.
2. **The refusal is unchanged.** `closeDocumentById("dir/no-such-doc")` → `success: false`, error contains "not found". Kills a "normalise then close whatever is active" reading of the fix. If the spec also asserts `unwatchFile` was not called, it **must** `vi.mocked(unwatchFile).mockClear()` as its first line: `unwatchFile` is a module-level `vi.fn()` (`:79`), the file's `beforeEach` (`:120-127`) clears only open docs + dirty state, and `vitest.config.ts` sets no `clearMocks`/`restoreMocks`, so every earlier spec in this `describe` (`:364-436`) has already called it and a bare `not.toHaveBeenCalled()` is a guaranteed false red. Note the clause is weak even repaired — the not-found early return at `:1557` precedes `unwatchFile` at `:1574`, so it cannot fail on a real regression; `success: false` + "not found" are the real discriminators. The file's own idiom for this is an explicit clear (`:431`, `:442`).

Existing specs at `:363-430` (plain ids, active-doc reassignment, session delete, `stopAutoSave`) must stay green unchanged — they are the proof the fix is a no-op for valid callers.

Probe H16 re-run: expected `success: true` with `still registered: false` (today: `still registered: true`).

## Done when

The four teardown calls take `safeId`; both specs green with all four teardown steps asserted in spec 1; the existing `closeDocumentById` specs untouched and green; `npm run typecheck` + the touched suites green.

## Not in scope

Validating `documentId` shape in `routes/close.ts` (the other five loopback-only routes in the CLAUDE.md inventory are the K-sec-server group's business). Any change to `tandem_close`. The `Document ${id} not found.` message text and the `routes/close.ts:18` vs `:22` sanitize-for-log / raw-in-JSON asymmetry.

## Review corrections (round 1)

**Adopted**

- **BLOCKING — the specs discriminated only 2 of the 4 corrected call sites.** Spec 1 now asserts all four: registry (`closeDocument`), `isDirty` (`clearDirtyState`), a `clearFileSyncContext` spy called with `"close-prefixed"` and not `"dir/close-prefixed"`, and an observable `savingDocs` check (reopen, then assert the next save is not `SAVE_IN_PROGRESS`). The "by inspection, same line-group" phrasing is removed and replaced with a note that inspection is what failed the first time. The Problem section now states why `savingDocs` (a persistent save-blocking lock, `:340-348`) and `clearFileSyncContext` (observer + tombstone-ledger leak, `file-sync-registry.ts:84-93`) are not cosmetic.
- The new partial `vi.mock` of `../../src/server/events/queue.js` (spreading `importOriginal`, wrapping `clearFileSyncContext`) is written into the Tests preamble — the file does not mock that module today.
- Spec 2's `unwatchFile` clause: `vi.mocked(unwatchFile).mockClear()` required as its first line (guaranteed false red otherwise — module-level `vi.fn()` at `:79`, no `clearMocks`, earlier specs in the same `describe` call it), plus a note that the clause is structurally weak even repaired because the not-found return at `:1557` precedes `unwatchFile` at `:1574`.
- The `routes/close.ts:18` vs `:22` sanitize-for-log / raw-in-JSON asymmetry is recorded in the Fix section and in "Not in scope" as known and deliberate, so it is not re-litigated later.
- Added a "Files touched" line.

**Not adopted**

None.
