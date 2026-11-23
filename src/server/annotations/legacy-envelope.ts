/**
 * Route the rows of an annotation envelope onto Y.Map keys without ever
 * writing one record over another.
 *
 * An envelope written before `snapshot()` persisted map keys (no
 * `meta.keyIdentity`) can hold a record under ANOTHER record's id: the old
 * `snapshot()` wrote `value.id`, so a record stored under key K with a stale
 * `id: X` reached disk as X, often beside X's own row. Keying those rows by
 * id (last one wins) wrote K's body over X — on disk and, on the next merge,
 * in the live map.
 *
 * **Marked envelopes merge as before**, keyed by id, with one extra rule: no
 * two rows ever land on one key.
 *
 * **Old-format envelopes go through ONE global assignment pass.** Seven review
 * rounds found alias shapes (cycles, chains, same-millisecond twins, promotion,
 * deleted records) that slipped between per-id "suspect" conditions; a global
 * matching closes the class. Every row is compared with every live record and
 * every repaired alias (the ledger) on fields nothing rewrites:
 *
 *   1. A row's candidates are the keys whose record is compatible with it:
 *      equal creation `timestamp`; a compatible `type` (after sanitize, with
 *      the promotion and legacy-import re-typings); and every discriminator
 *      present on BOTH sides agreeing (`textSnapshot`, the import `commentId`
 *      through `keysDriftIndex`, the import provenance).
 *   2. A row goes to key Y when Y is its only candidate and it is the only row
 *      whose only candidate is Y.
 *   3. A row with no candidate falls back to its own id only when nothing is
 *      there, or when the record there was re-created deterministically at
 *      that id (a tutorial seed, a `.docx` re-import). A different live record
 *      at its id is evidence the row is another record.
 *   4. Everything else goes to a deterministic fresh key. Duplicating a record
 *      is accepted; overwriting or losing one is not.
 *
 * Replies filed under an id whose row did not land on that id are ambiguous
 * (an older client posted the stale id from another record's card), so the
 * caller stamps the user's replies under every id in `quarantineIds` private.
 */

import { createHash } from "node:crypto";
import type * as Y from "yjs";
import { type RawAnnotation, sanitizeAnnotation } from "../../shared/sanitize.js";
import type { Annotation } from "../../shared/types.js";
import { keysDriftIndex } from "../file-io/docx-comments.js";
import type { AliasLedgerEntry } from "./alias-ledger.js";
import { type AnnotationDocV1, type AnnotationRecordV1, KEY_IDENTITY_FORMAT } from "./schema.js";

/** The prefix of a fresh key. No minting path uses it. */
const FRESH_KEY_PREFIX = "ann_rk_";

/** Whether `key` is a fresh key this pass minted for an unmatched row. */
export function isFreshKey(key: string): boolean {
  return key.startsWith(FRESH_KEY_PREFIX);
}
const TUTORIAL_PREFIX = "tutorial-";

export interface EnvelopeAssignment {
  /** Rows keyed by their target key, each stamped `id = targetKey`. */
  readonly rows: Map<string, AnnotationRecordV1>;
  /**
   * Ids whose replies are ambiguous: a row that left its own id, a fallback
   * onto an occupied id, and every repaired alias's stale id.
   */
  readonly quarantineIds: Set<string>;
  /** Whether the envelope was old-format. */
  readonly oldFormat: boolean;
  /**
   * Whether any row landed on a key other than its own id. Forces the merge's
   * rewrite, so a corrected envelope (with the marker) reaches disk; a
   * well-formed old envelope is marked by its next ordinary write instead.
   */
  readonly moved: boolean;
}

/** The fields the pass compares, for a file row or a candidate. */
interface Fingerprint {
  readonly timestamp: number | undefined;
  readonly type: Annotation["type"];
  readonly author: string | undefined;
  readonly promotedFrom: string | undefined;
  readonly textSnapshot: string | undefined;
  readonly commentId: string | undefined;
  readonly importAuthor: string | undefined;
  readonly importFile: string | undefined;
}

