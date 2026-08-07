// @vitest-environment happy-dom

/**
 * The wizard's Done screen must SAY, at wizard time, that a client it just
 * connected cannot be notified in real time (#1299).
 *
 * The reporter connected Claude Desktop, was told "AI connected", sent two
 * messages, and got silence — because for that target `shouldRegisterChannelShim`
 * returns a hard `false`: no channel shim, no supervisor stdin wake, no plugin
 * monitor. Push there does not fail, it does not exist. The wizard knew that
 * statically, at the moment it wrote the config, and said nothing.
 *
 * Mounted rather than unit-only because the *decision* is already unit-tested
 * in `integration-wizard-helpers.test.ts`; what this file pins is that the
 * decision reaches the screen — the gap the helper alone cannot prove, since a
 * correct helper nobody renders is exactly the pre-#1299 state.
 *
 * The wizard hook and the reachability probe are stubbed: the point of the test
 * is the render, and a real probe would fetch `/health`.
 */

import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApplyItemResult } from "../../src/shared/integrations/contract.js";

// Mutable stubs the mocked hooks return; each test sets them BEFORE render.
const wizardStub: {
  picked: unknown[];
  applyResults: ApplyItemResult[];
  channelRegistered: boolean | null;
} = { picked: [], applyResults: [], channelRegistered: null };

vi.mock("../../src/client/hooks/useIntegrationWizard.svelte", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createIntegrationWizard: () => ({
    step: "done",
    detecting: false,
    existing: [],
    get picked() {
      return wizardStub.picked;
    },
    get applyResults() {
      return wizardStub.applyResults;
    },
    get channelRegistered() {
      return wizardStub.channelRegistered;
    },
    errorMessage: null,
    keychainUnavailable: false,
    begin: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
    reset: vi.fn(),
    setPicked: vi.fn(),
    submitSecret: vi.fn(async () => {}),
    cleanupUnsavedSecrets: vi.fn(async () => {}),
  }),
}));

// `not-applicable` is what the real hook reports for an stdio target — no
// server to probe. Using the honest value keeps the row in the same shape the
// production Done screen renders for Claude Desktop.
vi.mock("../../src/client/hooks/useReachabilityCheck.svelte", () => ({
  createReachabilityCheck: () => ({
    phase: "done",
    serverUp: null,
    claudeConnected: false,
    results: wizardStub.applyResults.map((r) => ({
      id: r.id,
      status: r.id.startsWith("claude-desktop") ? "not-applicable" : "reachable",
    })),
  }),
}));

vi.mock("../../src/client/hooks/useClaudeCliStatus.svelte", () => ({
  createClaudeCliStatus: () => ({
    presence: null,
    bareNameLaunchable: null,
    loading: false,
    error: null,
    installing: false,
    installError: null,
    install: vi.fn(async () => null),
    refetch: vi.fn(async () => {}),
  }),
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

function pickedDesktop(id = "claude-desktop-1") {
  return {
    id,
    config: {
      kind: "claude-desktop",
      id,
      label: "Claude Desktop",
      configPath: "/home/u/claude_desktop_config.json",
      transport: "stdio",
    },
    hasStoredSecret: false,
    keychainUnavailable: false,
  };
}

function pickedCode(id = "claude-code-1") {
  return {
    id,
    config: {
      kind: "claude-code",
      id,
      label: "Claude Code",
      configPath: "/home/u/.claude.json",
      transport: "http",
      url: "http://127.0.0.1:3479/mcp",
    },
    hasStoredSecret: false,
    keychainUnavailable: false,
  };
}

const applied = (id: string): ApplyItemResult => ({ id, status: "applied" });

function mountDone(picked: unknown[], results: ApplyItemResult[]) {
  wizardStub.picked = picked;
  wizardStub.applyResults = results;
  return render(IntegrationWizardModal, { props: { open: true, onClose: vi.fn() } });
}

function q(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

describe("IntegrationWizardModal — per-target push support (#1299)", () => {
  afterEach(() => {
    cleanup();
    wizardStub.picked = [];
    wizardStub.applyResults = [];
    wizardStub.channelRegistered = null;
    vi.clearAllMocks();
  });

  it("tells a Claude Desktop user that nothing will notify it", async () => {
    const { container } = mountDone([pickedDesktop()], [applied("claude-desktop-1")]);
    await tick();
    const line = q(container, "integration-wizard-push-support-claude-desktop-1");
    expect(line).toBeTruthy();
    expect(line?.textContent ?? "").toMatch(/can't notify this one in real time/i);
    expect(line?.getAttribute("data-push-support")).toBe("none");
  });

  it("says nothing for Claude Code, where a transport at least exists", async () => {
    // Silence, not an affirmative line: a registered shim is not delivery
    // (findings A5/A7), and the separate push-mode block already carries the
    // hedged version of that story.
    const { container } = mountDone([pickedCode()], [applied("claude-code-1")]);
    await tick();
    expect(q(container, "integration-wizard-push-support-claude-code-1")).toBeNull();
  });

  it("marks only the Desktop row when both clients are connected at once", async () => {
    // The mixed selection is the case a whole-screen banner gets wrong: the
    // push-mode block renders its Claude Code copy here (`whatsNext` is not
    // `stdio-only`), so without a per-ROW line the Desktop user reads a
    // reassurance meant for the other client.
    const { container } = mountDone(
      [pickedCode(), pickedDesktop()],
      [applied("claude-code-1"), applied("claude-desktop-1")],
    );
    await tick();
    expect(q(container, "integration-wizard-push-support-claude-desktop-1")).toBeTruthy();
    expect(q(container, "integration-wizard-push-support-claude-code-1")).toBeNull();
  });

  it("says nothing on a row that did not apply", async () => {
    // An error row is about the write failing; leading with a delivery caveat
    // would bury the actionable problem under one the user cannot act on yet.
    const { container } = mountDone(
      [pickedDesktop()],
      [{ id: "claude-desktop-1", status: "error", code: "WRITE_FAILED" }],
    );
    await tick();
    expect(q(container, "integration-wizard-push-support-claude-desktop-1")).toBeNull();
  });
});
