/**
 * "A write through `useModels` committed" (#1123 part B, R1.2 and R3).
 *
 * A plain module with no runes, like `write-refusal.ts`: `useModels` reports
 * each committed write here, and the chat-answerer store
 * (`hooks/useChatAnswerer.svelte.ts`) listens, so neither imports the other.
 * Every add, update, delete, default change and enable or disable reaches it
 * through `useModels`' one write path (`writeThrough`), so the store hooks the
 * writes, not each caller (the Models tab, the edit modal, the first-run
 * picker).
 *
 * Listeners are called from a fetch continuation, never inside a reaction.
 */

export interface ModelsWriteCommitted {
  /**
   * An `addModel` that took the number of saved local-provider models from
   * zero to one or more (R3.2). False for every other write.
   */
  firstLocal: boolean;
}

const listeners = new Set<(info: ModelsWriteCommitted) => void>();

/** `useModels` calls this once per committed write. */
export function signalModelsWriteCommitted(info: ModelsWriteCommitted): void {
  for (const cb of [...listeners]) {
    try {
      cb(info);
    } catch (err) {
      console.warn("[models] a models-write listener failed", err);
    }
  }
}

/** Be told of each committed write. Returns the unsubscribe. */
export function onModelsWriteCommitted(cb: (info: ModelsWriteCommitted) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
