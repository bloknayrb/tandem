import type * as Y from "yjs";
import type { FootnoteBody } from "../../shared/types.js";
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
      /**
       * Granular per-loss strings (the un-joined `message`), used to populate
       * the persistent docx fidelity report (#1145). The docx adapter sets this
       * from `summarizeMammothMessages`; the joined `message` drives the toast.
       */
      importLosses?: string[];
    };

/**
 * Async-parsed source content, ready to `apply` into a Y.Doc inside the
 * caller's transact. Discriminator is `format`. The async parse + sync apply
 * split keeps the apply step inside one atomic Y.Doc transact (#609 large-
 * doc client freeze).
 *
 * Three adapters exist: `md`, `docx`, and a plaintext fallback. The `other`
 * arm collapses txt + html + any future plaintext-routed format.
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
      /**
       * Reconstructed Word footnote bodies (#1123 Tier-A #3 PR 2), keyed by the
       * OOXML footnote id. Captured from `word/footnotes.xml` in `parse`; the
       * docx adapter's `apply` reconciles them against mammoth's HTML in
       * `htmlToYDoc` and writes the surviving set off-fragment to
       * Y_MAP_FOOTNOTE_BODIES. Empty for docs with no footnotes.
       */
      footnoteBodies: Record<string, FootnoteBody>;
      /** `comments-failed` if `extractDocxComments` rejected. */
      issues: LoadIssue[];
    }
  | {
      format: "other";
      content: string;
      issues: LoadIssue[];
    };

/**
 * Format-specific content adapter (ADR-036).
 *
 * Two-phase load:
 *   1. `parse(content)` — async, NO doc dependency. Decodes bytes via
 *      format-specific helpers; parse-time failures land as `LoadIssue`
 *      entries rather than throwing.
 *   2. `apply(doc, prepared)` — SYNC; runs inside the caller's transact so
 *      the populate is one atomic Y.Doc update (#609). Returns additional
 *      `LoadIssue[]` for apply-time failures (e.g. inject-failed).
 *
 * **Saveability is structural**: formats that can write back to disk
 * (.md, .txt) provide a `save` method. Read-only formats (.docx) omit
 * `save` entirely — callers check `if (adapter.save)` instead of a
 * boolean flag.
 */
/**
 * Optional apply-time context. Adapters that need source metadata (e.g. the
 * docx adapter stamps `importSource.file` on imported comments so the UI can
 * render "From: <author>" bylines) read it here. Adapters that don't need it
 * ignore it. Optional so the format-adapter contract stays narrow for
 * call sites that don't have a meaningful fileName (uploads / scratchpads
 * pass `undefined` which makes the docx adapter fall back to "unknown").
 */
export interface ApplyContext {
  fileName?: string;
}

export interface FormatAdapter {
  /** Async pre-parse — no doc dependency. */
  parse(content: string | Buffer): Promise<Prepared>;

  /**
   * Sync apply — must be called inside the caller's origin-tagged transact.
   * Returns `LoadIssue`s discovered during apply (e.g. mid-transact inject-
   * failed); combine with `prepared.issues` for the full set.
   */
  apply(doc: Y.Doc, prepared: Prepared, ctx?: ApplyContext): LoadIssue[];

  /**
   * Serialize a Y.Doc back to text file content. Optional — formats that
   * can't write back as text omit this method. Callers check
   * `if (adapter.save)` before invoking. Used by the text-based atomic-write
   * path (`atomicWrite`) for .md / .txt.
   */
  save?(doc: Y.Doc): string;

  /**
   * Serialize a Y.Doc back to a binary file buffer (#576). Optional and
   * distinct from `save` because binary formats (.docx) need `atomicWriteBuffer`
   * (UTF-8 encoding would corrupt the ZIP) and an async serializer (the `docx`
   * Packer is promise-based). Callers check `if (adapter.saveBinary)`.
   *
   * Binary save is an EXPLICIT-SAVE-only capability: it is NOT wired into the
   * 60s auto-save timer (`AUTO_SAVE_FORMATS`). The protective layer for .docx
   * (lossy mammoth import) is "never overwrite without an explicit user save",
   * which supersedes ADR-004's read-only default.
   */
  saveBinary?(doc: Y.Doc): Promise<Buffer>;
}
