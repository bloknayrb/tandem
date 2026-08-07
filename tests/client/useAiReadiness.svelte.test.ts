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
 *   - `hasSession` promotes on any confident value and demotes on a confident
 *     `false` or on two consecutive dead POLL reads; a single `/health` blip
 *     never demotes (fail-safe). It was promotion-only until B1 — a fail-safe
 *     with no floor held "AI connected" against a server that had exited.
 *   - readiness stays `booting` until launcher status settles, regardless of
 *     `/health`.
 *   - Solo-mode suppresses the chip regardless.
 *
 * `createAiReadiness` calls `onDestroy` + `setInterval`, so it must run inside a
 * real component context — we mount it through `AiReadinessHarness.svelte`
 * (mirrors the `NotificationsHarness` pattern) rather than a bare `$effect.root`
 * (which gives a reactivity scope but no component lifecycle for `onDestroy`).
 */

import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChip, AiReadiness } from "../../src/client/hooks/useAiReadiness.svelte";
import { AI_CTA } from "../../src/client/hooks/useAiReadiness.svelte";
import AiReadinessHarness from "../../src/client/svelte-harness/AiReadinessHarness.svelte";
import { API_LAUNCHER_STATUS } from "../../src/shared/api-paths.js";

interface FetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

/** Both accessors, because the two readers in the hook use different ones:
 *  `pollLauncherStatus` calls `res.json()`, `fetchHealth` calls `res.text()`
 *  and parses separately so a body-stream failure stays distinguishable from a
 *  parse failure. */
function mkResponse(body: unknown, ok = true, status = 200): FetchResponse {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

/** A 200 carrying bytes that arrived complete and are not JSON — a squatter on
 *  :3479 serving HTML, say. Tandem's own `/health` cannot produce this. */
function mkUnparseable(): FetchResponse {
  const raw = "<!doctype html><title>not tandem</title>";
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(raw),
    text: async () => raw,
  };
}

/** Headers arrived, the body never did — the server began answering and then
 *  stopped existing (crash-looping sidecar, `kill_sidecar()` mid-poll). */
function mkStreamError(): FetchResponse {
  const boom = () => Promise.reject(new TypeError("network error"));
  return { ok: true, status: 200, json: boom, text: boom };
}

/** A route is a fixed response, an error to throw, or a thunk re-evaluated on
 *  every call — the last is what lets one stub change behaviour mid-test
 *  without rebuilding it. */
type Route = FetchResponse | Error | (() => FetchResponse);

/** Route the stub by URL so the launcher + health polls get distinct bodies. */
function routedFetch(routes: { launcher?: Route; health?: Route }): typeof fetch {
  return (async (input: string) => {
    const url = String(input);
    const pick = url.includes(API_LAUNCHER_STATUS) ? routes.launcher : routes.health;
    if (pick === undefined) throw new Error(`no stub for ${url}`);
    if (pick instanceof Error) throw pick;
    if (typeof pick === "function") return pick() as unknown as Response;
    return pick as unknown as Response;
  }) as unknown as typeof fetch;
}

/** The launcher fixture every demotion test shares: configured, not running —
 *  so readiness turns entirely on the MCP session, which is what those tests
 *  are about. */
const STOPPED_LAUNCHER = () => mkResponse({ available: true, running: false });

/** The auto-launched desktop default: the launcher believes Claude is up. Under
 *  this fixture `state` cannot observe a demotion at all — a dead launcher read
 *  keeps `running: true`, so `state` stays "ready" — which is exactly why the
 *  pill has to be asserted directly. */
const RUNNING_LAUNCHER = () => mkResponse({ available: true, running: true });

/** Wrap a route so it throws once the flag flips. Both `/health` and
 *  `/api/launcher/status` are served by the same Express app on :3479, so a
 *  dead server kills BOTH — every demotion fixture must route both through
 *  this, or it is testing a state the product cannot reach. */
function whenAlive(isDead: () => boolean, alive: () => FetchResponse): () => FetchResponse {
  return () => {
    if (isDead()) throw new Error("server gone");
    return alive();
  };
}

/** What a demotion looks like from outside, now that BOTH readers have floors.
 *  `state` is no longer the discriminator: with the whole server gone the
 *  launcher's floor clears `status` to null too, so `state` is "booting" —
 *  "we do not know" — rather than "stopped", which would assert the specific
 *  claim that Claude is configured and not running. These three are the
 *  health-reader's own observables. */
