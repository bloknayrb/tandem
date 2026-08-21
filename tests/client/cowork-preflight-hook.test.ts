/**
 * Direct tests for `createSubnetPreflight` (#1298).
 *
 * These exist because a review deleted BOTH staleness guards — the
 * `if (mine !== token) return;` in `run()` and the `token++` in `reset()` — and
 * the entire suite still passed. The mechanism the hook's longest comment
 * defends was pinned by nothing.
 *
 * Must live in `tests/client/`: `vitest.config.ts` registers the svelte plugin on
 * that project only, so a `.svelte.ts` import from anywhere else is never
 * compiled and fails with `$state is not defined`.
 */
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetClientLog, readClientLog } from "../../src/client/utils/client-log";

const preflightSubnet = vi.fn();

vi.mock("../../src/client/cowork/cowork-invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/cowork/cowork-invoke")>()),
  loadInvoke: vi.fn(async () => vi.fn()),
  coworkPreflightSubnet: () => preflightSubnet(),
}));

const { createSubnetPreflight } = await import(
  "../../src/client/hooks/useCoworkPreflight.svelte.js"
);

/** A promise plus its resolver, so a test can control settle ORDER. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const OK = { status: "ok", cidr: "172.20.0.0/20" } as const;
const BLOCKED = { status: "blocked", hint: "stale hint" } as const;

/**
 * `run()` has issued its probe and flipped `probing`.
 *
 * The leading `tick()` is #1376's deferral: `run()` no longer sets `probing`
 * synchronously, because the live region has to reach the accessibility tree
 * before the in-flight line lands in it.
 */
async function probeStarted(): Promise<void> {
  await tick();
  await Promise.resolve();
}

/**
 * Drain enough microtasks for every in-flight `run()` to get past its
 * `await tick()` and its `await loadInvoke()` and actually ATTACH to its probe
 * promise.
 *
 * Without this the tests below are vacuous: resolving a deferred before its
 * `await` is attached makes the continuations queue in ATTACH order rather than
 * RESOLVE order, so the newest probe wins by accident and the assertions pass
 * with the staleness guard deleted. Verified by mutation — that is exactly how
 * the first draft of this file behaved.
 */
