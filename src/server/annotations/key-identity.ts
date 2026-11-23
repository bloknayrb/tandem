/**
 * An annotation's identity is its Y.Map key — the reconciler and its token.
 *
 * Every minting path stores a record under its own id, but a browser CRDT
 * update, a session blob (`Y.applyUpdate`) or the `.docx` drift path can leave
 * a record under key K whose stored `id` is X. Reads stamp the key
 * (`atMapKey`); this module repairs the stored value and, before that, makes
 * the one consequence a read cannot undo safe: replies an older client filed
 * under X from K's card. Those carry the user's text with no `private` flag,
 * and once K's id is repaired nothing would mark them ambiguous again, so they
 * reach Claude on the next pull (ADR-027).
 *
 * **Ordering is enforced, not arranged.** `reconcileAnnotationKeys` returns a
 * {@link ReconciledDoc} token, and `channelVisibleReplies` — the single reply
 * gate every Claude egress uses — requires one. `collectAnnotations` reconciles
 * before it reads, so every write keyed by a stamped id (`refreshRange`, the
 * fallback overlay, `tandem_edit`'s re-anchor, reload remap) comes after the
 * quarantine. The eager calls (after a session restore, an attach-time scan,
 * the observer below) only keep the data clean sooner.
 */

import * as Y from "yjs";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../shared/constants.js";
import { BROWSER_ORIGIN, INTERNAL_ORIGIN, withInternal } from "../../shared/origins.js";
import { type RawAnnotation, sanitizeAnnotation } from "../../shared/sanitize.js";
import { getFileSyncContextForDoc } from "../events/file-sync-registry.js";
import { type AliasLedgerEntry, appendAliasLedger } from "./alias-ledger.js";
import { hasAnnotationShape } from "./annotation-shape.js";
import { nextRev } from "./schema.js";
import { quarantineReplies, queueSnapshot } from "./sync.js";

declare const reconciledBrand: unique symbol;

/**
 * Proof that a document was reconciled in the same synchronous call. Only
 * {@link reconcileAnnotationKeys} mints one, and it is bound to its document:
 * the reply gate reads replies through {@link reconciledRepliesMap}, so a token
 * for one document cannot vouch for another.
 *
 * **Opaque on purpose.** It carries no `Y.Doc`: `YDocStore.reconciled()` hands
 * one out, and that store exposes no Y.Doc or Y.Map (Unit 8j-2 removed the
 * escape hatch), so the document stays in a module-private map.
 */
export interface ReconciledDoc {
  readonly [reconciledBrand]: true;
}

const reconciledDocs = new WeakMap<ReconciledDoc, Y.Doc>();

/** The replies map of the document `token` reconciled. For the reply gate only. */
export function reconciledRepliesMap(token: ReconciledDoc): Y.Map<unknown> {
  const ydoc = reconciledDocs.get(token);
  if (!ydoc) throw new Error("not a ReconciledDoc minted by reconcileAnnotationKeys");
  return ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
}

export {
  copyAliasLedger,
  dropAliasLedger,
  getAliasLedger,
} from "./alias-ledger.js";

/** A key whose stored value carries a different, string id. */
interface Alias {
  key: string;
  storedId: string;
}

/**
 * Keys whose well-formed record carries a different stored id. A malformed
 * record (no range, say) is not touched: the read paths skip it, and
 * `awareness.ts`'s notice rule deliberately keeps reading its raw `value.id`.
 */
function findAliases(map: Y.Map<unknown>, keys: Iterable<string>): Alias[] {
  const out: Alias[] = [];
  for (const key of keys) {
    if (key === "") continue;
    const value = map.get(key);
    if (!hasAnnotationShape(value)) continue;
    const storedId = value.id as string;
    if (storedId !== key) out.push({ key, storedId });
  }
  return out;
}

/**
 * The reconciler must never run inside a browser or Hocuspocus-connection
 * transaction: its write would join that transaction and take its origin, so
 * the repair would be pushed to the channel as a user action. Every outer
 * transaction it can be reached from today is server-tagged; this checks the
 * convention. It throws only under vitest: `NODE_ENV` is unset on an npm
 * install, so keying on it would make a shipped server fail every Claude read
 * of the document instead of logging.
 */
function assertNotInsideClientTransaction(ydoc: Y.Doc): void {
  const origin = (ydoc as unknown as { _transaction: { origin: unknown } | null })._transaction
    ?.origin;
  if (origin !== BROWSER_ORIGIN && (typeof origin !== "object" || origin === null)) return;
  const message = "reconcileAnnotationKeys ran inside a client transaction";
  if (process.env.VITEST) throw new Error(message);
  console.error(`[key-identity] ${message}`);
}

/**
 * Repair every record stored under a key that differs from its stored id, and
 * quarantine the replies filed under the stale id. Idempotent: a document with
 * no alias returns at once and writes nothing.
 */
export function reconcileAnnotationKeys(ydoc: Y.Doc): ReconciledDoc {
  const token = Object.freeze({}) as ReconciledDoc;
  reconciledDocs.set(token, ydoc);
  const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
  const aliases = findAliases(map, map.keys());
  if (aliases.length > 0) repair(ydoc, map, aliases);
  return token;
}

