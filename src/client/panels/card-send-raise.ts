/**
 * The send notice's seam (#1123, ADR-039's amendment of 2026-11-18 on the send
 * notice). A card send — a note promoted to a comment through
 * `sendNoteToClaude` or `promoteNotesToComments` in `annotation-actions.ts`,
 * from the side panel, the margin, the batch bar or the desktop context menu —
 * calls `raiseCardSend()` once after its write. The raise carries nothing about
 * the annotation (ADR-027): what it decides and shows is App's, which fills
 * the seam with `createCardSendNotice` (`hooks/useChatAnswerer.svelte.ts`)
 * only while `BYO_MODELS_ENABLED` is on.
 *
 * Plain TypeScript with no runtime import, so the node suites that import
 * `annotation-actions.ts` never reach a rune module (the brief's R1.1).
 * Unset, a raise does nothing: master's behaviour.
 */

let raise: (() => void) | null = null;

/** App's fill, under the flag; tests reset it to `null`. */
export function setCardSendRaise(fn: (() => void) | null): void {
  raise = fn;
}

/**
 * Called by a card send after its write has committed. A throwing raise is
 * caught and logged, so the write stands and the caller's count is returned
 * (Ruling SN-6). `console.warn`, not the client log helper: the node suites'
 * import pins forbid it here.
 */
export function raiseCardSend(): void {
  if (raise === null) return;
  try {
    raise();
  } catch (err) {
    console.warn("[annotation-actions] the send notice failed:", err);
  }
}
