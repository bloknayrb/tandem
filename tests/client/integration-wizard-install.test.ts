// @vitest-environment happy-dom

/**
 * One-click "Install Claude Code" surface in the integration wizard's empty
 * state. The install can't be exercised end-to-end (it would download + run
 * real software), so this mounted test stubs `createClaudeCliStatus` and
 * asserts the presence→UI contract the plan locked in:
 *
 *   - The install CTA shows ONLY when presence is a confirmed NOT_INSTALLED
 *     (null/loading and any INSTALLED_* state hide it — no flash before the
 *     GET resolves, no button for a user who already has the CLI).
 *   - Clicking it calls `install()` exactly once.
 *   - `installing` disables the button; `installError` renders the banner.
 *   - INSTALLED_NOT_ON_PATH renders the post-install success banner.
 *
 * `createIntegrationWizard` is stubbed to the empty-connect state so the empty
 * state renders without a real /api round-trip.
 */

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClaudeCliPresence } from "../../src/client/../shared/integrations/contract.js";

// Mutable stub the mocked hook returns; tests set fields BEFORE render.
const cliStub: {
  presence: ClaudeCliPresence | null;
  bareNameLaunchable: boolean | null;
  loading: boolean;
  error: string | null;
  installing: boolean;
  installError: string | null;
  install: ReturnType<typeof vi.fn>;
  refetch: ReturnType<typeof vi.fn>;
} = {
  presence: null,
  bareNameLaunchable: null,
  loading: false,
  error: null,
  installing: false,
  installError: null,
  install: vi.fn(async () => null),
  refetch: vi.fn(async () => {}),
};

vi.mock("../../src/client/hooks/useClaudeCliStatus.svelte", () => ({
  createClaudeCliStatus: () => cliStub,
}));

// Detected Claude installs. Empty by default (the connect empty state, which
// the install CTA lives in); the shim-warning tests push an entry to reach the
// NON-empty branch, where that empty state never renders.
const wizardExisting: unknown[] = [];

// Only the stateful hook is replaced — the module's other exports are pure
// helpers the rendered cards call (`isSelectable`, `tandemEntryValidationFailed`,
// …), and stubbing them one failure at a time replaces real logic with guesses.
vi.mock("../../src/client/hooks/useIntegrationWizard.svelte", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createIntegrationWizard: () => ({
    step: "connect",
    detecting: false,
    existing: wizardExisting,
    picked: [],
    applyResults: [],
    errorMessage: null,
    keychainUnavailable: false,
    begin: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
    reset: vi.fn(),
    setPicked: vi.fn(),
    submitSecret: vi.fn(async () => {}),
  }),
  detectedToPicked: vi.fn(() => null),
}));

// Browser (non-Tauri) cowork stub so the Cowork row stays out of the way.
vi.mock("../../src/client/hooks/useCoworkStatus.svelte", () => ({
  createCoworkStatus: () => ({
    status: null,
    loading: false,
    error: null,
    refetch: vi.fn(async () => {}),
  }),
}));

import IntegrationWizardModal from "../../src/client/components/IntegrationWizardModal.svelte";

function resetStub() {
  cliStub.presence = null;
  cliStub.bareNameLaunchable = null;
  wizardExisting.length = 0;
  cliStub.loading = false;
  cliStub.error = null;
  cliStub.installing = false;
  cliStub.installError = null;
  cliStub.install = vi.fn(async () => null);
  cliStub.refetch = vi.fn(async () => {});
}

