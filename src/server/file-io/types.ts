import type * as Y from "yjs";

/**
 * Issue surfaced during `FormatAdapter.load` — a partial-load signal
 * that lets the caller decide whether to surface a user-visible
 * notification (ADR-036). Adapters push issues into the returned
 * `LoadResult` instead of swallowing failures inside their own catch.
 */
export type LoadIssue =
  | {
      kind: "comments-failed";
      /** The underlying error from the failing extraction step. */
      error: unknown;
    }
  | {
      // Reserved for future partial-load categories (e.g. mammoth.js
      // unsupported-style warnings, tracked-changes drops). New variants
      // are deliberately a sum-type extension so the existing handler
      // doesn't need updates when callers don't care.
      kind: "other";
      error: unknown;
      message?: string;
    };

/** Outcome of `FormatAdapter.load`. */
export interface LoadResult {
  /** Issues encountered during the load. Empty for a clean load. */
  issues: LoadIssue[];
}

/**
 * Format-specific content adapter (ADR-036).
 *
 * Adapters convert between raw file content and Y.Doc state. File I/O
 * (reading/writing to disk) stays in the MCP layer — adapters only see
 * content, never paths.
 *
 * **Saveability is structural**: formats that can write back to disk
 * (.md, .txt) provide a `save` method. Read-only formats (.docx) omit
 * `save` entirely — callers check `if (adapter.save)` instead of a
 * boolean flag. This replaces the prior `canSave: boolean` shape so
 * an adapter that omits `save` cannot accidentally be invoked.
 *
 * **Load surfaces partial failures** via the returned `LoadResult`'s
 * `issues` array — the .docx adapter pushes a `comments-failed` issue
 * when `extractDocxComments` rejects, instead of swallowing the error
 * silently (was #696).
 */
export interface FormatAdapter {
  /** Populate a Y.Doc from raw file content. */
  load(doc: Y.Doc, content: string | Buffer): Promise<LoadResult> | LoadResult;

  /**
   * Serialize a Y.Doc back to file content. Optional — formats that
   * can't write back omit this method. Callers check
   * `if (adapter.save)` before invoking.
   */
  save?(doc: Y.Doc): string;
}