async function settleAttachments(): Promise<void> {
  await probeStarted();
  // Over-drained deliberately. The deferreds are unresolved here, so extra
  // drains cost nothing — while too FEW fails toward GREEN, which is the mode
  // described above. Composed from `probeStarted` so the deferral is encoded
  // once rather than in two helpers that must agree.
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe("createSubnetPreflight", () => {
  beforeEach(() => {
    preflightSubnet.mockReset();
  });

  it("lets an older probe win when it settles last — without the token guard", async () => {
    const first = deferred<typeof BLOCKED>();
    const second = deferred<typeof OK>();
    preflightSubnet.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const probe = createSubnetPreflight();
    const a = probe.run();
    // `a` must reach its probe before `b` starts. Since #1376 `run()` waits a
    // flush before doing anything, so two `run()`s in one tick leave the first
    // superseded BEFORE it issues — it returns without calling the bridge at
    // all, and this test would then be pinning the wrong thing entirely.
    await probeStarted();
    const b = probe.run();
    await settleAttachments();

    // Settle out of order: the NEWER probe answers first, then the older one.
    second.resolve(OK);
    first.resolve(BLOCKED);
    await Promise.all([a, b]);

    expect(preflightSubnet).toHaveBeenCalledTimes(2);
    expect(probe.preflight).toEqual(OK);
    expect(probe.probing).toBe(false);
  });

  it("never issues a probe that was superseded before it started", async () => {
    // The other half of the same deferral: two `run()`s in one tick cost ONE
    // PowerShell round-trip, not two. A user double-clicking the retry button
    // is the common case.
    preflightSubnet.mockResolvedValue(OK);

    const probe = createSubnetPreflight();
    const a = probe.run();
    const b = probe.run();
    await Promise.all([a, b]);

    expect(preflightSubnet).toHaveBeenCalledTimes(1);
    expect(probe.preflight).toEqual(OK);
    expect(probe.probing).toBe(false);
  });

  it("keeps probing true until the newest probe settles, not the first", async () => {
    const first = deferred<typeof BLOCKED>();
    const second = deferred<typeof OK>();
    preflightSubnet.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const probe = createSubnetPreflight();
    const a = probe.run();
    await probeStarted(); // both must genuinely issue — see the test above
    const b = probe.run();
    await settleAttachments();

    first.resolve(BLOCKED);
    await a;
    // The superseded probe's `finally` must not clear the live probe's flag.
    expect(probe.probing).toBe(true);

    second.resolve(OK);
    await b;
    expect(probe.probing).toBe(false);
  });

  it("abandons an in-flight probe on reset, and the stale settle cannot re-latch probing", async () => {
    const pending = deferred<typeof BLOCKED>();
    preflightSubnet.mockReturnValueOnce(pending.promise);

    const probe = createSubnetPreflight();
    const run = probe.run();
    await probeStarted();
    expect(probe.probing).toBe(true);

    probe.reset();
    expect(probe.probing).toBe(false);
    expect(probe.preflight).toBeNull();

    pending.resolve(BLOCKED);
    await run;

    // Kills the `if (mine === token)` mutant in the `finally`: without it the
    // orphan would write `probing = false` — harmless here — but without the
    // guard in the success arm it would also resurrect the abandoned hint.
    expect(probe.preflight).toBeNull();
    expect(probe.probing).toBe(false);
  });

  it("holds the previous result across a re-probe so the retry button stays mounted", async () => {
    const pending = deferred<typeof OK>();
    preflightSubnet.mockResolvedValueOnce(BLOCKED).mockReturnValueOnce(pending.promise);

    const probe = createSubnetPreflight();
    await probe.run();
    expect(probe.preflight).toEqual(BLOCKED);

    // Re-probe. `preflight` must NOT be cleared — every surface gates its retry
    // button on `blocked`, so clearing it here unmounts the button the user is
    // clicking and mounts Enable in its place.
    const retry = probe.run();
    // `preflight` must survive the gap BEFORE `probing` flips too — that gap is
    // new, and it is exactly when the user's pointer is on the retry button.
    expect(probe.preflight).toEqual(BLOCKED);
    await probeStarted();
    expect(probe.probing).toBe(true);
    expect(probe.preflight).toEqual(BLOCKED);

    pending.resolve(OK);
    await retry;
    expect(probe.preflight).toEqual(OK);
  });

  it("reports failed rather than throwing when the probe rejects", async () => {
    // `failed`, not `unavailable` (#1436). `loadInvoke()` does not throw —
    // outside Tauri it resolves to an invoke that REJECTS, which
    // `coworkPreflightSubnet` catches and classifies as `unavailable`. So the
    // ordinary no-bridge path never reaches this arm; what does reach it is a
    // genuine client fault, and the user has to be told the check did not run.
    preflightSubnet.mockRejectedValueOnce(new Error("bridge gone"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const probe = createSubnetPreflight();
    await probe.run();

    expect(probe.preflight).toEqual({ status: "failed" });
    expect(probe.probing).toBe(false);
  });

  it("records the failure where a bug report can reach it (#1439)", async () => {
    // The rendered `failed` line is deliberately vague — it tells the user the
    // check did not run, not why. The release desktop build ships no devtools,
    // so without this log the cause of a pre-flight failure would still be
    // unrecoverable from a user's bug report (#1439).
    _resetClientLog();
    preflightSubnet.mockRejectedValueOnce(new Error("bridge gone"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await createSubnetPreflight().run();

    expect(readClientLog()).toEqual([
      expect.objectContaining({
        level: "error",
        scope: "cowork",
        event: "subnet pre-flight threw",
        detail: "Error: bridge gone",
      }),
    ]);
  });

  it("records a STRING rejection, which is the real Tauri shape", async () => {
    // `invoke` rejects with the Rust error's Display string, not an Error, so
    // the string branch of `describeCause` is the only thing that carries this.
    _resetClientLog();
    preflightSubnet.mockRejectedValueOnce("subnet probe failed: no such command");
    vi.spyOn(console, "error").mockImplementation(() => {});

    await createSubnetPreflight().run();

    expect(readClientLog()[0].detail).toBe("subnet probe failed: no such command");
  });
});
