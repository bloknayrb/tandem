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

  // --- probeSession (#1083): fresh moment-of-send check -----------------

  it("#1083: probeSession sees a session the stale poll missed, returns true, and clears the chip", async () => {
    // First /health read (the boot poll): no session yet. Subsequent reads
    // (the probe): an agent has since connected.
    let healthCall = 0;
    globalThis.fetch = (async (input: string) => {
      const url = String(input);
      if (url.includes(API_LAUNCHER_STATUS)) {
        return mkResponse({ available: false, reason: "stdio-mode" }) as unknown as Response;
      }
      healthCall += 1;
      return mkResponse({
        status: "ok",
        hasSession: healthCall > 1,
      }) as unknown as Response;
    }) as unknown as typeof fetch;

    const h = mount();
    await settle();
    // Stale view: launcher unavailable, no session → the false-toast state.
    expect(h.get().state).toBe("unconfigured");
    expect(h.get().chip).toBe("connect");

    await expect(h.get().probeSession()).resolves.toBe(true);
    await tick();
    // The fresh read also folds into polled state — chip clears immediately.
    expect(h.get().state).toBe("ready");
    expect(h.get().chip).toBeNull();
  });

  it("probeSession returns false when a fresh read confirms no session", async () => {
    globalThis.fetch = routedFetch({
      launcher: mkResponse({ available: true, running: false }),
      health: mkResponse({ status: "ok", hasSession: false }),
    });
    const h = mount();
    await settle();
    expect(h.get().chip).toBe("restart");

    await expect(h.get().probeSession()).resolves.toBe(false);
    await tick();
    expect(h.get().chip).toBe("restart");
  });

  it("probeSession falls back to the last-known polled value when the fresh read fails", async () => {
    // Poll established hasSession: true; the probe then blips. The probe must
    // answer true (never demote a connected agent on a hiccup).
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

    await expect(h.get().probeSession()).resolves.toBe(true);
    expect(h.get().state).toBe("ready");
  });

  it("probeSession treats a redacted body (no hasSession) as unknown and keeps last-known false", async () => {
    let healthCall = 0;
    globalThis.fetch = (async (input: string) => {
      const url = String(input);
      if (url.includes(API_LAUNCHER_STATUS)) {
        return mkResponse({ available: true, running: false }) as unknown as Response;
      }
      healthCall += 1;
      if (healthCall === 1) {
        return mkResponse({ status: "ok", hasSession: false }) as unknown as Response;
      }
      return mkResponse({ status: "ok" }) as unknown as Response; // redacted
    }) as unknown as typeof fetch;

    const h = mount();
    await settle();
    expect(h.get().chip).toBe("restart");

    await expect(h.get().probeSession()).resolves.toBe(false);
    await tick();
    expect(h.get().chip).toBe("restart");
  });

  it("a slow poll response cannot clobber a fresher probe result (last-issued-wins)", async () => {
    // The boot poll's /health read hangs; the probe's read resolves first with
    // a live session. When the stale poll response finally arrives ("no
    // session", sampled before the agent connected), it must not demote.
    let resolveFirst!: (r: Response) => void;
    let healthCall = 0;
    globalThis.fetch = (async (input: string) => {
      const url = String(input);
      if (url.includes(API_LAUNCHER_STATUS)) {
        return mkResponse({ available: true, running: false }) as unknown as Response;
      }
      healthCall += 1;
      if (healthCall === 1) {
        return new Promise<Response>((r) => {
          resolveFirst = r;
        });
      }
      return mkResponse({ status: "ok", hasSession: true }) as unknown as Response;
    }) as unknown as typeof fetch;

    const h = mount();
    await settle(); // launcher settled; health read 1 still in flight
    expect(h.get().state).toBe("stopped");

    await expect(h.get().probeSession()).resolves.toBe(true);
    await tick();
    expect(h.get().state).toBe("ready");

    resolveFirst(mkResponse({ status: "ok", hasSession: false }) as unknown as Response);
    await settle();
    expect(h.get().state).toBe("ready");
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

  // --- liveIndicator (WS-B): the affirmative "an agent is connected" signal ---
  describe("liveIndicator", () => {
    const runningLauncher = {
      available: true,
      running: true,
      reaperPid: 1,
      cwd: "/tmp",
      sessionId: "<set>",
      resuming: false,
    };

    it("is 'connected' when an MCP session is open in Tandem mode", async () => {
      globalThis.fetch = routedFetch({
        launcher: mkResponse(runningLauncher),
        health: mkResponse({ status: "ok", hasSession: true }),
      });
      const h = mount();
      await settle();
      expect(h.get().liveIndicator).toBe("connected");
    });

    it("is 'solo-paused' when a session is open but mode is Solo", async () => {
      globalThis.fetch = routedFetch({
        launcher: mkResponse(runningLauncher),
        health: mkResponse({ status: "ok", hasSession: true }),
      });
      const h = mount({ soloMode: true });
      await settle();
      expect(h.get().liveIndicator).toBe("solo-paused");
    });

    // The load-bearing negative assertion (review HIGH-2): `state === "ready"`
    // is reachable from the launcher `running: true` branch with NO open MCP
    // session (auto-launched desktop startup window). The affirmative indicator
    // must NOT fire there — keying it on `state` would render a false "AI
    // connected". It keys on `mcpSessionActive` instead.
    it("does NOT claim connected when the launcher runs but no MCP session is open", async () => {
      globalThis.fetch = routedFetch({
        launcher: mkResponse(runningLauncher),
        health: mkResponse({ status: "ok", hasSession: false }),
      });
      const h = mount();
      await settle();
      expect(h.get().state).toBe("ready"); // launcher-running promotes state…
      expect(h.get().liveIndicator).toBeNull(); // …but no session → no claim
    });

    it("is null when no MCP session is open (stopped launcher)", async () => {
      globalThis.fetch = routedFetch({
        launcher: mkResponse({ available: true, running: false }),
        health: mkResponse({ status: "ok", hasSession: false }),
      });
      const h = mount();
      await settle();
      expect(h.get().liveIndicator).toBeNull();
    });
  });
});