function expectDemoted(h: { get(): AiReadiness }): void {
  expect(h.get().state).toBe("booting");
  expect(h.get().liveIndicator).toBeNull();
  expect(h.get().pushDelivery).toBe("unknown");
  expect(h.get().serverUnreachable).toBe(true);
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
    // Unmount first, THEN restore fetch. This project sets no `globals: true`
    // and no setup file, so `@testing-library/svelte`'s auto-cleanup never
    // registers — without this every mounted harness leaks a component whose
    // `onDestroy` never runs and whose 8s poll keeps firing for the rest of the
    // worker's life, against the restored REAL fetch (`API_BASE` is absolute,
    // so those are live requests to 127.0.0.1:3479) and into later tests' stubs.
    cleanup();
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
    expect(h.get().lastError).toBeUndefined();
  });

  // #1268: `chip` is the single source of truth for the CTA views render —
  // it must fold the "go install Claude" `lastError` into `"setup"` itself,
  // rather than leaving each view to re-derive that from `lastError`
  // (which is how StatusBar and EmptyState drifted out of sync).
  it("shows the setup chip when the launcher's lastError is cli-unusable", async () => {
    globalThis.fetch = routedFetch({
      launcher: mkResponse({ available: true, running: false, lastError: "cli-unusable" }),
      health: mkResponse({ status: "ok", hasSession: false }),
    });
    const h = mount();
    await settle();
    expect(h.get().state).toBe("stopped");
    expect(h.get().lastError).toBe("cli-unusable");
    expect(h.get().chip).toBe("setup");
  });

  // This assertion is the INVERSE of the one #1268 shipped, deliberately.
  // `circuit-open` means the breaker tripped, which happens for a stale
  // --resume session, an auth failure, OOM or a bad plugin just as readily as
  // for a missing CLI — and the wizard `setup` opens cannot clear a tripped
  // breaker, only relaunch/start-fresh can. Routing it to `setup` told a
  // crash-looping user with a working install to install it again. The
  // supervisor now probes at trip time and reports `cli-unusable` when the CLI
  // really is the problem, leaving `circuit-open` to mean "it crashed".
  it("shows the restart chip (not setup) when lastError is a bare circuit-open", async () => {
    globalThis.fetch = routedFetch({
      launcher: mkResponse({ available: true, running: false, lastError: "circuit-open" }),
      health: mkResponse({ status: "ok", hasSession: false }),
    });
    const h = mount();
    await settle();
    expect(h.get().state).toBe("stopped");
    expect(h.get().lastError).toBe("circuit-open");
    expect(h.get().chip).toBe("restart");
  });

  it("still shows the restart chip for other lastError values, e.g. binary-not-found", async () => {
    // binary-not-found is the reaper-missing case, not a missing Claude CLI
    // (see the AiChip doc comment) — it gets no special CTA.
    globalThis.fetch = routedFetch({
      launcher: mkResponse({ available: true, running: false, lastError: "binary-not-found" }),
      health: mkResponse({ status: "ok", hasSession: false }),
    });
    const h = mount();
    await settle();
    expect(h.get().lastError).toBe("binary-not-found");
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

  it("suppresses the connect CTA while the launcher is deferred by autostart", async () => {
    // #1236. A boot launch holds the Claude launcher until the window is
    // shown. Falling through to "unconfigured" would tell a fully-configured
    // user to run the integration wizard — worse than saying nothing.
    globalThis.fetch = routedFetch({
      launcher: mkResponse({ available: false, reason: "deferred-autostart" }),
      health: mkResponse({ status: "ok", hasSession: false }),
    });
    const h = mount();
    await settle();
    expect(h.get().state).toBe("booting");
    expect(h.get().chip).toBeNull();
  });

  it("still shows the connect CTA to a LAN viewer, who sees no reason field", async () => {
    // `reason` is loopback-only, so off-loopback the deferred state is
    // indistinguishable from any other unavailable state — and a LAN viewer
    // could not act on the deferral anyway.
    globalThis.fetch = routedFetch({
      launcher: mkResponse({ available: false }),
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

  /**
   * The test above is the fail-safe; these are the defect (B1). They exist
   * because the blip tests each perform exactly ONE failed read, so they pass
   * before and after the fix — they pin the tolerance being kept, not the bug.
   *
   * A dead server fails BOTH endpoints — both routes are served by the same
   * Express app on :3479 — so any fixture simulating one kills both. They still
   * discriminate: the launcher's last good body said `running: false`, and a
   * dead launcher read keeps that prior value, so readiness turns entirely on
   * whether the MCP session is still believed in.
   */
  it("demotes after two consecutive dead poll reads", async () => {
    let dead = false;
    globalThis.fetch = routedFetch({
      launcher: whenAlive(() => dead, STOPPED_LAUNCHER),
      health: whenAlive(
        () => dead,
        () => mkResponse({ status: "ok", hasSession: true, push: { subscribers: 2 } }),
      ),
    });

    const h = mount();
    await settle();
    expect(h.get().state).toBe("ready");
    expect(h.get().pushDelivery).toBe("attached");

    dead = true;
    h.get().refresh();
    await settle();
    expect(h.get().state).toBe("ready"); // one strike — still tolerated

    h.get().refresh();
    await settle();
    // `pushDelivery` is `unknown`, never `none` — see the hook. A server we
    // cannot reach says nothing about how many consumers are attached to it.
    expectDemoted(h);
  });

  it("a success between two dead reads resets the count", async () => {
    let mode: "ok" | "dead" = "ok";
    const isDead = () => mode === "dead";
    globalThis.fetch = routedFetch({
      launcher: whenAlive(isDead, STOPPED_LAUNCHER),
      health: whenAlive(isDead, () => mkResponse({ status: "ok", hasSession: true })),
    });

    const h = mount();
    await settle();

    for (const step of ["dead", "ok", "dead"] as const) {
      mode = step;
      h.get().refresh();
      await settle();
    }
    // Two dead reads total, but not consecutive — the contract is a run, not a tally.
    expect(h.get().state).toBe("ready");
  });

  /**
   * The three ways a read can fail to be OUR server answering. All of them
   * demote, and that is the corrected contract — an earlier draft treated a
   * non-OK status and an unparseable body as "the server answered, so reset the
   * count", which reopened the exact hole one branch over.
   *
   * The justification is a property of the route, not a guess:
   * `makeHealthHandler` has no failure branch — it unconditionally sends a 200
   * carrying valid JSON — and the only thing that can reject ahead of it is the
   * DNS-rebinding Host check, which a 127.0.0.1 / `tauri.localhost` client never
   * trips. So on THIS route a 500 or a page of HTML is not Tandem being unwell;
   * it is evidence that Tandem is not what is on the port.
   */
  it.each([
    ["a non-OK status", () => mkResponse({}, false, 500)],
    ["an unparseable body", mkUnparseable],
    ["a body-stream failure", mkStreamError],
  ])("demotes after two consecutive reads that are not this server: %s", async (_label, bad) => {
    let mode: "ok" | "bad" = "ok";
    globalThis.fetch = routedFetch({
      launcher: STOPPED_LAUNCHER,
      health: () => (mode === "bad" ? bad() : mkResponse({ status: "ok", hasSession: true })),
    });

    const h = mount();
    await settle();
    expect(h.get().state).toBe("ready");

    mode = "bad";
    h.get().refresh();
    await settle();
    expect(h.get().state).toBe("ready"); // one strike — still tolerated

    h.get().refresh();
    await settle();
    expect(h.get().state).toBe("stopped");
  });

  it("a redacted body is the server declining to say, and never demotes", async () => {
    // The one case that IS "answered, but told us nothing": a genuine 200 with
    // valid JSON whose loopback-only fields are absent. It is expressed as null
    // FIELDS on an answered read, not as a failure, so it must not accrue a
    // strike however long it repeats.
    let mode: "full" | "redacted" | "dead" = "full";
    globalThis.fetch = routedFetch({
      launcher: STOPPED_LAUNCHER,
      health: () => {
        if (mode === "dead") throw new Error("server gone");
        return mode === "redacted"
          ? mkResponse({ status: "ok" }) // no hasSession, no push
          : mkResponse({ status: "ok", hasSession: true });
      },
    });

    const h = mount();
    await settle();
    expect(h.get().state).toBe("ready"); // promoted off the full body

    mode = "redacted";
    for (let i = 0; i < 4; i++) {
      h.get().refresh();
      await settle();
    }
    expect(h.get().state).toBe("ready"); // absence never demotes a known value

    // The assertion that bites: four redacted reads must leave the counter at
    // ZERO, so ONE dead read is still under the threshold. If redaction primed
    // the counter this demotes at half the intended patience.
    mode = "dead";
    h.get().refresh();
    await settle();
    expect(h.get().state).toBe("ready");
  });

  it("probeSession failures do not count toward demotion", async () => {
    // `probeSession` runs on every chat send and comment, so counting its reads
    // would let user activity demote well inside the intended two intervals.
    let dead = false;
    const isDead = () => dead;
    globalThis.fetch = routedFetch({
      launcher: whenAlive(isDead, STOPPED_LAUNCHER),
      health: whenAlive(isDead, () => mkResponse({ status: "ok", hasSession: true })),
    });

    const h = mount();
    await settle();

    dead = true;
    for (let i = 0; i < 5; i++) {
      await h.get().probeSession();
      await settle();
    }
    expect(h.get().state).toBe("ready");

    // …and the poll path still demotes on its own two, unaffected by the probes.
    h.get().refresh();
    await settle();
    h.get().refresh();
    await settle();
    expectDemoted(h);

    // The seam to the send path: `App.svelte` routes on this return value, and
    // `false` is what selects the "saved while no AI was connected" notice over
    // the delivery-delay one. That routing is the user-visible payoff of the
    // whole demotion, and it is the only assertion here that reaches it.
    await expect(h.get().probeSession()).resolves.toEqual({ answered: false, sessionLive: false });
  });

  it("drops the connected indicator when the server dies under a running launcher", async () => {
    // The auto-launched desktop default, and the configuration where `state`
    // is BLIND to the demotion: a dead launcher read keeps its last-known
    // `running: true`, so `state` stays "ready" throughout. Every other
    // demotion test asserts through `state` with a stopped launcher, so a
    // regression that latched `liveIndicator` — or re-derived it off `state`,
    // which the hook explicitly forbids — would pass all of them while leaving
    // the pill claiming "AI connected" against a process that had exited. That
    // pill is the thing B1 is about.
    let dead = false;
    const isDead = () => dead;
    globalThis.fetch = routedFetch({
      launcher: whenAlive(isDead, RUNNING_LAUNCHER),
      health: whenAlive(isDead, () =>
        mkResponse({ status: "ok", hasSession: true, push: { subscribers: 2 } }),
      ),
    });

    const h = mount();
    await settle();
    expect(h.get().liveIndicator).not.toBeNull();

    dead = true;
    h.get().refresh();
    await settle();
    h.get().refresh();
    await settle();

    // Both floors have now engaged, so `state` is "booting" rather than the
    // launcher's retained "ready". The point of the test is the pill: under a
    // RUNNING launcher a regression that latched `liveIndicator` — or re-derived
    // it off `state`, which the hook forbids — would survive every assertion
    // that goes through `state`, because the launcher's own last-known value
    // says "ready" right up until its floor engages.
    expect(h.get().liveIndicator).toBeNull();
    expect(h.get().pushDelivery).toBe("unknown");
    expect(h.get().serverUnreachable).toBe(true);
  });

  it("re-promotes when the server comes back, at full patience", async () => {
    let dead = false;
    const isDead = () => dead;
    globalThis.fetch = routedFetch({
      launcher: whenAlive(isDead, STOPPED_LAUNCHER),
      health: whenAlive(isDead, () => mkResponse({ status: "ok", hasSession: true })),
    });

    const h = mount();
    await settle();
    dead = true;
    h.get().refresh();
    await settle();
    h.get().refresh();
    await settle();
    expectDemoted(h);

    dead = false;
    h.get().refresh();
    await settle();
    expect(h.get().state).toBe("ready");
    expect(h.get().serverUnreachable).toBe(false);

    // The half that bites: recovery must reset the count to ZERO, not merely
    // re-promote. If it only re-promoted, the next single blip would demote at
    // half the intended patience for the rest of the session.
    dead = true;
    h.get().refresh();
    await settle();
    expect(h.get().state).toBe("ready");
  });

  it("still demotes when every poll read is superseded by a concurrent probe", async () => {
    // The inverse bug (see `readHasSession` for the mechanism), and the one no
    // other test here can see.
    //
    // Reproducing it needs a probe in flight over a poll read that is both
    // pending AND dead. The interleave alone is not the distinguisher — the
    // last-issued-wins test below deliberately hangs the boot poll's read and
    // probes over it — but that read resolves 200 OK, so it can never produce a
    // strike and the regression passes it. Dead is what matters, and every
    // other dead-read test awaits `settle()` between calls, so nothing is ever
    // in flight to supersede.
    //
    // Note the demotion write here is performed by the PROBE read: the poll
    // reads accrue both strikes and are then filtered by the staleness guard,
    // and the probe is the one still current when it lands. That is deliberate
    // — a probe may apply a demotion off strikes it did not earn, because the
    // strike count is a property of the server, not of who asked.
    globalThis.fetch = routedFetch({
      launcher: STOPPED_LAUNCHER,
      health: mkResponse({ status: "ok", hasSession: true }),
    });
    const h = mount();
    await settle();
    expect(h.get().state).toBe("ready");

    globalThis.fetch = routedFetch({
      launcher: new Error("server gone"),
      health: new Error("server gone"),
    });
    for (let i = 0; i < 2; i++) {
      h.get().refresh(); // poll read starts…
      void h.get().probeSession(); // …and is superseded before it resolves
      await settle();
      // Makes the accumulation visible. Without it, a refactor that gave probes
      // their own sequence counter would leave nothing superseded and this test
      // would still pass — as a duplicate of the plain two-dead-reads case.
      if (i === 0) expect(h.get().state).toBe("ready");
    }
    expectDemoted(h);
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

    await expect(h.get().probeSession()).resolves.toEqual({ answered: true, sessionLive: true });
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

    await expect(h.get().probeSession()).resolves.toEqual({ answered: true, sessionLive: false });
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

    // `sessionLive: true` is the FALLBACK, not a confirmation — and `answered:
    // false` is the only thing that says so. This pair is the whole reason the
    // return type is a record: a caller seeing the boolean alone cannot tell a
    // just-confirmed session from an 8-second-old guess, which is how a dead
    // server got a "Claude is connected" toast. `addressed-ai-notice.test.ts`
    // pins the consuming half.
    await expect(h.get().probeSession()).resolves.toEqual({ answered: false, sessionLive: true });
    expect(h.get().state).toBe("ready");
    // And the fallback must not have been laundered into polled state either.
    expect(h.get().serverUnreachable).toBe(false); // one blip is not a dead server
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

    await expect(h.get().probeSession()).resolves.toEqual({ answered: true, sessionLive: false });
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

    await expect(h.get().probeSession()).resolves.toEqual({ answered: true, sessionLive: true });
    await tick();
    expect(h.get().state).toBe("ready");

    resolveFirst(mkResponse({ status: "ok", hasSession: false }) as unknown as Response);
    await settle();
    expect(h.get().state).toBe("ready");
    expect(h.get().chip).toBeNull();
  });

  it("stale dead reads cannot demote against a fresher successful probe", async () => {
    // The mirror of the test above, in the direction that produces a FALSE
    // NEGATIVE — and the reason the demotion write stays BELOW the staleness
    // guard even though the strike count sits above it.
    //
    // Those two now live three lines apart with a long comment explaining why
    // the count moved up, which makes "consolidate them" an inviting edit. This
    // is what stops it: two hung poll reads that reject only after a fresh
    // probe has confirmed a live session earn both strikes, but neither is the
    // most-recently-issued read when it lands, so neither may write. Hoisting
    // the write demotes against the freshest evidence available.
    let rejectFirst!: (e: Error) => void;
    let rejectSecond!: (e: Error) => void;
    let healthCall = 0;
    globalThis.fetch = (async (input: string) => {
      const url = String(input);
      if (url.includes(API_LAUNCHER_STATUS)) {
        return mkResponse({ available: true, running: false }) as unknown as Response;
      }
      healthCall += 1;
      if (healthCall === 1) return new Promise<Response>((_, rej) => (rejectFirst = rej));
      if (healthCall === 2) return new Promise<Response>((_, rej) => (rejectSecond = rej));
      return mkResponse({ status: "ok", hasSession: true }) as unknown as Response;
    }) as unknown as typeof fetch;

    const h = mount(); // poll read 1 issued, hangs
    await settle();
    h.get().refresh(); // poll read 2 issued, hangs
    await settle();

    // Probe read 3 is issued last and answers: a live session, freshest word.
    await expect(h.get().probeSession()).resolves.toEqual({ answered: true, sessionLive: true });
    await tick();
    expect(h.get().state).toBe("ready");

    // Now the two stale reads fail. deadReads reaches the threshold — correctly,
    // they are poll reads that did not answer — but they are both superseded.
    rejectFirst(new Error("server gone"));
    rejectSecond(new Error("server gone"));
    await settle();
    expect(h.get().state).toBe("ready");
    expect(h.get().chip).toBeNull();
  });

  it("stops presenting a launcher state read from a server that stopped answering", async () => {
    // The launcher reader's own floor, exercised in isolation — only the
    // launcher route dies, `/health` keeps answering. That is deliberately NOT
    // the "dead server" fixture: this floor exists precisely for the case the
    // dead-server coupling does NOT cover, where the HTTP API degrades while
    // the Hocuspocus socket survives and `deps.connected()` therefore never
    // falls. Until this floor existed, `status` was retained through every
    // subsequent failure forever once one read had succeeded.
    let launcherDead = false;
    globalThis.fetch = routedFetch({
      launcher: whenAlive(() => launcherDead, RUNNING_LAUNCHER),
      health: () => mkResponse({ status: "ok", hasSession: false }),
    });

    const h = mount();
    await settle();
    expect(h.get().state).toBe("ready"); // launcher says Claude is up

    launcherDead = true;
    h.get().refresh();
    await settle();
    expect(h.get().state).toBe("ready"); // one strike — prior value still held

    h.get().refresh();
    await settle();
    // "booting" = we do not know, chip suppressed. NOT "stopped", which would
    // assert the specific claim that Claude is configured and not running —
    // a claim nothing supports once the route reporting it went silent.
    expect(h.get().state).toBe("booting");
    expect(h.get().chip).toBeNull();
    // …and the health reader is untouched: it kept answering, so nothing about
    // the SERVER being gone is claimed. The two floors are independent.
    expect(h.get().serverUnreachable).toBe(false);
  });

  it("a launcher body that isn't a LauncherStatus never settles the status", async () => {
    // An unchecked cast here is not cosmetic. Any parseable non-LauncherStatus
    // body — `{}` from a port squatter, an error envelope — makes both
    // `available === false` and `running === true` false, which lands on
    // `state === "stopped"` with no `lastError`, which renders a working
    // "Restart Claude Code" button derived from a body nobody validated. The
    // honest answer to "I got something I don't understand" is to keep waiting.
    globalThis.fetch = routedFetch({
      launcher: mkResponse({ error: "not the launcher" }),
      health: mkResponse({ status: "ok", hasSession: false }),
    });
    const h = mount();
    await settle();
    expect(h.get().state).toBe("booting");
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

/**
 * `AI_CTA` is the shared chip→call-to-action map consumed by StatusBar's
 * indicator button and App's "no AI connected" toast. It exists because both
 * surfaces independently reduced a THREE-member union with a binary
 * `chip === "connect" ? … : …` ternary, and `setup` — the branch that fires
 * when the Claude CLI isn't installed — fell through to the restart handler in
 * both. Restarting is exactly the doomed spawn loop the circuit breaker tripped
 * to stop, so the wrong branch is actively harmful, not merely mislabelled.
 */
describe("AI_CTA", () => {
  const CHIPS: Exclude<AiChip, null>[] = ["connect", "setup", "restart"];

  it("covers every non-null chip with non-empty copy", () => {
    // Guards against a future union member landing with no entry: the type
    // catches it at compile time, this catches a `{} as any` escape hatch.
    expect(Object.keys(AI_CTA).sort()).toEqual([...CHIPS].sort());
    for (const chip of CHIPS) {
      expect(AI_CTA[chip].label).toBeTruthy();
      expect(AI_CTA[chip].title).toBeTruthy();
      expect(AI_CTA[chip].ariaLabel).toBeTruthy();
    }
  });

  it("routes 'setup' to the connect flow, not restart", () => {
    expect(AI_CTA.setup.action).toBe("connect");
    expect(AI_CTA.setup.label).toBe("Set up Claude Code");
  });

  // Positive control for the assertion above — `restart` proves the `action`
  // field can actually take the other value, so "not restart" is a real result
  // rather than an artefact of a map that only ever says "connect".
  it("routes 'connect' and 'restart' to their own flows", () => {
    expect(AI_CTA.connect.action).toBe("connect");
    expect(AI_CTA.restart.action).toBe("restart");
  });
});

/**
 * `pushConsumerAttached` — the delivery half of the story.
 *
 * `liveIndicator` proves Claude CAN READ the document; this proves whether
 * anything will TELL it. They are structurally disjoint (routes/health.ts:40-45),
 * which is why a hand-launched session shows "AI connected" while a comment
 * reaches nobody until the next `tandem_checkInbox`.
 *
 * The asymmetry is the contract: only `false` is sound. `subscribers: 0` really
 * does mean no consumer, but any positive count includes an attached-but-inert
 * shim — so `true` must never be read as "push works".
 */
describe("createAiReadiness — push consumer", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    // Unmount first, THEN restore fetch. This project sets no `globals: true`
    // and no setup file, so `@testing-library/svelte`'s auto-cleanup never
    // registers — without this every mounted harness leaks a component whose
    // `onDestroy` never runs and whose 8s poll keeps firing for the rest of the
    // worker's life, against the restored REAL fetch (`API_BASE` is absolute,
    // so those are live requests to 127.0.0.1:3479) and into later tests' stubs.
    cleanup();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const RUNNING = {
    available: true,
    running: true,
    reaperPid: 1,
    cwd: "/tmp",
    sessionId: "<set>",
    resuming: false,
  };

  it("reports false when a session is live but no consumer is attached", async () => {
    // The case this whole change exists for: an agent is attached and readable,
    // and nothing is pushing to it.
    globalThis.fetch = routedFetch({
      launcher: mkResponse(RUNNING),
      health: mkResponse({ status: "ok", hasSession: true, push: { subscribers: 0 } }),
    });
    const h = mount();
    await settle();
    expect(h.get().liveIndicator).toBe("connected");
    expect(h.get().pushDelivery).toBe("none");
  });

  it("reports true when a consumer is attached", async () => {
    globalThis.fetch = routedFetch({
      launcher: mkResponse(RUNNING),
      health: mkResponse({ status: "ok", hasSession: true, push: { subscribers: 2 } }),
    });
    const h = mount();
    await settle();
    expect(h.get().pushDelivery).toBe("attached");
  });

  it("stays null when the loopback-only push field is absent", async () => {
    // A redacted (non-loopback) body must read as UNKNOWN, not as "no consumer"
    // — otherwise a LAN viewer would be told delivery is broken on the strength
    // of a field they were never allowed to see.
    globalThis.fetch = routedFetch({
      launcher: mkResponse(RUNNING),
      health: mkResponse({ status: "ok" }),
    });
    const h = mount();
    await settle();
    expect(h.get().pushDelivery).toBe("unknown");
  });

  it("keeps the prior count when a later /health read fails", async () => {
    // Same fail-safe as `hasSession`: a blip must not manufacture a scary
    // "nothing is delivering" state for a session that was fine a second ago.
    let fail = false;
    globalThis.fetch = (async (input: string) => {
      const url = String(input);
      if (url.includes(API_LAUNCHER_STATUS)) return mkResponse(RUNNING) as unknown as Response;
      if (fail) throw new Error("network blip");
      return mkResponse({
        status: "ok",
        hasSession: true,
        push: { subscribers: 3 },
      }) as unknown as Response;
    }) as unknown as typeof fetch;

    const h = mount();
    await settle();
    expect(h.get().pushDelivery).toBe("attached");

    fail = true;
    h.get().refresh();
    await settle();
    expect(h.get().pushDelivery).toBe("attached");
  });

  it("does not demote hasSession when a LATER body omits only the push field", async () => {
    // The two fields ride one fetch, so a partial body must not let one
    // signal's absence clobber the other's known value.
    //
    // This must start from a state where the demotion would be VISIBLE. An
    // earlier version of this test read a partial body on the first poll, so
    // `hasSession` had no prior value to clobber — it passed even with the
    // per-field guard removed, which mutation testing confirmed. Establish both
    // signals first, THEN feed a body missing one of them.
    let body: unknown = { status: "ok", hasSession: true, push: { subscribers: 0 } };
    globalThis.fetch = (async (input: string) => {
      const url = String(input);
      if (url.includes(API_LAUNCHER_STATUS)) {
        return mkResponse({ available: true, running: false }) as unknown as Response;
      }
      return mkResponse(body) as unknown as Response;
    }) as unknown as typeof fetch;

    const h = mount();
    await settle();
    expect(h.get().state).toBe("ready"); // promoted by hasSession
    expect(h.get().pushDelivery).toBe("none");

    // Now a body carrying ONLY the push field. `hasSession` must survive.
    body = { status: "ok", push: { subscribers: 2 } };
    h.get().refresh();
    await settle();
    expect(h.get().liveIndicator).toBe("connected");
    expect(h.get().state).toBe("ready");
    expect(h.get().pushDelivery).toBe("attached");
  });

  // --- D-5: the push↔pull join --------------------------------------------
  //
  // The RULES (threshold, Solo/offline precedence, unknown-state handling) are
  // `status/delivery-stall.ts`'s and are tested there. What is only observable
  // here is the WIRING, and specifically that the join is held on the opposite
  // terms from `hasSession` / `push.subscribers`.

  describe("deliveryStalledMs", () => {
    const STALLED = { state: "awaiting-poll", waitingMs: 200_000 };

    it("surfaces a stall the server reports", async () => {
      globalThis.fetch = routedFetch({
        launcher: RUNNING_LAUNCHER,
        health: mkResponse({ status: "ok", hasSession: true, delivery: STALLED }),
      });
      const h = mount();
      await settle();
      expect(h.get().deliveryStalledMs).toBe(200_000);
    });

    it("clears when a later read omits the join entirely", async () => {
      // THE point of this block. `hasSession` and `pushAttached` deliberately
      // only ever promote, so a redacted field cannot demote a live session.
      // The join is the opposite: absent means "the server declined to say",
      // and holding the last number would leave the banner asserting a stall
      // off evidence that no longer exists — the exact "claim outliving its
      // evidence" failure this whole surface was built to remove. A guard
      // copied from the two fields above would pass every other test here.
      let body: unknown = { status: "ok", hasSession: true, delivery: STALLED };
      globalThis.fetch = routedFetch({
        launcher: RUNNING_LAUNCHER,
        health: () => mkResponse(body),
      });
      const h = mount();
      await settle();
      expect(h.get().deliveryStalledMs).toBe(200_000);

      body = { status: "ok", hasSession: true };
      h.get().refresh();
      await settle();
      expect(h.get().deliveryStalledMs).toBeNull();
      expect(h.get().liveIndicator).toBe("connected"); // …and did not demote the session
    });

    it("clears once a poll lands and the server reports the join answered", async () => {
      let body: unknown = { status: "ok", hasSession: true, delivery: STALLED };
      globalThis.fetch = routedFetch({
        launcher: RUNNING_LAUNCHER,
        health: () => mkResponse(body),
      });
      const h = mount();
      await settle();
      expect(h.get().deliveryStalledMs).toBe(200_000);

      body = {
        status: "ok",
        hasSession: true,
        delivery: { state: "polled", waitingMs: null, latencyMs: 200_400 },
      };
      h.get().refresh();
      await settle();
      expect(h.get().deliveryStalledMs).toBeNull();
    });

    it("clears when the server dies rather than blaming the model for it", async () => {
      let dead = false;
      globalThis.fetch = routedFetch({
        launcher: whenAlive(() => dead, RUNNING_LAUNCHER),
        health: whenAlive(
          () => dead,
          () => mkResponse({ status: "ok", hasSession: true, delivery: STALLED }),
        ),
      });
      const h = mount();
      await settle();
      expect(h.get().deliveryStalledMs).toBe(200_000);

      dead = true;

      // One dead read holds the claim, deliberately, and that is the more
      // interesting half of this test. A dropped request is not evidence the
      // stall ENDED — the message is still unanswered either way — so clearing
      // on the first blip would blink the banner off and back on 8s later at a
      // slightly larger number. The claim survives to the same two-strike floor
      // the pill uses.
      h.get().refresh();
      await settle();
      expect(h.get().deliveryStalledMs).toBe(200_000);

      // At the floor the offline story takes over, and the two must not stack:
      // with the server gone, "Claude hasn't picked this up" is still true but
      // blames the wrong party, and the disconnection banner tells it better.
      h.get().refresh();
      await settle();
      expect(h.get().serverUnreachable).toBe(true);
      expect(h.get().deliveryStalledMs).toBeNull();
    });

    it("stays silent in Solo, where the user opted out of AI surfacing", async () => {
      globalThis.fetch = routedFetch({
        launcher: RUNNING_LAUNCHER,
        health: mkResponse({ status: "ok", hasSession: true, delivery: STALLED }),
      });
      const h = mount({ soloMode: true });
      await settle();
      expect(h.get().deliveryStalledMs).toBeNull();
    });

    it("ignores a wait that arrives as a string", async () => {
      // The one half of the parse guard with an observable failure, so it gets
      // the valid state string: `"200000" < DELIVERY_STALL_MS` coerces to
      // `200000 < 120000` → false, so an unguarded parse would pass the
      // threshold and hand a STRING to a component that does arithmetic on it.
      // (The `state` guard is not observable the same way — any value that is
      // not the literal `"awaiting-poll"` reads as no-claim by construction, so
      // it exists to keep the declared `string | null` type honest, and no test
      // here can distinguish its presence. Said plainly rather than papered
      // over with an assertion that passes either way.)
      globalThis.fetch = routedFetch({
        launcher: RUNNING_LAUNCHER,
        health: mkResponse({
          status: "ok",
          hasSession: true,
          delivery: { state: "awaiting-poll", waitingMs: "200000" },
        }),
      });
      const h = mount();
      await settle();
      expect(h.get().deliveryStalledMs).toBeNull();
    });
  });
});
