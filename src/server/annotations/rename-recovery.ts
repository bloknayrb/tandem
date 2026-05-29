/**
 * Rename recovery for durable annotations (#313).
 *
 * Annotations persist per-document at `<annotationsDir>/<docHash>.json`, where
 * `docHash = SHA-256(normalized abs path)`. Renaming a file changes its path
 * and therefore its hash, orphaning the annotation envelope (the new path
 * resolves to a fresh, empty envelope). This module re-associates the orphaned
 * envelope with the renamed document.
 *
 * ## The signal: byte-identical content + a vanished old path
 *
 * On open, when no path-hash envelope exists for the current document, we scan
 * every envelope in the annotations dir for one whose stored `meta.contentHash`
 * EXACTLY equals the current document's `contentHash(extractText(doc))` AND
 * whose `meta.filePath` no longer exists on disk. The vanished old path is the
 * rename signal: if the old path still exists, this is a COPY (not a rename),
 * and stealing the original's annotations would be wrong — so we leave it.
 *
 * ## Safety rails (a naïve version causes silent data loss)
 *
 *   - **Unique 1:1 match only.** If two orphaned envelopes share the content
 *     hash, we can't tell which one belongs to this document — bail.
 *   - **Skip empty/whitespace bodies.** Every brand-new file collides on the
 *     empty-content hash, so the empty hash carries no rename signal.
 *   - **Exact content match.** Flat-offset re-anchoring (done downstream by
 *     `loadAndMerge`/`refreshRange`) is valid ONLY because the exact match
 *     guarantees byte-identical text. An edited-then-renamed file will NOT
 *     re-associate (its content hash no longer matches) — correct-but-limited
 *     beats silent mis-anchoring. A bulk-migration CLI and `upload://` handling
 *     are deferred to a follow-up.
 *   - **Re-key, never raw-rename.** We rewrite the ENTIRE envelope (annotations
 *     + tombstones + replies) under the new docHash through the store's
 *     `queueWrite`/`flush`, then unlink the old file — never an `fs.rename`
 *     that could race a pending debounce on either hash.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type * as Y from "yjs";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../shared/constants.js";
import { withInternal } from "../../shared/origins.js";
import { isUploadPath } from "../../shared/paths.js";
import { extractText } from "../mcp/document-model.js";
import { contentHash, ENVELOPE_FILENAME_RE } from "./doc-hash.js";
import { type AnnotationDocV1, parseAnnotationDoc, SCHEMA_VERSION } from "./schema.js";
import {
  createStore,
  getAnnotationsDir,
  isStoreFeatureDisabled,
  isStoreReadOnly,
} from "./store.js";
import { recordTombstone } from "./sync.js";

// Envelope filename shape is hoisted to ./doc-hash.ts as ENVELOPE_FILENAME_RE
// so rename-recovery + session-cleanup share one source of truth (any drift
// would silently widen the trust surface).

/**
 * Attempt to recover an orphaned annotation envelope for a renamed document.
 *
 * Called from `wireAnnotationStore` ONLY when no envelope exists at the
 * document's current path-hash (so it never steals from a live envelope). On a
 * unique exact-content match against an orphaned envelope (old path gone), the
 * envelope is re-keyed to `currentHash` on disk and its annotations + replies
 * are injected into the Y.Doc via `withInternal` (open-time population);
 * tombstones are seeded into the in-memory ledger so the anti-resurrection
 * merge survives the rename. `loadAndMerge` then runs as usual (it sees the
 * re-keyed file and the now-populated Y.Map as identical — an idempotent
 * merge — and registers the observer).
 *
 * Best-effort: any failure is swallowed (logged to stderr). Recovery never
 * blocks a doc open; annotations are additive durability.
 *
 * @returns `true` if an envelope was recovered and re-keyed, `false` otherwise.
 */
