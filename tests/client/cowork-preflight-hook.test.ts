/**
 * Direct tests for `createSubnetPreflight` (#1298).
 *
 * These exist because a review deleted BOTH staleness guards — the
 * `if (mine !== token) return;` in `run()` and the `token++` in `reset()` — and
 * the entire suite still passed. The mechanism the hook's longest comment
 * defends was pinned by nothing.
 *
 * Must live in `tests/client/`: `vite.config.ts` registers the svelte plugin on
 * that project only, so a `.svelte.ts` import from anywhere else is never
 * compiled and fails with `$state is not defined`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
 * Drain enough microtasks for every in-flight `run()` to get past its
 * `await loadInvoke()` and actually attach to its probe promise.
 *
 * Without this the tests below are vacuous: resolving a deferred before its
 * `await` is attached makes the continuations queue in ATTACH order rather than
 * RESOLVE order, so the newest probe wins by accident and the assertions pass
 * with the staleness guard deleted. Verified by mutation — that is exactly how
 * the first draft of this file behaved.
 */
async function settleAttachments(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
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
    const b = probe.run();
    await settleAttachments();

    // Settle out of order: the NEWER probe answers first, then the older one.
    second.resolve(OK);
    first.resolve(BLOCKED);
    await Promise.all([a, b]);

    expect(probe.preflight).toEqual(OK);
    expect(probe.probing).toBe(false);
  });

  it("keeps probing true until the newest probe settles, not the first", async () => {
    const first = deferred<typeof BLOCKED>();
    const second = deferred<typeof OK>();
    preflightSubnet.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const probe = createSubnetPreflight();
    const a = probe.run();
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
    expect(probe.probing).toBe(true);
    expect(probe.preflight).toEqual(BLOCKED);

    pending.resolve(OK);
    await retry;
    expect(probe.preflight).toEqual(OK);
  });

  it("reports unknown rather than throwing when the probe rejects", async () => {
    preflightSubnet.mockRejectedValueOnce(new Error("bridge gone"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const probe = createSubnetPreflight();
    await probe.run();

    expect(probe.preflight).toEqual({ status: "unknown" });
    expect(probe.probing).toBe(false);
  });
});
