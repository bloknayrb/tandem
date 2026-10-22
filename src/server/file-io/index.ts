import * as crypto from "node:crypto";
import fs from "fs/promises";
import path from "path";
import {
  Y_MAP_ANNOTATIONS,
  Y_MAP_DOCUMENT_META,
  Y_MAP_FOOTNOTE_BODIES,
} from "../../shared/constants.js";
import { extractText, populateYDoc } from "../mcp/document-model.js";
import {
  countDroppedImages,
  htmlToYDoc,
  loadDocxWithWarnings,
  reconcileFootnoteIds,
} from "./docx.js";
import {
  type DocxComment,
  extractDocxComments,
  injectCommentsAsAnnotations,
} from "./docx-comments.js";
import { exportYDocToDocx } from "./docx-export.js";
import {
  type DocxNotes,
  footnoteDowngradeLines,
  footnoteStructuralLines,
  parseDocxFootnotes,
} from "./docx-footnotes.js";
import {
  moveCount,
  noLostFeatures,
  scanDocxLostFeatures,
  scanFailureLines,
  structuralLossLines,
} from "./docx-lost-features.js";
import { assertDocxWithinSizeLimits } from "./docx-size-gate.js";
import { isFlushUnsupported } from "./flush-unsupported.js";
import {
  normalizeAndRecordLineEnding,
  restoreBom,
  restoreLineEndings,
  stripAndRecordBom,
} from "./line-endings.js";
import { loadMarkdown, saveMarkdown } from "./markdown.js";
import type { FormatAdapter, LoadIssue, Prepared } from "./types.js";

export {
  type AcceptedSuggestion,
  type ApplyOptions,
  type ApplyOutput,
  applyTrackedChanges,
} from "./docx-apply.js";
export type { ApplyContext, FormatAdapter, LoadIssue, Prepared } from "./types.js";

// -- Adapter implementations (ADR-036 two-phase parse/apply) --

/**
 * Does this markdown contain an Obsidian-style `[[wikilink]]`?
 *
 * Exported so its COST is testable on its own: `loadMarkdown` is seconds-slow
 * on the same pathological input, so a timing assertion around the whole
 * `apply` measures remark rather than this.
 *
 * `[` is EXCLUDED from the negated class, and that is load-bearing rather than
 * tidiness: with `[` admitted, every `[[` start re-scans the rest of the line
 * before failing, so an unterminated `[[` in a long line is quadratic —
 * `"see [[note ".repeat(20000)` measured 3.3 s. This runs synchronously inside
 * the Y.Doc transact on every open AND every file-watcher reload, so that time
 * is a stall of Hocuspocus sync and every other open document. Excluding `[`
 * costs no matches: a wikilink target cannot contain one, so `[[note]]`,
 * `![[image.png]]` and `[[note|alias]]` all still match, at 0.5 ms on that
 * same input.
 */
export function containsWikilink(content: string): boolean {
  return /\[\[[^[\]\n]+\]\]/.test(content);
}

const markdownAdapter: FormatAdapter = {
  async parse(content): Promise<Prepared> {
    // Decode here, not at the consumer. `unified().parse` accepts a Buffer
    // (it is VFile-compatible), so a Buffer used to flow all the way through
    // and only surfaced once something did real string work on it. Mirrors
    // `plaintextAdapter.parse` below.
    return {
      format: "md",
      content: typeof content === "string" ? content : content.toString("utf-8"),
      issues: [],
    };
  },
  apply(doc, prepared, ctx) {
    if (prepared.format !== "md") return [];
    loadMarkdown(doc, prepared.content);
    // Obsidian-style vaults are out of scope for v1 (#1753): `[[wikilinks]]`
    // and `![[embeds]]` have no mdast representation here, so they survive as
    // literal text and pick up a `\` escape on save. Warn once per file per
    // open rather than pretending to support them — `notifyIssue`'s `"other"`
    // arm dedups on `load-other:${dedupSource}`. This is `apply` rather than
    // `parse` because only `ApplyContext` carries the file name.
    //
    // The `a[[i]]` false positive (R indexing, a nested Python list literal,
    // in prose or inside a fence) is ACCEPTED, not engineered around: the
    // notification is warn-only, changes no bytes and blocks nothing, whereas
    // excluding fenced regions would mean a second scanner agreeing with the
    // parser about fence boundaries.
    if (containsWikilink(prepared.content)) {
      return [
        {
          kind: "other",
          error: undefined,
          message:
            `${ctx?.fileName ?? "This document"} contains [[wikilinks]]. Tandem does not ` +
            `preserve them — they are saved as literal text. Obsidian-style vaults are not ` +
            `supported in this release.`,
        },
      ];
    }
    return [];
  },
  save(doc) {
    return saveMarkdown(doc);
  },
};

