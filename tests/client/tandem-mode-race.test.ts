// @vitest-environment happy-dom

/**
 * #1621 — the CTRL_ROOM mode broadcast used to race the ctrl provider's first
 * sync, and lose silently.
 *
 * The broadcast wrote `Y_MAP_MODE` into a fresh, unsynced `Y.Doc`, which made it
 * CONCURRENT with whatever the server already held for the same key. Yjs breaks
 * a concurrent `Y.Map` tie by highest clientID, not recency, and clientIDs are
 * random per launch — so every startup was a coin flip. The loser was silent
 * because nothing client-side read the key back, so the toggle kept showing the
 * mode the user picked while `tandem_status` served a dead session's value, and
 * a connected agent held annotations for a writer waiting on comments.
 *
 * The tie-break specs pin BOTH clientID orderings deliberately: pinning one
 * would be a green test over a live bug rather than a regression pin.
 *
 * Remote changes are driven by applying a real Yjs update from a second doc, so
 * the value the detector reads and the value in the map cannot disagree. There
 * is no "room value" prop on the fixture on purpose — injecting one would let a
 * spec assert against a state production cannot reach.
 */

import { cleanup, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { _resetClientLog, readClientLog } from "../../src/client/utils/client-log";
import {
  TANDEM_MODE_DEFAULT,
  TANDEM_MODE_KEY,
  Y_MAP_DWELL_MS,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../src/shared/constants";
import { BROWSER_ORIGIN } from "../../src/shared/origins";
import type { TandemMode } from "../../src/shared/types";
import TandemModeHarness from "./fixtures/TandemModeHarness.svelte";

/** A doc with a pinned clientID, so a tie has a decided winner. */
function docWithClientId(clientID: number): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  return doc;
}

/**
 * Stands in for the Hocuspocus provider as a transaction origin.
 *
 * Load-bearing, not decoration. Production applies wire updates as
 * `Y.applyUpdate(doc, update, provider)` — a NON-NULL origin. A bare
 * `Y.applyUpdate(to, update)` leaves `transaction.origin === null`, and review
 * found the gap that opens: swapping the detector's `transaction.local` check
 * for `transaction.origin !== null` left every spec green while, in production,
 * skipping every wire update so the detector could never fire once. Passing a
 * sentinel here makes that mutant red.
 */
const REMOTE_ORIGIN = { provider: "test-hocuspocus" };

function sync(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from), REMOTE_ORIGIN);
}

function modeOf(doc: Y.Doc): unknown {
  return doc.getMap(Y_MAP_USER_AWARENESS).get(Y_MAP_MODE);
}

function setServerMode(doc: Y.Doc, mode: TandemMode): void {
  doc.getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_MODE, mode);
}

/**
 * The DISTINCT `tandem-mode` events in the diagnostics buffer, not one entry
 * per fire. `readClientLog` coalesces repeats into a single entry carrying a
 * `count`, so this can never show the same event twice — a spec that needs to
 * see a second fire must assert on that `count` instead.
 */
function distinctModeWarnings(): readonly string[] {
  return readClientLog()
    .filter((e) => e.scope === "tandem-mode")
    .map((e) => e.event);
}

/**
 * A second writer overwrites the key after this client's broadcast landed. Goes
 * through a real merge rather than a direct `set` on the client doc, so the
 * observer sees `transaction.local === false` exactly as it would on the wire.
 */
function landRemoteWrite(client: Y.Doc, mode: TandemMode): void {
  const other = docWithClientId(DEAD_SESSION_CLIENT_ID);
  sync(client, other);
  setServerMode(other, mode);
  sync(other, client);
}

/**
 * A genuinely CONCURRENT competing write: `other` is built from the client's
 * state BEFORE the client writes, so neither item has seen the other and Yjs
 * must break the tie by clientID.
 *
 * `landRemoteWrite` above is the clean case — it syncs first, so the competitor
 * is causally after us and simply wins. This is the #1621 shape itself, where
 * this client can LOSE, and the detector has to report from the losing side.
 */
