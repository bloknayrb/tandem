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
 *
 * `createIntegrationWizard` is stubbed to the empty-connect state so the MAIN
 * view + "More integrations" section render without a real /api round-trip.
 */

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toggleIntegration = vi.fn(async () => ({ ok: true as const }));
const fakeInvoke = vi.fn();

// isTauriRuntime → true so the Cowork row + sub-view render; everything else
// in cowork-helpers (coworkSettingsVariant, formatCoworkError) stays real.
vi.mock("../../src/client/cowork/cowork-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/cowork/cowork-helpers")>();
  return { ...actual, isTauriRuntime: () => true };
});

vi.mock("../../src/client/cowork/cowork-invoke", () => ({
  TAURI_NOT_AVAILABLE: "Tauri runtime not available",
  loadInvoke: vi.fn(async () => fakeInvoke),
  coworkToggleIntegration: (...args: unknown[]) => toggleIntegration(...args),
}));

// A "normal" (Windows + detected) status with Cowork OFF, so the "Set up"
// button renders and enable is a meaningful action.
vi.mock("../../src/client/hooks/useCoworkStatus.svelte", () => ({
  createCoworkStatus: () => ({
    status: {
      osSupported: true,
      coworkDetected: true,
      enabled: false,
      vethernetCidr: "172.30.16.0/28",
      lanIpFallback: null,
      useLanIpOverride: false,
      workspaces: [],
      uacDeclined: false,
      uacDeclinedAt: null,
    },
    loading: false,
    error: null,
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
});
