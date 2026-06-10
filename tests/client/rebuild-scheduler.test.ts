import { describe, expect, it, vi } from "vitest";
import {
  createRebuildScheduler,
  POLL_INTERVAL_MS,
  type RebuildSchedulerDeps,
} from "../../src/client/hooks/rebuild-scheduler.js";

/**
 * Unit tests for the authenticationFailed → rebuild orchestrator extracted
 * from yjsSync.svelte.ts. After a server restart, ctrl + every tab provider
 * fire authenticationFailed nearly simultaneously — these branches decide
 * whether the client recovers (one clean rebuild) or corrupts/wedges
 * (duplicate rebuilds, rebuild-after-destroy, spurious teardown on an auth
 * blip). The full hook can't be unit-mounted (real provider construction),
 * so the orchestration is tested here in isolation.
 */

/** Let the scheduled microtask + chained awaits run to completion. */
const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function makeDeps(overrides: Partial<RebuildSchedulerDeps> = {}) {
  const deps = {
    isDestroyed: vi.fn(() => false),
    fetchGenerationId: vi.fn(async () => "gen-new" as string | null),
    getPinnedGeneration: vi.fn(() => "gen-old" as string | null),
    onGenerationUnchanged: vi.fn(),
    rebuild: vi.fn(),
    sleep: vi.fn(async () => {}),
    ...overrides,
  };
  return deps;
}

describe("createRebuildScheduler", () => {
  it("rebuilds with the rotated generation", async () => {
    const deps = makeDeps();
    createRebuildScheduler(deps)();
    await flushAsync();
    expect(deps.rebuild).toHaveBeenCalledExactlyOnceWith("gen-new");
    expect(deps.onGenerationUnchanged).not.toHaveBeenCalled();
  });

  it("does NOT rebuild when the generation is unchanged (auth blip)", async () => {
    const deps = makeDeps({
      fetchGenerationId: vi.fn(async () => "gen-old"),
    });
    createRebuildScheduler(deps)();
    await flushAsync();
    expect(deps.onGenerationUnchanged).toHaveBeenCalledOnce();
    expect(deps.rebuild).not.toHaveBeenCalled();
  });

  it("polls while the server is down, then rebuilds when it answers", async () => {
    const answers: (string | null)[] = [null, null, "gen-new"];
    const deps = makeDeps({
      fetchGenerationId: vi.fn(async () => answers.shift() ?? null),
    });
    createRebuildScheduler(deps)();
    await flushAsync();
    expect(deps.sleep).toHaveBeenCalledTimes(2);
    expect(deps.sleep).toHaveBeenCalledWith(POLL_INTERVAL_MS);
    expect(deps.rebuild).toHaveBeenCalledExactlyOnceWith("gen-new");
  });

  it("is single-flight: concurrent triggers run exactly one cycle", async () => {
    // After a restart, ctrl + N tab providers all fire authenticationFailed.
    let release!: (gen: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const deps = makeDeps({ fetchGenerationId: vi.fn(() => gate) });
    const schedule = createRebuildScheduler(deps);
    schedule();
    schedule();
    schedule();
    await Promise.resolve(); // let the first microtask start its fetch
    schedule(); // trigger arriving mid-fetch is dropped too
    release("gen-new");
    await flushAsync();
    expect(deps.fetchGenerationId).toHaveBeenCalledOnce();
    expect(deps.rebuild).toHaveBeenCalledExactlyOnceWith("gen-new");
  });

  it("re-arms after a completed cycle", async () => {
    const deps = makeDeps();
    const schedule = createRebuildScheduler(deps);
    schedule();
    await flushAsync();
    schedule();
    await flushAsync();
    expect(deps.rebuild).toHaveBeenCalledTimes(2);
  });

  it("does nothing when already destroyed at trigger time", async () => {
    const deps = makeDeps({ isDestroyed: vi.fn(() => true) });
    createRebuildScheduler(deps)();
    await flushAsync();
    expect(deps.fetchGenerationId).not.toHaveBeenCalled();
    expect(deps.rebuild).not.toHaveBeenCalled();
  });

  it("aborts without rebuilding when destroyed while the fetch is in flight", async () => {
    let destroyed = false;
    const deps = makeDeps({
      isDestroyed: vi.fn(() => destroyed),
      fetchGenerationId: vi.fn(async () => {
        destroyed = true; // destroy() lands while /api/info is in flight
        return "gen-new";
      }),
    });
    createRebuildScheduler(deps)();
    await flushAsync();
    expect(deps.rebuild).not.toHaveBeenCalled();
    expect(deps.onGenerationUnchanged).not.toHaveBeenCalled();
  });

  it("exits the server-down poll loop when destroyed mid-poll", async () => {
    let destroyed = false;
    const deps = makeDeps({
      isDestroyed: vi.fn(() => destroyed),
      fetchGenerationId: vi.fn(async () => null),
      sleep: vi.fn(async () => {
        destroyed = true; // destroy() lands while waiting out the poll interval
      }),
    });
    createRebuildScheduler(deps)();
    await flushAsync();
    expect(deps.sleep).toHaveBeenCalledOnce();
    expect(deps.rebuild).not.toHaveBeenCalled();
  });
});
