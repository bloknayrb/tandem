// @vitest-environment happy-dom

/**
 * CoworkSettings, actually rendered (#1375).
 *
 * `tests/client/cowork-settings.test.ts` is a pure-function suite over
 * `cowork-helpers`; the file name hid the fact that the component itself had
 * never been mounted by anything. So four of the testids #1366 added existed
 * only in the snapshot, and the wiring around them — the checkbox handler, the
 * confirm reset, the enable path's own close — was covered by nothing.
 *
 * What this pins is the wiring, not the helpers. Each `it` below names a path
 * that a passing suite reached zero times before this file existed.
 *
 * `useCoworkStatus` MUST be mocked: `CoworkSettings` calls
 * `createCoworkStatus(() => true)` unconditionally at mount, and that hook holds
 * an `$effect` and a real invoke — an unmocked mount hits the network.
 */

import { cleanup, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COWORK_PREFLIGHT_CHECKING,
  COWORK_PREFLIGHT_FAILED,
} from "../../src/client/cowork/cowork-helpers";
import type { SubnetPreflight } from "../../src/client/cowork/cowork-invoke";
import { coworkErrorCell, coworkStatusCell } from "../helpers/cowork-fixtures.svelte";

const toggleIntegration = vi.fn(async () => ({ ok: true as const }));
const fakeInvoke = vi.fn();

const preflightSubnet = vi.fn(async (): Promise<SubnetPreflight> => ({ status: "unavailable" }));
const setLanIpOverride = vi.fn(async () => {});

// Spread `importOriginal` rather than re-declaring the module: `cowork-invoke`
// exports nine symbols and each suite's mock used to name a different subset,
// so a component reaching for an un-named one failed as `undefined is not a
// function` — a component-shaped error, discovered one file at a time.
vi.mock("../../src/client/cowork/cowork-invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/cowork/cowork-invoke")>()),
  loadInvoke: vi.fn(async () => fakeInvoke),
  coworkToggleIntegration: (...args: unknown[]) => toggleIntegration(...args),
  coworkPreflightSubnet: () => preflightSubnet(),
  coworkSetLanIpOverride: (...args: unknown[]) => setLanIpOverride(...args),
}));

/**
 * The re-read that follows every write.
 *
 * Resolves `true` — "a fresh status was stored". The real `refetch` reports its
 * failure that way rather than throwing, and the handlers gate their resync on
 * it, so a mock resolving `undefined` would silently send every test in this
 * file down the read-back-failed branch and skip the very resync they exist to
 * pin. It would still be green, which is why it is worth saying out loud.
 *
 * It mutates `coworkStatusCell` — a REACTIVE cell, not a frozen literal —
 * because `enabled` is what the surface renders, and a status the component
 * cannot observe changing makes the post-write checkbox untestable. See the
 * helper for why a plain `let` is worse than useless here.
 */
const refetch = vi.fn(async () => true);

/** What the Rust side does on success: the toggle commits, the refetch reports it. */
function enableSucceeds(): void {
  refetch.mockImplementation(async () => {
    coworkStatusCell.patch({ enabled: true });
    return true;
  });
}

/** The disable mirror of `enableSucceeds`. */
function disableSucceeds(): void {
  refetch.mockImplementation(async () => {
    coworkStatusCell.patch({ enabled: false });
    return true;
  });
}

/**
 * The write commits, but the read-back after it does not land.
 *
 * `refetch` swallows that into `coworkState.error` and resolves `false` rather
 * than throwing, so `status` keeps its PRE-write value while every other signal
 * says the operation succeeded.
 */
function readBackFails(): void {
  refetch.mockImplementation(async () => false);
}

vi.mock("../../src/client/hooks/useCoworkStatus.svelte", () => ({
  createCoworkStatus: () => ({
    get status() {
      return coworkStatusCell.value;
    },
    loading: false,
    get error() {
      return coworkErrorCell.value;
    },
    refetch,
  }),
}));

import CoworkSettings from "../../src/client/components/CoworkSettings.svelte";

function q(container: HTMLElement, testid: string): HTMLElement | null {
  return container.querySelector(`[data-testid='${testid}']`);
}

/** Tick the checkbox and dispatch the `change` the handler listens for. */
async function setChecked(box: HTMLInputElement, checked: boolean): Promise<void> {
  box.checked = checked;
  box.dispatchEvent(new Event("change", { bubbles: true }));
  await tick();
}

