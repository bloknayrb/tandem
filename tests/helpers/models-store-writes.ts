/**
 * Store-shaped Models mutators over `modelsPose`, for focus tests of the Models
 * tab (#1123, ADR-039 item 27). They follow `useModels.svelte.ts`'s
 * `writeThrough` in the three ways focus depends on:
 *
 *  - every write is queued behind the one in flight (`_writeQueue`), and its
 *    optimistic change is applied only when its turn comes — on a later
 *    microtask, or after an earlier queued write has settled;
 *  - the write then stays pending until the test releases it, as "commit" or
 *    "rollback"; a rollback restores the list as it was before the change, so
 *    a removed row comes back as new DOM;
 *  - the caller's promise settles after the change (or the rollback), and a
 *    write that did not commit answers as the store does: `updateModel`
 *    resolves `false`, `addModel` `null`, `deleteModel` / `toggleEnabled`
 *    `undefined` (read the list afterwards to tell commit from rollback).
 */
import { modelsPose } from "./models-pose.svelte";

/** "throw": the list is restored and the caller's promise rejects (as a
 *  pre-write keychain failure does in the real store). */
type Outcome = "commit" | "rollback" | "throw";
type Entry = Record<string, unknown> & { id: string };

interface PendingWrite {
  label: string;
  release: (outcome: Outcome) => void;
}

export function createStoreWrites() {
  let queue: Promise<unknown> = Promise.resolve();
  /** Writes whose optimistic change has been applied and that wait for release. */
  const inFlight: PendingWrite[] = [];
  let nextId = 1;
  /** Release every write as it starts, with this outcome (null: hold them). */
  let autoOutcome: Outcome | null = null;

  function write<T>(
    label: string,
    apply: () => void,
    results: Record<"commit" | "rollback", T>,
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const snapshot = modelsPose.models;
      apply();
      const outcome =
        autoOutcome ??
        (await new Promise<Outcome>((resolve) => inFlight.push({ label, release: resolve })));
      if (outcome !== "commit") modelsPose.models = snapshot;
      if (outcome === "throw") throw new Error("Keychain unavailable");
      return results[outcome];
    };
    const turn = queue.then(run);
    queue = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  const entries = () => modelsPose.models as Entry[];

  return {
    addModel: (patch: Record<string, unknown>): Promise<string | null> => {
      const id = `new-${nextId++}`;
      return write(
        "add",
        () => {
          modelsPose.models = [...entries(), { ...patch, id }];
        },
        { commit: id, rollback: null },
      );
    },
    updateModel: (id: string, patch: Record<string, unknown>): Promise<boolean> =>
      write(
        "update",
        () => {
          modelsPose.models = entries().map((m) => (m.id === id ? { ...m, ...patch } : m));
        },
        { commit: true, rollback: false },
      ),
    deleteModel: (id: string): Promise<void> =>
      write(
        "delete",
        () => {
          modelsPose.models = entries().filter((m) => m.id !== id);
        },
        { commit: undefined, rollback: undefined },
      ),
    toggleEnabled: (id: string): Promise<void> =>
      write(
        "toggle",
        () => {
          modelsPose.models = entries().map((m) =>
            m.id === id ? { ...m, enabled: !m.enabled } : m,
          );
        },
        { commit: undefined, rollback: undefined },
      ),
    /** How many writes have applied their change and wait for release. */
    get pendingCount() {
      return inFlight.length;
    },
    /** Release the oldest write in flight. */
    release(outcome: Outcome = "commit") {
      const next = inFlight.shift();
      if (!next) throw new Error("no write in flight");
      next.release(outcome);
    },
    /** From now on, settle every write as soon as it starts. */
    settleAutomatically(outcome: Outcome | null = "commit") {
      autoOutcome = outcome;
    },
  };
}
