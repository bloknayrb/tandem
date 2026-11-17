/**
 * The "undo a client's chat writes" seam (#2358, the posts PR, R4.5): the
 * CTRL chat observer asks here whether a client connection's changes to the
 * chat map are undone. A seam rather than an import, because `ctrl-chat.ts`
 * must not import `sessions/ownership.ts` (which imports the ownership flag)
 * — the flag-importer pin in `tests/server/ownership-module-seam.test.ts`.
 *
 * `src/server/index.ts` wires the ownership side's `undoClientChatWrites`
 * at boot (pinned from source in `tests/server/ownership-source-pins.test.ts`).
 * Unwired, nothing is undone (master's behaviour). **Imports nothing.** A
 * predicate that throws answers "undo": a client write is never let through
 * because the question failed.
 */

let predicate: (() => boolean) | undefined;

/** Install the one predicate (`index.ts`, at boot). */
export function setChatClientWritesUndone(cb: (() => boolean) | undefined): void {
  predicate = cb;
}

/** Whether a client connection's changes to the CTRL chat map are undone now. */
export function chatClientWritesUndone(): boolean {
  if (predicate === undefined) return false;
  try {
    return predicate();
  } catch {
    console.error("[Tandem] Reading whether client chat writes are undone failed; undoing them");
    return true;
  }
}
