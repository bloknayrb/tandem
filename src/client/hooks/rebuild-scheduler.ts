/**
 * Single-flight scheduler for the `authenticationFailed` → full-rebuild path
 * (stale-tab resync). Extracted from `yjsSync.svelte.ts` so the orchestration
 * branches are unit-testable without constructing real Hocuspocus providers —
 * the same extraction pattern as `tab-reconcile.ts`.
 *
 * Behavior contract (see `tests/client/rebuild-scheduler.test.ts`):
 *  - Single-flight: triggers arriving while a cycle is in flight are dropped.
 *    Safe because the cycle itself resolves the freshest server state — after
 *    a restart, ctrl + every tab provider fire `authenticationFailed` nearly
 *    simultaneously, and exactly one rebuild must run.
 *  - The cycle starts on a microtask so no Y.Doc is destroyed while a Yjs
 *    observer or provider event is mid-dispatch.
 *  - Generation rotated → `rebuild(gen)` (tear down + re-bootstrap).
 *  - Generation unchanged → `onGenerationUnchanged()` (near-unreachable:
 *    /api/info and the auth gate disagreeing; nothing to rebuild).
 *  - Server unreachable → poll every `POLL_INTERVAL_MS` until it answers.
 *  - `isDestroyed()` is re-checked after every await so a torn-down hook
 *    never rebuilds; the in-flight latch resets on every exit path.
 */

export const POLL_INTERVAL_MS = 1000;

export interface RebuildSchedulerDeps {
  isDestroyed: () => boolean;
  /** Resolve the server's current generation id, or null if unreachable/absent. */
  fetchGenerationId: () => Promise<string | null>;
  /** The generation currently pinned by this client's providers. */
  getPinnedGeneration: () => string | null;
  /** Auth rejected but the generation didn't change — log/observe only. */
  onGenerationUnchanged: () => void;
  /** Generation rotated: tear everything down and re-bootstrap with `gen`. */
  rebuild: (gen: string) => void;
  sleep: (ms: number) => Promise<void>;
}

export function createRebuildScheduler(deps: RebuildSchedulerDeps): () => void {
  let inFlight = false;
  return function scheduleRebuild(): void {
    if (deps.isDestroyed() || inFlight) return;
    inFlight = true;
    queueMicrotask(async () => {
      try {
        while (!deps.isDestroyed()) {
          const gen = await deps.fetchGenerationId();
          if (deps.isDestroyed()) return;
          if (gen && gen === deps.getPinnedGeneration()) {
            deps.onGenerationUnchanged();
            return;
          }
          if (gen) {
            deps.rebuild(gen);
            return;
          }
          await deps.sleep(POLL_INTERVAL_MS); // server still down — poll until it's back
        }
      } finally {
        inFlight = false;
      }
    });
  };
}
