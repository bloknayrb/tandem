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

describe("CoworkOnboardingStep — confirm wiring (#1375)", () => {
  beforeEach(() => {
    toggleIntegration.mockClear();
    fakeInvoke.mockClear();
    preflightSubnet.mockClear();
    preflightSubnet.mockResolvedValue({ status: "unknown" });
  });

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
    expect(preflightSubnet).toHaveBeenCalledTimes(1);
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
  });

  it("Cancel clears the blocked hint, so a re-open does not paint a stale one", async () => {
    // Asserted through the DOM because `reset()` has no observable handle:
    // blocked hint, Cancel, re-open against a probe that never settles, and the
    // hint must already be gone. The second probe proves the re-open is real.
    preflightSubnet.mockResolvedValue({ status: "blocked", hint: "no adapter" });
    const { container } = mount();
    await openConfirm(container);
    await tick();

    expect(q(container, "cowork-onboarding-preflight-blocked")?.textContent).toContain(
      "no adapter",
    );

    (q(container, "cowork-onboarding-enable-cancel-btn") as HTMLButtonElement).click();
    await tick();
    expect(q(container, "cowork-onboarding-confirm")).toBeNull();

    preflightSubnet.mockImplementationOnce(() => new Promise(() => {}));
    await openConfirm(container);

    expect(q(container, "cowork-onboarding-confirm")).toBeTruthy();
    expect(q(container, "cowork-onboarding-preflight-blocked")).toBeNull();
    expect(preflightSubnet).toHaveBeenCalledTimes(2);
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
  beforeEach(() => {
    preflightSubnet.mockClear();
    preflightSubnet.mockResolvedValue({ status: "unknown" });
    toggleIntegration.mockClear();
  });

  it("mounts the region empty, before the text that has to be announced", async () => {
    preflightSubnet.mockImplementationOnce(() => new Promise(() => {}));
    const { container } = mount();
    await openConfirm(container);

    const region = q(container, "cowork-onboarding-preflight-live");
    expect(region).toBeTruthy();
    expect(region?.getAttribute("role")).toBe("status");
    expect(q(container, "cowork-onboarding-preflight-blocked")).toBeNull();
  });

  it("keeps the same region node across probing → blocked", async () => {
    preflightSubnet.mockResolvedValue({ status: "blocked", hint: "no adapter" });
    const { container } = mount();
    await openConfirm(container);
    const before = q(container, "cowork-onboarding-preflight-live");
    await tick();
    await tick();

    const after = q(container, "cowork-onboarding-preflight-live");
    expect(after).toBe(before);
    expect(after?.textContent).toContain("no adapter");
  });
});
