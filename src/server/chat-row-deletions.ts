/**
 * The "deleted" seam (#2358, the chat owners PR, R2.2, R3.6): the chat side
 * tells whoever listens that CTRL_ROOM chat rows were deleted, so the
 * ownership side can drop their per-message owners. A seam rather than an
 * import, because the two chat-side delete paths (the CTRL chat observer's
 * `delete` arm and `clearCtrlChatDurably`) must not import
 * `sessions/ownership.ts`: that would pull the ownership flag into files a
 * bundle without the flag's define may reach.
 *
 * `src/server/index.ts` wires the one listener at boot (pinned from source in
 * `tests/server/ownership-source-pins.test.ts`). Unwired, a delete tells
 * nobody. **Imports nothing.** A listener that throws is logged with fixed
 * text and never fails the delete.
 */

let listener: ((keys: readonly string[]) => void) | undefined;

/** Install the one listener (`index.ts`, at boot). */
export function setChatRowsDeletedListener(
  cb: ((keys: readonly string[]) => void) | undefined,
): void {
  listener = cb;
}

/** Chat rows under `keys` were deleted. Never throws. */
export function noteChatRowsDeleted(keys: readonly string[]): void {
  if (keys.length === 0 || listener === undefined) return;
  try {
    listener(keys);
  } catch {
    console.error("[Tandem] A chat-row deletion listener failed; the delete stands");
  }
}
