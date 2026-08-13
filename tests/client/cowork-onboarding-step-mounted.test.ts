// @vitest-environment happy-dom

/**
 * CoworkOnboardingStep, actually rendered (#1375).
 *
 * Like its Settings sibling, this component had no mounted coverage at all —
 * `tests/client/cowork-onboarding.test.ts` exercises `cowork-helpers` and never
 * renders anything. The property that most needed a test is the one a passing
 * suite would not have noticed losing: the step probes on CONFIRM, not on mount,
 * and moving the probe to `onMount` passes every other test in the repo.
 *
 * That ordering is a deliberate cost decision with a comment explaining it — the
 * step mounts for every user with Cowork detected-but-off, including everyone
 * who will hit Skip. The wizard suite pins the analogous property for itself;
 * this file gives the other surface the same guard.
 */

import { render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COWORK_PREFLIGHT_CHECKING } from "../../src/client/cowork/cowork-helpers";
import type { SubnetPreflight } from "../../src/client/cowork/cowork-invoke";
import { coworkStatusFixture } from "../helpers/cowork-fixtures.svelte";

const toggleIntegration = vi.fn(async () => ({ ok: true as const }));
const fakeInvoke = vi.fn();

const preflightSubnet = vi.fn(async (): Promise<SubnetPreflight> => ({ status: "unknown" }));

vi.mock("../../src/client/cowork/cowork-invoke", () => ({
  TAURI_NOT_AVAILABLE: "Tauri runtime not available",
  loadInvoke: vi.fn(async () => fakeInvoke),
  coworkToggleIntegration: (...args: unknown[]) => toggleIntegration(...args),
  coworkPreflightSubnet: () => preflightSubnet(),
}));

import CoworkOnboardingStep from "../../src/client/components/CoworkOnboardingStep.svelte";

// A prop, not a hook: this component takes its status from the parent, so the
// plain fixture is enough — nothing here observes it changing.
const STATUS = coworkStatusFixture();

function q(container: HTMLElement, testid: string): HTMLElement | null {
  return container.querySelector(`[data-testid='${testid}']`);
}

function mount() {
  const onAdvance = vi.fn();
  const { container } = render(CoworkOnboardingStep, {
    props: { status: STATUS, onAdvance },
  });
  return { container, onAdvance };
}

/** Click Enable, opening the confirm and starting the probe. */
async function openConfirm(container: HTMLElement): Promise<void> {
  (q(container, "cowork-onboarding-enable-btn") as HTMLButtonElement).click();
  await tick();
}

/**
 * Wait for the Nth probe to have been issued.
 *
 * `run()` defers `probing` one flush (#1376 rule 1 — the region must reach the
 * a11y tree before its first line), so the probe is not in flight by the end of
 * the tick that opened the confirm.
 */
async function probeCount(n: number): Promise<void> {
  await waitFor(() => {
    expect(preflightSubnet).toHaveBeenCalledTimes(n);
  });
}

// File scope so both describes get it — a per-describe reset is isolation by
// test ordering, which the next added test silently breaks.
beforeEach(() => {
  toggleIntegration.mockClear();
  toggleIntegration.mockImplementation(async () => ({ ok: true as const }));
  fakeInvoke.mockClear();
  preflightSubnet.mockClear();
  preflightSubnet.mockResolvedValue({ status: "unknown" });
});

