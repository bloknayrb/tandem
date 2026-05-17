/**
 * Named file-open entry points (ADR-034, part 1/N).
 *
 * This module is the published seam for opening documents into a Tandem
 * session. ADR-034 calls for four named entry points:
 *
 *   - `openFromDisk(filePath, opts?)` — opens an existing file path on disk.
 *   - `openFromUpload(fileName, content)` — opens browser-uploaded content
 *     under a synthetic `upload://` path; the content is never written back.
 *   - `openScratchpad()` — opens an empty ephemeral markdown buffer.
 *   - `openFromRestore(sessionEntry)` — restores a previously-open document
 *     from disk-cached session state. **Not yet exposed in part 1.**
 *
 * Part 1 (this PR) is an additive seam: each named entry forwards to the
 * existing implementation in `src/server/mcp/file-opener.ts`. Callers can
 * migrate their imports at their own pace. A follow-up PR moves the
 * shared internal pipeline (path resolution, content prep, finalization)
 * into this module and deletes the file-opener.ts façade.
 *
 * The `kindOfOpenResult` helper derives a tagged variant from the
 * existing boolean-flag `OpenFileResult` so callers that want to branch
 * on an enum instead of three booleans can do so today without waiting
 * for the full shape migration.
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
