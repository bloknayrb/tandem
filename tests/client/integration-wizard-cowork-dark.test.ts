// @vitest-environment happy-dom

/**
 * The integration wizard's AI-models row while local models are dark (#1123),
 * with Cowork lit and the Tauri runtime stubbed — the harness of
 * `integration-wizard-cowork.test.ts`, which this case was moved out of so that
 * file can run in either state of `BYO_MODELS_ENABLED`. The guard it pins is
 * `IntegrationWizardModal.svelte`'s `{#if !BYO_MODELS_ENABLED}` "coming soon"
 * branch. (`local-providers-dark.test.ts` checks the same row's exact text and
 * disabled class without Tauri; this one checks it with Cowork lit.)
 */

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  coworkToggleIntegration,
  SubnetPreflight,
} from "../../src/client/cowork/cowork-invoke";
import { coworkStatusFixture } from "../helpers/cowork-status-fixture";

const toggleIntegration = vi.fn(async (..._args: unknown[]) => ({ message: "Cowork enabled" }));
const fakeInvoke = vi.fn();

// Cowork ships dark as a literal `false` (ADR-055); this harness renders the
// wizard with Cowork lit, as `integration-wizard-cowork.test.ts` does.
vi.mock(import("../../src/shared/constants"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants")>()),
  COWORK_ENABLED: true as false,
  // This whole file is the local-model dark state, so it forces the flag off
  // whatever the shipped literal says (#1123: the suite holds in both states).
  BYO_MODELS_ENABLED: false as typeof import("../../src/shared/constants").BYO_MODELS_ENABLED,
}));

// isTauriRuntime → true so the Cowork row + sub-view render; everything else
// in cowork-helpers (coworkSettingsVariant, formatCoworkError) stays real.
vi.mock(import("../../src/client/cowork/cowork-helpers"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/cowork/cowork-helpers")>();
  return { ...actual, isTauriRuntime: () => true };
});

// #1298: the sub-view pre-flights subnet detection on entry. Default to
// `unknown` (the probe couldn't run) — the state that must leave Enable alone.
// The real type, not a transcription: a hand-copied union goes stale silently.
const preflightSubnet = vi.fn(async (): Promise<SubnetPreflight> => ({ status: "unavailable" }));

// Spread `importOriginal` rather than re-declaring the module: `cowork-invoke`
// exports nine symbols and each suite's mock used to name a different subset,
// so a component reaching for an un-named one failed as `undefined is not a
// function` — a component-shaped error, discovered one file at a time.
vi.mock(import("../../src/client/cowork/cowork-invoke"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/cowork/cowork-invoke")>()),
  loadInvoke: vi.fn(async () => fakeInvoke),
  // Wrapper, NOT a bare reference: a `vi.mock` factory is hoisted, so naming the
  // top-level spy directly throws "Cannot access before initialization". The
  // cast rides on the wrapper -- production is `(invoke, enabled)` while the
  // spy takes `...unknown[]` so call assertions stay simple.
  coworkToggleIntegration: ((...args: unknown[]) =>
    toggleIntegration(...args)) as unknown as typeof coworkToggleIntegration,
  coworkPreflightSubnet: () => preflightSubnet(),
}));

// A "normal" (Windows + detected) status with Cowork OFF, so the "Set up"
// button renders and enable is a meaningful action. The shared fixture, not a
// literal: its sibling `integration-wizard-push-support.test.ts` mounts the
// SAME component through the SAME mock, and a hand-written literal here omits
// the optional fields the sidecar always sends — so the two suites would render
// different `undetectedDetail` arms for reasons neither file states.
vi.mock(import("../../src/client/hooks/useCoworkStatus.svelte"), () => ({
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
vi.mock(import("../../src/client/hooks/useClaudeCliStatus.svelte"), () => ({
  createClaudeCliStatus: () => ({
    presence: "INSTALLED_ON_PATH" as const,
    bareNameLaunchable: true,
    loading: false,
    error: null,
    installing: false,
    installError: null,
    install: vi.fn(async () => "INSTALLED_ON_PATH" as const),
    refetch: vi.fn(async () => {}),
  }),
}));

// Empty-connect MCP state — keeps the MAIN view rendered with no /api fetch.
vi.mock(import("../../src/client/hooks/useIntegrationWizard.svelte"), () => ({
  createIntegrationWizard: () => ({
    step: "connect" as const,
    detecting: false,
    existing: [],
    picked: [],
    applyResults: [],
    tandemClaude: null,
    errorMessage: null,
    channelRegistered: null,
    keychainUnavailable: false,
    begin: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
    reset: vi.fn(),
    setPicked: vi.fn(),
    submitSecret: vi.fn(async () => {}),
    cleanupUnsavedSecrets: vi.fn(async () => {}),
    hasSetupToKeep: false,
    keepError: null,
    keepSetup: vi.fn(async () => true),
    pickedForInstall: vi.fn(() => null),
    refreshDetected: vi.fn(async () => []),
  }),
  detectedToPicked: vi.fn(() => null),
}));

import IntegrationWizardModal from "../../src/client/components/IntegrationWizardModal.svelte";

function q(container: HTMLElement, testid: string): HTMLElement | null {
  return container.querySelector(`[data-testid='${testid}']`);
}

describe("integration wizard, local models dark, Cowork lit", () => {
  beforeEach(() => {
    toggleIntegration.mockClear();
    fakeInvoke.mockClear();
    preflightSubnet.mockClear();
    preflightSubnet.mockResolvedValue({ status: "unavailable" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the AI-models 'coming soon' line and NO Set-up button while dark", async () => {
    // This file forces `BYO_MODELS_ENABLED=false`, so the `{#if}` (coming-soon)
    // branch renders, not the `{:else}` enabled row.
    const { container } = render(IntegrationWizardModal, {
      props: { open: true, onClose: vi.fn() },
    });
    await tick();

    expect(q(container, "integration-wizard-more")?.textContent).toMatch(/coming soon/i);
    expect(q(container, "integration-wizard-models-setup")).toBeNull();
  });
});
