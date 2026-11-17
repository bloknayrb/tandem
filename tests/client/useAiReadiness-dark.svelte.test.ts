// @vitest-environment happy-dom

/**
 * `createAiReadiness` while local models are dark (#1123 part B, R10.1), moved
 * out of `useAiReadiness.svelte.test.ts` so that file holds in either state of
 * the flag. The guard pinned: `useAiReadiness.svelte.ts`'s `BYO_MODELS_ENABLED`
 * test before it reads the launcher status's `heldForLocalModel`. The mount
 * helpers are copied from that file.
 */

import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiReadiness } from "../../src/client/hooks/useAiReadiness.svelte";
import AiReadinessHarness from "../../src/client/svelte-harness/AiReadinessHarness.svelte";
import { API_LAUNCHER_STATUS } from "../../src/shared/api-paths.js";

// This whole file is the dark state, so it forces the flag off whatever the
// shipped literal says (#1123: the suite holds in both states).
vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants.js")>()),
  BYO_MODELS_ENABLED: false as typeof import("../../src/shared/constants.js").BYO_MODELS_ENABLED,
}));

interface FetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

function mkResponse(body: unknown, ok = true, status = 200): FetchResponse {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

/** Route the stub by URL so the launcher + health polls get distinct bodies. */
function routedFetch(routes: {
  launcher: FetchResponse | (() => FetchResponse);
  health: FetchResponse;
}): typeof fetch {
  return (async (input: string) => {
    const url = String(input);
    const pick = url.includes(API_LAUNCHER_STATUS) ? routes.launcher : routes.health;
    if (typeof pick === "function") return pick() as unknown as Response;
    return pick as unknown as Response;
  }) as unknown as typeof fetch;
}

function mount(): { get(): AiReadiness } {
  const holder: { readiness: AiReadiness | null } = { readiness: null };
  render(AiReadinessHarness, {
    props: { onReady: (r: AiReadiness) => (holder.readiness = r) },
  });
  return {
    get(): AiReadiness {
      if (holder.readiness === null) throw new Error("harness did not call onReady");
      return holder.readiness;
    },
  };
}

/** Let the in-flight fetches resolve, then flush Svelte reactivity. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  await tick();
}

describe("createAiReadiness, dark — Tandem's Claude (launcher facts)", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("heldForLocalModel is never read while BYO_MODELS_ENABLED is off (#1123 part B, R10.1)", async () => {
    // A status from a flag-on server, in a dark editor: fresh, both arms.
    for (const body of [
      { available: true, running: false, standby: "awaiting-start", heldForLocalModel: true },
      { available: true, running: true, cwd: "/home/u", heldForLocalModel: true },
    ]) {
      globalThis.fetch = routedFetch({
        launcher: () => mkResponse(body),
        health: mkResponse({ status: "ok", hasSession: false }),
      });
      const h = mount();
      await settle();
      expect(h.get().launcherHeldForLocalModel).toBe(false);
    }
  });
});
