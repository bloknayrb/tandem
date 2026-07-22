// @vitest-environment happy-dom

/**
 * "AI models" row in the unified onboarding wizard's "More integrations"
 * section (#1123 M2b §3.6), FLAG-ON path.
 *
 * While dark the row renders a disabled "coming soon" line (asserted in
 * `integration-wizard-cowork.test.ts`, which runs with the shipped
 * `BYO_MODELS_ENABLED=false`). This file mocks the constant ON to exercise the
 * `{:else}` enabled row: a "Set up" button that closes the wizard and invokes
 * the `onSetupModels` callback (App wires it to `openModelsSettings`). This is
 * the thin gate-wiring seam from the plan §3.8 — the constant stays a literal
 * `false` in production; only this test flips it.
 *
 * The hook mocks mirror `integration-wizard-cowork.test.ts` so the MAIN view +
 * "More integrations" section render with no real /api round-trip.
 */

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/shared/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants")>()),
  BYO_MODELS_ENABLED: true,
}));

// isTauriRuntime → false: the Cowork row hides (its poller early-returns) but the
// AI-models row is not Tauri-gated, so it still renders. Keeps the mock set lean.
vi.mock("../../src/client/cowork/cowork-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/cowork/cowork-helpers")>();
  return { ...actual, isTauriRuntime: () => false };
});

vi.mock("../../src/client/hooks/useCoworkStatus.svelte", () => ({
  createCoworkStatus: () => ({
    status: null,
    loading: false,
    error: null,
    refetch: vi.fn(async () => {}),
  }),
}));

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

// Empty-connect MCP state — keeps the MAIN view + More section rendered.
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

const { default: IntegrationWizardModal } = await import(
  "../../src/client/components/IntegrationWizardModal.svelte"
);

function q(container: HTMLElement, testid: string): HTMLElement | null {
  return container.querySelector(`[data-testid='${testid}']`);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("integration wizard — AI models row (§3.6, flag ON)", () => {
  it("renders the enabled 'Set up' models row (not the coming-soon line)", async () => {
    const { container } = render(IntegrationWizardModal, {
      props: { open: true, onClose: vi.fn() },
    });
    await tick();

    const setup = q(container, "integration-wizard-models-setup");
    expect(setup).toBeTruthy();
    // The disabled coming-soon row must NOT be the one rendered.
    expect(q(container, "integration-wizard-more")?.textContent).toMatch(/local AI model/i);
    expect(q(container, "integration-wizard-more")?.textContent).not.toMatch(/coming soon/i);
  });

  it("Set up closes the wizard and invokes onSetupModels", async () => {
    const onClose = vi.fn();
    const onSetupModels = vi.fn();
    const { container } = render(IntegrationWizardModal, {
      props: { open: true, onClose, onSetupModels },
    });
    await tick();

    (q(container, "integration-wizard-models-setup") as HTMLButtonElement).click();
    await tick();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSetupModels).toHaveBeenCalledTimes(1);
  });
});
