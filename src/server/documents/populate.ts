/**
 * Loading content into a Y.Doc, and tearing it back out again.
 *
 * Split out of `mcp/file-opener.ts` for ADR-034 Unit 7a. This is the half the
 * open pipeline and the reload family genuinely share: `clearAndReload` and
 * `reloadFromDisk` reach for the same `prepareContent` / `applyPreparedContent`
 * / `clearDocMaps` as a first-time open does. Leaving them behind while moving
 * the pipeline would have made the reload family import back into
 * `documents/`, which is the cycle 7a exists to remove, pointed the other way.
 *
 * Nothing here touches the document registry or `document-service.ts` — that
 * is what lets both sides import it.
 */

import fs from "fs/promises";
import path from "path";
import type * as Y from "yjs";
import {
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
  Y_MAP_AWARENESS,
  Y_MAP_DOCUMENT_META,
  Y_MAP_EXTERNAL_CONFLICT,
  Y_MAP_FIDELITY_REPORT,
  Y_MAP_READ_ONLY,
  Y_MAP_SAVED_AT_VERSION,
  Y_MAP_USER_AWARENESS,
} from "../../shared/constants.js";
import { withFileSync, withInternal } from "../../shared/origins.js";
import type { FidelityReport } from "../../shared/types.js";
import { generateNotificationId } from "../../shared/utils.js";
import { attachObservers, clearFileSyncContext } from "../events/queue.js";
import { getAdapter, type LoadIssue, type Prepared } from "../file-io/index.js";
import { pushNotification } from "../notifications.js";
import { deleteSession } from "../session/manager.js";
import { markClean } from "./dirty.js";
import type { OpenDoc } from "./registry.js";

/**
 * Context passed to populateDocFromContent for user-facing diagnostics —
 * either a file path (displayName=basename, dedupSource=absolute path) or
 * an upload (displayName=uploaded filename, dedupSource=synthetic upload path).
 */
interface PopulateContext {
  displayName: string;
  dedupSource: string;
}

/**
 * Async pre-parse step — runs OUTSIDE any Y.Doc transact. Delegates all
 * format-specific work to the adapter's `parse`; parse-time failures land
 * as `LoadIssue` entries on the returned `Prepared` rather than throwing.
 * Notifications fire later at `applyPreparedContent` time so parse + apply
 * issues are surfaced together.
 */
async function prepareContent(format: string, source: string | Buffer): Promise<Prepared> {
  if (format === "docx" && !Buffer.isBuffer(source)) {
    throw Object.assign(new Error("prepareContent: docx requires Buffer source"), {
      code: "INVALID_SOURCE",
    });
  }
  return getAdapter(format).parse(source);
}

/**
 * Sync apply step — must run INSIDE the caller's origin-tagged transact.
 *
 * Delegates doc mutation to `adapter.apply`. The docx adapter owns the
 * snapshot/undo dance around `injectCommentsAsAnnotations` (Yjs does NOT roll
 * back inner-transact writes when a callback throws). Parse-time and apply-
 * time `LoadIssue`s surface as deduped user-facing notifications; distinct
 * dedupKey namespaces per failure kind so a docx hitting both comments-failed
 * AND inject-failed shows two toasts, not one collapsed.
 */
function applyPreparedContent(doc: Y.Doc, prepared: Prepared, ctx: PopulateContext): void {
  const adapter = getAdapter(prepared.format);
  const applyIssues = adapter.apply(doc, prepared, { fileName: ctx.displayName });
  for (const issue of prepared.issues) notifyIssue(issue, ctx);
  for (const issue of applyIssues) notifyIssue(issue, ctx);
  writeImportLossReport(doc, prepared);
}

/**
 * Write/refresh the docx fidelity report's import-loss half (#1145, the
 * "honesty layer" / phase 0f). MUST run inside the caller's origin-tagged
 * transaction — `applyPreparedContent` is always wrapped in `withInternal`
 * (open + force-reload). docx-only; resets `exportDowngrades` because a
 * re-import makes any prior save's downgrades stale. Always writes for docx so
 * a re-import with no losses clears a prior report (the client hides the banner
 * when both lists are empty). The write is inert for the channel + durable-sync
 * subsystems regardless of origin (no observer on per-doc documentMeta).
 */
export function writeImportLossReport(doc: Y.Doc, prepared: Prepared): void {
  if (prepared.format !== "docx") return;
  let importLosses: string[] = [];
  let structuralLosses = 0;
  for (const issue of prepared.issues) {
    if (issue.kind === "other" && issue.importLosses) {
      importLosses = issue.importLosses;
      structuralLosses = issue.structuralLosses ?? 0;
    }
  }
  const meta = doc.getMap(Y_MAP_DOCUMENT_META);
  meta.set(Y_MAP_FIDELITY_REPORT, {
    importLosses,
    structuralLosses,
    exportDowngrades: [],
    updatedAt: Date.now(),
  } satisfies FidelityReport);
}