/**
 * Wait for the Nth probe to have been issued.
 *
 * `run()` defers `probing` one flush (#1376 rule 1 — the region has to reach
 * the a11y tree before its first line), so the probe is never in flight by the
 * end of the tick that opened the confirm. Counted ticks would encode that
 * offset as a constant; this stays true if the chain gains or loses a hop.
 */
async function probeCount(n: number): Promise<void> {
  // `interval: 5` because the predicate is a mock call count: it emits no DOM
  // mutation, so `waitFor`'s MutationObserver can never wake it and it falls
  // through to the poll timer. At the 50ms default that is one full interval
  // per call, measured at ~479ms across these suites.
  await waitFor(() => expect(preflightSubnet).toHaveBeenCalledTimes(n), { interval: 5 });
}

function mount() {
  const { container } = render(CoworkSettings);
  const checkbox = q(container, "cowork-toggle-checkbox") as HTMLInputElement;
  return { container, checkbox };
}

// FILE scope, not per-describe: `coworkStatusCell` is module state and
// `enableSucceeds()` installs a `refetch` that mutates it to `enabled: true`.
// Scoped to one describe, a sibling describe inherits whatever the previous
// one left — isolation by test ordering, which the next added test silently
// breaks.
beforeEach(() => {
  coworkStatusCell.reset();
  toggleIntegration.mockClear();
  toggleIntegration.mockImplementation(async () => ({ ok: true as const }));
  fakeInvoke.mockClear();
  coworkErrorCell.reset();
  refetch.mockReset();
  refetch.mockImplementation(async () => true);
  setLanIpOverride.mockClear();
  setLanIpOverride.mockImplementation(async () => {});
  preflightSubnet.mockClear();
  preflightSubnet.mockResolvedValue({ status: "unavailable" });
});

afterEach(() => {
  // Explicit: without `globals: true` Testing Library never registers its own
  // `afterEach`, so mounts would accumulate across this file — the other half
  // of the isolation argument the file-scoped `beforeEach` above makes.
  cleanup();
  vi.unstubAllGlobals();
});

