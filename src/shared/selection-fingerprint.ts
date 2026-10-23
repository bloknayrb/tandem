/**
 * A short, fixed-size fingerprint of the text a user selected (#1997).
 *
 * The editor stores it in the `Y_MAP_SELECTION` record beside the flat
 * offsets; `tandem_checkInbox` reports `activity.selectedText` only while the
 * fingerprint of the text now at those offsets still equals it. Nothing updates
 * the record for a document no editor is showing, so without this check an edit
 * there made the inbox slice whatever text had moved under the old offsets.
 *
 * **Both sides must hash the SERVER's flat projection** of `[from, to)` — the
 * server's `extractText`, and on the client `pmDocFlatText` (pinned equal to it
 * by `tests/client/flat-projection-equivalence.test.ts`). Never `textBetween`
 * or the record's own `selectedText`: those omit heading prefixes and spell
 * hard breaks and block leaves differently (#1631). Any disagreement between
 * the two projections fails toward `null`, never toward wrong text. Hash the
 * whole span, never a truncated display copy of it.
 *
 * Not a security boundary: the record is client-written, and a collision only
 * re-admits the pre-#1997 behaviour (reporting the text at the offsets).
 *
 * 32-bit FNV-1a over UTF-16 code units, prefixed with the length. Deliberately
 * import-free: `src/shared` reaches every bundle, including the ones built
 * without the licence define.
 */
export function selectionFingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}
