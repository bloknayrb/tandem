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

import { render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COWORK_PREFLIGHT_CHECKING } from "../../src/client/cowork/cowork-helpers";
import type { SubnetPreflight } from "../../src/client/cowork/cowork-invoke";
import { coworkStatusCell } from "../helpers/cowork-fixtures.svelte";

const toggleIntegration = vi.fn(async () => ({ ok: true as const }));
const fakeInvoke = vi.fn();

const preflightSubnet = vi.fn(async (): Promise<SubnetPreflight> => ({ status: "unknown" }));

// Spread `importOriginal` rather than re-declaring the module: `cowork-invoke`
// exports nine symbols and each suite's mock used to name a different subset,
// so a component reaching for an un-named one failed as `undefined is not a
// function` — a component-shaped error, discovered one file at a time.
vi.mock("../../src/client/cowork/cowork-invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/cowork/cowork-invoke")>()),
  loadInvoke: vi.fn(async () => fakeInvoke),
  coworkToggleIntegration: (...args: unknown[]) => toggleIntegration(...args),
  coworkPreflightSubnet: () => preflightSubnet(),
}));

// A REACTIVE status cell, not a frozen literal: `enabled` is what the surface
// renders, and a status the component cannot observe changing makes the
// post-enable checkbox untestable. See the helper for why a plain `let` is
// worse than useless here.
const refetch = vi.fn(async () => {});

/** What the Rust side does on success: the toggle commits, the refetch reports it. */
function enableSucceeds(): void {
  refetch.mockImplementation(async () => {
    coworkStatusCell.patch({ enabled: true });
  });
}

vi.mock("../../src/client/hooks/useCoworkStatus.svelte", () => ({
  createCoworkStatus: () => ({
    get status() {
      return coworkStatusCell.value;
    },
    loading: false,
    error: null,
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
  refetch.mockReset();
  refetch.mockImplementation(async () => {});
  preflightSubnet.mockClear();
  preflightSubnet.mockResolvedValue({ status: "unknown" });
});

afterEach(() => {
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