describe("CoworkOnboardingStep — confirm wiring (#1375)", () => {
  it("does not probe on mount — the step renders for everyone who will Skip", async () => {
    const { container } = mount();
    await tick();

    expect(q(container, "cowork-onboarding-step")).toBeTruthy();
    expect(preflightSubnet).not.toHaveBeenCalled();
    expect(toggleIntegration).not.toHaveBeenCalled();
  });

  it("Skip advances without probing or enabling", async () => {
    const { container, onAdvance } = mount();
    (q(container, "cowork-onboarding-skip-btn") as HTMLButtonElement).click();
    await tick();

    expect(onAdvance).toHaveBeenCalledTimes(1);
    expect(preflightSubnet).not.toHaveBeenCalled();
    expect(toggleIntegration).not.toHaveBeenCalled();
  });

  it("Enable opens the confirm and probes, without enabling", async () => {
    const { container } = mount();
    await openConfirm(container);

    expect(q(container, "cowork-onboarding-confirm")).toBeTruthy();
    await probeCount(1);
    expect(toggleIntegration).not.toHaveBeenCalled();
  });

  it("the confirm's Enable is the sole trigger, and it advances", async () => {
    const { container, onAdvance } = mount();
    await openConfirm(container);

    (q(container, "cowork-onboarding-enable-confirm-btn") as HTMLButtonElement).click();
    // `waitFor`, not a tick count: the advance is several promise hops past the
    // click, and a hand-counted number is a constant nobody can re-derive.
    await waitFor(() => {
      expect(onAdvance).toHaveBeenCalledTimes(1);
    });

    expect(toggleIntegration).toHaveBeenCalledTimes(1);
    expect(toggleIntegration).toHaveBeenCalledWith(fakeInvoke, true);
    // The success path must close the confirm too — deleting `closeConfirm()`
    // and leaving `onAdvance()` used to pass every test in this file. The step
    // can be returned to, so a confirm left open comes back with it.
    expect(q(container, "cowork-onboarding-confirm")).toBeNull();
  });

  it("a successful enable supersedes the probe still in flight", async () => {
    // The success path's own `reset()`. It cannot be proved the way Cancel's is
    // — a blocked hint REPLACES the confirm's Enable button with a retry, so
    // there is no state where a hint is on screen and Enable is clickable.
    // What is reachable is the race: enable while the probe is still running,
    // then let it answer `blocked` afterwards. Without `reset()`'s ticket bump
    // that late result paints a firewall hint over a step the user has left.
    let release: ((v: SubnetPreflight) => void) | undefined;
    preflightSubnet.mockImplementationOnce(
      () =>
        new Promise<SubnetPreflight>((resolve) => {
          release = resolve;
        }),
    );
    const { container, onAdvance } = mount();
    await openConfirm(container);
    await probeCount(1);

    (q(container, "cowork-onboarding-enable-confirm-btn") as HTMLButtonElement).click();
    await waitFor(() => {
      expect(onAdvance).toHaveBeenCalledTimes(1);
    });

    release?.({ status: "blocked", hint: "no adapter" });
    await tick();
    await tick();

    expect(q(container, "cowork-onboarding-preflight-blocked")).toBeNull();
    expect(q(container, "cowork-onboarding-confirm")).toBeNull();
  });

  it("Cancel clears the blocked hint, so a re-open does not paint a stale one", async () => {
    // Asserted through the DOM because `reset()` has no observable handle:
    // blocked hint, Cancel, re-open against a probe that never settles, and the
    // hint must already be gone. The second probe proves the re-open is real.
    preflightSubnet.mockResolvedValue({ status: "blocked", hint: "no adapter" });
    const { container } = mount();
    await openConfirm(container);
    await waitFor(() => {
      expect(q(container, "cowork-onboarding-preflight-blocked")?.textContent ?? "").toContain(
        "no adapter",
      );
    });

    (q(container, "cowork-onboarding-enable-cancel-btn") as HTMLButtonElement).click();
    await tick();
    expect(q(container, "cowork-onboarding-confirm")).toBeNull();

    preflightSubnet.mockImplementationOnce(() => new Promise(() => {}));
    await openConfirm(container);
    await probeCount(2);

    expect(q(container, "cowork-onboarding-confirm")).toBeTruthy();
    expect(q(container, "cowork-onboarding-preflight-blocked")).toBeNull();
  });

  it("a failed enable keeps the confirm open and says why", async () => {
    toggleIntegration.mockRejectedValueOnce(new Error("firewall write refused"));
    const { container, onAdvance } = mount();
    await openConfirm(container);

    (q(container, "cowork-onboarding-enable-confirm-btn") as HTMLButtonElement).click();
    await waitFor(() => {
      expect(q(container, "cowork-onboarding-error")).toBeTruthy();
    });

    expect(onAdvance).not.toHaveBeenCalled();
    expect(q(container, "cowork-onboarding-error")?.textContent).toContain(
      "firewall write refused",
    );
    expect(q(container, "cowork-onboarding-confirm")).toBeTruthy();
  });
});

describe("CoworkOnboardingStep — pre-flight live region (#1376)", () => {
  it("mounts the region empty, before the text that has to be announced", async () => {
    preflightSubnet.mockImplementationOnce(() => new Promise(() => {}));
    const { container } = mount();
    await openConfirm(container);

    const region = q(container, "cowork-onboarding-preflight-live");
    expect(region).toBeTruthy();
    expect(region?.getAttribute("role")).toBe("status");
    // Empty is the half that matters and the half nothing asserted: the
    // in-flight line is the FIRST text to arrive here, so a region that mounts
    // already holding it is announced by nothing.
    expect(region?.textContent?.trim()).toBe("");
    expect(q(container, "cowork-onboarding-preflight-blocked")).toBeNull();
  });

  it("announces the in-flight line into the region it already mounted", async () => {
    // The `{#if probe.probing}` child on this surface was covered by nothing —
    // deleting it outright left the file green. It is also the one line that
    // proves the region fills rather than being replaced.
    preflightSubnet.mockImplementationOnce(() => new Promise(() => {}));
    const { container } = mount();
    await openConfirm(container);
    const region = q(container, "cowork-onboarding-preflight-live");

    await waitFor(() => {
      expect(region?.textContent ?? "").toContain(COWORK_PREFLIGHT_CHECKING);
    });
    expect(q(container, "cowork-onboarding-preflight-live")).toBe(region);
  });

  it("keeps the same region node across probing → blocked", async () => {
    preflightSubnet.mockResolvedValue({ status: "blocked", hint: "no adapter" });
    const { container } = mount();
    await openConfirm(container);
    const before = q(container, "cowork-onboarding-preflight-live");
    expect(before).toBeTruthy();

    await waitFor(() => {
      expect(q(container, "cowork-onboarding-preflight-live")?.textContent ?? "").toContain(
        "no adapter",
      );
    });
    expect(q(container, "cowork-onboarding-preflight-live")).toBe(before);
  });

  it("keeps the hint mounted while re-checking it", async () => {
    // Additive, not `{:else if}` — pinned on Settings but not here, so swapping
    // this surface's second `{#if}` was a silent change. The hint the retry is
    // re-checking must not vanish under the pointer that clicked retry.
    preflightSubnet.mockResolvedValue({ status: "blocked", hint: "no adapter" });
    const { container } = mount();
    await openConfirm(container);
    await waitFor(() => {
      expect(q(container, "cowork-onboarding-preflight-retry-btn")).toBeTruthy();
    });

    preflightSubnet.mockImplementationOnce(() => new Promise(() => {}));
    (q(container, "cowork-onboarding-preflight-retry-btn") as HTMLButtonElement).click();
    await probeCount(2);

    await waitFor(() => {
      expect(q(container, "cowork-onboarding-preflight-live")?.textContent ?? "").toContain(
        COWORK_PREFLIGHT_CHECKING,
      );
    });
    expect(q(container, "cowork-onboarding-preflight-live")?.textContent ?? "").toContain(
      "no adapter",
    );
  });
});
