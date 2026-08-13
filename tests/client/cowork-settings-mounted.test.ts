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
import type { SubnetPreflight } from "../../src/client/cowork/cowork-invoke";
import { coworkStatusCell } from "../helpers/cowork-fixtures.svelte";

const toggleIntegration = vi.fn(async () => ({ ok: true as const }));
const fakeInvoke = vi.fn();

const preflightSubnet = vi.fn(async (): Promise<SubnetPreflight> => ({ status: "unknown" }));

vi.mock("../../src/client/cowork/cowork-invoke", () => ({
  TAURI_NOT_AVAILABLE: "Tauri runtime not available",
  loadInvoke: vi.fn(async () => fakeInvoke),
  coworkToggleIntegration: (...args: unknown[]) => toggleIntegration(...args),
  coworkPreflightSubnet: () => preflightSubnet(),
  coworkRescan: vi.fn(async () => {}),
  coworkSetLanIpOverride: vi.fn(async () => {}),
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

function mount() {
  const { container } = render(CoworkSettings);
  const checkbox = q(container, "cowork-toggle-checkbox") as HTMLInputElement;
  return { container, checkbox };
}

describe("CoworkSettings — enable confirm wiring (#1375)", () => {
  beforeEach(() => {
    coworkStatusCell.reset();
    toggleIntegration.mockClear();
    fakeInvoke.mockClear();
    refetch.mockReset();
    refetch.mockImplementation(async () => {});
    preflightSubnet.mockClear();
    preflightSubnet.mockResolvedValue({ status: "unknown" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

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
    expect(preflightSubnet).toHaveBeenCalledTimes(1);
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

  it("re-checking after a cancel starts a second probe", async () => {
    // The raced path #1375 singles out: two overlapping probes on the surface
    // where a user can toggle faster than PowerShell answers. `reset()` bumps
    // the ticket, so only the newest may write — which is invisible unless a
    // test actually issues the second one.
    const { checkbox } = mount();
    await setChecked(checkbox, true);
    await setChecked(checkbox, false);
    await setChecked(checkbox, true);

    expect(preflightSubnet).toHaveBeenCalledTimes(2);
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
    await tick();

    expect(q(container, "cowork-preflight-blocked")?.textContent).toContain("no adapter");

    (q(container, "cowork-enable-cancel-btn") as HTMLButtonElement).click();
    await tick();

    preflightSubnet.mockImplementationOnce(() => new Promise(() => {}));
    await setChecked(checkbox, true);

    expect(q(container, "cowork-enable-confirm")).toBeTruthy();
    expect(q(container, "cowork-preflight-blocked")).toBeNull();
    expect(preflightSubnet).toHaveBeenCalledTimes(2);
  });
});

describe("CoworkSettings — pre-flight live region (#1376)", () => {
  beforeEach(() => {
    preflightSubnet.mockClear();
    preflightSubnet.mockResolvedValue({ status: "unknown" });
    toggleIntegration.mockClear();
  });

  it("mounts the region empty, before the text that has to be announced", async () => {
    // The whole of #1376: a live region inserted together with its content is
    // generally not announced. Region first and empty, content second.
    preflightSubnet.mockImplementationOnce(() => new Promise(() => {}));
    const { container, checkbox } = mount();
    await setChecked(checkbox, true);

    const region = q(container, "cowork-preflight-live");
    expect(region).toBeTruthy();
    expect(region?.getAttribute("role")).toBe("status");
    expect(q(container, "cowork-preflight-blocked")).toBeNull();
  });

  it("keeps the same region node across probing → blocked", async () => {
    preflightSubnet.mockResolvedValue({ status: "blocked", hint: "no adapter" });
    const { container, checkbox } = mount();
    await setChecked(checkbox, true);
    const before = q(container, "cowork-preflight-live");
    await tick();
    await tick();

    const after = q(container, "cowork-preflight-live");
    expect(after).toBe(before);
    expect(after?.textContent).toContain("no adapter");
  });

  it("announces the re-probe without dropping the hint it is re-checking", async () => {
    // `run()` deliberately keeps the previous result, so a retry has `probing`
    // and `blocked` set at once. Appending rather than swapping is what lets
    // the region change (so it is announced) while `-blocked` stays mounted for
    // the three suites that read it mid-probe.
    preflightSubnet.mockResolvedValue({ status: "blocked", hint: "no adapter" });
    const { container, checkbox } = mount();
    await setChecked(checkbox, true);
    await tick();
    await tick();

    preflightSubnet.mockImplementationOnce(() => new Promise(() => {}));
    (q(container, "cowork-preflight-retry-btn") as HTMLButtonElement).click();
    await tick();
    await tick();

    const region = q(container, "cowork-preflight-live");
    expect(region?.textContent).toContain("no adapter");
    expect(region?.textContent).toMatch(/Checking/);
  });
});