describe("CoworkSettings — enable confirm wiring (#1375)", () => {
  it("renders the toggle without enabling or probing anything", async () => {
    const { container, checkbox } = mount();
    await tick();

    expect(q(container, "cowork-settings")).toBeTruthy();
    expect(checkbox).toBeTruthy();
    expect(checkbox.checked).toBe(false);
    expect(q(container, "cowork-enable-confirm")).toBeNull();
    expect(toggleIntegration).not.toHaveBeenCalled();
    // The probe costs a real PowerShell round-trip; it belongs to the confirm,
    // not to the mount of a settings tab the user may only be scrolling past.
    expect(preflightSubnet).not.toHaveBeenCalled();
  });

  it("checking the box opens the confirm and probes, without enabling", async () => {
    const { container, checkbox } = mount();
    await setChecked(checkbox, true);

    expect(q(container, "cowork-enable-confirm")).toBeTruthy();
    await probeCount(1);
    expect(toggleIntegration).not.toHaveBeenCalled();
  });

  it("un-checking while the confirm is open cancels instead of disabling", async () => {
    // The defect: the handler's `else` branch fired a real
    // `coworkToggleIntegration(invoke, false)` for a transition that had never
    // happened, and left the confirm — Enable button and all — standing behind
    // it. Nothing was enabled, so nothing was there to disable.
    const { container, checkbox } = mount();
    await setChecked(checkbox, true);
    await setChecked(checkbox, false);

    expect(toggleIntegration).not.toHaveBeenCalled();
    expect(q(container, "cowork-enable-confirm")).toBeNull();
  });

  it("the Cancel button un-checks the box, not just the banner", async () => {
    // The `|| confirming === "enable"` half of the `checked=` expression, which
    // was previously pinned by nothing: dropping it (or the whole attribute)
    // left every test here green, because `setChecked` writes `box.checked` by
    // hand and the suite never observed Svelte writing it. Driving Cancel from
    // the BUTTON is what makes the DOM write observable — Svelte skips the
    // write whenever the expression re-computes to its cached value, so with
    // `checked={s.enabled}` alone the box stays visually checked over a
    // disabled integration until the next status refetch.
    const { container, checkbox } = mount();
    await setChecked(checkbox, true);
    expect(q(container, "cowork-enable-confirm")).toBeTruthy();

    (q(container, "cowork-enable-cancel-btn") as HTMLButtonElement).click();
    await tick();

    expect(checkbox.checked).toBe(false);
    expect(toggleIntegration).not.toHaveBeenCalled();
  });

  it("a failed disable puts the box back, so the retry is reachable", async () => {
    // Measured trap this closes: `checked=` is one-way and Svelte caches the
    // last value it wrote, so a disable that throws left the box unchecked over
    // `enabled: true` with the line beneath it reading "yes" — and the next
    // click, seeing an unchecked box, opened the ENABLE confirm. There was no
    // gesture that reached `handleToggleOff` again short of a remount.
    coworkStatusCell.patch({ enabled: true });
    toggleIntegration.mockRejectedValueOnce(new Error("UAC declined"));
    const { container, checkbox } = mount();
    await tick();
    expect(checkbox.checked).toBe(true);

    await setChecked(checkbox, false);
    // `interval: 5`: a `checked` property assignment emits no mutation record,
    // so the observer never fires and this polls to the full default otherwise.
    await waitFor(() => expect(checkbox.checked).toBe(true), { interval: 5 });

    // Still on, still says so, and no confirm was opened by the failure.
    expect(q(container, "cowork-settings")?.textContent).toContain("Integration enabled: yes");
    expect(q(container, "cowork-enable-confirm")).toBeNull();
    expect(toggleIntegration).toHaveBeenCalledWith(fakeInvoke, false);
  });

  it("a disable that succeeds leaves the box off", async () => {
    // The mirror of the test above, and the one that makes the resync's ARGUMENT
    // matter rather than just its presence: with only the failure path covered,
    // `enabled` never moves, so `resyncCheckbox(box, true)` as a hard-coded
    // constant is indistinguishable from reading the model — and a constant
    // `true` would leave the box checked over an integration that just turned
    // off, which is precisely the defect `checkbox-sync.ts` exists to fix.
    coworkStatusCell.patch({ enabled: true });
    disableSucceeds();
    const { container, checkbox } = mount();
    await tick();
    expect(checkbox.checked).toBe(true);

    await setChecked(checkbox, false);

    // Wait on the MODEL's readout, not the box: `resyncCheckbox` writes
    // `checked` imperatively before Svelte's flush, so gating on the box alone
    // would let this proceed while the surface still said "yes".
    await waitFor(
      () =>
        expect(q(container, "cowork-settings")?.textContent).toContain("Integration enabled: no"),
      { interval: 5 },
    );
    expect(checkbox.checked).toBe(false);
  });

  it("a rejected disable that still committed re-reads instead of re-checking the box", async () => {
    // The disable arm rejects AFTER its meta write lands.
    // `cowork_toggle_integration` persists `enabled = false` (its `meta_persist`
    // write) and only then returns `Err` if every workspace failed to uninstall
    // — the mirror of #1437 itself (reject-but-actually-changed instead of
    // resolve-but-unchanged). With the read-back inside `withInvoke`'s callback
    // the throw skipped it, the sentinel stayed `true`, and the resync painted
    // the stale `enabled: true` straight back over a box the user had just
    // unchecked over an integration that really was off — next to a line
    // reading "Integration enabled: yes". Re-reading unconditionally is what
    // makes the paint follow the truth rather than which way the promise
    // settled.
    coworkStatusCell.patch({ enabled: true });
    toggleIntegration.mockRejectedValueOnce(
      new Error("Cowork disable failed: all 2 workspace(s) failed to uninstall"),
    );
    // What the rejected command left on disk: the write DID land.
    refetch.mockImplementationOnce(async () => {
      coworkStatusCell.patch({ enabled: false });
      return true;
    });
    const { container, checkbox } = mount();
    await tick();
    expect(checkbox.checked).toBe(true);

    await setChecked(checkbox, false);

    // Wait on the mock CALL COUNT, not on the box: `setChecked` already wrote
    // `checked` by hand, and a mock call emits no DOM mutation for `waitFor`'s
    // observer to wake on. Before the fix this timed out at 0 calls, because
    // the throw skipped the read-back entirely.
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1), { interval: 5 });
    await waitFor(
      () =>
        expect(q(container, "cowork-settings")?.textContent).toContain("Integration enabled: no"),
      { interval: 5 },
    );
    // The box must agree with that readout. Before the fix the resync fired
    // with the STALE `enabled: true` and re-checked it here.
    expect(checkbox.checked).toBe(false);
    expect(toggleIntegration).toHaveBeenCalledWith(fakeInvoke, false);
  });

  it("a disable whose read-back fails leaves the box off and says why", async () => {
    // The write landed; only the re-read did not. `status` therefore still says
    // `enabled: true`, and resyncing from it would visibly RE-CHECK the box over
    // an integration that is now off — the resync making the UI more wrong than
    // no resync at all. So the resync is gated on the read-back, and the failure
    // gets a banner instead of the silence it used to get.
    coworkStatusCell.patch({ enabled: true });
    readBackFails();
    const { checkbox } = mount();
    await tick();
    expect(checkbox.checked).toBe(true);

    await setChecked(checkbox, false);
    // `disabled={busy}` is the handler's own end-marker, and waiting on it is
    // what makes this test non-vacuous: waiting on `toggleIntegration` instead
    // resolves while `refetch` and the resync are still pending, so the
    // assertion below would read the user's click position and pass no matter
    // what the handler went on to do. Both edges, so a missed flush cannot make
    // the second wait return immediately.
    await waitFor(() => expect(checkbox.disabled).toBe(true), { interval: 5 });
    await waitFor(() => expect(checkbox.disabled).toBe(false), { interval: 5 });

    expect(toggleIntegration).toHaveBeenCalledWith(fakeInvoke, false);
    expect(checkbox.checked).toBe(false);
  });

  it("surfaces a re-read failure that happens after the first load", async () => {
    // The banner used to be gated on `!coworkState.status`, which is false for
    // every failure a user of the toggle can cause — the toggle only exists once
    // a status has loaded. So the one error state reachable from this surface
    // was the one the banner could not show.
    coworkStatusCell.patch({ enabled: true });
    refetch.mockImplementation(async () => {
      coworkErrorCell.set("bridge unavailable");
      return false;
    });
    const { container, checkbox } = mount();
    await tick();

    await setChecked(checkbox, false);

    const banner = await waitFor(
      () => {
        const el = q(container, "cowork-settings-error");
        expect(el).toBeTruthy();
        return el as HTMLElement;
      },
      { interval: 5 },
    );
    expect(banner.textContent).toContain("bridge unavailable");
    // Phrased for a refresh, not a cold load — the status on screen is real,
    // just stale.
    expect(banner.textContent).toContain("refresh");
  });

  it("the LAN-IP override row resyncs its own box", async () => {
    // This row is behind `{#if s.lanIpFallback !== null}` and every fixture
    // leaves that null, so `handleToggleLanIp` had never executed under a mount
    // at all — deleting its resync left the whole suite green. It carries the
    // same hazard as the Enable toggle with none of the cover: no confirm
    // banner, no "enabled: yes/no" line, so the box IS the readout.
    coworkStatusCell.patch({ lanIpFallback: "192.168.1.100", useLanIpOverride: false });
    const { container } = mount();
    await tick();

    const lanBox = q(container, "cowork-lan-ip-override-checkbox") as HTMLInputElement;
    expect(lanBox).toBeTruthy();
    expect(lanBox.checked).toBe(false);

    // The write fails, so `useLanIpOverride` stays false and the expression
    // re-computes to the value Svelte last wrote — the skipped-write trap.
    setLanIpOverride.mockRejectedValueOnce(new Error("bridge gone"));
    lanBox.checked = true;
    lanBox.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(() => expect(lanBox.checked).toBe(false), { interval: 5 });
  });

  it("a rejected LAN-IP write still re-reads, and snaps the box back to the real value", async () => {
    // #1437 review, Minor 7: `cowork_set_lan_ip_override`'s own meta write is
    // fail-closed, but the command can still reject AFTER that write landed
    // (its follow-on workspace re-walk can fail on its own) — the mirror
    // image of #1437 itself (reject-but-actually-changed instead of
    // resolve-but-unchanged). Either way the only safe move is to re-read, so
    // `refetch()` must run even though the invoke threw.
    //
    // Run it in the direction where the manual set and the real value
    // DISAGREE. The user UNCHECKS a box whose model says `true`; the write
    // rejects; the re-read reports the unchanged `true`. The final assertion
    // is then reachable ONLY through `resyncCheckbox` — seeding and asserting
    // the same value would pass whether the resync ran, was deleted, or never
    // fired, because the `checked={lanIpOverrideChecked}` binding would paint
    // it anyway.
    coworkStatusCell.patch({ lanIpFallback: "192.168.1.100", useLanIpOverride: true });
    const { container } = mount();
    await tick();

    const lanBox = q(container, "cowork-lan-ip-override-checkbox") as HTMLInputElement;
    expect(lanBox.checked).toBe(true);

    setLanIpOverride.mockRejectedValueOnce(new Error("re-walk failed: all workspace(s) failed"));
    lanBox.checked = false;
    lanBox.dispatchEvent(new Event("change", { bubbles: true }));

    // Wait on the mock CALL COUNT first, not on `lanBox.checked`: the line
    // above already set the box by hand (simulating the browser's own
    // pre-`change` write, same as `setChecked()` above), and a mock call count
    // emits no DOM mutation, so `waitFor`'s MutationObserver can never wake on
    // it — exactly the vacuous-wait trap `probeCount()` above avoids. Before
    // the fix, `refetch()` lived INSIDE the `withInvoke` callback, so the
    // thrown write skipped it entirely and this would time out at 0 calls.
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1), { interval: 5 });
    // Then wait on the box itself rather than asserting it synchronously here.
    // The resync runs after the read-back resolves, but not necessarily in the
    // same microtask — `readBackStatus()` is its own `async` hop — and a
    // synchronous assert encodes "exactly zero intervening ticks" as a
    // constant that any refactor of the read-back breaks. It stays
    // non-vacuous: the line above set the box to `false` by hand, so `true`
    // here is reachable only through the resync.
    await waitFor(() => expect(lanBox.checked).toBe(true), { interval: 5 });
  });

  it("a LAN-IP write that never landed snaps the box back even when the re-read also fails", async () => {
    // The `!wrote` term in `handleToggleLanIp`'s resync gate. One
    // corrupt `cowork-meta.json` rejects BOTH `cowork_set_lan_ip_override`
    // (via `cowork_meta::load`) and `cowork_get_status` (its own
    // `cowork_meta::load`), so the write never lands AND the re-read fails.
    // Nothing changed, so the stored status is still accurate and the box must
    // snap back to it. Gating the resync on `readBack` alone leaves the box
    // showing an override that is off — and it never heals, because
    // `useLanIpOverride` did not change, so the `checked={lanIpOverrideChecked}`
    // binding recomputes to the value Svelte last wrote and `set_checked`
    // returns before touching the DOM (see `src/client/utils/checkbox-sync.ts`).
    coworkStatusCell.patch({ lanIpFallback: "192.168.1.100", useLanIpOverride: true });
    const { container } = mount();
    await tick();

    const lanBox = q(container, "cowork-lan-ip-override-checkbox") as HTMLInputElement;
    expect(lanBox.checked).toBe(true);

    setLanIpOverride.mockRejectedValueOnce(new Error("failed to read cowork-meta.json"));
    // `refetch()` swallows its own failure and reports it by returning false.
    refetch.mockImplementationOnce(async () => false);
    lanBox.checked = false;
    lanBox.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1), { interval: 5 });
    // Only reachable via the resync: the model still says `true`, the user's
    // click said `false`, and the re-read told us nothing. Waited on rather
    // than asserted synchronously, for the reason given in the test above —
    // dropping the `!wrote` term still reddens it, it just takes the poll
    // timeout to do so.
    await waitFor(() => expect(lanBox.checked).toBe(true), { interval: 5 });
  });

  it("checking an already-enabled box re-asserts it instead of offering Enable", async () => {
    // The other exit from that desync. Clicking a box whose model is already
    // `true` must not open a confirm whose Enable button fires a UAC prompt and
    // a firewall write for the state the user is in.
    coworkStatusCell.patch({ enabled: true });
    const { container, checkbox } = mount();
    await tick();

    await setChecked(checkbox, true);

    expect(checkbox.checked).toBe(true);
    expect(q(container, "cowork-enable-confirm")).toBeNull();
    expect(preflightSubnet).not.toHaveBeenCalled();
    expect(toggleIntegration).not.toHaveBeenCalled();
  });

  it("re-checking after a cancel starts a second probe", async () => {
    // The raced path #1375 singles out: two OVERLAPPING probes on the surface
    // where a user can toggle faster than PowerShell answers. `reset()` bumps
    // the ticket, so only the newest may write.
    //
    // The first probe must never settle, or this degenerates into two
    // sequential probes and exercises no supersession at all — the default mock
    // resolves immediately, so probe 1 would already be done before probe 2
    // started.
    let releaseFirst: ((v: SubnetPreflight) => void) | undefined;
    preflightSubnet.mockImplementationOnce(
      () =>
        new Promise<SubnetPreflight>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const { container, checkbox } = mount();
    await setChecked(checkbox, true);
    await probeCount(1);

    await setChecked(checkbox, false);
    await setChecked(checkbox, true);
    await probeCount(2);

    // Probe 1 lands late, after its ticket was superseded twice. Its result
    // must not paint: the user is looking at the second probe's surface.
    releaseFirst?.({ status: "blocked", hint: "stale adapter" });
    await waitFor(() => {
      expect(q(container, "cowork-enable-confirm")).toBeTruthy();
    });
    expect(q(container, "cowork-preflight-blocked")).toBeNull();
    expect(toggleIntegration).not.toHaveBeenCalled();
  });

  it("Enable fires the toggle, closes the confirm, and leaves the box checked", async () => {
    // `closeEnableConfirm()` on SUCCESS is the reset #1366 made load-bearing:
    // `run()` no longer clears `preflight`, so a path that leaves the confirm
    // without resetting leaves a stale hint waiting for the next open.
    const { container, checkbox } = mount();
    await setChecked(checkbox, true);

    enableSucceeds();
    (q(container, "cowork-enable-confirm-btn") as HTMLButtonElement).click();
    // `waitFor`, not a tick count: `withInvoke` awaits `loadInvoke` → the toggle
    // → `refetch`, and a hand-counted number of flushes is a constant nobody
    // can re-derive when the chain gains a hop.
    await waitFor(() => {
      expect(q(container, "cowork-enable-confirm")).toBeNull();
    });

    expect(toggleIntegration).toHaveBeenCalledTimes(1);
    expect(toggleIntegration).toHaveBeenCalledWith(fakeInvoke, true);
    expect(refetch).toHaveBeenCalledTimes(1);
    // The box must still read checked, now because the integration IS enabled
    // rather than because a confirm is open. With a frozen `enabled: false`
    // fixture it would silently un-check here and nothing would notice.
    expect(checkbox.checked).toBe(true);
  });

  it("an enable whose read-back fails leaves the box checked and the confirm open", async () => {
    // The mirror of "a disable whose read-back fails leaves the box off and
    // says why", in the more security-relevant direction: the write landed
    // (Cowork IS enabled), only the re-read did not, so `status.enabled` is
    // still stale at `false`. Closing the confirm unconditionally would drop
    // the only `true` term left in `enableBoxChecked` and visibly UNCHECK a
    // box over an integration that is actually on. Leaving the confirm open
    // is the accurate reflection: nothing here is confidently wrong.
    const { container, checkbox } = mount();
    await setChecked(checkbox, true);

    readBackFails();
    (q(container, "cowork-enable-confirm-btn") as HTMLButtonElement).click();
    // Both edges, as in the disable read-back-fail test above: waiting only on
    // `disabled === false` risks reading before the click's async chain even
    // starts, which would pass this test no matter what the handler does.
    await waitFor(() => expect(checkbox.disabled).toBe(true), { interval: 5 });
    await waitFor(() => expect(checkbox.disabled).toBe(false), { interval: 5 });

    expect(toggleIntegration).toHaveBeenCalledWith(fakeInvoke, true);
    expect(refetch).toHaveBeenCalledTimes(1);
    // Confirm still open: closing it is exactly what a fresh read-back gates.
    expect(q(container, "cowork-enable-confirm")).not.toBeNull();
    // Box still checked via `confirming === "enable"`, not via `status.enabled`
    // (which a frozen `enabled: false` fixture would leave stale) — accurate.
    expect(checkbox.checked).toBe(true);
  });

  it("a failed enable leaves the confirm closed and the box unchecked, and says why", async () => {
    // The mirror of "a failed disable puts the box back" (earlier in this
    // describe block), which was the only thrown-invoke case covered for
    // either direction until now. This is not
    // new behaviour — `handleToggleOn` already handles a thrown toggle
    // correctly (see its comment: `readBack` stays at its initial `true` on a
    // throw, so the confirm still closes and `enableBoxChecked` falls back to
    // the accurate, unchanged status) — it's regression coverage for a real
    // pre-existing gap this investigation surfaced, not proof of the #1437
    // fix itself. This test already passes on unmodified `CoworkSettings.svelte`;
    // the load-bearing test for #1437 is the Rust one
    // (`enable_persist_outcome_tests` in `src-tauri/src/lib.rs`), since the
    // fix is that a partial-commit enable now REJECTS instead of resolving,
    // and this file mocks `coworkToggleIntegration` — it cannot observe that
    // Rust-side change either way.
    const { container, checkbox } = mount();
    await setChecked(checkbox, true);

    toggleIntegration.mockRejectedValueOnce(new Error("disk full"));
    (q(container, "cowork-enable-confirm-btn") as HTMLButtonElement).click();
    // `waitFor` on the confirm's own removal — same pattern as "Enable fires
    // the toggle, closes the confirm..." above — not the disabled-then-
    // enabled dance the read-back-fail tests use. `busy` (and so `disabled`)
    // flips back to `false` inside `withInvoke`'s `finally`, ONE microtask
    // before `closeEnableConfirm()` runs back in `handleToggleOn` — so
    // waiting on both edges of `disabled` and then synchronously asserting
    // the confirm is gone races that extra hop and can read the DOM before
    // Svelte has flushed the removal. Waiting on the removal directly can't
    // race itself.
    await waitFor(() => {
      expect(q(container, "cowork-enable-confirm")).toBeNull();
    });

    expect(toggleIntegration).toHaveBeenCalledWith(fakeInvoke, true);
    expect(checkbox.checked).toBe(false);
    expect(q(container, "cowork-inline-toast")?.textContent).toContain("Failed to enable Cowork");
  });

  it("Cancel clears the blocked hint, so a re-open does not paint a stale one", async () => {
    // `reset()` has no observable handle — `probe` is component-local. So this
    // asserts through the DOM instead: blocked hint, Cancel, re-open with a
    // probe that never settles, and the hint must already be gone. Written as
    // "assert reset() was called" it would need a spy that cannot exist.
    preflightSubnet.mockResolvedValue({ status: "blocked", hint: "no adapter" });
    const { container, checkbox } = mount();
    await setChecked(checkbox, true);
    await waitFor(() => {
      expect(q(container, "cowork-preflight-blocked")?.textContent ?? "").toContain("no adapter");
    });

    (q(container, "cowork-enable-cancel-btn") as HTMLButtonElement).click();
    await tick();

    preflightSubnet.mockImplementationOnce(() => new Promise(() => {}));
    await setChecked(checkbox, true);
    await probeCount(2);

    expect(q(container, "cowork-enable-confirm")).toBeTruthy();
    expect(q(container, "cowork-preflight-blocked")).toBeNull();
  });
});

