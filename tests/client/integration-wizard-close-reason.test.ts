// @vitest-environment happy-dom

/**
 * The wizard tells App why it closed (#1123, the first-run local-model window,
 * R1.1 item 1): "claude-set-up" when it closes from Done with a Claude Code or
 * Claude Desktop row applied, "other" otherwise.
 *
 * The wizard hook is stubbed STATEFULLY: its `reset()` really clears `step`,
 * `picked` and `applyResults`, as the real hook does. A `reset: vi.fn()` stub
 * would pass a build that computed the reason after `reset()`; this one fails
 * it, because by then every input reads empty.
 */

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IntegrationWizardState,
  PickedIntegration,
  WizardStep,
} from "../../src/client/hooks/useIntegrationWizard.svelte";
import type { ApplyItemResult } from "../../src/shared/integrations/contract.js";
import { wizardStepCell } from "../helpers/wizard-step-cell.svelte";

const wizardStub: {
  picked: IntegrationWizardState["picked"];
  applyResults: ApplyItemResult[];
  /** Delegated to a `$state` cell so a reset re-renders (see the helper). */
  step: WizardStep;
} = {
  picked: [],
  applyResults: [],
  get step(): WizardStep {
    return wizardStepCell.value as WizardStep;
  },
  set step(next: WizardStep) {
    wizardStepCell.set(next);
  },
};

vi.mock(import("../../src/client/hooks/useIntegrationWizard.svelte"), async (importOriginal) => ({
  ...(await importOriginal()),
  createIntegrationWizard: () => ({
    get step() {
      return wizardStub.step;
    },
    detecting: false,
    existing: [],
    hasSetupToKeep: false,
    keepError: null,
    keepSetup: vi.fn(async () => true),
    pickedForInstall: vi.fn(() => null),
    refreshDetected: vi.fn(async () => []),
    get picked() {
      return wizardStub.picked;
    },
    get applyResults() {
      return wizardStub.applyResults;
    },
    tandemClaude: null,
    channelRegistered: null,
    errorMessage: null,
    keychainUnavailable: false,
    begin: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
    // As the real `reset()` does (useIntegrationWizard.svelte.ts): back to
    // detection, with no picks and no results.
    reset: vi.fn(() => {
      wizardStub.step = "connect";
      wizardStub.picked = [];
      wizardStub.applyResults = [];
    }),
    setPicked: vi.fn(),
    submitSecret: vi.fn(async () => {}),
    cleanupUnsavedSecrets: vi.fn(async () => {}),
  }),
}));

vi.mock(import("../../src/client/hooks/useReachabilityCheck.svelte"), () => ({
  createReachabilityCheck: () => ({
    phase: "done",
    serverUp: null,
    claudeConnected: false,
    results: [],
  }),
}));

vi.mock(import("../../src/client/hooks/useClaudeCliStatus.svelte"), () => ({
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

vi.mock(import("../../src/client/hooks/useCoworkStatus.svelte"), () => ({
  createCoworkStatus: () => ({
    status: null,
    loading: false,
    error: null,
    refetch: vi.fn(async () => true),
  }),
}));

// The "AI models: Set up" button renders only with the flag on, on the
// connect step AND on Done; one case below presses it on Done. Every other
// case here is independent of the flag. Lit as the other mock-true files do
// (#1123, the flag-neutral tests).
vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants.js")>()),
  BYO_MODELS_ENABLED: true as typeof import("../../src/shared/constants.js").BYO_MODELS_ENABLED,
}));

import IntegrationWizardModal from "../../src/client/components/IntegrationWizardModal.svelte";

function pick(id: string, kind: "claude-code" | "claude-desktop" | "other-mcp"): PickedIntegration {
  const base = { id, label: id, configPath: `/home/u/${id}.json` };
  const config =
    kind === "claude-code"
      ? { ...base, kind, transport: "http" as const, url: "http://127.0.0.1:3479/mcp" }
      : kind === "claude-desktop"
        ? { ...base, kind, transport: "stdio" as const }
        : { ...base, kind, transport: "stdio" as const };
  return {
    id,
    config: config as PickedIntegration["config"],
    hasStoredSecret: false,
    keychainUnavailable: false,
  };
}

