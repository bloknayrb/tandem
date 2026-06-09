// @vitest-environment happy-dom

/**
 * SF-2: a successful install POST that still reports `NOT_INSTALLED` must
 * surface an install-error banner, not silently re-render the identical CTA.
 *
 * This exercises the REAL `useClaudeCliStatus` hook (un-mocked) through the
 * modal — the branch lives inside `install()`, and the hook's `onDestroy` +
 * `$effect` need a component context, so we mount rather than `$effect.root`.
 * The sibling `integration-wizard-install.test.ts` stubs the hook to test the
 * presence→UI mapping; this file complements it by driving the hook's logic.
 */

import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

// Keep the wizard + cowork hooks stubbed (no real /api round-trips), but use
// the REAL useClaudeCliStatus so install()'s SF-2 branch actually runs.
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

vi.mock("../../src/client/hooks/useCoworkStatus.svelte", () => ({
  createCoworkStatus: () => ({
    status: null,
    loading: false,
    error: null,
    refetch: vi.fn(async () => {}),
  }),
}));

import IntegrationWizardModal from "../../src/client/components/IntegrationWizardModal.svelte";

function q(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

describe("IntegrationWizardModal — install completes but binary still not detected (SF-2)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("shows an install-error banner when the install POST returns ok:true + NOT_INSTALLED", async () => {
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "GET" && /claude-cli-status/.test(url)) {
        return new Response(JSON.stringify({ presence: "NOT_INSTALLED" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && /install-claude-code/.test(url)) {
        // Exit 0 but the binary still isn't found — the honest server response.
        return new Response(JSON.stringify({ ok: true, presence: "NOT_INSTALLED" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "no-stub", url }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchStub);

    const { container } = render(IntegrationWizardModal, {
      props: { open: true, onClose: vi.fn() },
    });

    // The status GET resolves async → wait for the CTA to appear.
    const btn = await waitFor(() => {
      const el = q(container, "integration-wizard-install-claude");
      if (!el) throw new Error("install CTA not yet rendered");
      return el;
    });
    await fireEvent.click(btn);

    // After the install POST resolves NOT_INSTALLED, the hook sets installError
    // (rather than the modal silently re-rendering the same CTA).
    await waitFor(() => {
      const banner = q(container, "integration-wizard-install-error");
      expect(banner?.textContent).toContain("wasn't detected yet");
    });
  });
});
