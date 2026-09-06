# A-rest — #1797 `closeDocumentById` looks up by basename but tears down by the raw id

Branch `fix/restore-and-close-ids-1768`. Closes #1797. Ledger: `docs/reviews/2026-09-02-v1-review/areas/server-mcp.md:22`; track row `tracks/A-stop-the-bleeding.md:22`. Probe: `docs/reviews/2026-09-02-v1-review/experiments/probe-tools.mts` case **H16**. Reviewer: `security-reviewer` (a route-reachable id).

## Problem

`src/server/mcp/document-service.ts`, `closeDocumentById`: `const safeId = path.basename(id)` resolves the registry entry (`openDocs.get(safeId)`) and is used for `getOrCreateDocument`, `isDirty` and the log lines — but four teardown steps still take the **raw** `id`:

- `clearFileSyncContext(id)` (`:1619`)
- `savingDocs.delete(id)` (`:1622`)
- `clearDirtyState(id)` (`:1625`)
- `closeDocument(id)` (`:1630`)

The steps keyed off `docState.filePath` (`unwatchFile`, `closeStore(docHash(filePath))`, `deleteSession`) run regardless. So `POST /api/close {"documentId":"x/<realId>"}` — `routes/close.ts:13` passes the body value through unnormalised, and `/api/close` is one of the six routes relying solely on the path-wide loopback invariant — unwatches the file, closes the durable annotation store and deletes the session while leaving the document registered, open in every tab, and still in `savingDocs`/dirty tracking. It returns `success: true`. `tandem_close` (`document.ts:1388`) already basenames, so the MCP surface is unaffected.

Two misses are more than a cosmetic leak, which is why the specs cover them rather than trusting inspection:

- **`savingDocs` is a save-blocking lock.** `saveDocumentToDisk` adds at `:348` and releases in its own `finally` at `:667`, both on its raw argument, so add/release are symmetric and no completed or thrown save leaves an entry behind. The close's miss is a latent-consistency defect — it claims to release the lock on the document it closed and does not — observable only while a save is **in flight across the close**, which is what spec 1b constructs. **Do not call it silent data loss** here, in the PR body or in the ledger; `areas/server-mcp.md:22` makes no such claim and must not gain one.
- **`clearFileSyncContext` misses leave the observer attached** (`src/server/events/file-sync-registry.ts:84-93`), keeping `tombstonesByDoc[hash]` and the per-doc observer alive — the durability the comment at `:1606-1613` calls load-bearing.

### The same defect class in `saveDocumentToDisk`

`saveDocumentToDisk` (`:264`) has the **identical** split, in the same file, with a worse outcome: it serializes a brand-new **empty** `Y.Doc` over the user's real file.

- `:272-273` — `const safeDocId = path.basename(docId); const docState = openDocs.get(safeDocId);` so `"dir/<realId>"` **resolves** to the real document and its real `filePath`.
- `:428` — `getOrCreateDocument(docId)` on the **raw** id; `provider.ts:51-58` mints a NEW empty `Y.Doc` for an unknown room name. `:505` `adapter.save!(doc)` → `:528` `atomicWrite(docState.filePath, output)`.
- The external-modification guard cannot stop it: `:401-404` reads `Y_MAP_SAVED_AT_VERSION` off that same fresh doc, so `lastSavedAt` is `undefined` and the guard is skipped rather than tripped. The lock is bypassed the same way (`:340`, `:348`, `:667` raw), so two prefixed saves can `atomicWrite` one file concurrently.
- **It is reachable.** `POST /api/save` type-checks `documentId` only — no `isValidDocumentId`, no basename (`routes/save.ts:57-63`) — and passes it straight through at `:132`. In scope per CLAUDE.md ("if you find something broken while working, fix it rather than filing it"); the substitution is one identifier and stays inside the file this issue already names.

**The blast radius is exactly `saveDocumentToDisk`.** `saveDocumentAsToDisk` (`:754`) and `renameDocument` (`:1113`) both do `openDocs.get(docId)` on the **raw** id and compute no `safeDocId` at all — internally consistent and fail-closed (a prefixed id misses the registry → `NOT_FOUND`). Adding a basename there would *widen* what they accept, and `routes/rename.ts:76` already basenames at the boundary.

## Fix

One resolved id for lookup **and** every subsequent step. Two functions, the same rule.

**(a) `closeDocumentById`** — replace the four raw `id` arguments with the already-computed `safeId`.