const row = (id: string, status: ApplyItemResult["status"]): ApplyItemResult =>
  status === "error"
    ? { id, status, code: "WRITE_FAILED" as never, message: "no" }
    : { id, status };

function mountAt(step: WizardStep, picked: PickedIntegration[], results: ApplyItemResult[]) {
  wizardStub.step = step;
  wizardStub.picked = picked;
  wizardStub.applyResults = results;
  const onClose = vi.fn();
  const view = render(IntegrationWizardModal, { props: { open: true, onClose } });
  return { ...view, onClose };
}

function q(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no ${id}`);
  return el;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
});

afterEach(() => {
  cleanup();
  wizardStub.picked = [];
  wizardStub.applyResults = [];
  wizardStepCell.reset();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("IntegrationWizardModal — the close reason (#1123)", () => {
  const claudeSetUp: Array<[string, PickedIntegration, string]> = [
    ["a Claude Code row applied", pick("cc", "claude-code"), "cc"],
    ["a Claude Desktop row applied", pick("cd", "claude-desktop"), "cd"],
  ];
  for (const [name, p, id] of claudeSetUp) {
    it(`Done, ${name}, closed by Done's button: claude-set-up`, async () => {
      const m = mountAt("done", [p], [row(id, "applied")]);
      await tick();
      await fireEvent.click(q(m.container, "integration-wizard-done-close"));
      expect(m.onClose).toHaveBeenCalledTimes(1);
      expect(m.onClose).toHaveBeenCalledWith("claude-set-up");
    });
  }

  it("Done, a Claude row applied, closed by Escape: claude-set-up", async () => {
    const m = mountAt("done", [pick("cc", "claude-code")], [row("cc", "applied")]);
    await tick();
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(m.onClose).toHaveBeenCalledWith("claude-set-up");
  });

  const other: Array<[string, PickedIntegration[], ApplyItemResult[]]> = [
    ["a Claude Code row skipped", [pick("cc", "claude-code")], [row("cc", "skipped")]],
    ["a Claude Desktop row errored", [pick("cd", "claude-desktop")], [row("cd", "error")]],
    ["only another MCP client applied", [pick("om", "other-mcp")], [row("om", "applied")]],
  ];
  for (const [name, picked, results] of other) {
    it(`Done, ${name}: other`, async () => {
      const m = mountAt("done", picked, results);
      await tick();
      await fireEvent.click(q(m.container, "integration-wizard-done-close"));
      expect(m.onClose).toHaveBeenCalledWith("other");
    });
  }

  // Try again is offered only when a target failed: Claude applied, another
  // target failed, then Try again resets the wizard, so the close is "other".
  it("Claude applied and another target failed, Try again, then close: other (RW-4)", async () => {
    const m = mountAt(
      "done",
      [pick("cc", "claude-code"), pick("om", "other-mcp")],
      [row("cc", "applied"), row("om", "error")],
    );
    await tick();
    await fireEvent.click(q(m.container, "integration-wizard-done-retry"));
    await tick();
    expect(wizardStub.step).toBe("connect");
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(m.onClose).toHaveBeenCalledWith("other");
  });

  // The lit design, quoted from the brief on #1123 (issuecomment-6965850014,
  // R1.1 item 1): "The Set up button's direct `onClose()` gives `"other"`", and
  // its case table: "Presses "AI models: Set up" in the wizard | never;
  // Settings opens alone". On Done with Claude applied, a build that routed the
  // button through `close()` would give "claude-set-up" here.
  it("Done, a Claude row applied, the AI models Set up button: other", async () => {
    const m = mountAt("done", [pick("cc", "claude-code")], [row("cc", "applied")]);
    await tick();
    await fireEvent.click(q(m.container, "integration-wizard-models-setup"));
    expect(m.onClose).toHaveBeenCalledTimes(1);
    expect(m.onClose).toHaveBeenCalledWith("other");
  });

  // A step other than Done is "other" even with a Claude row's results present,
  // so the reason is keyed on the step, not on the rows alone.
  for (const step of ["connect", "applying", "error"] as const) {
    it(`closed from the ${step} step: other`, async () => {
      const m = mountAt(step, [pick("cc", "claude-code")], [row("cc", "applied")]);
      await tick();
      await fireEvent.keyDown(window, { key: "Escape" });
      expect(m.onClose).toHaveBeenCalledWith("other");
    });
  }
});