const plaintextAdapter: FormatAdapter = {
  async parse(content): Promise<Prepared> {
    const text = typeof content === "string" ? content : content.toString("utf-8");
    return { format: "other", content: text, issues: [] };
  },
  apply(doc, prepared) {
    if (prepared.format !== "other") return [];
    populateYDoc(doc, stripAndRecordBom(doc, normalizeAndRecordLineEnding(doc, prepared.content)));
    return [];
  },
  save(doc) {
    // Restoring here rather than inside `extractText` is deliberate: that
    // function is also the flat-offset coordinate system every annotation range
    // is expressed in (Critical Rule 5), and a `\r` there would shift every
    // offset past it. Only the disk-bound copy gets the file's own endings.
    return restoreBom(doc, restoreLineEndings(doc, extractText(doc)));
  },
};

/**
 * The .docx adapter provides `saveBinary` (#576) — .docx write-back holds edits
 * in the Y.Doc and serializes to a `.docx` buffer on EXPLICIT save only. This
 * supersedes ADR-004's read-only default; the protective layer is now "never
 * overwrite without an explicit save" rather than `contenteditable=false`.
 * Exports body + Word comments (#1068): user/Claude `comment`-type annotations
 * AND imported Word comments written back to their source file (private notes
 * that round-trip but stay Claude-invisible), per the gate in
 * `docx-comment-export.ts` — tracked changes stay deferred.
 *
 *   - `parse` runs four readers in parallel: `loadDocxWithWarnings`,
 *     `extractDocxComments`, `parseDocxFootnotes`, and `scanDocxLostFeatures`.
 *     The last two exist because mammoth is SILENT about its highest-stakes
 *     losses — it emits zero warnings for footnotes, headers/footers or tracked
 *     changes — so the only way to be honest about them is to read the package
 *     directly. Their count-only lines join mammoth's own into a single
 *     `LoadIssue { kind: "other" }` carrying `importLosses`, which drives both
 *     the open-time toast and the persistent fidelity report. Comment-extraction
 *     failures land as `LoadIssue { kind: "comments-failed" }` rather than being
 *     swallowed.
 *   - `apply` runs `htmlToYDoc` then `injectCommentsAsAnnotations`
 *     synchronously inside the caller's transact. The snapshot/undo dance
 *     around inject lives here because Yjs doesn't roll back inner-transact
 *     writes when a callback throws.
 *   - `saveBinary` serializes the current Y.Doc body + pending comment
 *     annotations to a `.docx` buffer via `exportYDocToDocx`
 *     (trust-boundary-gated). NOT wired into auto-save.
 */