**(b) `saveDocumentToDisk`** — substitute `safeDocId` for the raw `docId` at every site after the lookup: the lock (`:340`, `:348`, `:667`); `getOrCreateDocument` (`:375`, `:401`, `:428`) — this is the one that stops the empty-file overwrite and restores the conflict and mtime guards to reading the *real* document's meta; the dirty bookkeeping (`snapshotDirtyVersion` `:432`, `markCleanIfUnchanged` `:568`); and the notification `documentId`/`dedupKey` keys (`:478`, `:521`, `:644-645`, `:661-662`). `:486` already passes `safeDocId`. **Do not touch `saveDocumentAsToDisk` or `renameDocument`.**

- No new error code and no new refusal: a path-prefixed id that resolves now closes (or saves) **fully** rather than half-doing it, keeping `path.basename` in its established CodeQL taint-terminator role and leaving every legitimate caller byte-identical.
- The `success: false` message keeps the caller's raw string (`:1558`), and `routes/close.ts:18` basenames for the log sink while `:20` puts `result.error` verbatim into the 404 JSON. That asymmetry is known and deliberate — a JSON response is not a log sink.
- `path.basename` on Linux does not split a backslash path, so `x\<id>` stays whole, misses the registry and returns the not-found refusal — the fail-closed direction.

No Y.Doc write, no Y.Map key, no new tool or route, no `NON_LOOPBACK_ALLOWED` change, no `data-testid`.

**Files touched:** `src/server/mcp/document-service.ts`, `tests/server/document-service.test.ts`.

## Tests

`tests/server/document-service.test.ts`. The file already mocks the session manager, `file-io/index.js`, `file-watcher.js`, notifications, `doc-backup.js` and `fs/promises`, and keeps `documents/dirty.js` real. **Add one partial mock** — `vi.mock("../../src/server/events/queue.js", …)` spreading `importOriginal` (so `attachObservers` stays real) and replacing `clearFileSyncContext` with a `vi.fn()`; `document-service.ts:42` imports both from that specifier. `markDirty` / `isDirty` / `clearDirtyState` come from `../../src/server/documents/dirty.js` (`:181`, `:195`, `:201`) and are not re-exported by `document-service.ts`; the file currently imports only `registerDirtyObserver` / `resetForTesting` from it.

1. **A path-prefixed id closes fully.** `addDoc("close-prefixed", …)`, `setActiveDocId`, `markDirty`, then `await closeDocumentById("dir/close-prefixed")` → `success: true`, and:
   - `hasDoc("close-prefixed") === false`, `docCount() === 0`, `getActiveDocId() === null` — covers `closeDocument` (`:1630`).
   - `isDirty("close-prefixed") === false` — covers `clearDirtyState` (`:1625`); `clearDirtyState` deletes the map entry (`dirty.ts:180-184`) and `isDirty` returns false only when it is gone.
   - `expect(vi.mocked(clearFileSyncContext)).toHaveBeenCalledWith("close-prefixed")` — **not** `"dir/close-prefixed"`. Covers `:1619`.