export async function recoverRenamedEnvelope(
  doc: Y.Doc,
  currentHash: string,
  currentFilePath: string,
): Promise<boolean> {
  try {
    // Read-only mode OR the feature kill-switch (`TANDEM_ANNOTATION_STORE=off`):
    // queueWrite is a no-op and flush won't persist the re-keyed envelope.
    // Injecting + unlinking the old file would then lose data. The feature-off
    // case is the dangerous one — `annotationFileExists` short-circuits to
    // false when disabled, so recovery is entered, the inert flush "succeeds"
    // silently, and the old envelope would be unlinked with no durable copy.
    // Bail before mutating anything.
    if (isStoreReadOnly() || isStoreFeatureDisabled()) return false;

    const text = extractText(doc);
    // Empty/whitespace bodies carry no rename signal — every new file collides
    // on (near-)empty content. Skip them entirely.
    if (text.trim().length === 0) return false;
    const wantHash = contentHash(text);

    const dir = getAnnotationsDir();
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }

    const currentFile = `${currentHash}.json`;

    // Collect candidate envelopes: content-hash match + old path vanished.
    // Track the source FILENAME alongside the parsed doc — the filename is the
    // storage key and the only path-safe handle (it passed ENVELOPE_FILENAME_RE). The
    // envelope's internal `meta`/`docHash` are unconstrained JSON and must never
    // be used to build a filesystem path (path-injection + a legacy envelope's
    // `docHash` can disagree with its filename, e.g. `docHash: ""`).
    const candidates: { doc: AnnotationDocV1; file: string }[] = [];
    for (const file of files) {
      if (!ENVELOPE_FILENAME_RE.test(file)) continue;
      if (file === currentFile) continue; // can't be its own source

      let raw: string;
      try {
        raw = await fs.readFile(path.join(dir, file), "utf-8");
      } catch {
        continue; // unreadable — skip, never fail the whole recovery
      }
      // Perf: short-circuit on hash mismatch before the Zod parse. The store
      // serializes `meta.contentHash` as a compact `"contentHash":"<hex>"`
      // substring (no spacing, JSON.stringify default), so this substring
      // check is a cheap O(N) filter that rejects 99%+ of envelopes without
      // paying the parser cost. Whitespace-sensitive: if the writer ever
      // switches to pretty-printed JSON, this optimization silently stops
      // working — guarded by the freshly-written-envelope test below.
      if (!raw.includes(`"contentHash":"${wantHash}"`)) continue;
      const parsed = parseAnnotationDoc(raw);
      if (!parsed.ok) continue;

      const stored = parsed.doc.meta.contentHash;
      if (typeof stored !== "string" || stored !== wantHash) continue;

      const oldPath = parsed.doc.meta.filePath;
      if (!oldPath || oldPath === currentFilePath) continue;
      // Exclude upload://… envelopes from rename-source candidacy: their
      // `oldPath` (e.g. `upload://<id>/<name>`) is never reachable via
      // `fs.access`, so the "vanished" probe below would always succeed and
      // a content-matching local doc could be silently re-keyed onto the
      // upload's envelope — then `fs.unlink` the upload's recovery. The
      // legitimate upload would lose its annotations.
      if (isUploadPath(oldPath)) continue;
      // Only accept absolute paths — relative paths from untrusted JSON could
      // resolve to unexpected locations. path.isAbsolute rejects them early.
      if (!path.isAbsolute(oldPath)) continue;
      // Normalize via path.resolve so the downstream fs.access receives a
      // fully-resolved path. After resolving, reject any UNC/network share
      // prefix (\\\\server\\share or //server/share) to prevent NTLM hash
      // leakage via Windows authentication challenges.
      const resolvedOldPath = path.resolve(oldPath);
      if (resolvedOldPath.startsWith("\\\\") || resolvedOldPath.startsWith("//")) continue;

      // The rename signal: the old path must no longer exist. If it still
      // exists, this is a copy — do NOT steal its annotations.
      // Safety: path is validated above (isAbsolute + resolve + no-UNC).
      let oldStillExists: boolean;
      try {
        await fs.access(resolvedOldPath); // lgtm[js/path-injection]
        oldStillExists = true;
      } catch {
        oldStillExists = false;
      }
      if (oldStillExists) continue;

      candidates.push({ doc: parsed.doc, file });
    }

    // Re-key only on a unique 1:1 match. Ambiguity → bail (don't guess).
    if (candidates.length !== 1) return false;

    const source = candidates[0].doc;
    const sourceFile = candidates[0].file;

    // Rewrite the ENTIRE envelope under the new docHash via the store's
    // queueWrite/flush (never a raw fs.rename that could race a pending
    // debounce on either hash). lastUpdated/contentHash are refreshed; the
    // snapshot observer will re-stamp contentHash on the next live write too.
    const rekeyed: AnnotationDocV1 = {
      ...source,
      schemaVersion: SCHEMA_VERSION,
      docHash: currentHash,
      meta: {
        ...source.meta,
        filePath: currentFilePath,
        lastUpdated: Date.now(),
        contentHash: wantHash,
      },
    };

    const store = createStore(currentHash, { filePath: currentFilePath });
    store.queueWrite(() => rekeyed);
    await store.flush();

    // Inject recovered annotations + replies into the Y.Doc (open-time
    // population → withInternal). The merge that loadAndMerge runs next sees
    // file == Y.Map and is a no-op.
    const annMap = doc.getMap(Y_MAP_ANNOTATIONS);
    const repMap = doc.getMap(Y_MAP_ANNOTATION_REPLIES);
    withInternal(doc, () => {
      for (const ann of rekeyed.annotations) {
        annMap.set(ann.id, ann);
      }
      for (const reply of rekeyed.replies) {
        repMap.set(reply.id, reply);
      }
    });

    // Seed tombstones into the in-memory ledger under the NEW hash so a stale
    // reconnecting tab can't resurrect a deletion that happened before the
    // rename. `recordTombstone` dedupes by id (keeps the higher rev); it stores
    // at `prevRev + 1`, so we pass `rev - 1` to preserve the recorded rev.
    for (const stone of rekeyed.tombstones) {
      recordTombstone(currentHash, stone.id, stone.rev - 1);
    }

    // Unlink the old envelope now that the re-keyed copy is durably flushed.
    // Use the actual source FILENAME (path-safe, passed ENVELOPE_FILENAME_RE) — never
    // the envelope's internal `docHash`, which is unconstrained JSON.
    try {
      await fs.unlink(path.join(dir, sourceFile));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // Constant format string + args (filenames are user-controlled — keep
        // them out of the printf-style format slot; CodeQL js/format-string).
        console.error(
          "[ANNOTATION-RECOVERY] re-keyed %s -> %s but failed to unlink old file:",
          sourceFile,
          currentFile,
          err,
        );
      }
    }

    console.error(
      "[ANNOTATION-RECOVERY] recovered renamed annotations: %s -> %s (%d annotation(s))",
      sourceFile,
      currentFile,
      rekeyed.annotations.length,
    );
    return true;
  } catch (err) {
    // Best-effort — never block a doc open.
    console.error(
      "[ANNOTATION-RECOVERY] recovery failed for %s:",
      currentFilePath,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