const docxAdapter: FormatAdapter = {
  async parse(content, options): Promise<Prepared> {
    const buffer = content as Buffer;

    // #1310: refuse an over-expanding archive BEFORE any reader sees the buffer.
    //
    // This has to sit ahead of the fan-out rather than inside the readers, because the first entry
    // below is mammoth, which loads its own zip and reads more parts than the other three combined.
    // Nothing added to our own `.async("text")` call sites can reach it. Throwing here also means a
    // reader added later inherits the guard instead of having to remember it.
    //
    // Deliberately a throw rather than a `LoadIssue`: every issue kind below describes a document
    // that DID import with something lost, and the fidelity-report banner reads them that way.
    // "We refused to open this" is not a fidelity loss, and dressing it as one would render a
    // banner about a document that isn't on screen.
    await assertDocxWithinSizeLimits(buffer);

    const issues: LoadIssue[] = [];
    let commentsFailed = false;
    const [loaded, comments, notes, lost] = await Promise.all([
      loadDocxWithWarnings(buffer),
      extractDocxComments(buffer).catch((err) => {
        console.error(
          "[docx-comments] Comment extraction failed; document will load without imported comments:",
          err,
        );
        issues.push({ kind: "comments-failed", error: err });
        commentsFailed = true;
        return [] as DocxComment[];
      }),
      // Footnote/endnote capture (#1123 Tier-A #3): mammoth flattens these to a
      // trailing list and emits NO warning. Read the real notes directly from
      // the ZIP so the import can BOTH surface an honest loss line AND capture
      // footnote bodies for reconstruction. parseDocxFootnotes never throws (it
      // catches per-part + per-archive); this .catch is last-resort defense.
      parseDocxFootnotes(buffer).catch((err) => {
        console.error("[docx-footnotes] parse failed unexpectedly:", err);
        return { footnotes: {}, endnotes: 0 } satisfies DocxNotes;
      }),
      // Tracked changes + headers/footers (#1142 G3): mammoth emits ZERO
      // warnings for either — measured, not assumed — so without this scan a
      // reviewed document imports with every insertion silently accepted and
      // every deletion silently discarded. Counts only; never reads w:author or
      // header text. scanDocxLostFeatures never throws; this is last-resort.
      options?.scanLostFeatures === false
        ? noLostFeatures()
        : scanDocxLostFeatures(buffer).catch((err) => {
            console.error("[docx-lost-features] scan failed unexpectedly:", err);
            return noLostFeatures();
          }),
    ]);
    // Ordered MOST-DESTRUCTIVE FIRST. Tracked changes lead: they are the only
    // entry in the whole report where the text the user reads is not the text
    // the author wrote (an insertion is silently accepted, a deletion silently
    // discarded). Headers/footers next — total destruction of visible page
    // furniture. Footnote lines follow (mostly reconstructed now, so only the
    // degraded subset reports). mammoth's style-level long tail rides last,
    // already deduped + capped inside summarizeMammothMessages.
    //
    // The fixed-set lines are bounded at 10 — up to 5 revision-family (the
    // "couldn't check" line CAN coexist with counts, since the notes parts are
    // still tallied after the main part fails), 2 header/footer, 3 note — and
    // ride on TOP of mammoth's MAX_FIDELITY_WARNINGS cap. mammoth's move bucket
    // is partitioned out of that cap and is itself bounded at 6 distinct
    // messages, so the true worst case is 10 + 8 + 6 = 24 lines for a
    // pathological document. No re-flooding, no new cap needed. Note the counts INSIDE each
    // line are unbounded, deliberately: "47 tracked deletions" is materially
    // different from "3", and these lines never reach Claude (see the note in
    // docx-lost-features.ts), so there is no oracle to bound.
    // Crucially the guard below fires when ANY source is non-empty,
    // because mammoth emits zero warnings for revisions, headers/footers OR
    // notes. The footnote line is driven off the RECONCILED partition (same
    // inputs `htmlToYDoc` reconciles in `apply` → identical result), so a
    // footnote that won't reconstruct (an orphaned definition, or a
    // mammoth-format drift) is reported as a loss, not silently claimed
    // "preserved".
    const reconciliation = reconcileFootnoteIds(loaded.html, notes.footnotes);
    // Body pictures (#1755). mammoth emits a picture as `<p><img src="data:…"/></p>`
    // and the paragraph arm defers its children to `processInlineNodes`, which has
    // no `img` arm — so the image is discarded, `scanDocxLostFeatures` says nothing,
    // and `tandem_save` then regenerates the .docx without it. Skipped when the
    // caller skipped the lost-feature scan, because that is the `docx-verify.ts`
    // re-import, which reads no `prepared.issues`: this costs one extra conversion
    // per real document open and zero per save verification.
    const droppedImages =
      options?.scanLostFeatures === false ? 0 : countDroppedImages(loaded.html, notes.footnotes);
    // mammoth is the ONE revision family it isn't silent about: it emits
    // "unrecognised element was ignored: w:move…" for both halves of a move and
    // their range markers. `loadDocxWithWarnings` keeps those OUT of the capped
    // general set (see `partitionMammothMessages`) so they can't crowd out real
    // style warnings; here we decide whether to surface them at all. Our own
    // move line says strictly more, so it supersedes them — but ONLY when we
    // actually emitted it, so a failed scan can never leave the move loss
    // unreported by BOTH sources.
    const mammothWarnings =
      moveCount(lost.revisions) > 0
        ? loaded.warnings
        : [...loaded.warnings, ...(loaded.moveWarnings ?? [])];
    // `structural` = things that ARE gone, and only those: it drives the
    // save-time overwrite warning, whose copy asserts the backed-up original has
    // features this file doesn't. The scan-failure line rides in the banner but
    // stays out of that count — "couldn't check" is not "is missing".
    const structural = [
      ...structuralLossLines(lost),
      ...footnoteStructuralLines(notes, reconciliation),
      // A comment-extraction failure is a STRUCTURAL loss like any other: the
      // file's Word comments are not in the model and the save writes a .docx
      // without them. It previously produced only an open-time toast via the
      // `comments-failed` issue, so it was silent at the moment of overwrite —
      // the half of G3 that matters most. Count-only, like every other line.
      ...(commentsFailed
        ? ["this file's Word comments couldn't be read and won't be in the saved file"]
        : []),
      // `structural` because `structural` means "things that ARE gone" — NOT
      // because it drives the overwrite warning, which for this document can no
      // longer happen: the save is refused outright (`import-image-loss`).
      // Count-only, never a `src` or an `alt`; and the copy has to describe the
      // REFUSAL and name an exit reachable FROM THIS DOCUMENT. Since #1941 there
      // are two exits and the first needs no Claude at all: the "Save anyway
      // without pictures" button this line sits directly above in
      // `FidelityReportBanner`. The wording must still not read as a
      // lossy-save-by-default — the refusal is the default, the button is the
      // opt-out.
      ...(droppedImages > 0
        ? [
            `${droppedImages} picture(s) couldn't be imported, so saving back as .docx is ` +
              'refused by default — choose "Save anyway without pictures" below to save your ' +
              "edits without them, or ask Claude to convert it to Markdown to keep everything",
          ]
        : []),
    ];
    // A footnote that reconstructs but lost its bold is NOT structural loss —
    // the line literally says "preserved". Counting it would fire the overwrite
    // warning for a footnote the exporter re-emits intact, and formatted
    // footnotes are near-universal in reviewed Word files.
    const importLosses = [
      ...scanFailureLines(lost),
      ...structural,
      ...footnoteDowngradeLines(notes, reconciliation),
      ...mammothWarnings,
    ];
    if (importLosses.length > 0) {
      issues.push({
        kind: "other",
        error: undefined,
        message:
          // "features", not "formatting": a tracked change is neither formatting
          // nor merely dropped — it was APPLIED, which the lines themselves say.
          "Some Word features in this file weren't imported and won't be preserved on save: " +
          `${importLosses.join("; ")}.`,
        // Granular list for the persistent fidelity report (#1145); the joined
        // `message` above drives the transient open-time toast.
        importLosses,
        structuralLosses: structural.length,
        droppedImages,
      });
    }
    return { format: "docx", html: loaded.html, comments, footnoteBodies: notes.footnotes, issues };
  },
  async saveBinary(doc): Promise<Buffer> {
    return exportYDocToDocx(doc);
  },
  apply(doc, prepared, ctx) {
    if (prepared.format !== "docx") return [];
    const reconciledFootnotes = htmlToYDoc(doc, prepared.html, prepared.footnoteBodies);
    // Persist the reconstructed footnote bodies off-fragment so the exporter can
    // re-emit real <w:footnote> parts (#1123 Tier-A #3 PR 2). WHOLE-VALUE replace
    // (a reload with fewer footnotes must not leave stale ids). The caller's
    // transact is already origin-tagged; this documentMeta key has no observer
    // (server write-only, client/Claude-invisible) and sits OUTSIDE the comment-
    // inject rollback zone below, which only deletes newly-added annotation keys.
    doc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_FOOTNOTE_BODIES, reconciledFootnotes);
    const out: LoadIssue[] = [];
    if (prepared.comments.length > 0) {
      // Snapshot-and-rollback: Yjs does NOT roll back inner-transact writes
      // when a callback throws, so we capture the key set before inject and
      // delete any newly-added keys on throw. Without this, a partial inject
      // would commit half the comments and re-open would hit importAnnotationId
      // dedup, permanently dropping the failing comment.
      const annotMap = doc.getMap(Y_MAP_ANNOTATIONS);
      const before = new Set(annotMap.keys());
      try {
        // The `onClamp` callback fires at most once, and only when a comment's
        // range had to be clamped to the document end. One aggregate LoadIssue,
        // not one per comment: the per-comment detail is already on stderr, and
        // what the user needs to know is "some of your Word comments did not
        // land where Word put them", once (#1752).
        injectCommentsAsAnnotations(
          doc,
          prepared.comments,
          ctx?.fileName,
          ({ count, maxClamp }) => {
            out.push({ kind: "comments-clamped", count, maxClamp });
          },
        );
      } catch (err) {
        for (const k of annotMap.keys()) {
          if (!before.has(k)) annotMap.delete(k);
        }
        console.error(
          "[docx-comments] inject failed mid-transact; document loads without imported comments:",
          err,
        );
        out.push({ kind: "inject-failed", error: err });
      }
    }
    return out;
  },
};

