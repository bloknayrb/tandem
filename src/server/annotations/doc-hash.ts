/**
 * Per-document hashing for durable-annotation storage keys.
 *
 * Phase 1 of the durable-annotations plan persists each document's annotation
 * envelope to a JSON file whose filename is `<docHash>.json`. This module
 * produces that hash.
 *
 * ## Why SHA-256 (and not URL-encoding like `sessionKey`)?
 *
 * `src/server/session/manager.ts` already exposes a `sessionKey(filePath)`
 * helper that URL-encodes the path. We intentionally do NOT reuse it here:
 *
 *   - Variable-length + percent-escaped paths can overflow OS path limits.
 *     SHA-256 hex is a fixed 64 characters that every filesystem accepts.
 *   - Opaque: app-data filenames don't leak the user's path hierarchy.
 *   - Cross-platform stable: we control every normalization step, so we don't
 *     inherit quirks of `encodeURIComponent` on odd characters.
 *
 * The plan's wording "matches existing `sessionKey` semantics" refers to the
 * determinism contract (same path → same key, different paths → different
 * keys), not the hashing algorithm. `sessionKey` is left untouched.
 *
 * ## Filename format: raw hex, no `sha256:` prefix
 *
 * The schema's `docHash` *field* is `z.string()` and accepts any shape, so
 * either `"sha256:<hex>"` or `"<hex>"` would parse. We pick raw hex for the
 * value this function returns because it doubles as a filename key, and a
 * colon is allowed on POSIX but forbidden on Windows NTFS filenames. Callers
 * that want the `sha256:` prefix for the JSON envelope field can prepend it
 * themselves.
 *
 * ## Upload paths get a stable, non-hashed id
 *
 * `upload://<id>/<name>` paths are synthetic: `<id>` is stable across reopens
 * but `<name>` is the original user filename (which they may rename on the
 * next upload). Hashing the full string would mean the annotation file
 * doesn't follow the upload when the user renames it. Instead we return
 * `upload_<id>`, which mirrors the upload's actual identity.
 *
 * ## No I/O
 *
 * Pure function. Callers should assume it's safe to call in hot paths.
 */

import * as crypto from "node:crypto";
import * as path from "node:path";
import { isUploadPath, UPLOAD_PREFIX } from "../../shared/paths.js";

/**
 * Normalize a real filesystem path into a canonical string for hashing.
 *
 * Normalization steps:
 *   1. `path.resolve()` — relative paths become absolute (relative to cwd).
 *   2. Backslashes → forward slashes.
 *   3. Strip trailing slash (except for the root `/` or `C:/`).
 *   4. On Windows, lowercase the whole string (NTFS is case-insensitive, so
 *      `C:\foo\bar.md` and `c:/Foo/bar.md` must hash identically). On POSIX,
 *      preserve case (paths are case-sensitive).
 */
function normalizeRealPath(filePath: string): string {
  let normalized = path.resolve(filePath).replace(/\\/g, "/");

  // Strip trailing slashes unless the path IS the root.
  // Windows root (e.g., "C:/") keeps its slash; POSIX root "/" does too.
  // Loop-based trim avoids a polynomial-backtracking regex on many-slash input.
  if (normalized.length > 1 && normalized.endsWith("/")) {
    const isWinRoot = /^[A-Za-z]:\/$/.test(normalized);
    if (!isWinRoot) {
      while (normalized.length > 1 && normalized.endsWith("/")) {
        normalized = normalized.slice(0, -1);
      }
    }
  }

  if (process.platform === "win32") {
    normalized = normalized.toLowerCase();
  }

  return normalized;
}

/**
 * Compute the durable-annotation storage key for a document path.
 *
 * @returns
 *   - For `upload://<id>/<name>` paths with a parseable id: `upload_<id>`.
 *   - For all other paths (including malformed upload paths): the lowercase
 *     hex SHA-256 of the normalized absolute path. Fixed 64 characters.
 *
 * @example
 *   docHash("/tmp/notes.md")               // "a1b2..." (64 hex chars)
 *   docHash("C:\\Users\\me\\doc.md")       // same hash on Windows for "c:/users/me/doc.md"
 *   docHash("upload://abc123/foo.md")       // "upload_abc123"
 *   docHash("upload://")                     // falls through → SHA-256 of "upload://"
 */
export function docHash(filePath: string): string {
  if (isUploadPath(filePath)) {
    // `upload://<id>/<name>` — everything after the scheme.
    const rest = filePath.slice(UPLOAD_PREFIX.length);
    const slashIdx = rest.indexOf("/");
    // Require BOTH a non-empty id AND a `/` separating id from name. A bare
    // `upload://abc` (no slash, no name) is still malformed in the sense
    // that it doesn't match the expected `<id>/<name>` shape, so we fall
    // through to SHA-256 of the literal string for determinism.
    if (slashIdx > 0) {
      const id = rest.slice(0, slashIdx);
      return `upload_${id}`;
    }
    // Fall through: malformed upload path. Hash the whole literal string so
    // it's still deterministic and collision-resistant with real paths.
  }

  const normalized = isUploadPath(filePath)
    ? filePath // preserve literal for malformed upload fallback
    : normalizeRealPath(filePath);

  return crypto.createHash("sha256").update(normalized).digest("hex");
}

/**
 * Compute the content hash stored in the durable envelope's `meta.contentHash`
 * (#313). SHA-256 of the document's flat text (`extractText(doc)` output),
 * recomputed on EVERY durable write so rename-recovery can match an orphaned
 * envelope to a renamed-but-unedited document by exact byte-identical content.
 *
 * Pure function over the already-extracted text — keeps this module I/O- and
 * Y.Doc-free. Callers pass the result of `extractText(doc)`.
 */
export function contentHash(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * Security boundary: filename shape for envelopes that rename-recovery and
 * session-cleanup will read or unlink. Matches `<64-hex>.json` (regular docs)
 * or `upload_<id>.json` (uploads/scratchpads). Must NOT match dotfiles
 * (`.tandem-tmp-*`, `.corrupt.*`, `.future`), session files, or any other
 * sibling we may add to the annotations dir later.
 *
 * Hoisted here so all consumers (rename-recovery, session/manager) share a
 * single definition — drifting copies would silently widen the trust surface.
 */
export const ENVELOPE_FILENAME_RE = /^(?:[a-f0-9]{64}|upload_.+)\.json$/;
