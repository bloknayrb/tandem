/**
 * Whose `answers` a document's reply rows may carry (#2360; ADR-054's #2360
 * PR A amendment; `docs/plans/2360-thread-replies.md` §3 "Rows already on
 * disk").
 *
 * `answers` and `inProgress` are server-only reply fields, written only by the
 * reply seam with ownership on. With ownership on, a client connection's change
 * to the replies map is undone (`events/observers/reply-client-undo.ts`). But
 * the reply schema passes unknown keys through, and the envelope merge, the
 * session restore and `onLoadDocument` all load with no origin, so a row a
 * client forged while the undo was off (any dark build) would otherwise load
 * as if the server wrote it. So:
 *
 * - **Flag off**, every load strips both fields from every reply row. No
 *   legitimate row carries them while the flag is off, so on a store that
 *   holds none this changes nothing and opens no transaction.
 * - **Flag on**, the same strip runs unless the envelope's meta carries
 *   `threadAnswersTrusted: true`. The marker is server-only (it is not in the
 *   Y.Doc), and is written by `snapshot()` only for a document this process
 *   has TRUSTED: one whose load either found the marker or stripped, with the
 *   flag on (after a flag-on strip only the server can write the fields). A
 *   flag-off load of a marked envelope strips and rewrites it unmarked.
 * - A document with no file-sync context (an unwired or read-only store) is
 *   never trusted, so every attach strips it: fails safe (owed again).
 *
 * The strip is ONE `withInternal` transaction (Critical Rule 2: a server-side
 * repair; `internal` derives no channel event), and it bumps each row's `rev`
 * so a later merge of an older file copy cannot win back the forged fields.
 * `internal` is skipped by durable sync, so each caller queues the write.
 *
 * Reads the flag through `chat-client-writes.ts`, the seam the CTRL chat undo
 * already uses (it answers "ownership on" once `index.ts` wires it), so this
 * module adds no importer of the flag module.
 */

import type * as Y from "yjs";
import { Y_MAP_ANNOTATION_REPLIES } from "../../shared/constants.js";
import { withInternal } from "../../shared/origins.js";
import { clientWritesUndoneGrant } from "../chat-client-writes.js";
import { nextRev } from "./schema.js";

/** The server-only fields of a reply row (#2360). */
const THREAD_FIELDS = ["answers", "inProgress"] as const;

/** Documents (by envelope `docHash`) this process trusts; see the module docblock. */
const trusted = new Set<string>();

/**
 * The Y.Docs whose load established trust. The attach-time sweep asks by
 * Y.Doc as well as by `docHash`, because a content reload of an open document
 * (`tandem_open force`, the external-change reload) re-attaches its observers
 * while its file-sync context is cleared, and must not strip the rows the
 * document's own load already trusted.
 */
let trustedDocs = new WeakSet<Y.Doc>();

/** Whether the document's rows' thread fields are trusted now (flag on only). */
export function threadFieldsTrusted(docHash: string): boolean {
  return clientWritesUndoneGrant() && trusted.has(docHash);
}

/**
 * Whether `ydoc`'s rows are trusted now (flag on only): its own load trusted
 * it, or the file-sync context it is bound to (`docHash`) is trusted.
 */
export function threadFieldsTrustedForDoc(ydoc: Y.Doc, docHash: string | undefined): boolean {
  if (!clientWritesUndoneGrant()) return false;
  return trustedDocs.has(ydoc) || (docHash !== undefined && trusted.has(docHash));
}

/**
 * Remove `answers` and `inProgress` from every reply row that carries either,
 * in ONE `withInternal` transaction, bumping each changed row's `rev`. Returns
 * how many rows changed; none opens no transaction.
 */
export function stripThreadFields(ydoc: Y.Doc): number {
  const replies = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
  const stale: string[] = [];
  replies.forEach((value, key) => {
    if (typeof value !== "object" || value === null) return;
    if (THREAD_FIELDS.some((field) => Object.hasOwn(value, field))) stale.push(key);
  });
  if (stale.length === 0) return 0;
  withInternal(ydoc, () => {
    for (const key of stale) {
      const row = replies.get(key) as Record<string, unknown>;
      const { answers: _answers, inProgress: _inProgress, ...rest } = row;
      // `nextRev(row)`, never `nextRev()`: the argument-free form is a fresh
      // record's `rev: 1`, which would LOWER a row already above it and let an
      // older file copy carrying the stripped fields win the next merge.
      replies.set(key, { ...rest, rev: nextRev(row as { rev?: number }) });
    }
  });
  return stale.length;
}

/**
 * Decide a document's trust at its envelope load, after the merge, and strip
 * when it is not trusted (see the module docblock). `fileTrusted` is the
 * loaded envelope's `meta.threadAnswersTrusted === true`. Returns whether the
 * envelope must be rewritten: to drop stripped fields, to add the marker (flag
 * on, first trusted load) or to drop a marker (flag off).
 */
export function settleThreadFieldsAtLoad(
  ydoc: Y.Doc,
  docHash: string,
  fileTrusted: boolean,
): boolean {
  trusted.delete(docHash);
  trustedDocs.delete(ydoc);
  const undone = clientWritesUndoneGrant();
  if (undone && fileTrusted) {
    trusted.add(docHash);
    trustedDocs.add(ydoc);
    return false;
  }
  const stripped = stripThreadFields(ydoc);
  if (undone) {
    trusted.add(docHash);
    trustedDocs.add(ydoc);
    return true;
  }
  return stripped > 0 || fileTrusted;
}

/** Forget every trust decision (tests). */
export function resetThreadFieldsTrustForTests(): void {
  trusted.clear();
  trustedDocs = new WeakSet<Y.Doc>();
}
