// @vitest-environment happy-dom
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFirstRunNeeded } from "../../src/client/hooks/useFirstRunNeeded.svelte.js";

/**
 * Coverage for `createFirstRunNeeded` — the boot-time first-run-needed
 * fetcher used by App.svelte to decide whether to auto-open the wizard.
 *
 * The hook's safety-critical contract:
 *   1. server says needed → `needed: true`, `settled: true`
 *   2. network error, non-OK response, malformed JSON → `needed: false`,
 *      `settled: true` (the safe default — never auto-open when uncertain)
 *   3. out-of-order resolves are dropped (monotonic `gen` counter)
 */

interface FetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function fetchStubReturning(response: FetchResponse | Error): typeof fetch {
  return (async () => {
    if (response instanceof Error) throw response;
    return response as unknown as Response;
  }) as unknown as typeof fetch;
}

function mkResponse(body: unknown, ok = true, status = 200): FetchResponse {
  return {
    ok,
    status,
    json: async () => body,
  };
}

describe("createFirstRunNeeded", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("populates state from a successful response", async () => {
    globalThis.fetch = fetchStubReturning(
      mkResponse({
        needed: true,
        serverVersion: "0.12.0-test",
        confirmationNonce: "nonce-1",
      }),
    );
    const state = createFirstRunNeeded();
    // Settle the microtask queue so the in-flight fetch resolves.
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(state.needed).toBe(true);
    expect(state.serverVersion).toBe("0.12.0-test");
    expect(state.confirmationNonce).toBe("nonce-1");
    expect(state.settled).toBe(true);
  });

  it("defaults to needed=false when the network throws", async () => {
    globalThis.fetch = fetchStubReturning(new Error("network down"));
    const state = createFirstRunNeeded();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(state.needed).toBe(false);
    expect(state.settled).toBe(true);
  });

  it("defaults to needed=false on a non-OK HTTP response", async () => {
    globalThis.fetch = fetchStubReturning(mkResponse({}, false, 500));
    const state = createFirstRunNeeded();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(state.needed).toBe(false);
    expect(state.settled).toBe(true);
  });

  it("defaults to needed=false when JSON parsing throws", async () => {
    globalThis.fetch = (async () => {
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("malformed JSON");
        },
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const state = createFirstRunNeeded();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(state.needed).toBe(false);
    expect(state.settled).toBe(true);
  });

  it("refetch() updates values", async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      return mkResponse({
        needed: call === 1, // first true, then false
        serverVersion: `v-${call}`,
        confirmationNonce: `nonce-${call}`,
      }) as unknown as Response;
    }) as unknown as typeof fetch;
    const state = createFirstRunNeeded();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(state.needed).toBe(true);
    expect(state.confirmationNonce).toBe("nonce-1");
    await state.refetch();
    flushSync();
    expect(state.needed).toBe(false);
    expect(state.confirmationNonce).toBe("nonce-2");
  });

  it("out-of-order resolves don't clobber newer state (gen counter)", async () => {
    // Two fetches issued in order A then B; A resolves AFTER B. The state
    // must reflect B (newest), not A.
    let callIndex = 0;
    const pendingA = { resolve: undefined as ((v: unknown) => void) | undefined };
    const pendingB = { resolve: undefined as ((v: unknown) => void) | undefined };

    globalThis.fetch = (async () => {
      callIndex += 1;
      const slot = callIndex === 1 ? pendingA : pendingB;
      return new Promise<Response>((res) => {
        slot.resolve = res as (v: unknown) => void;
      });
    }) as unknown as typeof fetch;

    const state = createFirstRunNeeded();
    // Kick off the second fetch before the first resolves.
    const refetchPromise = state.refetch();

    // Resolve B (the second fetch) first.
    pendingB.resolve?.(
      mkResponse({ needed: false, serverVersion: "v-B", confirmationNonce: "nonce-B" }),
    );
    await refetchPromise;
    flushSync();
    expect(state.confirmationNonce).toBe("nonce-B");

    // Now resolve A (the first fetch) — the late resolve must NOT overwrite
    // the newer values written by B.
    pendingA.resolve?.(
      mkResponse({ needed: true, serverVersion: "v-A", confirmationNonce: "nonce-A" }),
    );
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(state.confirmationNonce).toBe("nonce-B");
    expect(state.needed).toBe(false);
  });
});
