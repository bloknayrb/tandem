/**
 * The per-document alias ledger of the annotation key-identity reconciler.
 *
 * A module of its own, with no runtime imports, so both the reconciler
 * (`key-identity.ts`, which imports `sync.ts`) and the envelope merge
 * (`sync.ts`, via `legacy-envelope.ts`) can read it without an import cycle.
 */

import type * as Y from "yjs";
import type { AnnotationType } from "../../shared/types.js";

/**
 * One repaired alias, captured from the sanitized value BEFORE the repair.
 * The legacy-envelope pass (`legacy-envelope.ts`) treats these repair-time
 * values as the authority for record K, even if K is later edited or deleted.
 */
export interface AliasLedgerEntry {
  readonly key: string;
  readonly storedId: string;
  readonly timestamp: number | undefined;
  readonly textSnapshot: string | undefined;
  readonly commentId: string | undefined;
  readonly type: AnnotationType;
}

/**
 * Per-document alias ledger. Dropped only when the document closes
 * (`dropAliasLedger`, from `closeDocumentById`), never in the sync cleanup's
 * `"close"` phase, which `tandem_open force` also runs: a later
 * `mergeEnvelopeForward`, force-open or rename recovery may still read an
 * uncorrected envelope, for instance while the store is read-only.
 */
const ledgers = new WeakMap<Y.Doc, AliasLedgerEntry[]>();

export function getAliasLedger(ydoc: Y.Doc): readonly AliasLedgerEntry[] {
  return ledgers.get(ydoc) ?? [];
}

/**
 * Copy (never move) the ledger to a replacement doc on a Hocuspocus swap: an
 * in-flight `loadAndMerge` still holds the old `ctx.ydoc`.
 */
export function copyAliasLedger(from: Y.Doc, to: Y.Doc): void {
  const entries = ledgers.get(from);
  if (entries && entries.length > 0) ledgers.set(to, [...entries, ...(ledgers.get(to) ?? [])]);
}

export function dropAliasLedger(ydoc: Y.Doc): void {
  ledgers.delete(ydoc);
}

/** Record repaired aliases for `ydoc` (the reconciler's write). */
export function appendAliasLedger(ydoc: Y.Doc, entries: readonly AliasLedgerEntry[]): void {
  ledgers.set(ydoc, [...(ledgers.get(ydoc) ?? []), ...entries]);
}