1b. **`savingDocs`, with a save held in flight across the close** — its own adjacent `it`, so a registry/dirty/spy failure cannot mask it. `savingDocs` is module-private (`:127`) with no seam, and a save driven to completion empties it in its own `finally`, so a completed-save fixture is green either way and must not ship. Hang the write instead: the file already spies `atomicWrite` in its `file-io/index.js` partial mock (`:54-66`), so `let release!: () => void; vi.mocked(atomicWrite).mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));` then `const inFlight = saveDocumentToDisk("close-prefixed");` **without awaiting**. Three fixture rules, each of which turns the spec green-or-poisonous if skipped:
   - `await vi.waitFor(() => expect(release).toBeDefined());` before using it — the lock itself is live synchronously (`:271-345` are all sync), but the deferred resolver is not.
   - **Release unconditionally** — `try { … } finally { release(); await inFlight; }` or `onTestFinished(() => release())`. There is no `savingDocs` reset seam, `beforeEach` (`:120`) resets only open docs/active id/dirty state, and `vitest.config.ts` sets no `clearMocks`/`restoreMocks`, so a failing assertion on master leaks `"close-prefixed"` into every later save spec.
   - **Assert the positive**, `expect(result.status).toBe("saved")` — never "not `SAVE_IN_PROGRESS`", which all six earlier skip arms at `:274-345` satisfy. `"saved"` is reachable: `fs/promises.stat` is mocked to `{ mtimeMs: 0 }` (`:104-110`).

   So: start the save, `vi.waitFor`, `await closeDocumentById("dir/close-prefixed")`, `addDoc("close-prefixed", …)`, assert the next `await saveDocumentToDisk("close-prefixed")` is `"saved"`, release in the `finally`. Unfixed, `savingDocs` still holds `"close-prefixed"` → `SAVE_IN_PROGRESS` → red. Covers `:1622`. Use a saveable text doc (`makeOpenDoc` defaults to `/tmp/<id>.md`) and `vi.mocked(atomicWrite).mockClear()` as the first line (the file's idiom, `:803`).
2. **The refusal is unchanged.** `closeDocumentById("dir/no-such-doc")` → `success: false`, error contains "not found" — kills a "normalise then close whatever is active" reading. If it also asserts `unwatchFile` was not called it **must** `vi.mocked(unwatchFile).mockClear()` first (module-level `vi.fn()` at `:79`, no `clearMocks`, earlier specs in the same `describe` already called it), and the clause is weak even repaired — the not-found return at `:1557` precedes `unwatchFile` at `:1574`.
3. **A path-prefixed id does not empty the file** — fix (b). In the save `describe`: `mkdtempSync` (the file's idiom, `:697`), `addDoc("save-prefixed", makeOpenDoc("save-prefixed", path.join(dir, "save-prefixed.md")))`, `editBody("save-prefixed", "real content")` (`:126-135`), then `await saveDocumentToDisk("dir/save-prefixed", "manual")` and `expect(fsSync.readFileSync(target, "utf8")).toContain("real content")`. **Red on master**: `getOrCreateDocument("dir/save-prefixed")` mints a fresh empty `Y.Doc`, `adapter.save!` serializes nothing, and the partial mock's `atomicWrite` delegates to the real implementation (`:54-66`), so the empty string genuinely lands on disk. Optionally also `expect(result.status).toBe("saved")` — on master the save "succeeds" while destroying the content.

Existing specs at `:363-430` (plain ids, active-doc reassignment, session delete, `stopAutoSave`) must stay green unchanged — they are the proof the fix is a no-op for valid callers.

Probe H16 re-run: expected `success: true` with `still registered: false`.

## Done when

`closeDocumentById`'s four teardown calls take `safeId`; `saveDocumentToDisk` operates on `safeDocId` after the lookup and `saveDocumentAsToDisk` / `renameDocument` are untouched; specs 1, 1b, 2 and 3 green; the existing close and save specs untouched and green; `npm run typecheck` + the touched suites green.

## Not in scope

Validating `documentId` shape in `routes/close.ts` or `routes/save.ts` — handed to the K-sec-server group. This PR makes the unvalidated value harmless at the sink rather than rejecting it at the boundary. State the handoff in the PR body with its context: after this fix, `{"documentId":"any/prefix/<realId>"}` on `POST /api/close` performs a **complete** close where today it does three of the steps only. **That is not an escalation** — the same loopback caller can send the bare id and get exactly that — but it changes what an unvalidated value achieves there.

Any change to `tandem_close`. The `Document ${id} not found.` message text and the `routes/close.ts:18`-vs-`:20` sanitize-for-log / raw-in-JSON asymmetry.

**No route-level spec.** Both halves are unit-level. `handleClose` applies no normalisation of its own (`close.ts:13`), so the route is covered transitively; a route spec beside `tests/server/routes/response-path-scrub.test.ts` would be cheap and is welcome.

## Review corrections (scope cut)

**Fixed directly** — the round-3 blocking finding, which was a false premise concealing a real bug:

- The Problem section's "Every caller today passes an already-resolved id, so no reachable state has a `savingDocs` entry that only the close can clear" and the Fix's "`openDocs`, `savingDocs`, the dirty map and the registry are all keyed by the registered id" are **deleted**. Verified false: `routes/save.ts:57-63` type-checks `documentId` only and `:132` passes it straight to `saveDocumentToDisk`, which resolves by `path.basename` at `:272-273` but calls `getOrCreateDocument` on the raw id at `:375`/`:401`/`:428`. The Problem gains the subsection stating that defect and its reachability, the Fix gains part **(b)**, and new spec 3 pins it.
- **One half of the finding's proposed fix is refuted with evidence and deliberately not applied**: "apply the same substitution at the `saveDocumentAsToDisk` and rename sites (`:844`/`:847`/`:1031`, `:1201`/`:1216`/`:1536`)". Measured — both functions do `openDocs.get(docId)` raw (`:754`, `:1113`) and compute no `safeDocId`, so they are internally consistent and fail closed. There is nothing to substitute, and a basename there would widen what they accept.

**Removed** (three adversarial rounds grew the spec past the issue; none of these was a mechanism #1797 asked for):

- The extended `saveDocumentToDisk` site list in the finding's fix beyond the sites that actually carry the split — `snapshotDirtyVersion` at `:588` was double-listed, and the neighbour-function sites are refuted above.
- The round 1–3 correction logs and the line-number re-anchoring ledger, folded into this section.
- The "sanctioned alternative" test-only `savingDocs` reader seam. It is a new test seam for a property spec 1b already observes through behaviour; adding a seam is a mechanism, not a fix.
