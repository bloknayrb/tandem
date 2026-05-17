import type * as Y from "yjs";
import type { DocxComment } from "./docx-comments.js";

/**
 * Issue surfaced during `FormatAdapter.parse` or `apply` — a partial-load
 * signal that lets the caller decide whether to surface a user-visible
 * notification (ADR-036). Adapters push issues into `Prepared.issues`
 * (from `parse`) or into the return value of `apply` rather than swallowing
 * failures inside their own catch.
 */
export type LoadIssue =
  | {
      /** `parse` step: `extractDocxComments` rejected before any doc mutation. */
      kind: "comments-failed";
      error: unknown;
    }
  | {
      /** `apply` step: `injectCommentsAsAnnotations` threw mid-transact; partial
       *  annotation keys were rolled back. */
      kind: "inject-failed";
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

/**
 * Async-parsed source content, ready to `apply` into a Y.Doc inside the
 * caller's transact. Discriminator is `format`. PR #707 review-driven:
 * the previous single-method `load(doc, content)` shape was incompatible
 * with the production prepare/apply split (`prepareContent` async, then
 * `applyPreparedContent` sync inside ONE MCP_ORIGIN transact for #609).
 *
 * Only three adapters exist: `md`, `docx`, `plaintext` (the catch-all
 * registered under key `txt` and used as fallback for `.html` / unknown
 * extensions). The `other` arm collapses txt + html + any future
 * plaintext-routed format.
 */
export type Prepared =
  | {
      format: "md";
      content: string;
      /** Always empty for md today — placeholder for future warnings. */
      issues: LoadIssue[];
    }
  | {
      format: "docx";
      html: string;
      comments: DocxComment[];
      /** `comments-failed` if `extractDocxComments` rejected. */
      issues: LoadIssue[];
    }
  | {
      format: "other";
      content: string;
      issues: LoadIssue[];
    };

/**
 * Format-specific content adapter (ADR-036, PR #707 review revision).
 *
 * Two-phase load:
 *   1. `parse(content)` — async, NO doc dependency. Pulls bytes through
 *      format-specific decoders (`loadDocx`, `extractDocxComments`,
 *      `loadMarkdown` is sync but uniform shape). Catches and records
 *      parse-time failures as `LoadIssue` rather than throwing.
 *   2. `apply(doc, prepared)` — SYNC. Runs inside the caller's transact
 *      so the populate is one atomic Y.Doc update (#609 large-doc freeze
 *      mitigation, lesson 74). Returns additional `LoadIssue[]` for
 *      apply-time failures (e.g. inject-failed).
 *
 * **Saveability is structural**: formats that can write back to disk
 * (.md, .txt) provide a `save` method. Read-only formats (.docx) omit
 * `save` entirely — callers check `if (adapter.save)` instead of a
 * boolean flag.
 */
export interface FormatAdapter {
  /** Async pre-parse — no doc dependency. */
  parse(content: string | Buffer): Promise<Prepared>;

  /**
   * Sync apply — must be called inside the caller's `doc.transact`. The
   * caller chooses the origin (typically MCP_ORIGIN for opens). Returns
   * additional `LoadIssue`s discovered during the apply (e.g. mid-transact
   * inject-failed). Combine with `prepared.issues` for the full set.
   */
  apply(doc: Y.Doc, prepared: Prepared): LoadIssue[];

  /**
   * Serialize a Y.Doc back to file content. Optional — formats that
   * can't write back omit this method. Callers check
   * `if (adapter.save)` before invoking.
   */
  save?(doc: Y.Doc): string;
}
