/**
 * The durable-annotation merge rule, in a module of its own (no imports) so the
 * envelope assignment pass (`legacy-envelope.ts`) can ask whether a file row
 * would replace a live record without importing `sync.ts`. Re-exported there.
 */

/**
 * Pure merge rule for a pair of (file, ymap) records that share an id. Used
 * for annotations and replies (both carry `rev` and `editedAt`). Returns
 * `"file"` if the file copy should replace the Y.Map entry, `"ymap"` if the
 * Y.Map entry should be left alone.
 *
 * Rules (in order):
 *   1. Higher `rev` wins.
 *   2. On tie, higher `editedAt` wins.
 *   3. On tie with `editedAt` undefined on Y.Map only (session-restored
 *      pre-plan state) and a real `editedAt` on file → file wins.
 *   4. Otherwise Y.Map wins (the live-session state is preferred by default
 *      when nothing distinguishes the two).
 */
export function pickWinner(
  fileRec: { rev: number; editedAt?: number },
  ymapRec: { rev: number; editedAt?: number },
): "file" | "ymap" {
  if (fileRec.rev > ymapRec.rev) return "file";
  if (ymapRec.rev > fileRec.rev) return "ymap";
  // Tie on rev.
  const fileEdit = fileRec.editedAt;
  const ymapEdit = ymapRec.editedAt;
  if (typeof fileEdit === "number" && typeof ymapEdit === "number") {
    return fileEdit > ymapEdit ? "file" : "ymap";
  }
  if (typeof fileEdit === "number" && ymapEdit === undefined) {
    // Heuristic: session-restored Y.Map entries lack editedAt; file wins.
    return "file";
  }
  return "ymap";
}

/**
 * Merge a Map of file records into a Y.Map under `pickWinner`'s rules
 * (higher `rev` wins; tied `rev` falls back to `editedAt`). For each file
 * record: insert if absent (unless `shouldSkipInsert` vetoes), otherwise
 * compare normalized copies and let the winner replace. After the pass,
 * `needsWrite` is true if the Y.Map carries ids the file doesn't (minus
 * `ymapOnlyIgnoreIds`) — caller queues a post-merge write so those land.
 * `fileWon` names every id the pass wrote FROM the file (inserted or replaced),
 * so a caller can fix up records whose file copy predates something the live
 * map already reflects (#2269's post-reload remap).
 */