/** Translate a single LoadIssue to a user-facing notification. */
function notifyIssue(issue: LoadIssue, ctx: PopulateContext): void {
  switch (issue.kind) {
    case "comments-failed":
      pushNotification({
        id: generateNotificationId(),
        type: "annotation-error",
        severity: "warning",
        message: `Failed to import Word comments from ${ctx.displayName}. Document opened without comments.`,
        dedupKey: `docx-comments:${ctx.dedupSource}`,
        timestamp: Date.now(),
      });
      return;
    case "inject-failed":
      pushNotification({
        id: generateNotificationId(),
        type: "annotation-error",
        severity: "warning",
        message: `Failed to import some Word comments from ${ctx.displayName}. Document opened, but comments may be missing.`,
        dedupKey: `docx-comments-inject:${ctx.dedupSource}`,
        timestamp: Date.now(),
      });
      return;
    case "other":
      pushNotification({
        id: generateNotificationId(),
        type: "annotation-error",
        severity: "warning",
        message: issue.message ?? `Loading ${ctx.displayName} produced a warning.`,
        dedupKey: `load-other:${ctx.dedupSource}`,
        timestamp: Date.now(),
      });
      return;
  }
}

/**
 * Load file content from disk into the Y.Doc. Thin wrapper around
 * populateDocFromContent — reads the buffer once (the caller has already
 * validated `resolved` via resolveAndValidatePath: size limit, extension
 * allowlist, UNC rejection) and delegates the parse + transact + cleanup logic
 * to the shared helper used by openFileFromContent.
 */
export async function loadContentIntoDoc(
  doc: Y.Doc,
  format: string,
  resolved: string,
  docId: string,
): Promise<void> {
  const buffer = await fs.readFile(resolved);
  await populateDocFromContent(doc, format, buffer, docId, {
    displayName: path.basename(resolved),
    dedupSource: resolved,
  });
}

/**
 * Shared populate path for openFileByPath (disk) and openFileFromContent
 * (upload). Async I/O and parsing happen OUTSIDE the transaction; the Y.Doc
 * mutation runs INSIDE one `withInternal` transact so mdastToYDoc's many tiny
 * inserts arrive as one update. The durable-annotation sync observer and the
 * channel event queue both attach later via `wireAnnotationStore`, so no
 * echo can occur during populate.
 */
export async function populateDocFromContent(
  doc: Y.Doc,
  format: string,
  source: string | Buffer,
  docId: string | undefined,
  ctx: PopulateContext,
): Promise<void> {
  const prepared = await prepareContent(format, source);

  try {
    withInternal(doc, () => applyPreparedContent(doc, prepared, ctx));
  } catch (err) {
    // Clear partial state in a fresh top-level transact so a retry sees a clean
    // Y.Doc instead of a poisoned cached one. Yjs has unwound the failed
    // transact by the time the catch fires, so this is not nested. Same
    // origin as the populate above — observers don't attach until
    // wireAnnotationStore, so there's nothing to echo to.
    let cleanupOk = true;
    try {
      withInternal(doc, () => {
        const fragment = doc.getXmlFragment("default");
        fragment.delete(0, fragment.length);
        // injectCommentsAsAnnotations can leave partial entries even when its
        // own catch fires (Yjs does not roll back inner-transact writes).
        const annotations = doc.getMap(Y_MAP_ANNOTATIONS);
        annotations.forEach((_, k) => annotations.delete(k));
      });
    } catch (cleanupErr) {
      cleanupOk = false;
      console.error(
        "[Tandem] populateDocFromContent: cleanup after populate failure also failed:",
        cleanupErr,
      );
      // Evict in-place (#616) — see evictPartialDocState. Failures are logged
      // and swallowed so the original populate error is what bubbles up.
      try {
        evictPartialDocState(doc, docId);
      } catch (evictErr) {
        console.error(
          "[Tandem] populateDocFromContent: eviction after cleanup failure also failed:",
          evictErr,
        );
      }
    }
    // Static-literal first arg; user-controlled values arrive as trailing args
    // so util.format doesn't treat them as a format string.
    console.error(
      "[Tandem] populateDocFromContent: populate failed; partial state cleared before rethrow.",
      { format, displayName: ctx.displayName, cleanupOk },
      err,
    );
    throw err;
  }
}

