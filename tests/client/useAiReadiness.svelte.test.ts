// @vitest-environment happy-dom

/**
 * Coverage for `createAiReadiness` (#1054/#1018).
 *
 * The hook folds TWO signals into readiness:
 *   1. launcher `GET /api/launcher/status` (the supervised process)
 *   2. `GET /health` `hasSession` (whether ANY MCP transport is open)
 *
 * Safety-critical contract under test:
 *   - launcher `stopped` + an active MCP session → `ready` (chip suppressed).
 *     This is the #1054 fix: a manually-launched agent must not surface the
 *     restart CTA (clicking it would spawn a second agent).
 *   - `hasSession` only PROMOTES to ready; a `/health` blip never demotes a
 *     connected agent's chip back on (fail-safe).
 *   - readiness stays `booting` until launcher status settles, regardless of
 *     `/health`.
 *   - Solo-mode suppresses the chip regardless.
 *
 * `createAiReadiness` calls `onDestroy` + `setInterval`, so it must run inside a
 * real component context — we mount it through `AiReadinessHarness.svelte`
 * (mirrors the `NotificationsHarness` pattern) rather than a bare `$effect.root`
 * (which gives a reactivity scope but no component lifecycle for `onDestroy`).
 */

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiReadiness } from "../../src/client/hooks/useAiReadiness.svelte";
import AiReadinessHarness from "../../src/client/svelte-harness/AiReadinessHarness.svelte";
import { API_LAUNCHER_STATUS } from "../../src/shared/api-paths.js";

interface FetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function mkResponse(body: unknown, ok = true, status = 200): FetchResponse {
  return { ok, status, json: async () => body };
}

/** Route the stub by URL so the launcher + health polls get distinct bodies. */
function routedFetch(routes: {
  launcher?: FetchResponse | Error;
  health?: FetchResponse | Error;
}): typeof fetch {
  return (async (input: string) => {
    const url = String(input);
    const pick = url.includes(API_LAUNCHER_STATUS) ? routes.launcher : routes.health;
    if (pick === undefined) throw new Error(`no stub for ${url}`);
    if (pick instanceof Error) throw pick;
    return pick as unknown as Response;
  }) as unknown as typeof fetch;
}

/** Mount the harness; `onReady` fires in an $effect after mount, so the handle
 *  is captured in a holder and read (via `.get()`) after `settle()`. */
function mount(
  props: { connected?: boolean; firstRunSettled?: boolean; soloMode?: boolean } = {},
): { get(): AiReadiness } {
  const holder: { readiness: AiReadiness | null } = { readiness: null };
  render(AiReadinessHarness, {
    props: { ...props, onReady: (r: AiReadiness) => (holder.readiness = r) },
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

describe("createAiReadiness", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("is ready when the launcher reports running", async () => {
    globalThis.fetch = routedFetch({
      launcher: mkResponse({
        available: true,
        running: true,
        reaperPid: 1,
        cwd: "/tmp",
        sessionId: "<set>",
        resuming: false,
      }),
      health: mkResponse({ status: "ok", hasSession: false }),
    });
    const h = mount();
    await settle();
    expect(h.get().state).toBe("ready");
    expect(h.get().chip).toBeNull();
  });

  it("shows the restart chip when launcher is stopped AND no MCP session", async () => {
    globalThis.fetch = routedFetch({
      launcher: mkResponse({ available: true, running: false }),
      health: mkResponse({ status: "ok", hasSession: false }),
    });
    const h = mount();
    await settle();
    expect(h.get().state).toBe("stopped");
    expect(h.get().chip).toBe("restart");
  });

  it("#1054: an active MCP session promotes a stopped launcher to ready (no restart chip)", async () => {
    globalThis.fetch = routedFetch({
      launcher: mkResponse({ available: true, running: false }),
      health: mkResponse({ status: "ok", hasSession: true }),
    });
    const h = mount();
    await settle();
    expect(h.get().state).toBe("ready");
    expect(h.get().chip).toBeNull();
  });

  it("an active MCP session also suppresses the connect chip when launcher is unavailable", async () => {
    globalThis.fetch = routedFetch({
      launcher: mkResponse({ available: false, reason: "stdio-mode" }),
      health: mkResponse({ status: "ok", hasSession: true }),
    });
    const h = mount();
    await settle();
    expect(h.get().state).toBe("ready");
    expect(h.get().chip).toBeNull();
  });

  it("shows the connect chip when launcher unavailable and no session", async () => {
    globalThis.fetch = routedFetch({
      launcher: mkResponse({ available: false, reason: "stdio-mode" }),
      health: mkResponse({ status: "ok", hasSession: false }),
    });
    const h = mount();
    await settle();
    expect(h.get().state).toBe("unconfigured");
    expect(h.get().chip).toBe("connect");
  });

  it("a /health blip never demotes a connected agent (keeps prior hasSession)", async () => {
    // First poll: session active → hasSession cached true. Second poll's
    // /health throws → the prior (connected) value must survive.
    let healthCall = 0;
    globalThis.fetch = (async (input: string) => {
      const url = String(input);
      if (url.includes(API_LAUNCHER_STATUS)) {
        return mkResponse({ available: true, running: false }) as unknown as Response;
      }
      healthCall += 1;
      if (healthCall === 1) {
        return mkResponse({ status: "ok", hasSession: true }) as unknown as Response;
      }
      throw new Error("health blip");
    }) as unknown as typeof fetch;

    const h = mount();
    await settle();
    expect(h.get().state).toBe("ready");

    h.get().refresh();
    await settle();
    expect(h.get().state).toBe("ready");
    expect(h.get().chip).toBeNull();
  });

  it("absent hasSession (non-loopback shape) does not promote and is treated as unknown", async () => {
    globalThis.fetch = routedFetch({
      launcher: mkResponse({ available: true, running: false }),
      health: mkResponse({ status: "ok" }), // no hasSession field
    });
    const h = mount();
    await settle();
    expect(h.get().state).toBe("stopped");
    expect(h.get().chip).toBe("restart");
  });

  it("Solo mode suppresses the chip even when stopped", async () => {
    globalThis.fetch = routedFetch({
      launcher: mkResponse({ available: true, running: false }),
      health: mkResponse({ status: "ok", hasSession: false }),
    });
    const h = mount({ soloMode: true });
    await settle();
    expect(h.get().state).toBe("stopped");
    expect(h.get().chip).toBeNull();
  });

  it("is booting until the launcher status settles, regardless of /health", async () => {
    globalThis.fetch = routedFetch({
      launcher: mkResponse({}, false, 500), // launcher never settles
      health: mkResponse({ status: "ok", hasSession: true }),
    });
    const h = mount();
    await settle();
    expect(h.get().state).toBe("booting");
    expect(h.get().chip).toBeNull();
  });
});