// -- Registry --

const adapters: Record<string, FormatAdapter> = {
  md: markdownAdapter,
  other: plaintextAdapter, // covers txt, html, and any other plaintext-routed format
  docx: docxAdapter,
};

/** Look up the adapter for a given format string. Unknown formats fall back
 * to the plaintext adapter. */
export function getAdapter(format: string): FormatAdapter {
  return adapters[format] ?? plaintextAdapter;
}

// -- Shared helpers --

/**
 * Atomic rename retry constants. Windows can throw EPERM/EACCES when another
 * process (AV scanner, file indexer, or a stale handle) is briefly holding the
 * destination file. A handful of short retries with exponential backoff clears
 * virtually all such contention in practice.
 */
const RENAME_MAX_RETRIES = 3;
const RENAME_RETRY_BASE_MS = 50;

async function renameWithRetry(tempPath: string, filePath: string): Promise<void> {
  for (let attempt = 0; attempt < RENAME_MAX_RETRIES; attempt++) {
    try {
      await fs.rename(tempPath, filePath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === "EPERM" || code === "EACCES") && attempt < RENAME_MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, RENAME_RETRY_BASE_MS * 2 ** attempt));
        continue;
      }
      await fs.unlink(tempPath).catch(() => {});
      throw err;
    }
  }
}