/** Scoped testid query — avoids cross-test duplicate matches in document.body. */
function q(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

describe("IntegrationWizardModal — Install Claude Code CTA", () => {
  beforeEach(() => resetStub());
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  function mount() {
    return render(IntegrationWizardModal, { props: { open: true, onClose: vi.fn() } });
  }

  it("shows the install CTA only when presence is NOT_INSTALLED", async () => {
    cliStub.presence = "NOT_INSTALLED";
    const { container } = mount();
    await tick();
    expect(q(container, "integration-wizard-install-claude")).toBeTruthy();
  });

  it.each([
    { presence: null as ClaudeCliPresence | null, label: "null (loading)" },
    { presence: "INSTALLED_ON_PATH" as ClaudeCliPresence, label: "INSTALLED_ON_PATH" },
  ])("hides the install CTA when presence is $label", async ({ presence }) => {
    cliStub.presence = presence;
    const { container } = mount();
    await tick();
    expect(q(container, "integration-wizard-install-claude")).toBeNull();
    expect(q(container, "integration-wizard-install-success")).toBeNull();
  });

  it("renders the success banner (not the CTA) when INSTALLED_NOT_ON_PATH", async () => {
    cliStub.presence = "INSTALLED_NOT_ON_PATH";
    const { container } = mount();
    await tick();
    expect(q(container, "integration-wizard-install-success")).toBeTruthy();
    expect(q(container, "integration-wizard-install-claude")).toBeNull();
  });

  it("calls install() exactly once when the CTA is clicked", async () => {
    cliStub.presence = "NOT_INSTALLED";
    const { container } = mount();
    await tick();
    const btn = q(container, "integration-wizard-install-claude");
    expect(btn).toBeTruthy();
    await fireEvent.click(btn as HTMLElement);
    expect(cliStub.install).toHaveBeenCalledTimes(1);
  });

  it("disables the button and shows 'Installing…' while installing", async () => {
    cliStub.presence = "NOT_INSTALLED";
    cliStub.installing = true;
    const { container } = mount();
    await tick();
    const btn = q(container, "integration-wizard-install-claude") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent?.trim()).toBe("Installing…");
  });

  it("renders the error banner when installError is set", async () => {
    cliStub.presence = "NOT_INSTALLED";
    cliStub.installError = "Install failed (exit 1). boom";
    const { container } = mount();
    await tick();
    const banner = q(container, "integration-wizard-install-error");
    expect(banner?.textContent).toContain("Install failed");
  });
});

/**
 * The shim warning is the one CLI message that must survive OUTSIDE the "we
 * couldn't find Claude" empty state. Its audience — a Windows npm-global
 * install — has almost always run `claude` from a terminal (where PATHEXT makes
 * the shim work), which writes the config `detectTargets` keys on, so they land
 * in the non-empty branch. Gating it on the empty state would reach nearly
 * nobody, which is why every test here seeds a detected install.
 */
describe("IntegrationWizardModal — unlaunchable-shim warning", () => {
  beforeEach(() => {
    resetStub();
    wizardExisting.push({
      target: { kind: "claude-code", label: "Claude Code", configPath: "/x" },
      status: "ok",
      tandemEntry: { type: "http", url: "http://127.0.0.1:3479/mcp" },
      tandemValidation: { status: "valid" },
    });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  function mount() {
    return render(IntegrationWizardModal, { props: { open: true, onClose: vi.fn() } });
  }

  it("renders alongside a detected install (not only in the empty state)", async () => {
    cliStub.presence = "INSTALLED_ON_PATH";
    cliStub.bareNameLaunchable = false;
    const { container } = mount();
    await tick();
    expect(q(container, "integration-wizard-empty")).toBeNull();
    const banner = q(container, "integration-wizard-shim-warning");
    expect(banner?.textContent).toContain("npm");
  });

  it.each([
    { launchable: true, label: "launchable" },
    { launchable: null, label: "not yet probed" },
  ])("stays hidden when $label", async ({ launchable }) => {
    cliStub.presence = "INSTALLED_ON_PATH";
    cliStub.bareNameLaunchable = launchable;
    const { container } = mount();
    await tick();
    // Positive control: the step this banner lives in DID render, so the
    // absence below is the flag's doing and not an unrendered subtree.
    expect(q(container, "integration-wizard-step-detect")).toBeTruthy();
    expect(q(container, "integration-wizard-shim-warning")).toBeNull();
  });
});
