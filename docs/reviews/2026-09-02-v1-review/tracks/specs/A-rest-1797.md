# A-rest — #1797 `closeDocumentById` looks up by basename but tears down by the raw id

Branch `fix/restore-and-close-ids-1768`. Closes #1797. Ledger: `docs/reviews/2026-09-02-v1-review/areas/server-mcp.md:22`; track row `tracks/A-stop-the-bleeding.md:22`. Probe: `experiments/probe-tools.mts` case **H16** (`closeDocumentById("dir/h16")`, prints `still registered:`). Reviewer: `security-reviewer` (a route-reachable id).

## Problem

`src/server/mcp/document-service.ts`, `closeDocumentById`: `const safeId = path.basename(id)` resolves the registry entry (`openDocs.get(safeId)`) and is used for `getOrCreateDocument`, `isDirty` and the log lines — but four teardown steps still take the **raw** `id`:

- `clearFileSyncContext(id)`
- `savingDocs.delete(id)`
- `clearDirtyState(id)`
- `closeDocument(id)`

The steps keyed off `docState.filePath` (`unwatchFile`, `closeStore(docHash(filePath))`, `deleteSession`) run regardless. So `POST /api/close {"documentId":"x/<realId>"}` — `routes/close.ts:13` passes the body value through unnormalised, and `/api/close` is one of the six routes relying solely on the path-wide loopback invariant (CLAUDE.md, Security), so any loopback page can send it — unwatches the file, closes the durable annotation store and deletes the session while leaving the document registered, open in every tab, and still in `savingDocs`/dirty tracking. It also returns `success: true`. H16 reproduces it directly. `tandem_close` (`document.ts:1388`) already basenames before calling, so the MCP surface is unaffected.

## Fix

One resolved id for lookup **and** every cleanup step, exactly as the issue's second suggestion says: replace the four raw `id` arguments with `safeId`. Nothing else changes — `safeId` is already computed at the top, `openDocs`, `savingDocs`, the dirty map and the registry are all keyed by the registered id, and every downstream call already receives it.

- No new error code and no new refusal: a path-prefixed id that resolves now closes **fully** rather than half-closing, which keeps `path.basename` in its established role here (the same CodeQL taint-terminator technique `resolveExternalConflict` names at `reload-family.ts:399`) and leaves every legitimate caller byte-identical.
- The `success: false` message ("Document &lt;id&gt; not found.") keeps the caller's raw string: `routes/close.ts:18` already basenames it before the log sink, and changing it here is unrelated churn.
- Cross-platform note (CLAUDE.md, Windows gotchas): `path.basename` on Linux does not split a backslash path, so `x\<id>` stays whole, misses the registry and returns the not-found refusal. That is the fail-closed direction and needs no extra handling.

No Y.Doc write, no Y.Map key, no new tool or route, no `NON_LOOPBACK_ALLOWED` change, no `data-testid`.

## Tests

`tests/server/document-service.test.ts`, in the existing `describe("closeDocumentById")` (the file mocks the session manager and `unwatchFile`, and keeps `documents/dirty.js` real):

1. **A path-prefixed id closes fully.** `addDoc("close-prefixed", …)`, `setActiveDocId("close-prefixed")`, `markDirty("close-prefixed")`, then `await closeDocumentById("dir/close-prefixed")` → `success: true`, `hasDoc("close-prefixed") === false`, `docCount() === 0`, `getActiveDocId() === null`, and `isDirty("close-prefixed") === false`. The registry assertion kills the half-close; the dirty assertion is the discriminator that kills a partial fix which changes only `closeDocument(id)` and leaves `clearDirtyState(id)` (and, by inspection, the two siblings edited in the same line-group) on the raw id.
2. **The refusal is unchanged.** `closeDocumentById("dir/no-such-doc")` → `success: false`, error contains "not found", and nothing else is torn down (`unwatchFile` not called). Kills a "normalise then close whatever is active" reading of the fix.

Existing specs at `:363-430` (plain ids, active-doc reassignment, session delete, `stopAutoSave`) must stay green unchanged — they are the proof the fix is a no-op for valid callers.

Probe H16 re-run: expected `success: true` with `still registered: false` (today: `still registered: true`).

## Done when

The four teardown calls take `safeId`; both new specs green; the existing `closeDocumentById` specs untouched and green; `npm run typecheck` + the touched suites green.

## Not in scope

Validating `documentId` shape in `routes/close.ts` (the other five loopback-only routes in the CLAUDE.md inventory are the K-sec-server group's business). Any change to `tandem_close`. The `Document ${id} not found.` message text.