/**
 * Filename prefix for atomic-write temp siblings. Exported so the startup
 * reaper (`reaper.ts`) can build the exact same name shape it sweeps for.
 */
export const ATOMIC_TEMP_PREFIX = ".tandem-tmp-";

/**
 * Produce a unique temp filename in the same directory as `filePath`. Uses a
 * random suffix so concurrent writers to the same directory cannot collide on
 * a shared `Date.now()` millisecond (the annotation store writes multiple
 * files in the same directory in parallel).
 */
export function tempSiblingPath(filePath: string): string {
  const rand = crypto.randomBytes(6).toString("hex");
  return path.join(path.dirname(filePath), `${ATOMIC_TEMP_PREFIX}${Date.now()}-${rand}`);
}

/**
 * Permission bits of the file a save is about to replace, or `undefined` to
 * create the replacement at the process default (today's behaviour) — for a
 * new file, on Windows (mode bits do not carry its access control), for
 * anything but a regular file, or for any stat failure. The catch also covers
 * a partial stat double such as `{ mtimeMs }` (its `isFile` call throws),
 * which would otherwise yield `undefined & 0o666 === 0`: a mode-0000 file.
 *
 * `stat`, never `lstat`: the rename replaces a symlink with a regular file
 * either way, so the mode that matters is the file it points at. Execute bits
 * are dropped (`& 0o666`): a document is never executable, and keeping them
 * would make a save wider than the old default. Never throws, so the
 * cleanup contract in `writeTempThenRename` is unchanged.
 */
