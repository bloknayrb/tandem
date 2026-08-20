// @vitest-environment happy-dom

/**
 * Cowork sub-view gating in the unified onboarding wizard.
 *
 * The Cowork enable flow renders ONLY in the Tauri WebView (the browser hides
 * it because `loadInvoke` rejects), so the E2E suite — which drives the
 * browser — cannot reach it. This mounted test stubs `isTauriRuntime()` true
 * and mocks `coworkToggleIntegration` so we can assert the security-critical
 * gating contract that the plan locked in:
 *
 *   1. The "More integrations → Set up" button only NAVIGATES — it must never
 *      enable Cowork.
 *   2. Entering the sub-view must not auto-enable (no onMount/$effect call).
 *   3. `cowork-enable-confirm-btn` is the SOLE trigger of
 *      `coworkToggleIntegration(invoke, true)`.
 *   4. (#1298) Entering the sub-view pre-flights subnet detection, and a
 *      known-failing detection replaces Enable with a retry — but a probe that
 *      cannot run leaves Enable exactly as it was.
 *
 * `createIntegrationWizard` is stubbed to the empty-connect state so the MAIN
 * view + "More integrations" section render without a real /api round-trip.
 */

import { render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COWORK_PREFLIGHT_CHECKING } from "../../src/client/cowork/cowork-helpers";
import type { SubnetPreflight } from "../../src/client/cowork/cowork-invoke";
import { coworkStatusFixture } from "../helpers/cowork-status-fixture";

const toggleIntegration = vi.fn(async () => ({ ok: true as const }));
const fakeInvoke = vi.fn();

// isTauriRuntime → true so the Cowork row + sub-view render; everything else
// in cowork-helpers (coworkSettingsVariant, formatCoworkError) stays real.
vi.mock("../../src/client/cowork/cowork-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/cowork/cowork-helpers")>();
  return { ...actual, isTauriRuntime: () => true };
});

// #1298: the sub-view pre-flights subnet detection on entry. Default to
// `unknown` (the probe couldn't run) — the state that must leave Enable alone.
// The real type, not a transcription: a hand-copied union goes stale silently,
// and `tests/` is typechecked by nothing (`tsconfig.json` includes only `src`),
// so the copy would not even fail to compile.
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

// A "normal" (Windows + detected) status with Cowork OFF, so the "Set up"
// button renders and enable is a meaningful action. The shared fixture, not a
// literal: its sibling `integration-wizard-push-support.test.ts` mounts the
// SAME component through the SAME mock, and a hand-written literal here omits
// the optional fields the sidecar always sends — so the two suites would render
// different `undetectedDetail` arms for reasons neither file states.
vi.mock("../../src/client/hooks/useCoworkStatus.svelte", () => ({
  createCoworkStatus: () => ({
    status: coworkStatusFixture(),
    loading: false,
    error: null,
    // The real hook resolves `true`/`false` (a fresh status was/wasn't
    // stored) and `enableCowork`/`handleToggleOn` gate a UI transition on it —
    // stubbing `undefined` here would make every enable in this file look
    // like a failed read-back to that gate, whether or not that's this file's
    // intent to test.
    refetch: vi.fn(async () => true),
  }),
}));

// Stub the Claude-CLI status hook so the modal doesn't fire a real (blocked)
// fetch at 127.0.0.1:3479 during these Cowork-focused tests. Presence ON_PATH
// keeps the install CTA out of the empty state.
vi.mock("../../src/client/hooks/useClaudeCliStatus.svelte", () => ({
  createClaudeCliStatus: () => ({
    presence: "INSTALLED_ON_PATH",
    loading: false,
    error: null,
    installing: false,
    installError: null,
    install: vi.fn(async () => "INSTALLED_ON_PATH"),
    refetch: vi.fn(async () => {}),
  }),
}));