function repair(ydoc: Y.Doc, map: Y.Map<unknown>, aliases: readonly Alias[]): void {
  assertNotInsideClientTransaction(ydoc);
  const replies = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
  const staleIds = new Set(aliases.map((a) => a.storedId));
  const quarantined: string[] = [];
  const repaired: AliasLedgerEntry[] = [];

  // `withInternal`: a repair, not a user or Claude action. It skips the
  // channel (no `annotation:*` or `annotation:reply` event) and the durable
  // observer, so the snapshot is queued explicitly below.
  withInternal(ydoc, () => {
    // (a) Replies filed under a stale id are ambiguous: an older client posted
    // the stale id from K's card, so a note-thread reply may sit under a
    // comment. Fail closed, through the one quarantine the envelope merge also
    // uses. Its `rev` bump makes the stamp win `pickWinner` against an
    // unstamped envelope copy (sticky-private covers a tie).
    quarantined.push(...quarantineReplies([], replies, staleIds).stampedLiveKeys);

    // (b) Rewrite each aliased record under its own key. Read inside the
    // transaction, never from a captured event value, so a concurrent stamp
    // (`heldInSolo`) is spread through rather than lost.
    for (const { key, storedId } of aliases) {
      const raw = map.get(key) as (Record<string, unknown> & { rev?: number }) | undefined;
      if (!raw || raw.id !== storedId) continue;
      // (c) Ledger first, from the sanitized pre-repair value. Sanitize's
      // migration events are not relayed here: the read paths relay them. A
      // record sanitize cannot read is skipped, never allowed to abort the
      // whole reconcile (and with it every read and remap of the document).
      let ann: ReturnType<typeof sanitizeAnnotation>;
      try {
        ann = sanitizeAnnotation(raw as unknown as RawAnnotation, () => {});
      } catch {
        continue;
      }
      repaired.push({
        key,
        storedId,
        timestamp: typeof raw.timestamp === "number" ? raw.timestamp : undefined,
        textSnapshot: typeof raw.textSnapshot === "string" ? raw.textSnapshot : undefined,
        commentId: ann.importSource?.commentId,
        type: ann.type,
      });
      map.set(key, { ...raw, id: key, rev: nextRev(raw) });
    }
  });

  if (repaired.length > 0) appendAliasLedger(ydoc, repaired);

  const ctx = getFileSyncContextForDoc(ydoc);
  if (ctx) queueSnapshot(ctx);

  for (const { key, storedId } of repaired) {
    console.warn("[key-identity] repaired annotation stored under %s with id %s", key, storedId);
  }
  if (quarantined.length > 0) {
    console.warn(
      "[key-identity] withheld %s user repl%s filed under a repaired id from Claude: %s",
      String(quarantined.length),
      quarantined.length === 1 ? "y" : "ies",
      quarantined.join(", "),
    );
  }
}

/**
 * Reconcile as soon as an alias arrives, rather than at the next read. Not
 * load-bearing for privacy (every Claude read reconciles first); it keeps the
 * stored data clean. Attached for every document, uploads included. Reacts to
 * every origin but `internal` — INCLUDING `null` (a session restore), unlike
 * `held-in-solo` — and looks only at the keys the transaction changed.
 * Its own `withInternal` write is skipped, and finds no alias, so it never loops.
 *
 * The full scan at attach time covers state that arrived before the observer.
 */
export function attachKeyIdentityObserver(ydoc: Y.Doc, opts: { scan: boolean }): () => void {
  const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
  const observer = (event: Y.YMapEvent<unknown>, txn: Y.Transaction) => {
    if (txn.origin === INTERNAL_ORIGIN) return;
    const aliases = findAliases(map, event.keysChanged);
    if (aliases.length > 0) repair(ydoc, map, aliases);
  };
  map.observe(observer);
  if (opts.scan) reconcileAnnotationKeys(ydoc);
  return () => map.unobserve(observer);
}

/**
 * `(docHashKey, key)` pairs whose stored id was already reported as differing
 * from its key. `collectAnnotations` runs on every refreshed read, so the
 * warning is deduplicated until the document closes.
 */
const reportedKeyMismatches = new Set<string>();

/** Warn once per `(document, key)` that a record is read under its key. */
export function reportKeyMismatch(docHashKey: string, key: string, storedId: string): void {
  const entry = `${docHashKey}\u0000${key}`;
  if (reportedKeyMismatches.has(entry)) return;
  reportedKeyMismatches.add(entry);
  // Ids only, as `%s` arguments: keys are client-written (log injection).
  console.warn(
    "[key-identity] annotation stored under key %s carries id %s in %s; reading it as %s",
    key,
    storedId,
    docHashKey,
    key,
  );
}

/** Forget the reported mismatches for one document (on close) or all (tests). */
export function forgetKeyMismatchReports(docHashKey?: string): void {
  if (docHashKey === undefined) {
    reportedKeyMismatches.clear();
    return;
  }
  for (const entry of reportedKeyMismatches) {
    if (entry.startsWith(`${docHashKey}\u0000`)) reportedKeyMismatches.delete(entry);
  }
}
