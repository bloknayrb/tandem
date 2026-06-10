# Pre-write document backups + shutdown dirty-doc flush

Status: design reviewed (2 adversarial agents: correctness + security); all findings adjudicated and folded in below.

## Problem

Tandem has no recovery path for user text documents. For `.md`/`.txt`, the dirty-gated 60s autosave rewrites the user's file through `remark-stringify` with no snapshot of the original — and the serializer has mangled files three separate times (#379, #605, lesson #69). All fixed, but the recurrence pattern says round-trip bugs will happen again. `tandem_restoreBackup` covers `.docx` only. Additionally, `saveDocumentAsToDisk` will overwrite an existing target file (`document-service.ts` "the file shouldn't exist yet, but if it does…" — it proceeds), so a misdirected Save-As can destroy a foreign file outright.

Secondary gap: graceful shutdown (`src/server/index.ts` `shutdown()`) calls `saveCurrentSession()` but never `autoSaveAllToDisk()`. A user who quits leaves the disk file lagging the session by up to 60s of edits; if they open the file in another editor before relaunching Tandem, they see stale content.

## Design

### 1. Pre-overwrite snapshot

**When:** Immediately before the first `atomicWrite` to a given **resolved file path** in this process lifetime, at two call sites:
- `saveDocumentToDisk()` text branch (`.md`/`.txt`; `.docx` keeps its existing `tandem_applyChanges` backup — no double-backup), and
- `saveDocumentAsToDisk()` when the target path already exists (the silent-overwrite hole above).

A module-level `Set<string>` keyed by **`docHash(resolvedPath)`** gates it — one snapshot per path per server run. Path-keyed (not docId-keyed) because docId is the Hocuspocus room name and stays stable across rename; the snapshot decision is about the bytes at a *path*. Rename consequences: rename refuses EEXIST, so the file at the new path is always Tandem's own prior output — a post-rename snapshot is harmless churn bounded by the 3-cap, and the byte-content is still a valid recovery point. (Adjudicated review finding C1: not a loss vector, but path-keying is adopted because it also covers Save-As-onto-existing, which IS one.)

**What:** Copy the current on-disk bytes verbatim (`fs.readFile` → backup write). No serializer involvement — the point is to survive serializer bugs. ENOENT → skip silently (new file; nothing to lose). TOCTOU note (review I1): the read shares the existing save path's window — the mtime guard runs before it and nothing new is introduced; an external writer mid-read was already a hazard for the save itself.

