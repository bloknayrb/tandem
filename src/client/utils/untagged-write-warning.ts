/**
 * DEV-only detector for Y.Doc mutations that were not origin-tagged (#1482).
 *
 * WHY A RUNTIME CHECK RATHER THAN A LINT RULE. Critical Rule 2 says every write
 * goes through a helper in `shared/origins.ts`, but the only enforcement is
 * `audit-origins.ts`, which matches raw `.transact(` calls textually. A bare
 * `map.set(...)` outside any transact is invisible to it, and cannot be caught
 * statically at acceptable precision: `.set(` collides with native `Map`/`Set`,
 * ProseMirror and `$state` containers, and the real question is
 * inter-procedural — `withBrowser(doc, () => helper())`, where `helper` does the
 * `set`, is correct code no intra-procedural rule can bless. Watching the
 * transaction itself is complete regardless of call shape, and costs nothing in
 * production.
 *
 * WHAT IT DOES NOT MEAN. Client-side origins never cross the wire. Yjs binary
 * updates carry no origin field, and Hocuspocus applies every incoming client
 * update with the `Connection` as origin, so a server observer cannot tell a
 * `withBrowser` write from an untagged one. This warning is about auditability
 * and one mental model, not a leak — see ADR-031 and `docs/gotchas.md`.
 *
 * KNOWN BENIGN SOURCE, named up front so this does not get deleted as noisy:
 * `y-prosemirror.cjs:834` merges adjacent Y.Text nodes inside a bare
 * `doc.transact(tr => ...)` with no origin. It fires from y-prosemirror's own
 * normalization, not from our code, and there is nothing to tag. If you see it,
 * it is not a finding.
 */

import type * as Y from "yjs";

/** Origin a transaction carries when nothing tagged it. */
const UNTAGGED = null;

export interface UntaggedWriteReport {
  /** Y types the untagged transaction actually mutated. */
  changedTypes: number;
  /** Present only when the caller supplied one; helps locate a doc among several. */
  label?: string;
}

/**
 * Subscribe to `doc` and warn on any mutating transaction with a null origin.
 * Returns an unsubscribe function.
 *
 * Non-mutating transactions are ignored: Yjs opens one for plenty of read-side
 * bookkeeping, and warning on those would bury the signal this exists to give.
 *
 * `onReport` exists so tests can observe without asserting on console output.
 */
export function installUntaggedWriteWarning(
  doc: Y.Doc,
  options: { label?: string; onReport?: (report: UntaggedWriteReport) => void } = {},
): () => void {
  const handler = (transaction: Y.Transaction) => {
    if (transaction.origin !== UNTAGGED) return;
    if (transaction.changed.size === 0) return;

    const report: UntaggedWriteReport = {
      changedTypes: transaction.changed.size,
      ...(options.label ? { label: options.label } : {}),
    };
    options.onReport?.(report);
    console.warn(
      `[origins] Untagged Y.Doc write${options.label ? ` on ${options.label}` : ""} — ` +
        `${report.changedTypes} type(s) mutated with no origin. Wrap it in a helper from ` +
        "shared/origins.ts (Critical Rule 2). If this came from y-prosemirror's own " +
        "Y.Text merge, it is expected — see this file's header.",
    );
  };

  doc.on("afterTransaction", handler);
  return () => doc.off("afterTransaction", handler);
}
