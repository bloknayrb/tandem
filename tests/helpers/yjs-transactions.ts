/**
 * Recording `afterTransaction` observers for Y.Doc tests.
 *
 * Two suites — the file-opener batching contract and the reload-from-disk
 * persistence contract — independently grew the same recorder, the same record
 * shape and the same `asChangedKey` cast, comment for comment. This is that
 * helper, written once.
 */
import type * as Y from "yjs";

/** One `afterTransaction` observation: its origin tag and which types it touched. */
export interface TxnRecord {
  origin: unknown;
  /**
   * The type *instance refs* from `txn.changed.keys()`, so callers can
   * identity-test against a specific `Y.AbstractType` (e.g. the doc's
   * XmlFragment) rather than name-comparing — which cannot distinguish the
   * ANNOTATIONS / REPLIES / AWARENESS Y.Maps, all of whose `constructor.name`
   * is "YMap".
   */
  changedTypes: Set<Y.AbstractType<Y.YEvent<any>>>;
}

/**
 * Widen a concrete Y type to the element type of {@link TxnRecord.changedTypes}.
 *
 * `AbstractType` is invariant in its event-type parameter, so a concrete type
 * like `YXmlFragment` (`AbstractType<YXmlEvent>`) or `YMap<unknown>`
 * (`AbstractType<YMapEvent<unknown>>`) does not structurally match
 * `Set<AbstractType<YEvent<any>>>` even though at runtime it is the exact same
 * object `txn.changed.keys()` would have yielded.
 */
export function asChangedKey(type: Y.AbstractType<any>): Y.AbstractType<Y.YEvent<any>> {
  return type as unknown as Y.AbstractType<Y.YEvent<any>>;
}

/** Record every transaction on `doc` until `detach()` is called. */
export function listenForTransactions(doc: Y.Doc): {
  records: TxnRecord[];
  detach: () => void;
} {
  const records: TxnRecord[] = [];
  const listener = (txn: Y.Transaction) => {
    records.push({ origin: txn.origin, changedTypes: new Set(txn.changed.keys()) });
  };
  doc.on("afterTransaction", listener);
  return { records, detach: () => doc.off("afterTransaction", listener) };
}