function landConcurrentWrite(client: Y.Doc, before: Uint8Array, mode: TandemMode): void {
  const other = docWithClientId(DEAD_SESSION_CLIENT_ID);
  Y.applyUpdate(other, before);
  setServerMode(other, mode);
  sync(other, client);
}

/**
 * The server's incumbent value, written by a since-dead session. In the live
 * instance that surfaced this there were competing writes to the one key from
 * 20+ distinct clientIDs, nearly all at clock 0 — one per app launch.
 */
const DEAD_SESSION_CLIENT_ID = 2_587_528_963;

let fetchSpy: ReturnType<typeof vi.fn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  localStorage.clear();
  _resetClientLog();
  // `logClientWarning` also writes to the console by design; silence it so a
  // deliberate warn in a passing spec does not read as a failure.
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  _resetClientLog();
  localStorage.clear();
});

describe("#1621 mode broadcast vs. the ctrl provider's first sync", () => {
  // The same scenario with the client's clientID moved to either side of the
  // incumbent's. Both must pass: the fix works by making the write causally
  // ordered rather than concurrent, which wins regardless of clientID, so an
  // implementation that merely got lucky fails one of them.
  for (const [label, clientID] of [
    ["lower than the incumbent's", DEAD_SESSION_CLIENT_ID - 1_000_000],
    ["higher than the incumbent's", DEAD_SESSION_CLIENT_ID + 1_000_000],
  ] as const) {
    it(`wins the merge when this client's clientID is ${label}`, async () => {
      const server = docWithClientId(DEAD_SESSION_CLIENT_ID);
      setServerMode(server, "solo");

      localStorage.setItem(TANDEM_MODE_KEY, "tandem");
      const client = docWithClientId(clientID);

      // Mount BEFORE sync, exactly as the provider does: `bootstrapYdoc` is
      // assigned at construction, so consumers see the doc while it is still
      // empty and unsynced.
      const view = render(TandemModeHarness, { props: { doc: client, synced: false } });
      await waitFor(() => expect(view.getByTestId("mode").textContent).toBe("tandem"));
      expect(modeOf(client)).toBeUndefined();

      // The provider syncs, then reports it.
      sync(server, client);
      await view.rerender({ doc: client, synced: true });
      await waitFor(() => expect(modeOf(client)).toBe("tandem"));

      sync(client, server);
      expect(modeOf(server)).toBe("tandem");
      expect(view.getByTestId("mode").textContent).toBe("tandem");
    });
  }

  it("writes nothing into the ctrl doc before the provider reports sync", async () => {
    localStorage.setItem(TANDEM_MODE_KEY, "solo");
    const client = new Y.Doc();
    render(TandemModeHarness, { props: { doc: client, synced: false, dwellMs: 250 } });

    // Deliberately asserts the dwell key too: it is broadcast by a sibling
    // effect with the identical race, and fixing only the loud one leaves a
    // second concurrent write on the same map.
    await waitFor(() => expect(modeOf(client)).toBeUndefined());
    expect(client.getMap(Y_MAP_USER_AWARENESS).get(Y_MAP_DWELL_MS)).toBeUndefined();
  });

  it("never broadcasts while the provider never syncs (offline start)", async () => {
    localStorage.setItem(TANDEM_MODE_KEY, "solo");
    const client = new Y.Doc();
    const view = render(TandemModeHarness, { props: { doc: client, synced: false } });
    await view.rerender({ doc: client, synced: false, dwellMs: 500 });

    // The key stays absent rather than wrong. An absent key reads as
    // `indeterminate` server-side and `reportedMode` falls back to the default,
    // which is strictly better than the coin-flip loss this replaces.
    await waitFor(() => expect(view.getByTestId("mode").textContent).toBe("solo"));
    expect(modeOf(client)).toBeUndefined();
  });
});