/**
 * Evict a cached Y.Doc's content + annotation state in-place (#616).
 *
 * Called from the cleanup-after-populate-failure path when targeted cleanup
 * itself threw — the Y.Doc is then in an indeterminate partial state and a
 * subsequent open of the same `documentId` would merge fresh content on top
 * of poisoned CRDT state. Eviction restores the doc to the same fresh-
 * instance shape `getOrCreateDocument(id)` would have produced.
 *
 * `withFileSync` tag: both durable-sync and channel-event observers skip
 * file-sync, so the half-cleared snapshot is neither persisted nor broadcast.
 * The per-doc file-sync context drops with phase `"close"` (not `"swap"`) —
 * eviction is fresh-start semantics, so the prior tombstone ledger is
 * released, not retained.
 */
export function evictPartialDocState(doc: Y.Doc, docId: string | undefined): void {
  if (docId) {
    // Drop the per-doc file-sync context with phase "close" (the registry's
    // clearFileSyncContext path). A no-op if no context was ever registered
    // for this docId — common during open, since wireAnnotationStore runs
    // AFTER populate.
    clearFileSyncContext(docId);
  }

  // `clearFileSyncContext` MUST run before the clear. It detaches the
  // durable-sync observer first; otherwise clearing the maps would fire the
  // observer with empty-map delete events and persist an empty snapshot to the
  // on-disk annotation file — destroying durable annotations for the docId we
  // intended to evict-and-reopen.
  withFileSync(doc, () => {
    clearDocMaps(doc);
    const fragment = doc.getXmlFragment("default");
    fragment.delete(0, fragment.length);
  });
}

/**
 * Clear the four document-state Y.Maps (annotations, replies, awareness,
 * user-awareness) in place. Caller wraps with the appropriate origin helper
 * and is responsible for the XmlFragment if it also needs clearing.
 *
 * NOT exhaustive by design: `documentMeta` keys owned by the docx adapter — the
 * fidelity report (Y_MAP_FIDELITY_REPORT) and footnote bodies
 * (Y_MAP_FOOTNOTE_BODIES) — are intentionally NOT cleared here. Each is rewritten
 * as a whole-value replace on every (re)import (`writeImportLossReport` /
 * `docxAdapter.apply`), so a reload of the same path can't strand a stale value,
 * and a document's format is stable across reloads (Save-As to another format
 * yields a new document/tab). Don't add them here assuming this is the canonical
 * reset — the adapter owns their lifecycle.
 */
function clearDocMaps(doc: Y.Doc): void {
  const maps = [
    doc.getMap(Y_MAP_ANNOTATIONS),
    doc.getMap(Y_MAP_ANNOTATION_REPLIES),
    doc.getMap(Y_MAP_AWARENESS),
    doc.getMap(Y_MAP_USER_AWARENESS),
  ];
  for (const m of maps) m.forEach((_, k) => m.delete(k));
}

export { evictPartialDocState as __testEvictPartialDocState };

/**
 * Clear all document state in-place and repopulate from a pre-read buffer.
 * Unlike the old forceCloseDocument, this preserves the Y.Doc instance, Hocuspocus
 * room, and client WebSocket connections. All state (content, annotations, awareness)
 * is cleared and repopulated in a single Y.js transaction so clients see one atomic update.
 *
 * The caller owns the disk read (passes `source`) so the `fs.readFile` sink
 * sits at the call site where the path has already flowed through
 * resolveAndValidatePath — keeps CodeQL path-injection tracking local.
 *
 * Shares parse + apply helpers with `populateDocFromContent` (closes #611).
 * That means force-reload now inherits the rollback containment + docx
 * comment-extract/inject notification UX that #612 added to the normal-open
 * path: a malformed Word comment no longer silently drops on reload, and an
 * inject mid-transact failure rolls back partial annotation writes.
 *
 * `opts.markCleanAfter` (default true): force-reload reads FROM disk, so the
 * repopulated body matches disk and the doc is clean. The source-view reload
 * (#1021) repopulates from a user-edited markdown STRING that does NOT match
 * disk yet, so it passes `false` to keep the doc dirty — its caller then writes
 * the new content to disk explicitly.
 *
 * `opts.readOnly` (default false): the authoritative readOnly for the rewritten
 * metadata. Previously hardcoded `isDocx` — a #576 leftover from when .docx
 * opened read-only; .docx is writable now, so the caller's value is the truth.
 *
 * `opts.conflictGuard` (default undefined — unconditional delete, #1238 review
 * finding): when provided, the `Y_MAP_EXTERNAL_CONFLICT` delete below only
 * fires if the map's CURRENT raw value still equals `conflictGuard.raw` — the
 * value the caller captured before its own async gap. Without a guard, this
 * function's unconditional delete is correct for its other caller (force-open
 * via `tandem_open force:true`, which is explicitly "discard everything,
 * including any conflict"). `reloadDocumentFromMarkdown` passes a guard
 * because a real external write can land during ITS pre-call gap and flag a
 * genuinely new conflict that this unrelated repopulation must not silently
 * wipe. The wrapper object (rather than a bare `unknown`) distinguishes "no
 * guard requested" from "guard requested, captured value was undefined".
 */