async function existingMode(filePath: string): Promise<number | undefined> {
  if (process.platform === "win32") return undefined;
  try {
    const st = await fs.stat(filePath);
    return st.isFile() ? st.mode & 0o666 : undefined;
  } catch {
    return undefined;
  }
}

/** Options shared by `atomicWrite` / `atomicWriteBuffer`. */
export interface AtomicWriteOptions {
  /**
   * POSIX permission ceiling for the written file (#2266). The temp is created
   * at `(replaced file's mode ?? 0o666) & maxMode`, so the ceiling only ever
   * REMOVES bits — it cannot widen a file, and it is applied at create time
   * rather than by a chmod. Ignored on Windows, mirroring `existingMode`.
   * Omitted: today's behaviour exactly (the replaced file's mode, else the
   * process default).
   */
  maxMode?: number;
}

/**
 * A mode ceiling for a file DERIVED from `sourcePath` (the annotation-export
 * sidecar, convert output): the owner keeps read/write, and group/other get at
 * most what the source grants them — `0o600 | (src & 0o066)`. So a `0600`
 * document yields a `0600` derivative, a `0640` one `0640`, a `0444` one
 * `0644` (world-readable source, world-readable derivative, but writable by its
 * owner), and a `0400` one `0600`.
 *
 * `undefined` — no ceiling — for an `upload://` source (no file on disk), on
 * Windows, and whenever the source cannot be stat'd as a regular file.
 */
export async function derivedFileModeCeiling(sourcePath: string): Promise<number | undefined> {
  if (sourcePath.startsWith("upload://")) return undefined;
  const src = await existingMode(sourcePath);
  return src === undefined ? undefined : 0o600 | (src & 0o066);
}

/** The temp's create mode: the replaced file's mode, capped by `maxMode` on POSIX. */
async function tempMode(
  filePath: string,
  maxMode: number | undefined,
): Promise<number | undefined> {
  const existing = await existingMode(filePath);
  if (maxMode === undefined || process.platform === "win32") return existing;
  return (existing ?? 0o666) & maxMode;
}

/** Directories whose filesystem refused fsync once; later saves skip the flush. */
const flushRefusedDirs = new Set<string>();

/**
 * Shared body of `atomicWrite` / `atomicWriteBuffer`: write a temp sibling,
 * then rename it over the target.
 *
 * The temp is created at the replaced file's mode (#2266), so saving a
 * `chmod 600` document no longer widens it to the umask default. The umask
 * still applies at create, so the result is `original & 0o666 & ~umask` — never wider
 * than the original, and never wider than before this fix. Bits the umask
 * strips are deliberately NOT restored: no chmod runs at all, because a
 * path-based chmod follows a symlink swapped in after the create, and
 * re-granting group bits can widen access when the rename hands the file
 * Tandem's group rather than the original's. `wx` refuses a pre-existing
 * entry at the temp name rather than writing through it.
 *
 * An optional `maxMode` (app-data store files at `0600`, derived files at the
 * source's ceiling) is ANDed into that create mode, so it narrows and never
 * widens, and it keeps the same no-chmod shape: an existing `0644` store file
 * becomes `0600` the next time it is rewritten, and a file that is never
 * rewritten keeps whatever mode it has.
 *
 * The temp is fsynced before the rename publishes it (`flush: true`), so a
 * power loss or OS crash cannot leave the document renamed into place but
 * empty or zero-filled — the failure an unflushed tmp+rename has on XFS and
 * possibly NTFS. macOS `fsync` does not flush the drive's own cache (Node has
 * no `F_FULLFSYNC`), so APFS gets only part of this. The directory is NOT
 * fsynced: a lost rename leaves the complete previous file (or, for a file
 * being created, no file), never a torn one.
 */
