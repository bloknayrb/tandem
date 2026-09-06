# A-rest — #1768 no-arg `tandem_restoreBackup` on a `.docx` restores the sidecar, ignoring `readOnly` and every safety check

Branch `fix/restore-and-close-ids-1768`. Closes #1768. Ledger: `docs/reviews/2026-09-02-v1-review/areas/server-mcp.md:19`; track row `tracks/A-stop-the-bleeding.md:19`. Probe: `experiments/probe-tools.mts` case **H5** (`restoreBackup({})` on a read-only `.docx` with a sidecar) — before/after in the PR body. Reviewer: `security-reviewer` (a write reachable from a tool).

## Problem

`src/server/mcp/docx-apply.ts`, `tandem_restoreBackup`: the `if (docState.format === "docx")` block owns the whole no-`backup` (list) case. When `listDocBackups` returns zero snapshots it falls through to a **second, private restore implementation** — `fs.open(sidecar, O_RDONLY|O_NOFOLLOW)` → `atomicWriteBuffer(filePath, backupBytes)` → `mcpSuccess("Restored …")`. That path never consults `docState.readOnly`, never takes the reload guard, never calls `snapshotBeforeFirstWrite`, never runs `suppressNextChange`/`recordSelfWrite`/`rearmWatch`, and never reloads the Y.Doc — so the open document keeps showing the pre-restore text while disk holds older bytes. The tool description and `docs/mcp-tools.md:842` both call the no-arg form "list". `tests/server/restore-backup.test.ts:619` ("keeps the .docx sidecar restore unchanged") pins the destructive behaviour, and H5 reproduces it on a `readOnly: true` document.

**Decision 1 (Bryan, `decisions.md`):** the no-arg call **lists** the sidecar as an entry and never restores; the sidecar restore path honours `readOnly`.

## Fix