describe("CoworkSettings — pre-flight live region (#1376)", () => {
  it("mounts the region empty, before the text that has to be announced", async () => {
    // The whole of #1376: a live region inserted together with its content is
    // generally not announced. Region first and EMPTY, content second — and
    // the emptiness is the half that was asserted by nothing. The in-flight
    // line is the first text to arrive, so a `probing` that flips in the tick
    // that mounts the region puts this right back; `run()` defers it one flush
    // for exactly this reason.
    preflightSubnet.mockImplementationOnce(() => new Promise(() => {}));
    const { container, checkbox } = mount();
    await setChecked(checkbox, true);

    const region = q(container, "cowork-preflight-live");
    expect(region).toBeTruthy();
    expect(region?.getAttribute("role")).toBe("status");
    expect(region?.textContent?.trim()).toBe("");
    expect(q(container, "cowork-preflight-blocked")).toBeNull();

    // …and the same node then fills, rather than being replaced by one that
    // arrives already populated.
    await waitFor(() => {
      expect(region?.textContent ?? "").toContain(COWORK_PREFLIGHT_CHECKING);
    });
    expect(q(container, "cowork-preflight-live")).toBe(region);
  });

  it("keeps the same region node across probing → blocked", async () => {
    preflightSubnet.mockResolvedValue({ status: "blocked", hint: "no adapter" });
    const { container, checkbox } = mount();
    await setChecked(checkbox, true);
    // Captured BEFORE the hint arrives — that is what makes the identity
    // assertion real. A wrapper living inside `{#if blocked}` gives `before ===
    // null` here and fails, which is the shape #1376 is about.
    const before = q(container, "cowork-preflight-live");
    expect(before).toBeTruthy();

    await waitFor(() => {
      expect(q(container, "cowork-preflight-live")?.textContent ?? "").toContain("no adapter");
    });
    expect(q(container, "cowork-preflight-live")).toBe(before);
  });

  it("lands the broken-probe line in the region that is already mounted (#1436)", async () => {
    // The bug this issue names: `role="status"` announces added and changed
    // text, but EMPTYING a region announces nothing. Before the split, a probe
    // that could not run rendered nothing, so the sequence a screen reader got
    // was the in-flight line followed by permanent silence. Captured before
    // the line arrives, so this fails if the copy is ever moved into a wrapper
    // that mounts with it.
    preflightSubnet.mockResolvedValue({ status: "failed" });
    const { container, checkbox } = mount();
    await setChecked(checkbox, true);
    const before = q(container, "cowork-preflight-live");
    expect(before).toBeTruthy();

    await waitFor(() => {
      expect(q(container, "cowork-preflight-failed")?.textContent ?? "").toContain(
        COWORK_PREFLIGHT_FAILED,
      );
    });
    expect(q(container, "cowork-preflight-live")).toBe(before);
    expect(q(container, "cowork-preflight-live")?.textContent ?? "").toContain(
      COWORK_PREFLIGHT_FAILED,
    );
  });

  it("keeps Enable — a check that did not run is not a check that failed", async () => {
    // `blocked` swaps Enable for "Check again" because we watched detection
    // fail and know the outcome. `failed` knows nothing, so taking Enable away
    // would block a user whose Cowork setup is fine on the strength of our own
    // bug. The two must not share a branch.
    preflightSubnet.mockResolvedValue({ status: "failed" });
    const { container, checkbox } = mount();
    await setChecked(checkbox, true);
    await waitFor(() => {
      expect(q(container, "cowork-preflight-failed")).toBeTruthy();
    });

    expect(q(container, "cowork-preflight-retry-btn")).toBeNull();
    const enable = q(container, "cowork-enable-confirm-btn") as HTMLButtonElement;
    expect(enable).toBeTruthy();
    expect(enable.disabled).toBe(false);
    // Muted help text, never `cs-preflight` — that class is the warning-token
    // banner the `blocked` hint wears, and wearing it here would say "this will
    // fail" about something we did not observe.
    expect(q(container, "cowork-preflight-failed")?.className ?? "").not.toContain("cs-preflight");
  });

  it("renders nothing at all when the probe was never available", async () => {
    // The other half of the split. `unavailable` is every non-Windows and
    // non-Tauri session — the overwhelmingly common case — and it has no news,
    // so a hedged line there would be permanent noise for people whose network
    // was never going to be probed. Only the region and its in-flight line.
    preflightSubnet.mockResolvedValue({ status: "unavailable" });
    const { container, checkbox } = mount();
    await setChecked(checkbox, true);
    await probeCount(1);
    await waitFor(() => {
      expect(q(container, "cowork-preflight-live")?.textContent ?? "").not.toContain(
        COWORK_PREFLIGHT_CHECKING,
      );
    });

    expect(q(container, "cowork-preflight-failed")).toBeNull();
    expect(q(container, "cowork-preflight-blocked")).toBeNull();
    expect(q(container, "cowork-preflight-live")?.textContent?.trim()).toBe("");
    expect(q(container, "cowork-enable-confirm-btn")).toBeTruthy();
  });

  it("announces the re-probe without dropping the hint it is re-checking", async () => {
    // `run()` deliberately keeps the previous result, so a retry has `probing`
    // and `blocked` set at once. Appending rather than swapping is what lets
    // the region change (so it is announced) while `-blocked` stays mounted —
    // swapping to `{:else if}` would unmount the hint the retry is re-checking,
    // under a pointer that is on the retry button.
    preflightSubnet.mockResolvedValue({ status: "blocked", hint: "no adapter" });
    const { container, checkbox } = mount();
    await setChecked(checkbox, true);
    await waitFor(() => {
      expect(q(container, "cowork-preflight-retry-btn")).toBeTruthy();
    });

    preflightSubnet.mockImplementationOnce(() => new Promise(() => {}));
    (q(container, "cowork-preflight-retry-btn") as HTMLButtonElement).click();
    await probeCount(2);

    await waitFor(() => {
      expect(q(container, "cowork-preflight-live")?.textContent ?? "").toContain(
        COWORK_PREFLIGHT_CHECKING,
      );
    });
    expect(q(container, "cowork-preflight-live")?.textContent ?? "").toContain("no adapter");
  });
});