describe("#1621 reading the key back", () => {
  it("reports a disagreement in BOTH directions without adopting either", async () => {
    // The "does NOT adopt" property, pinned symmetrically. Asserting only the
    // room-holds-tandem direction leaves an adopt-when-solo mutant green — and
    // that is the worse direction, because it drags the window INTO Solo and the
    // persist effect writes it to localStorage, so it outlives the session.
    //
    // The absent POST is the other half: `setTandemMode` fires
    // `triggerSoloRelease` on Solo→Tandem, so an adopt routed through the
    // public setter would release held annotations as a side effect of a merge.
    for (const [local, remote, event] of [
      ["tandem", "solo", "room-holds-solo-not-ours"],
      ["solo", "tandem", "room-holds-tandem-not-ours"],
    ] as const) {
      _resetClientLog();
      localStorage.setItem(TANDEM_MODE_KEY, local);
      const client = new Y.Doc();
      const view = render(TandemModeHarness, { props: { doc: client, synced: true } });
      await waitFor(() => expect(modeOf(client)).toBe(local));

      landRemoteWrite(client, remote);
      await waitFor(() => expect(distinctModeWarnings()).toEqual([event]));

      expect(view.getByTestId("mode").textContent).toBe(local);
      expect(localStorage.getItem(TANDEM_MODE_KEY)).toBe(local);
      expect(modeOf(client)).toBe(remote);
      expect(fetchSpy).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("does NOT report this client's own broadcast", async () => {
    // The `transaction.local` gate. Our own `awareness.set` re-enters the
    // observer synchronously inside the broadcast effect's transaction, so
    // without it every toggle would file a disagreement against itself.
    localStorage.setItem(TANDEM_MODE_KEY, "solo");
    const client = new Y.Doc();
    const view = render<typeof TandemModeHarness>(TandemModeHarness, {
      props: { doc: client, synced: true },
    });
    await waitFor(() => expect(modeOf(client)).toBe("solo"));

    for (const mode of ["tandem", "solo", "tandem"] as const) {
      view.component.setMode(mode);
      await waitFor(() => expect(modeOf(client)).toBe(mode));
    }
    expect(distinctModeWarnings()).toEqual([]);
  });

  it("does NOT report the room's value on first sync, ahead of its own broadcast", async () => {
    // On first sync the map legitimately holds the previous session's persisted
    // mode — `restoreCtrlDoc` re-applies the whole CTRL doc — so comparing
    // before this client has written would warn on every single launch and train
    // everyone to ignore the signal.
    const server = docWithClientId(DEAD_SESSION_CLIENT_ID);
    setServerMode(server, "solo");
    localStorage.setItem(TANDEM_MODE_KEY, "tandem");

    const client = new Y.Doc();
    const view = render(TandemModeHarness, { props: { doc: client, synced: false } });
    await waitFor(() => expect(view.getByTestId("mode").textContent).toBe("tandem"));

    sync(server, client);
    await view.rerender({ doc: client, synced: true });
    await waitFor(() => expect(modeOf(client)).toBe("tandem"));
    expect(distinctModeWarnings()).toEqual([]);
  });

  it("does NOT report a pre-rebuild value after a reconnect", async () => {
    // The generation gate replaces the ctrl Y.Doc and resets
    // `ctrlInitialSyncComplete`. A `lastBroadcast` left standing from the
    // previous generation would compare the new room's restored value against a
    // write that never happened on this doc — the same false positive as first
    // sync, on reconnect only, which no first-launch spec can see.
    localStorage.setItem(TANDEM_MODE_KEY, "tandem");
    const first = new Y.Doc();
    const view = render(TandemModeHarness, { props: { doc: first, synced: true } });
    await waitFor(() => expect(modeOf(first)).toBe("tandem"));

    const server = docWithClientId(DEAD_SESSION_CLIENT_ID);
    setServerMode(server, "solo");
    const rebuilt = new Y.Doc();
    await view.rerender({ doc: rebuilt, synced: false });
    sync(server, rebuilt);
    await view.rerender({ doc: rebuilt, synced: true });

    await waitFor(() => expect(modeOf(rebuilt)).toBe("tandem"));
    expect(distinctModeWarnings()).toEqual([]);
  });

  it("stays silent when the server echoes this client's own Solo release", async () => {
    // The product's most common remote-mode write, and it must NOT be reported.
    // `setTandemMode` fires `triggerSoloRelease` on Solo→Tandem, and
    // `/api/mode/release` answers by writing "tandem" into the ctrl doc — a
    // NON-LOCAL transaction that lands right back in this observer. It is silent
    // only because the broadcast effect refreshes `lastBroadcast` on every
    // toggle; a one-character `lastBroadcast ??= mode` freezes it at the mount
    // value and files a disagreement against the server echoing the user's own
    // action, on every Solo→Tandem toggle there is.
    localStorage.setItem(TANDEM_MODE_KEY, "solo");
    const client = new Y.Doc();
    const view = render<typeof TandemModeHarness>(TandemModeHarness, {
      props: { doc: client, synced: true },
    });
    await waitFor(() => expect(modeOf(client)).toBe("solo"));

    view.component.setMode("tandem");
    await waitFor(() => expect(modeOf(client)).toBe("tandem"));
    expect(fetchSpy).toHaveBeenCalled();

    landRemoteWrite(client, "tandem");
    await waitFor(() => expect(modeOf(client)).toBe("tandem"));
    expect(distinctModeWarnings()).toEqual([]);
  });

  it("reports from the LOSING side of a genuine concurrent tie", async () => {
    // #1621's own shape, which every other spec here avoids: `landRemoteWrite`
    // syncs first, so the competitor is causally after us and merely wins. Here
    // neither writer has seen the other, so Yjs breaks the tie by clientID — and
    // the competitor is higher, so this client loses exactly as it did on
    // 0.24.1. The detector has to speak from the losing side.
    localStorage.setItem(TANDEM_MODE_KEY, "solo");
    const client = docWithClientId(DEAD_SESSION_CLIENT_ID - 1_000_000);
    const before = Y.encodeStateAsUpdate(client);
    render(TandemModeHarness, { props: { doc: client, synced: true } });
    await waitFor(() => expect(modeOf(client)).toBe("solo"));

    landConcurrentWrite(client, before, "tandem");
    await waitFor(() => expect(modeOf(client)).toBe("tandem"));
    expect(distinctModeWarnings()).toEqual(["room-holds-tandem-not-ours"]);
  });

  it("does not re-fire on a remote write to a DIFFERENT key of the same map", async () => {
    // `Y_MAP_DWELL_MS` lives on this very map and is broadcast four lines away
    // from the mode. Without the `keysChanged` filter, ANY remote write to the
    // awareness map re-runs the comparison — so once a genuine disagreement
    // exists, a second window nudging its dwell slider re-files the same warning
    // on every nudge and floods the buffer the user pastes into an issue.
    //
    // The disagreement has to be established FIRST, and the assertion has to be
    // on `count`, not on the event list. Without a standing disagreement the
    // value comparison short-circuits and the missing filter is invisible; and
    // `readClientLog` coalesces duplicates into one entry, so `distinctModeWarnings()`
    // reports the SET of events and can never see a second fire.
    localStorage.setItem(TANDEM_MODE_KEY, "solo");
    const client = new Y.Doc();
    render(TandemModeHarness, { props: { doc: client, synced: true } });
    await waitFor(() => expect(modeOf(client)).toBe("solo"));

    landRemoteWrite(client, "tandem");
    await waitFor(() => expect(distinctModeWarnings()).toEqual(["room-holds-tandem-not-ours"]));
    const firstCount = readClientLog().find((e) => e.scope === "tandem-mode")?.count;
    expect(firstCount).toBe(1);

    const other = docWithClientId(DEAD_SESSION_CLIENT_ID);
    sync(client, other);
    other.getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_DWELL_MS, 2500);
    sync(other, client);

    await waitFor(() => expect(client.getMap(Y_MAP_USER_AWARENESS).get(Y_MAP_DWELL_MS)).toBe(2500));
    expect(readClientLog().find((e) => e.scope === "tandem-mode")?.count).toBe(1);
  });

  it("stays silent rather than mislabelling an unparseable room value", async () => {
    // The one branch where the detector chooses silence. A deleted or legacy
    // value must not be reported as "room-holds-tandem-not-ours": the warning
    // lands in an artifact the user pastes into a public issue, and a
    // confidently wrong diagnostic there is worse than none.
    localStorage.setItem(TANDEM_MODE_KEY, "solo");
    const client = new Y.Doc();
    render(TandemModeHarness, { props: { doc: client, synced: true } });
    await waitFor(() => expect(modeOf(client)).toBe("solo"));

    const other = docWithClientId(DEAD_SESSION_CLIENT_ID);
    sync(client, other);
    other.getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_MODE, "not-a-mode");
    sync(other, client);

    await waitFor(() => expect(modeOf(client)).toBe("not-a-mode"));
    expect(distinctModeWarnings()).toEqual([]);
  });

  it("broadcasts under the browser origin, not another helper", async () => {
    // Critical Rule 2: the helper choice IS the contract, and `audit:origins`
    // counts tagged sites without checking WHICH helper — so swapping
    // `withBrowser` for `withInternal` here is a silent change every other spec
    // tolerates. Only `browser` writes generate channel events.
    localStorage.setItem(TANDEM_MODE_KEY, "solo");
    const client = new Y.Doc();
    const origins: unknown[] = [];
    client.on("afterTransaction", (txn: Y.Transaction) => {
      if (txn.local) origins.push(txn.origin);
    });
    render(TandemModeHarness, { props: { doc: client, synced: true } });
    await waitFor(() => expect(modeOf(client)).toBe("solo"));

    expect(origins.length).toBeGreaterThan(0);
    expect(new Set(origins)).toEqual(new Set([BROWSER_ORIGIN]));
  });

  it("registers exactly one observer per ctrl doc and releases it on replace", async () => {
    // Without this the leak is invisible to every other spec here: an unguarded
    // `.observe()` in a value-reactive effect accumulates a listener per toggle,
    // and a missing `.unobserve()` keeps the old doc's listener alive across the
    // rebuild that #1621's own reconnect path performs.
    localStorage.setItem(TANDEM_MODE_KEY, "solo");
    const client = new Y.Doc();
    const awareness = client.getMap(Y_MAP_USER_AWARENESS);
    const observeSpy = vi.spyOn(awareness, "observe");
    const unobserveSpy = vi.spyOn(awareness, "unobserve");

    const view = render<typeof TandemModeHarness>(TandemModeHarness, {
      props: { doc: client, synced: true },
    });
    await waitFor(() => expect(modeOf(client)).toBe("solo"));

    for (const mode of ["tandem", "solo"] as const) {
      view.component.setMode(mode);
      await waitFor(() => expect(modeOf(client)).toBe(mode));
    }
    expect(observeSpy).toHaveBeenCalledTimes(1);
    expect(unobserveSpy).not.toHaveBeenCalled();

    // `synced: false` on the swap, matching production: `startBootstrap` sets
    // `ctrlInitialSyncComplete = false` BEFORE publishing the new doc, both
    // synchronously, so `(a fresh doc, synced: true)` is a pairing the app never
    // produces. The counts hold either way — the detector effect depends only on
    // the doc — but a spec that reaches a state the app cannot is one step from
    // a claim that only holds in the fixture.
    await view.rerender({ doc: new Y.Doc(), synced: false });
    await waitFor(() => expect(unobserveSpy).toHaveBeenCalledTimes(1));
    expect(observeSpy).toHaveBeenCalledTimes(1);
  });

  it("does not touch the ctrl map while the doc is still null", async () => {
    // The pre-bootstrap window, and the post-`bootstrapCleanup` one: `yjsSync`
    // publishes `bootstrapYdoc` as null before `startBootstrap` and again after
    // `ydoc.destroy()`. Without this spec the `!bootstrapYdoc` half of the
    // broadcast gate — and the detector's own null return — are covered by
    // nothing: deleting either leaves every other spec in this file green.
    //
    // The two gates fail differently, and each half is pinned by a different
    // observation. Deleting the BROADCAST gate reaches `.getMap()` on null and
    // the effect's own `catch` swallows it as a console warning — so `warnSpy`
    // staying clean is what covers it, and `lastBroadcast` is left holding the
    // previous generation's value for the detector to compare against. The
    // DETECTOR effect has no `catch`, so deleting its null return throws out of
    // the effect body and fails the render itself. Both were confirmed by
    // mutation rather than assumed.
    localStorage.setItem(TANDEM_MODE_KEY, "solo");
    const view = render(TandemModeHarness, {
      props: { doc: null, synced: true },
    });
    await waitFor(() => expect(view.getByTestId("mode").textContent).toBe("solo"));
    expect(warnSpy).not.toHaveBeenCalled();

    // And it starts working normally once a doc arrives, so the spec above is
    // pinning a quiet gate rather than a permanently dead hook.
    const client = new Y.Doc();
    await view.rerender({ doc: client, synced: false });
    await view.rerender({ doc: client, synced: true });
    await waitFor(() => expect(modeOf(client)).toBe("solo"));
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("#1623 the persisted last mode is the only preference", () => {
  // #1623 was filed as "Settings -> Collaboration `defaultMode` is stored,
  // validated, migrated, unit-tested and read by nothing". It was resolved by
  // DELETING the setting rather than wiring it up: the mode toggle already
  // persists to `localStorage`, so a second source for the same preference could
  // only ever disagree with the first. These specs pin what is left.
  it("restores the mode the user last chose", async () => {
    localStorage.setItem(TANDEM_MODE_KEY, "solo");
    const client = new Y.Doc();
    const view = render(TandemModeHarness, { props: { doc: client, synced: true } });
    await waitFor(() => expect(view.getByTestId("mode").textContent).toBe("solo"));
    expect(modeOf(client)).toBe("solo");
  });

  it("starts in the default mode when nothing has been chosen yet", async () => {
    const client = new Y.Doc();
    const view = render(TandemModeHarness, { props: { doc: client, synced: true } });
    await waitFor(() => expect(view.getByTestId("mode").textContent).toBe(TANDEM_MODE_DEFAULT));
  });

  it("writes the user's choice back so the next launch restores it", async () => {
    // The other half of the contract, and the half nothing else covers. Deleting
    // the `localStorage.setItem` in the persist effect leaves every other spec in
    // this file green — they SEED storage and never read it back — while the
    // user's toggle silently stops sticking across launches. Since #1623 removed
    // the Settings default-mode control, this write is the ONLY thing that
    // carries a mode from one session to the next.
    const client = new Y.Doc();
    const view = render(TandemModeHarness, { props: { doc: client, synced: true } });
    await waitFor(() => expect(modeOf(client)).toBe(TANDEM_MODE_DEFAULT));

    view.component.setMode("solo");
    await waitFor(() => expect(localStorage.getItem(TANDEM_MODE_KEY)).toBe("solo"));

    view.component.setMode("tandem");
    await waitFor(() => expect(localStorage.getItem(TANDEM_MODE_KEY)).toBe("tandem"));
  });

  it("falls back to the default when the stored value is corrupt", async () => {
    localStorage.setItem(TANDEM_MODE_KEY, "not-a-mode");
    const client = new Y.Doc();
    const view = render(TandemModeHarness, { props: { doc: client, synced: true } });
    await waitFor(() => expect(view.getByTestId("mode").textContent).toBe(TANDEM_MODE_DEFAULT));
  });

  it("falls back to the default when localStorage throws", async () => {
    // A storage-disabled browser is a supported case here (CLAUDE.md calls it
    // out), and the catch branch is the only path that survives it.
    //
    // The `warnSpy` assertion is the discriminating precondition, not decoration.
    // Asserting only the resulting mode passes whether or not the stub throws:
    // the no-stored-value path returns the same constant. Proving the throw
    // happened is what makes the green mean something.
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
      removeItem: () => {},
      clear: () => {},
    });

    const client = new Y.Doc();
    const view = render(TandemModeHarness, { props: { doc: client, synced: true } });
    await waitFor(() => expect(view.getByTestId("mode").textContent).toBe(TANDEM_MODE_DEFAULT));

    expect(
      warnSpy.mock.calls.some((c: unknown[]) =>
        String(c[0]).includes("localStorage unavailable reading"),
      ),
    ).toBe(true);
    expect(modeOf(client)).toBe(TANDEM_MODE_DEFAULT);
  });
});