export async function clearAndReload(
  id: string,
  doc: Y.Doc,
  resolved: string,
  format: string,
  existing: OpenDoc,
  source: string | Buffer,
  opts?: {
    markCleanAfter?: boolean;
    readOnly?: boolean;
    conflictGuard?: { raw: unknown };
  },
): Promise<void> {
  console.error("[Tandem] clearAndReload: reloading %s from disk", id);

  // 0. Detach durable-annotation sync for this doc before clearing Y.Maps so
  //    the observer doesn't queue a write snapshotting the mid-clear state,
  //    and wipe the on-disk annotation file so loadAndMerge (run by the
  //    caller after repopulation) doesn't resurrect the pre-reload set.
  //    Failures here must not abort the reload — annotations are additive
  //    durability and we still want the content reload to land.
  const dropped = clearFileSyncContext(id);
  if (dropped) {
    try {
      await dropped.store.clear();
    } catch (err) {
      console.error("[Tandem] clearAndReload: store.clear failed for %s:", id, err);
    }
  }

  // 1. Pre-parse OUTSIDE the transaction (async I/O / docx parsing). Reuses
  //    prepareContent so the docx pre-parse and comment-extract notification
  //    UX match populateDocFromContent exactly.
  const ctx: PopulateContext = {
    displayName: path.basename(resolved),
    dedupSource: resolved,
  };
  const prepared = await prepareContent(format, source);

  // 2. Single transaction: clear all state + repopulate + rewrite metadata.
  //    Clients see one atomic Y.js update — no intermediate states. The
  //    try-catch is a diagnostic safety net for Y.js internal corruption; on
  //    throw we re-raise so the caller's force-reload reports the failure.
  try {
    withInternal(doc, () => {
      clearDocMaps(doc);
      // Repopulate content via shared helper (idem with populateDocFromContent).
      applyPreparedContent(doc, prepared, ctx);
      // Rewrite metadata + dirty-tracking baseline
      const meta = doc.getMap(Y_MAP_DOCUMENT_META);
      meta.delete(Y_MAP_READ_ONLY);
      meta.set(Y_MAP_READ_ONLY, opts?.readOnly ?? false);
      meta.set("format", format);
      meta.set("documentId", id);
      meta.set("fileName", path.basename(resolved));
      meta.set(Y_MAP_SAVED_AT_VERSION, Date.now());
      // Content was rebuilt from the caller's source — any pending external-
      // conflict flag (#1069) is moot. Y.Map.delete on a missing key is a no-op.
      //
      // Guarded when the caller opted in (#1238 review finding): a real
      // external write can land during this function's own async gap
      // (`prepareContent` above) and flag a NEW conflict via the file watcher.
      // Deleting unconditionally would silently wipe that newer, real
      // conflict for content this reload never saw. Only delete if the map's
      // current raw value still matches what the caller captured before the
      // gap opened.
      if (
        opts?.conflictGuard === undefined ||
        meta.get(Y_MAP_EXTERNAL_CONFLICT) === opts.conflictGuard.raw
      ) {
        meta.delete(Y_MAP_EXTERNAL_CONFLICT);
      }
    });

    // 3. Reattach event queue observers (idempotent — detaches existing first)
    attachObservers(id, doc);

    // The body now mirrors disk content — clear the autosave dirty flag so the
    // reload itself doesn't trigger a redundant write-back (#851). Done after
    // attachObservers re-registers the body observer (which preserves the
    // counter the in-transaction repopulation above may have bumped).
    //
    // Skipped by the source-view reload (#1021): its body came from a user-
    // edited string that does NOT yet match disk, so the doc must stay dirty
    // until the caller persists it.
    if (opts?.markCleanAfter !== false) markClean(id);
  } catch (err) {
    // Static format literal; id/format pass as args (not interpolated into the
    // format position) so a user-supplied documentId reaching this sink via
    // reloadDocumentFromMarkdown can't be treated as a printf format string.
    console.error(
      "[Tandem] clearAndReload: failed for %s (format=%s). Y.Doc may be in a partially cleared state:",
      id,
      format,
      err,
    );
    throw err;
  }

  // 4. Delete session after successful reload so stale state doesn't restore on next startup.
  //    Runs last: if readFile or transact fails above, the session survives as a recovery path.
  await deleteSession(existing.filePath).catch((err) => {
    console.error("[Tandem] clearAndReload: deleteSession failed for %s:", id, err);
  });

  console.error("[Tandem] clearAndReload: complete for %s", id);
}