function fingerprintOf(raw: unknown): Fingerprint | null {
  if (typeof raw !== "object" || raw === null) return null;
  let ann: Annotation;
  try {
    // Migration events are relayed by the read paths, not here.
    ann = sanitizeAnnotation(raw as RawAnnotation, () => {});
  } catch {
    return null;
  }
  const r = raw as { timestamp?: unknown; textSnapshot?: unknown; promotedFrom?: unknown };
  return {
    timestamp: typeof r.timestamp === "number" ? r.timestamp : undefined,
    type: ann.type,
    author: ann.author,
    promotedFrom: typeof r.promotedFrom === "string" ? r.promotedFrom : undefined,
    textSnapshot: typeof r.textSnapshot === "string" ? r.textSnapshot : undefined,
    commentId: ann.importSource?.commentId,
    importAuthor: ann.importSource?.author,
    importFile: ann.importSource?.file,
  };
}

function ledgerFingerprint(entry: AliasLedgerEntry): Fingerprint {
  return {
    timestamp: entry.timestamp,
    type: entry.type,
    author: undefined,
    promotedFrom: undefined,
    textSnapshot: entry.textSnapshot,
    commentId: entry.commentId,
    importAuthor: undefined,
    importFile: undefined,
  };
}

const isImport = (f: Fingerprint) => f.author === "import" && f.importFile !== undefined;

/** Both import `commentId`s present, usable and equal — never `undefined === undefined`. */
const strictCommentIdsAgree = (a: Fingerprint, b: Fingerprint) =>
  keysDriftIndex(a.commentId) && keysDriftIndex(b.commentId) && a.commentId === b.commentId;

/**
 * Whether `row`'s type is compatible with `cand`'s. Equal types, a promoted
 * note (note row ↔ live comment `promotedFrom: "note"`), and two import
 * re-typings that are strict on `commentId`: the author, file and Word date
 * are not unique, so a deleted comment A and a new comment B by the same
 * author on the same date would otherwise pair.
 */
function typeCompatible(row: Fingerprint, cand: Fingerprint): boolean {
  if (row.type === cand.type) return true;
  if (row.type === "note" && cand.type === "comment" && cand.promotedFrom === "note") return true;
  if (cand.type === "note" && row.type === "comment" && isImport(cand)) {
    // The legacy import migration (an import comment stored, a note now), or
    // the re-import of a promoted import (a promoted comment stored, an
    // import note re-created now).
    const legacyImport = isImport(row);
    const promotedImport = row.promotedFrom === "note" && row.importFile !== undefined;
    if (legacyImport || promotedImport) return strictCommentIdsAgree(row, cand);
  }
  return false;
}

/** A discriminator present on both sides must agree; a missing one is skipped. */
function agreesWhereBothPresent(a: string | undefined, b: string | undefined): boolean {
  return a === undefined || b === undefined || a === b;
}

function compatible(row: Fingerprint, cand: Fingerprint): boolean {
  if (row.timestamp === undefined || row.timestamp !== cand.timestamp) return false;
  if (!typeCompatible(row, cand)) return false;
  if (!agreesWhereBothPresent(row.textSnapshot, cand.textSnapshot)) return false;
  if (keysDriftIndex(row.commentId) && keysDriftIndex(cand.commentId)) {
    if (row.commentId !== cand.commentId) return false;
  }
  return (
    agreesWhereBothPresent(row.importAuthor, cand.importAuthor) &&
    agreesWhereBothPresent(row.importFile, cand.importFile)
  );
}

/**
 * The record at `id` was re-created deterministically at that same id, with a
 * new timestamp: a tutorial seed (same type and target text) or a `.docx`
 * re-import (never a promoted record; `commentId` strict).
 */