Delete the private restore. The sidecar becomes an ordinary **named** backup, restored through the one guarded path, `restoreDocumentFromBackup` (`src/server/documents/reload-family.ts:220`) — which already checks `source !== "file"`, `RESTORE_FORMATS`, `readOnly`, `isReloadInProgress`, snapshots the current bytes, runs the `#1749` triple (`suppressNextChange` → `atomicWriteBuffer` → `recordSelfWrite`, `rearmWatch` in the inner `finally` — CLAUDE.md's file-watcher gotcha; **`recordSelfWrite` before `rearmWatch`**, and the existing arg-expression equality in `document-write-rearm.test.ts` must keep holding), reloads via `reloadFromDisk`, and re-baselines `Y_MAP_SAVED_AT_VERSION` under `withInternal` (Critical Rule 2 — no new Y.Doc write is added here).

1. **`src/server/file-io/doc-backup.ts`** — one new pure export, no fs:
   `export function docxSidecarBackupPath(filePath: string): string | null` → `filePath.replace(/\.docx$/i, ".backup.docx")` when the path ends `.docx` (case-insensitive), else `null`. Both call sites below use it, so the sidecar name has one definition instead of the two ad-hoc `replace(/\.docx$/i, …)` literals in `docx-apply.ts`.
2. **`reload-family.ts` `restoreDocumentFromBackup`** — resolution and read:
   - `const sidecarPath = isDocx ? docxSidecarBackupPath(existing.filePath) : null;`
     `const useSidecar = sidecarPath !== null && backupName === path.basename(sidecarPath);`
     `const snapshotPath = useSidecar ? sidecarPath : docBackupSnapshotPath(existing.filePath, appDataDir, backupName);` (unchanged `null` → `FILE_NOT_FOUND`). The two namespaces cannot collide: `SNAPSHOT_TAIL_RE` requires `-YYYYMMDD-HHMMSS-<hex8>`, which `<name>.backup.docx` never matches.
   - Reading the sidecar keeps the **O_NOFOLLOW open-then-read** currently in `docx-apply.ts`, moved verbatim (comment block included) into a module-local helper in `reload-family.ts`. This is load-bearing, not cosmetic: `fs.readFile` follows symlinks, so a plain read here would re-open the vulnerability that block documents — and it would re-open it on `POST /api/backups/restore` too, which reaches `restoreDocumentFromBackup` with a caller-supplied `backup` name. Keep the Windows asymmetry note (`O_NOFOLLOW` undefined → `lstat` fallback). Refusal throws `{ code: "INVALID_PATH" }` (symlink / `ELOOP`); `ENOENT` throws the existing `FILE_NOT_FOUND`.
   - Everything downstream is untouched, so the sidecar restore now also gets `assertDocxWithinSizeLimits` and a pre-restore snapshot of the current bytes.
3. **`docx-apply.ts` `tandem_restoreBackup`** — the whole `if (docState.format === "docx") { … }` block is deleted. In the surviving shared list branch, after `listDocBackups`, append the sidecar when `docState.format === "docx"`: `docxSidecarBackupPath(filePath)` → `fs.lstat` → push `{ name: path.basename(sidecar), timestamp, size }` only when `st.isFile()` (a symlinked sidecar is not listed; any error is swallowed — a missing sidecar is the normal case), then re-sort the array newest-first by `timestamp` so the response's own "listed newest first" sentence stays true. The empty-list `FILE_NOT_FOUND` message gains a `.docx`-only sentence naming the `{name}.backup.docx` sidecar. Non-`file` sources keep returning `FORMAT_ERROR` in list mode (unchanged text).
4. **`docx-apply.ts` catch arm** — split the fold: `INVALID_PATH → mcpError("INVALID_PATH", e.message)`, `UNSUPPORTED_FORMAT → mcpError("FORMAT_ERROR", e.message)`. Reason: the symlink refusal now arrives as a thrown `INVALID_PATH`, and the existing security test asserts the tool answers `INVALID_PATH` — folding it to `FORMAT_ERROR` would silently weaken a pinned security assertion. Side effect, stated in the PR body and the docs: a named restore on an upload-source document answers `INVALID_PATH` instead of `FORMAT_ERROR` (list mode is unchanged).
5. **Tool description + `docs/mcp-tools.md:840-872`** — the `.docx` bullet at `:844` is rewritten from "calling without `backup` restores the sidecar" to "the list includes the `{name}.backup.docx` sidecar written by `tandem_applyChanges`; restore it by name like any snapshot". Update the `**Errors:**` line at `:867` (add `INVALID_PATH` — symlinked sidecar, or an upload-source document named with `backup`) and the `.docx` note at `:870`. `GET /api/backups` deliberately keeps listing snapshots only: the palette action restores `backups[0]`, and adding the sidecar there would change which bytes that button writes. Say so in the docs note. `skills/tandem/SKILL.md:121` describes the generic list/restore shape and stays true — **no skill version bump**.

No new tool and no new `/api` route, so the license-gated set is unchanged (`tandem_restoreBackup` is already `gatedTool`); `NON_LOOPBACK_ALLOWED` untouched; no `data-testid`.

## Tests

`tests/server/restore-backup.test.ts` (replacing the `:619` pin) — each kills a specific wrong fix:

1. **Lists the sidecar and leaves the file alone.** `.docx` with a sidecar and no snapshots, `restoreTool({})` → `error: false`, `data.backups` contains `report.backup.docx`, and `fs.readFile(filePath)` still holds the *modified* bytes. Kills both halves: a fix that stops restoring but forgets to list, and a fix that lists and still writes.
2. **Named sidecar restore works end to end.** Real `.docx` bytes (`buildDocx`) + `openFromDisk`, `restoreTool({ backup: "<name>.backup.docx" })` → bytes byte-identical to the sidecar and the open document reloaded (model: the existing "restores a named .docx snapshot" spec at `:736`). Kills a fix that only deletes the branch and makes the sidecar unrestorable.
3. **`readOnly` refusal.** Same fixture with `readOnly: true`, named sidecar restore → code `READ_ONLY` and the file unchanged. This is the issue's headline; it kills any fix that keeps a private sidecar write in `docx-apply.ts`.
4. **Symlinked sidecar, both surfaces** (converted from the `:653` security spec, still `runIf(platform !== "win32")`): no-arg list does **not** contain the sidecar name, and the named restore returns `INVALID_PATH` with the document's own bytes intact. Kills a `fs.readFile` in `reload-family.ts` and a listing that stats through the link.
5. **No snapshots, no sidecar** (existing `:681`) stays: `FILE_NOT_FOUND` for both the no-arg call and a snapshot-shaped name.
6. `tests/server/document-write-rearm.test.ts`: delete the `server/mcp/docx-apply.ts` / `tandem_restoreBackup` census row — the file's own header calls this edit out as "A6 coupling" (`:99`), with `docx-apply.ts`'s acknowledged count going 2 → 1 and `reload-family.ts` staying at 2 because no write is added. That census, not a new runtime spec, is what pins the fingerprint/re-arm contract for the moved write.

Probe H5 re-run: expected `restoreBackup({})` → list containing the sidecar, disk unchanged (today: `Restored …`, disk overwritten on a read-only document).

## Done when

The no-arg call has exactly one code path and it never writes; the sidecar restores only by name and only through `restoreDocumentFromBackup`; six specs above green; `docs/mcp-tools.md` matches; `npm run typecheck` + the touched suites green.

## Not in scope

A `readPendingConflict` refusal inside `restoreDocumentFromBackup` (it has none today for snapshots either — adding one would change existing restore behaviour beyond this issue). Listing the sidecar in `GET /api/backups`. Sweeping or capping sidecars. The `.docx` walker items on #1754.