// Empty-connect MCP state — keeps the MAIN view rendered with no /api fetch.
vi.mock("../../src/client/hooks/useIntegrationWizard.svelte", () => ({
  createIntegrationWizard: () => ({
    step: "connect",
    detecting: false,
    existing: [],
    picked: [],
    applyResults: [],
    errorMessage: null,
    keychainUnavailable: false,
    begin: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
    reset: vi.fn(),
    setPicked: vi.fn(),
    submitSecret: vi.fn(async () => {}),
    cleanupUnsavedSecrets: vi.fn(async () => {}),
  }),
  detectedToPicked: vi.fn(() => null),
}));

import IntegrationWizardModal from "../../src/client/components/IntegrationWizardModal.svelte";

function q(container: HTMLElement, testid: string): HTMLElement | null {
  return container.querySelector(`[data-testid='${testid}']`);
}

describe("integration wizard — Cowork sub-view gating", () => {
  beforeEach(() => {
    toggleIntegration.mockClear();
    fakeInvoke.mockClear();
    preflightSubnet.mockClear();
    preflightSubnet.mockResolvedValue({ status: "unknown" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the More-integrations Cowork Set-up affordance without enabling", async () => {
    const { container } = render(IntegrationWizardModal, {
      props: { open: true, onClose: vi.fn() },
    });
    await tick();

    expect(q(container, "integration-wizard-more")).toBeTruthy();
    expect(q(container, "integration-wizard-cowork-setup")).toBeTruthy();
    // Nothing enabled just by rendering the row.
    expect(toggleIntegration).not.toHaveBeenCalled();
  });

  it("Set up navigates to the sub-view but does NOT enable", async () => {
    const { container } = render(IntegrationWizardModal, {
      props: { open: true, onClose: vi.fn() },
    });
    await tick();

    (q(container, "integration-wizard-cowork-setup") as HTMLButtonElement).click();
    await tick();

    // Sub-view is showing (warning + confirm button), enable NOT yet fired.
    expect(q(container, "integration-wizard-cowork-step")).toBeTruthy();
    expect(q(container, "cowork-enable-confirm-btn")).toBeTruthy();
    expect(toggleIntegration).not.toHaveBeenCalled();
  });

  it("shows the AI-models 'coming soon' line and NO Set-up button while dark", async () => {
    // This file runs with the shipped `BYO_MODELS_ENABLED=false`, so the `{#if}`
    // (coming-soon) branch renders, not the `{:else}` enabled row.
    const { container } = render(IntegrationWizardModal, {
      props: { open: true, onClose: vi.fn() },
    });
    await tick();

    expect(q(container, "integration-wizard-more")?.textContent).toMatch(/coming soon/i);
    expect(q(container, "integration-wizard-models-setup")).toBeNull();
  });

  it("cowork-enable-confirm-btn is the sole trigger of enable", async () => {
    const { container } = render(IntegrationWizardModal, {
      props: { open: true, onClose: vi.fn() },
    });
    await tick();

    (q(container, "integration-wizard-cowork-setup") as HTMLButtonElement).click();
    await tick();
    (q(container, "cowork-enable-confirm-btn") as HTMLButtonElement).click();
    await tick();

    expect(toggleIntegration).toHaveBeenCalledTimes(1);
    expect(toggleIntegration).toHaveBeenCalledWith(fakeInvoke, true);
  });

  // -------------------------------------------------------------------------
  // #1298 — the pre-flight. Before this, the sub-view offered an Enable button
  // whose second step (subnet detection) it could have known would fail, and
  // reported the failure as "is Cowork set up on this machine?" — on a screen
  // that only renders because Cowork *was* detected.
  // -------------------------------------------------------------------------

  async function openCoworkSubView(container: HTMLElement): Promise<void> {
    (q(container, "integration-wizard-cowork-setup") as HTMLButtonElement).click();
    // Wait for the probe to be ISSUED rather than counting ticks: `run()`
    // defers `probing` one flush so the live region reaches the accessibility
    // tree empty first (#1376), which puts the call an unknowable number of
    // hops from the click.
    // `interval: 5` — a mock call count wakes no MutationObserver.
    await waitFor(() => expect(preflightSubnet).toHaveBeenCalled(), { interval: 5 });
    // Two flushes to let an ALREADY-RESOLVED mock's continuations run. Not a
    // chain length — the `waitFor` above owns that — so this stays correct if
    // `run()` gains a hop. A caller waiting on a specific settled state should
    // still use its own `waitFor`; the ones below do.
    await tick();
    await tick();
  }

  it("pre-flights subnet detection when entering the sub-view", async () => {
    const { container } = render(IntegrationWizardModal, {
      props: { open: true, onClose: vi.fn() },
    });
    await tick();
    expect(preflightSubnet).not.toHaveBeenCalled();

    await openCoworkSubView(container);

    expect(preflightSubnet).toHaveBeenCalledTimes(1);
    // Probing is not enabling.
    expect(toggleIntegration).not.toHaveBeenCalled();
  });

  it("replaces Enable with a retry, and says why, when detection is known-failing", async () => {
    preflightSubnet.mockResolvedValue({
      status: "blocked",
      hint: "Tandem didn't find a Hyper-V virtual network adapter.",
    });
    const { container } = render(IntegrationWizardModal, {
      props: { open: true, onClose: vi.fn() },
    });
    await tick();
    await openCoworkSubView(container);

    await waitFor(() => {
      expect(
        q(container, "integration-wizard-cowork-preflight-blocked")?.textContent ?? "",
      ).toContain("didn't find a Hyper-V virtual network adapter");
    });
    expect(q(container, "integration-wizard-cowork-preflight-retry-btn")).toBeTruthy();
    // The whole point: no button offering an action we've watched fail.
    expect(q(container, "cowork-enable-confirm-btn")).toBeNull();
  });

  it("re-probes on Check again, and restores Enable once detection succeeds", async () => {
    preflightSubnet.mockResolvedValue({ status: "blocked", hint: "no adapter" });
    const { container } = render(IntegrationWizardModal, {
      props: { open: true, onClose: vi.fn() },
    });
    await tick();
    await openCoworkSubView(container);

    // The user starts a Cowork session, then retries.
    preflightSubnet.mockResolvedValue({ status: "ok", cidr: "172.20.0.0/20" });
    await waitFor(() => {
      expect(q(container, "integration-wizard-cowork-preflight-retry-btn")).toBeTruthy();
    });
    (q(container, "integration-wizard-cowork-preflight-retry-btn") as HTMLButtonElement).click();
    // `waitFor` on the settled outcome, not a tick count: the blocked banner
    // survives until the re-probe SETTLES rather than vanishing synchronously
    // on click (see the test below for why), so any fixed number of ticks is
    // either mid-probe or an over-count nobody can re-derive.
    await waitFor(() => {
      expect(q(container, "cowork-enable-confirm-btn")).toBeTruthy();
    });

    expect(preflightSubnet).toHaveBeenCalledTimes(2);
    expect(q(container, "integration-wizard-cowork-preflight-blocked")).toBeNull();
  });

  it("keeps the retry button in place while it re-probes, rather than swapping in Enable", async () => {
    // The defect: `run()` used to clear `preflight` synchronously, and every
    // surface gates its retry button on `blocked`. So clicking "Check again"
    // unmounted the button under the pointer and mounted Enable in its place —
    // destroying focus mid-interaction, and making the second click of a
    // double-click fire the real enable (UAC prompt, firewall write) on a
    // machine the probe had just said could not work.
    //
    // The existing "re-probes on Check again" test awaits two ticks and can
    // only see the settled state, so it passes either way. This one holds the
    // probe open and looks at the frame in between.
    preflightSubnet.mockResolvedValue({ status: "blocked", hint: "no adapter" });
    const { container } = render(IntegrationWizardModal, {
      props: { open: true, onClose: vi.fn() },
    });
    await tick();
    await openCoworkSubView(container);

    // `mockImplementationOnce`, not a bare pending promise on the shared mock:
    // `beforeEach` uses `mockClear`, which does NOT clear implementations, so a
    // hanging default would wedge every later test in this file.
    preflightSubnet.mockImplementationOnce(() => new Promise(() => {}));
    await waitFor(() => {
      expect(q(container, "integration-wizard-cowork-preflight-retry-btn")).toBeTruthy();
    });
    const retryBtn = q(container, "integration-wizard-cowork-preflight-retry-btn");
    (retryBtn as HTMLButtonElement).click();
    await waitFor(() => expect(preflightSubnet).toHaveBeenCalledTimes(2), { interval: 5 });
    await tick();

    const stillThere = q(container, "integration-wizard-cowork-preflight-retry-btn");
    expect(stillThere, "the retry button unmounted mid-probe").toBeTruthy();
    expect(stillThere).toBe(retryBtn); // same node — focus survives
    expect(stillThere?.textContent?.trim()).toBe("Checking…");
    expect(
      q(container, "cowork-enable-confirm-btn"),
      "Enable must not take the retry button's slot mid-probe",
    ).toBeNull();
  });

  // -------------------------------------------------------------------------
  // #1376 — the live region. `role="status"` sat on the blocked banner, which
  // is created together with its text; a region inserted with its content is
  // generally not announced, so the sentence explaining a failed detection was
  // silent for exactly the users #1298 wrote it for.
  // -------------------------------------------------------------------------

  it("mounts the pre-flight region empty on entry, before any hint exists", async () => {
    preflightSubnet.mockImplementationOnce(() => new Promise(() => {}));
    const { container } = render(IntegrationWizardModal, {
      props: { open: true, onClose: vi.fn() },
    });
    await tick();
    (q(container, "integration-wizard-cowork-setup") as HTMLButtonElement).click();
    await tick();

    const region = q(container, "integration-wizard-cowork-preflight-live");
    expect(region).toBeTruthy();
    expect(region?.getAttribute("role")).toBe("status");
    // EMPTY, which nothing asserted before: the in-flight line is the first
    // text to arrive, so a `probing` flipped in the tick that mounts the region
    // reintroduces the whole defect. `run()` defers it one flush for this.
    expect(region?.textContent?.trim()).toBe("");
    expect(q(container, "integration-wizard-cowork-preflight-blocked")).toBeNull();

    await waitFor(() => {
      expect(region?.textContent ?? "").toContain(COWORK_PREFLIGHT_CHECKING);
    });
    expect(q(container, "integration-wizard-cowork-preflight-live")).toBe(region);
  });

  it("keeps the same region node when the hint arrives", async () => {
    // Same NODE, not merely a region present in both states: a wrapper that
    // unmounts and remounts with its content is the original bug wearing a
    // testid.
    preflightSubnet.mockResolvedValue({ status: "blocked", hint: "no adapter" });
    const { container } = render(IntegrationWizardModal, {
      props: { open: true, onClose: vi.fn() },
    });
    await tick();
    (q(container, "integration-wizard-cowork-setup") as HTMLButtonElement).click();
    await tick();
    const before = q(container, "integration-wizard-cowork-preflight-live");
    expect(before).toBeTruthy();

    await waitFor(() => {
      expect(q(container, "integration-wizard-cowork-preflight-live")?.textContent ?? "").toContain(
        "no adapter",
      );
    });
    expect(q(container, "integration-wizard-cowork-preflight-live")).toBe(before);
  });

  it("leaves Enable available when the probe itself cannot run", async () => {
    // A broken probe says nothing about whether enabling would work. Blocking
    // here would strand a user whose enable would have succeeded — a worse
    // failure than the one #1298 fixes.
    preflightSubnet.mockRejectedValue(new Error("Tauri runtime not available"));
    const { container } = render(IntegrationWizardModal, {
      props: { open: true, onClose: vi.fn() },
    });
    await tick();
    await openCoworkSubView(container);

    expect(q(container, "integration-wizard-cowork-preflight-blocked")).toBeNull();
    const enableBtn = q(container, "cowork-enable-confirm-btn") as HTMLButtonElement;
    expect(enableBtn).toBeTruthy();
    expect(enableBtn.disabled).toBe(false);
  });
});