async function writeTempThenRename(
  filePath: string,
  content: string | Buffer,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const mode = await tempMode(filePath, options.maxMode);
  const dir = path.dirname(filePath);
  let tempPath = tempSiblingPath(filePath);
  try {
    await writeTemp(tempPath, content, mode, !flushRefusedDirs.has(dir));
  } catch (err) {
    // A filesystem that refuses fsync keeps the pre-flush behaviour rather
    // than failing every save. A fresh temp name: the first is already gone.
    if (flushRefusedDirs.has(dir) || !isFlushUnsupported(err)) throw err;
    flushRefusedDirs.add(dir);
    tempPath = tempSiblingPath(filePath);
    await writeTemp(tempPath, content, mode, false);
  }
  await renameWithRetry(tempPath, filePath);
}

/**
 * Create `tempPath` exclusively and write `content` to it.
 *
 * On a failed write, unlink the partial temp before rethrowing — mirroring
 * `renameWithRetry`'s own failure arm. A partial sibling in the USER's document
 * directory is never reaped (the boot reaper sweeps the annotations + sessions
 * dirs only), and on the buffer path it is the largest file Tandem writes.
 * The unlink is swallowed: the write error is the one the caller must see, and
 * the temp may legitimately not exist (an ENOSPC that failed before `open`).
 * An EEXIST is not ours to unlink. (#1850)
 */
async function writeTemp(
  tempPath: string,
  content: string | Buffer,
  mode: number | undefined,
  flush: boolean,
): Promise<void> {
  const opts = { flag: "wx", mode, flush } as const;
  try {
    if (typeof content === "string")
      await fs.writeFile(tempPath, content, { ...opts, encoding: "utf-8" });
    else await fs.writeFile(tempPath, content, opts);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
}

/**
 * Tail of the in-flight write chain per resolved target path. Two writes to
 * one path each have their own temp, so without this the rename that lands
 * LAST wins — and the fsync above makes "last" a race between threadpool
 * jobs, letting an older snapshot (an annotation envelope, a session) be
 * renamed over a newer one. Chaining makes renames land in call order, and
 * callers pass content already snapshotted, so call order is snapshot order.
 */
const writeChains = new Map<string, Promise<void>>();

function serializedWrite(
  filePath: string,
  content: string | Buffer,
  options?: AtomicWriteOptions,
): Promise<void> {
  return runSerialized(writeChains, path.resolve(filePath), () =>
    writeTempThenRename(filePath, content, options),
  );
}

/**
 * Run `task` after every task previously queued under `key` in `chains` has
 * settled, so tasks on one key run strictly in call order. A failed task does
 * not stall the queue; its rejection reaches only its own caller. The entry is
 * dropped once the queue drains, so `chains` does not grow with every key seen.
 * `await chains.get(key)` waits for the queue to drain and never rejects.
 */
export function runSerialized(
  chains: Map<string, Promise<void>>,
  key: string,
  task: () => Promise<void>,
): Promise<void> {
  const next = (chains.get(key) ?? Promise.resolve()).then(task);
  const tail = next.catch(() => {});
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return next;
}

/**
 * Atomic file write: write to a temp file, then rename.
 * Prevents partial writes on crash. Retries the rename up to 3 times on
 * EPERM/EACCES (Windows file-handle contention) with exponential backoff, and
 * cleans up the temp sibling on a failed write (#1850).
 */
export function atomicWrite(
  filePath: string,
  content: string,
  options?: AtomicWriteOptions,
): Promise<void> {
  return serializedWrite(filePath, content, options);
}

/**
 * Atomic binary file write: write Buffer to a temp file, then rename.
 * Used for .docx (ZIP) output where UTF-8 encoding would corrupt binary data.
 * Shares the same retry and temp-cleanup behaviour as `atomicWrite`.
 */
export function atomicWriteBuffer(
  filePath: string,
  content: Buffer,
  options?: AtomicWriteOptions,
): Promise<void> {
  return serializedWrite(filePath, content, options);
}