**Where:** `${appDataDir}/doc-backups/<pathHash>/<sanitizedBasename>-<YYYYMMDD-HHMMSS>-<uuid8><ext>`
- Subdir per path-hash; collision-free pruning.
- `<sanitizedBasename>`: strip path separators, reserved Windows device stems (CON/NUL/PRN/AUX/COM1-9/LPT1-9 — reuse the checks behind `validateRenameFilename` in `src/server/file-io/filename-safety.ts`), trailing dots/spaces; cap at 40 chars; fallback `doc`. (Security F1.)
- `source.txt` in the subdir records the original absolute path; rewritten on every snapshot write, so post-rename staleness self-heals on the next snapshot (review M2).
- New module `src/server/file-io/doc-backup.ts`. **Copy-adapt** the write/list/prune logic from `src/server/integrations/backup.ts` rather than importing `writeBackup`: its abort-on-ACL-failure contract (delete backup + rethrow) is wrong here (review I2/M1). *(As shipped, only `formatTimestamp` is imported: snapshot names vary per document — stem + extension, not a constant prefix/suffix pair — so `listBackups`/`pruneOldBackups` didn't fit; the module matches on a `-<timestamp>-<uuid8>` tail regex and prunes inline without re-sorting, since same-second names tie on the random uuid.)*

**Permissions (security F3):** dir `0o700`, files `0o600` (`wx` exclusive-create), `setRestrictiveAcl` on the `doc-backups/` dir at creation on Windows — **best-effort**: ACL failure logs a warning and keeps the backup (document content, not bearer tokens; an existing backup beats no backup).

**Failure mode: warn-and-proceed.** A failed snapshot must NOT block the save — the in-memory edits are the newer data. On failure: `pushNotification` once (dedupKey per path), log, proceed with the save, do NOT mark the path in the gate (next save retries).

**Scope guards:**
- Text formats only; not `upload://`; not read-only (both already short-circuit earlier in `saveDocumentToDisk`).
- Byte-identical skip: `Buffer.equals` against the newest existing backup for the path; ENOENT mid-read (e.g. concurrent prune by a second instance) → treat as "no prior backup", proceed (review I4).
- **Total-size cap (security F2):** before writing, if `doc-backups/` total size exceeds `MAX_DOC_BACKUP_BYTES` (500 MB), skip the snapshot + one-time notification. Bounds confused-deputy churn (an MCP client opening unlimited fresh paths) without per-doc bookkeeping.

**Retention:**
- Per path: newest `MAX_DOC_BACKUPS = 3`, pruned after each write.
- Boot sweep: delete backup files older than 30 days (matches session GC), then remove empty subdirs. Skipped when the annotation store is read-only; fire-and-forget with `.catch()` (matches `reapOrphanedTemps` discipline). The reaper's `^\.tandem-tmp-` regex boundary is unaffected — sibling dir, never scanned.

### 2. Shutdown dirty-doc flush

In `shutdown()` (`src/server/index.ts`), reorder (review I3):
1. `unwatchAll()`
2. `stopAutoSave()` — clear the timer FIRST so it can't fire concurrently with the flush
3. `await autoSaveAllToDisk()` bounded by `Promise.race` with a 5s timeout
4. `await saveCurrentSession()`

`autoSaveAllToDisk` already exists, is dirty-gated (#851), skips binary/read-only/upload docs, and swallows per-doc errors — all guards a hostile MCP client would need bypassed run identically here (security F6: none bypassed). On timeout: log a message that explicitly distinguishes "flush timed out — session saved with stale saved-at version" from a completed flush (security F4). Sequential saves mean >3 large dirty docs may not all flush in 5s (review M3) — acceptable: session save remains the recovery path, same as today; noted in code comment rather than parallelizing in this PR.

### 3. Session-restore interplay

Sessions retain full Y.Doc state and restore at boot — the *unsaved-work* recovery path. Snapshots are the *original-file* recovery path:
- "Tandem mangled/overwrote my file" → restore the snapshot (pre-overwrite bytes).
- "I quit before autosave ran" → session restore handles it; the shutdown flush makes disk converge too.

No restore UI in this PR. Files are plain copies; `docs/troubleshooting.md` gets a "Recovering a previous version of a document" section with per-platform `doc-backups` locations. Extending `tandem_restoreBackup` to text docs = follow-up issue, not bundled.

## Files

- `src/server/file-io/doc-backup.ts` — new: snapshot write (sanitized name, perms, size cap, byte-identical skip), per-path prune, boot sweep
- `src/server/mcp/document-service.ts` — snapshot call in `saveDocumentToDisk` text branch + `saveDocumentAsToDisk` existing-target branch; test-only gate reset export
- `src/server/index.ts` — shutdown reorder + flush + boot sweep wiring
- `tests/server/file-io/doc-backup.test.ts` — new
- `docs/troubleshooting.md`, `docs/architecture.md` (file map), `CHANGELOG.md`, `CLAUDE.md` (Files/Sessions gotcha entry)

## Tests

- First save snapshots pre-existing bytes; second save same session skips; ENOENT (new file) skips; byte-identical skips; newest-backup ENOENT mid-compare proceeds; prune keeps 3; size cap skips + notifies once; snapshot failure → save proceeds + notification + retried next save; sanitization (reserved stems, trailing dot/space, long names, separators); save-as onto existing file snapshots the victim's bytes.
- Boot sweep: removes >30d files + empty dirs; skipped when store read-only.
- Shutdown ordering: timer stopped before flush (unit-testable via exported pieces); flush-then-session sequence.
- Manual: edit a real .md, confirm snapshot in app-data; corrupt the file; restore by copy.

## Out of scope

- Restore UI / MCP tool extension (follow-up issue)
- `.docx` snapshots (existing applyChanges backup + explicit-save-only protect it)
- Parallelizing autoSaveAllToDisk (noted in comment)
- Versioning beyond 3 snapshots / Git integration (roadmap v2)