function recreatedDeterministically(id: string, row: Fingerprint, live: Fingerprint): boolean {
  if (id.startsWith(TUTORIAL_PREFIX)) {
    return (
      row.type === live.type &&
      row.textSnapshot !== undefined &&
      row.textSnapshot === live.textSnapshot
    );
  }
  if (live.author !== "import" || !isImport(row)) return false;
  const typeOk =
    row.type === live.type || (live.type === "note" && row.type === "comment" && isImport(row));
  return typeOk && strictCommentIdsAgree(row, live);
}

function freshKey(docHash: string, row: AnnotationRecordV1, index: number, salt: number): string {
  const input = `${docHash}\u0000${row.id}\u0000${String(row.timestamp)}\u0000${index}\u0000${salt}`;
  return FRESH_KEY_PREFIX + createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Assign every row of `file` to a target key. `annMap` is the live map AFTER
 * the merge's tombstone loop; `ledger` is the document's alias ledger.
 */
export function assignEnvelopeRows(
  file: AnnotationDocV1,
  annMap: Y.Map<unknown>,
  ledger: readonly AliasLedgerEntry[],
  docHash: string,
): EnvelopeAssignment {
  const quarantineIds = new Set(ledger.map((e) => e.storedId));
  const rows = new Map<string, AnnotationRecordV1>();
  const oldFormat = file.meta.keyIdentity !== KEY_IDENTITY_FORMAT;
  let moved = false;

  const place = (target: string, row: AnnotationRecordV1) => {
    if (target !== row.id) moved = true;
    rows.set(target, target === row.id ? row : { ...row, id: target });
  };

  if (!oldFormat) {
    // Every row id is its key. One target per key: a second row at one id (a
    // hand-edited file) never races; it goes to a fresh key.
    file.annotations.forEach((row, index) => {
      if (!rows.has(row.id)) {
        place(row.id, row);
        return;
      }
      place(freshTarget(docHash, row, index, annMap, rows), row);
      quarantineIds.add(row.id);
    });
    return { rows, quarantineIds, oldFormat, moved };
  }

  // Candidates: every live key, with the ledger's repair-time values as the
  // authority for a repaired key. A live record the envelope's own tombstones
  // beat is NO candidate: it is about to be deleted (a stale tab resurrected
  // it), and a row routed onto it would be buried with it. `loadAndMerge` has
  // already deleted these; rename recovery runs this pass before that merge.
  const stoneRev = new Map(file.tombstones.map((t) => [t.id, t.rev]));
  const doomed = (key: string, value: unknown) => {
    const rev = stoneRev.get(key);
    const liveRev = (value as { rev?: unknown } | null)?.rev;
    return rev !== undefined && rev > (typeof liveRev === "number" ? liveRev : 0);
  };
  const ledgerByKey = new Map(ledger.map((e) => [e.key, e]));
  const candidates = new Map<string, Fingerprint>();
  annMap.forEach((value, key) => {
    if (key === "" || ledgerByKey.has(key) || doomed(key, value)) return;
    const fp = fingerprintOf(value);
    if (fp) candidates.set(key, fp);
  });
  for (const entry of ledger) candidates.set(entry.key, ledgerFingerprint(entry));

  const byTimestamp = new Map<number, string[]>();
  for (const [key, fp] of candidates) {
    if (fp.timestamp === undefined) continue;
    const bucket = byTimestamp.get(fp.timestamp);
    if (bucket) bucket.push(key);
    else byTimestamp.set(fp.timestamp, [key]);
  }

  const rowFps = file.annotations.map((row) => fingerprintOf(row));
  const allCands = rowFps.map((fp) =>
    fp?.timestamp === undefined
      ? []
      : (byTimestamp.get(fp.timestamp) ?? []).filter((key) =>
          compatible(fp, candidates.get(key) as Fingerprint),
        ),
  );

  // Step 1b: a row first claims its OWN id when nothing marks that id as
  // aliased. Records commonly share a creation timestamp (tutorial seeds,
  // same-second Word imports, one local-model run), so without this a
  // well-formed old envelope would be duplicated wholesale on its first merge.
  // The claim is refused, and the row left to the global pass, when:
  //   - its id appears more than once in the file (an alias beside its record);
  //   - its id is a repaired alias's stale id, or a repaired key (the ledger);
  //   - a live key that has NO row in the file is also compatible with it. The
  //     old `snapshot()` wrote an aliased record K as another id, so K having
  //     no row of its own is the alias signal that survives a restart.
  const idCount = new Map<string, number>();
  for (const row of file.annotations) idCount.set(row.id, (idCount.get(row.id) ?? 0) + 1);
  const fileIds = new Set(idCount.keys());
  const ledgerIds = new Set(ledger.flatMap((e) => [e.key, e.storedId]));
  const claimed = new Set<string>();
  const ownClaim: boolean[] = file.annotations.map((row, index) => {
    const cands = allCands[index];
    if (idCount.get(row.id) !== 1 || ledgerIds.has(row.id) || !cands.includes(row.id)) {
      return false;
    }
    if (cands.some((key) => key !== row.id && !fileIds.has(key))) return false;
    claimed.add(row.id);
    return true;
  });
  const rowCands = allCands.map((cands, index) =>
    ownClaim[index] ? [file.annotations[index].id] : cands.filter((key) => !claimed.has(key)),
  );

  // Step 2: unique mutual match.
  const soleClaims = new Map<string, number>();
  for (const cands of rowCands) {
    if (cands.length === 1) soleClaims.set(cands[0], (soleClaims.get(cands[0]) ?? 0) + 1);
  }
  const target: (string | undefined)[] = rowCands.map((cands) =>
    cands.length === 1 && soleClaims.get(cands[0]) === 1 ? cands[0] : undefined,
  );
  const matched = new Set(target.filter((t): t is string => t !== undefined));

  // Step 3: fallback to the row's own id, for a row with no candidate.
  const fallbacks = new Map<string, number[]>();
  file.annotations.forEach((row, index) => {
    if (target[index] !== undefined || rowCands[index].length > 0) return;
    const fp = rowFps[index];
    const live = annMap.get(row.id);
    // An unreadable live value is not a record: the file copy replaces it, as
    // it always has.
    const occupied = fingerprintOf(live) !== null || ledgerByKey.has(row.id);
    if (occupied) {
      const liveFp = fingerprintOf(live);
      if (!fp || !liveFp || !recreatedDeterministically(row.id, fp, liveFp)) return;
    }
    const list = fallbacks.get(row.id);
    if (list) list.push(index);
    else fallbacks.set(row.id, [index]);
  });
  for (const [id, indexes] of fallbacks) {
    // A step-2 match wins over a fallback, and a contested fallback goes to
    // nobody, so file order never decides.
    if (indexes.length !== 1 || matched.has(id)) continue;
    target[indexes[0]] = id;
    if (fingerprintOf(annMap.get(id)) !== null || ledgerByKey.has(id)) quarantineIds.add(id);
  }

  // Step 4: everything else to a fresh key; then place, one row per key.
  file.annotations.forEach((row, index) => {
    const own = target[index];
    if (own !== undefined && !rows.has(own)) {
      place(own, row);
      if (own !== row.id) quarantineIds.add(row.id);
      return;
    }
    place(freshTarget(docHash, row, index, annMap, rows), row);
    quarantineIds.add(row.id);
  });

  return { rows, quarantineIds, oldFormat, moved };
}

/**
 * A deterministic fresh key for `row`. An existing key is reused only when it
 * is the same row's earlier placement (same creation `timestamp`), so a re-run
 * against an unchanged envelope reproduces the same key; anything else takes
 * the next deterministic salt.
 */
function freshTarget(
  docHash: string,
  row: AnnotationRecordV1,
  index: number,
  annMap: Y.Map<unknown>,
  taken: ReadonlyMap<string, AnnotationRecordV1>,
): string {
  for (let salt = 0; ; salt++) {
    const key = freshKey(docHash, row, index, salt);
    if (taken.has(key)) continue;
    const live = annMap.get(key) as { timestamp?: unknown } | undefined;
    if (live === undefined || live.timestamp === row.timestamp) return key;
  }
}
