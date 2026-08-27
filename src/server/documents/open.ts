/**
 * Named file-open entry points (ADR-034).
 *
 * This module is the published seam for opening documents into a Tandem
 * session. ADR-034 calls for four named entry points:
 *
 *   - `openFromDisk(filePath, opts?)` — opens an existing file path on disk.
 *   - `openFromUpload(fileName, content)` — opens browser-uploaded content
 *     under a synthetic `upload://` path.
 *   - `openScratchpad(content?)` — opens an ephemeral markdown buffer, seeded
 *     with `content` when given.
 *   - `openFromRestore(sessionEntry)` — restores a previously-open document
 *     from disk-cached session state. **Not yet exposed** — Unit 7a adds it;
 *     until then `restoreOpenDocuments` calls `file-opener` directly, through
 *     the dynamic import that breaks the module cycle.
 *
 * Every disk, upload and scratchpad caller in `src/` now goes through this
 * module, but **the redirect is not the whole of file-open and is not meant to
 * be.** `routes/backups.ts`, `routes/document-reload.ts`,
 * `routes/external-conflict.ts` and `mcp/docx-apply.ts` still import
 * `mcp/file-opener.ts` for `restoreDocumentFromBackup`,
 * `reloadDocumentFromMarkdown` and `resolveExternalConflict` — reload-family
 * entries this seam does not name. Deleting `file-opener.ts` therefore waits
 * for Unit 7c, not for this redirect.
 *
 * Each named entry still forwards to the implementation in
 * `src/server/mcp/file-opener.ts`. Unit 7a moves the shared pipeline (path
 * resolution, content prep, finalization) into this module.
 *
 * Two corrections to what this header used to claim, both load-bearing enough
 * that a reader acting on them would be wrong:
 *
 *   - Upload content is **not** "never written back". A `upload://` document is
 *     promoted to a real file by Save-As, at which point its entry's `source`
 *     flips to `"file"` and it saves like any other document.
 *   - `openScratchpad` has taken an optional `content` argument since #979; it
 *     opens an empty buffer only when called with none.
 *
 * The `kindOfOpenResult` helper derives a tagged variant from the existing
 * boolean-flag `OpenFileResult` so callers that want to branch on an enum
 * instead of three booleans can do so today without waiting for the full shape
 * migration. Unit 7b promotes it to a real discriminator — and must pin this
 * precedence ordering first, because the booleans are disjoint by accident
 * (two of them are hardcoded `false` at their construction sites), not by type.
 */

export {
  type OpenFileResult,
  openFileByPath as openFromDisk,
  openFileFromContent as openFromUpload,
  openScratchpad,
} from "../mcp/file-opener.js";

import type { OpenFileResult } from "../mcp/file-opener.js";

/**
 * Tagged variant for `OpenFileResult.kind` — derived from the existing
 * `restoredFromSession` / `alreadyOpen` / `forceReloaded` booleans.
 * ADR-034 part 2 promotes this to a real discriminator on the result
 * type; part 1 exposes it as a derivation so callers can adopt the
 * vocabulary now.
 *
 *   - `fresh`            — first time this session, content loaded from disk/upload/empty
 *   - `restored`         — disk-cached session state was applied; no disk re-read
 *   - `already-open`     — caller asked for a doc that's already tracked; no-op switch
 *   - `force-reloaded`   — caller passed `force: true`; doc state replaced from disk
 */
export type OpenResultKind = "fresh" | "restored" | "already-open" | "force-reloaded";

export function kindOfOpenResult(result: OpenFileResult): OpenResultKind {
  if (result.forceReloaded) return "force-reloaded";
  if (result.alreadyOpen) return "already-open";
  if (result.restoredFromSession) return "restored";
  return "fresh";
}
