// @vitest-environment happy-dom

/**
 * The wizard's offer to install Claude Code for a Claude Desktop setup (#2199).
 * Opt-in, never pre-selected: it shows only beside a detected Claude Desktop
 * with no Claude Code anywhere, its Install is a secondary button, and the card
 * that a successful install brings is ticked because the click was the opt-in
 * (Bryan, 2026-10-14). Mounted with the two stateful hooks stubbed, like
 * `integration-wizard-install.test.ts`.
 */

import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  PickedIntegration,
  WizardStep,
} from "../../src/client/hooks/useIntegrationWizard.svelte";
import type {
  ClaudeCliPresence,
  ExistingMcpInstall,
} from "../../src/shared/integrations/contract.js";
import type { TandemClaudeAfterSetup } from "../../src/shared/launcher/contract.js";

// `presence` is reactive: an install moves it on while the offer is mounted.
const presenceCell = reactiveCell<ClaudeCliPresence | null>(null);
const cliStub: {
  presence: ClaudeCliPresence | null;
  bareNameLaunchable: boolean | null;
  loading: boolean;
  error: string | null;
  installing: boolean;
  installError: string | null;
  install: ReturnType<typeof vi.fn<() => Promise<ClaudeCliPresence | null>>>;
  refetch: ReturnType<typeof vi.fn<() => Promise<void>>>;
} = {
  get presence() {
    return presenceCell.value;
  },
  set presence(next) {
    presenceCell.value = next;
  },
  bareNameLaunchable: null,
  loading: false,
  error: null,
  installing: false,
  installError: null,
  install: vi.fn(async () => null),
  refetch: vi.fn(async () => {}),
};

vi.mock(import("../../src/client/hooks/useClaudeCliStatus.svelte"), () => ({
  createClaudeCliStatus: () => cliStub,
}));

const desktopInstall = {
  target: {
    kind: "claude-desktop",
    label: "Claude Desktop",
    configPath: "/home/u/claude_desktop_config.json",
  },
  status: "ok",
} as ExistingMcpInstall;
const codeInstall = {
  target: { kind: "claude-code", label: "Claude Code", configPath: "/home/u/.claude.json" },
  status: "missing",
} as ExistingMcpInstall;

const existing: ExistingMcpInstall[] = [];
// The done screen's inputs, changed while mounted (after the install).
const stepCell = reactiveCell<WizardStep>("connect");
const pickedCell = reactiveCell<PickedIntegration[]>([]);
const tandemClaudeCell = reactiveCell<TandemClaudeAfterSetup | null>(null);
const refreshDetected = vi.fn(
  async (_opts?: { pickNewOfKind?: string }): Promise<ExistingMcpInstall[]> => [],
);

vi.mock(import("../../src/client/hooks/useIntegrationWizard.svelte"), async (importOriginal) => ({
  ...(await importOriginal()),
  createIntegrationWizard: () => ({
    get step() {
      return stepCell.value;
    },
    detecting: false,
    get existing() {
      return existing;
    },
    get picked() {
      return pickedCell.value;
    },
    applyResults: [],
    get tandemClaude() {
      return tandemClaudeCell.value;
    },
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
    refreshDetected,
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

import IntegrationWizardModal from "../../src/client/components/IntegrationWizardModal.svelte";
import { reactiveCell } from "../helpers/reactive-cell.svelte";

function q(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function mount(props: Record<string, unknown> = {}) {
  return render(IntegrationWizardModal, { props: { open: true, onClose: vi.fn(), ...props } });
}

describe("IntegrationWizardModal — the Claude Code offer for a Claude Desktop setup (#2199)", () => {
  beforeEach(() => {
    existing.length = 0;
    existing.push(desktopInstall);
    cliStub.presence = "NOT_INSTALLED";
    cliStub.installing = false;
    cliStub.installError = null;
    cliStub.install = vi.fn(async () => "INSTALLED_NOT_ON_PATH" as const);
    cliStub.refetch = vi.fn(async () => {});
    stepCell.reset();
    pickedCell.reset();
    tandemClaudeCell.reset();
    refreshDetected.mockReset();
    refreshDetected.mockImplementation(async () => {
      existing.push(codeInstall);
      return [codeInstall];
    });
  });
  afterEach(() => cleanup());

  it("shows for Desktop with no Claude Code, as a SECONDARY action", async () => {
    const { container } = mount();
    await tick();
    expect(q(container, "integration-wizard-claude-code-offer")).not.toBeNull();
    const install = q(container, "integration-wizard-claude-code-offer-install");
    expect(install?.className).toContain("iw-btn-secondary");
    // Honest about Desktop, and no pricing claim.
    const text = q(container, "integration-wizard-claude-code-offer")?.textContent ?? "";
    expect(text).toContain("Claude Desktop answers only when you ask it");
    expect(text).not.toMatch(/free/i);
  });

  it.each([
    ["the CLI probe has not answered", () => (cliStub.presence = null)],
    [
      "Claude Code is installed and has a card",
      () => {
        cliStub.presence = "INSTALLED_ON_PATH";
        existing.push(codeInstall);
      },
    ],
    [
      "there is no Claude Desktop and no Claude Code card",
      () => {
        existing.length = 0;
        existing.push({
          ...codeInstall,
          target: { ...codeInstall.target, kind: "cursor" },
        } as never);
      },
    ],
  ])("hidden when %s", async (_l, arrange) => {
    arrange();
    const { container } = mount();
    await tick();
    expect(q(container, "integration-wizard-claude-code-offer")).toBeNull();
  });

  it("a Claude Code card with no Claude Code program: the same Install, as a repair", async () => {
    existing.push(codeInstall);
    const { container } = mount();
    await tick();
    const block = q(container, "integration-wizard-claude-code-offer");
    expect(block?.getAttribute("data-offer-phase")).toBe("missing");
    expect(block?.textContent).toContain("can't start its own");
    expect(q(container, "integration-wizard-claude-code-offer-install")).not.toBeNull();
  });

  it("installed but never run (no card yet), arriving from the chat offer: the run-it-once step, not a dead end", async () => {
    cliStub.presence = "INSTALLED_ON_PATH";
    const unasked = mount();
    await tick();
    // Unasked, nothing: it would be an install prompt nobody raised.
    expect(q(unasked.container, "integration-wizard-claude-code-offer")).toBeNull();
    unasked.unmount();
    const { container } = mount({ focusClaudeCodeOffer: true });
    await tick();
    expect(
      q(container, "integration-wizard-claude-code-offer")?.getAttribute("data-offer-phase"),
    ).toBe("not-detected");
    expect(q(container, "integration-wizard-claude-code-offer-recheck")).not.toBeNull();
  });

  it("the block stays mounted while the install's re-read runs, though presence has moved on", async () => {
    let release!: () => void;
    refreshDetected.mockImplementationOnce(
      () =>
        new Promise<ExistingMcpInstall[]>((resolve) => {
          release = () => {
            existing.push(codeInstall);
            resolve([codeInstall]);
          };
        }),
    );
    cliStub.install = vi.fn(async () => {
      cliStub.presence = "INSTALLED_NOT_ON_PATH";
      return "INSTALLED_NOT_ON_PATH" as const;
    });
    const { container } = mount();
    await tick();
    await fireEvent.click(
      q(container, "integration-wizard-claude-code-offer-install") as HTMLElement,
    );
    await waitFor(() => expect(refreshDetected).toHaveBeenCalled());
    await tick();
    // Not merely a block: the same Install the user clicked, not a flash of
    // the "run claude once" step, so focus has somewhere to stay.
    expect(q(container, "integration-wizard-claude-code-offer-install")).not.toBeNull();
    release();
    await waitFor(() =>
      expect(q(container, "integration-wizard-claude-code-offer-installed")).not.toBeNull(),
    );
  });

  it("Install installs, then re-reads WITHOUT starting over and ticks the new Claude Code card", async () => {
    const { container } = mount();
    await tick();
    await fireEvent.click(
      q(container, "integration-wizard-claude-code-offer-install") as HTMLElement,
    );
    await waitFor(() =>
      expect(q(container, "integration-wizard-claude-code-offer-installed")).not.toBeNull(),
    );
    expect(cliStub.install).toHaveBeenCalledTimes(1);
    expect(refreshDetected).toHaveBeenCalledWith({ pickNewOfKind: "claude-code" });
    // Focus lands on the note, not on <body> inside the focus trap.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        q(container, "integration-wizard-claude-code-offer-installed"),
      ),
    );
  });

  it("a failed install shows its error and leaves the offer in place", async () => {
    cliStub.install = vi.fn(async () => {
      cliStub.installError = "Install failed (exit 1).";
      return null;
    });
    const { container } = mount();
    await tick();
    await fireEvent.click(
      q(container, "integration-wizard-claude-code-offer-install") as HTMLElement,
    );
    await tick();
    expect(refreshDetected).not.toHaveBeenCalled();
    expect(q(container, "integration-wizard-claude-code-offer-install")).not.toBeNull();
  });

  it("installed but no card yet: Check again re-reads, keeping the user's picks", async () => {
    refreshDetected.mockImplementationOnce(async () => []);
    const { container } = mount();
    await tick();
    await fireEvent.click(
      q(container, "integration-wizard-claude-code-offer-install") as HTMLElement,
    );
    const recheck = await waitFor(() => {
      const el = q(container, "integration-wizard-claude-code-offer-recheck");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    await fireEvent.click(recheck);
    await waitFor(() =>
      expect(q(container, "integration-wizard-claude-code-offer-installed")).not.toBeNull(),
    );
    expect(cliStub.refetch).toHaveBeenCalled();
    expect(refreshDetected).toHaveBeenCalledTimes(2);
  });

  describe("the done screen after an install here", () => {
    async function installThenApply(
      tandemClaude: TandemClaudeAfterSetup,
      props: Record<string, unknown> = {},
    ) {
      const r = mount(props);
      await tick();
      await fireEvent.click(
        q(r.container, "integration-wizard-claude-code-offer-install") as HTMLElement,
      );
      await waitFor(() =>
        expect(q(r.container, "integration-wizard-claude-code-offer-installed")).not.toBeNull(),
      );
      pickedCell.value = [
        { id: "claude-code-1", config: { kind: "claude-code" } } as unknown as PickedIntegration,
      ];
      tandemClaudeCell.value = tandemClaude;
      stepCell.value = "done";
      await tick();
      return r;
    }
    const whatsNext = (c: HTMLElement) =>
      (q(c, "integration-wizard-whats-next")?.textContent ?? "").replace(/\s+/g, " ");

    it("an answer that timed out points at no line that is not there", async () => {
      const { container } = await installThenApply("unknown");
      expect(q(container, "integration-wizard-tandem-claude")).toBeNull();
      expect(whatsNext(container)).toContain("Claude Desktop works with Tandem as before.");
      expect(whatsNext(container)).not.toContain("line below");
    });

    it("a start waiting on sign-in does not say 'talk to Tandem's own Claude'", async () => {
      const { container } = await installThenApply("starting", {
        tandemClaudeLive: { running: false, remedy: "sign-in", standby: null },
        onLauncherRemedy: vi.fn(),
      });
      expect(whatsNext(container)).not.toContain("talk to Tandem's own Claude");
      expect(q(container, "integration-wizard-check-sign-in")).not.toBeNull();
    });

    it.each([
      ["a crash loop", { running: false, remedy: "restart", standby: null }],
      ["the licence refusing", { running: false, remedy: "ai-off", standby: null }],
      ["a standby", { running: false, remedy: "start", standby: "off" }],
    ] as const)(
      "a start overtaken by %s does not say 'talk to Tandem's own Claude'",
      async (_l, live) => {
        const { container } = await installThenApply("starting", { tandemClaudeLive: live });
        expect(whatsNext(container)).not.toContain("talk to Tandem's own Claude");
        expect(q(container, "integration-wizard-tandem-claude")).not.toBeNull();
      },
    );

    it("points at the line below with a space between the two sentences", async () => {
      const { container } = await installThenApply("held");
      expect(q(container, "integration-wizard-tandem-claude")).not.toBeNull();
      // Collapsing whitespace cannot add a space that is not there.
      expect(whatsNext(container)).toContain("as before. The line below");
    });

    it("control: a start that is under way does say it", async () => {
      const { container } = await installThenApply("starting");
      expect(whatsNext(container)).toContain("talk to Tandem's own Claude");
    });
  });

  it("opened from the chat panel's offer, it focuses the Install button", async () => {
    const { container } = mount({ focusClaudeCodeOffer: true });
    await tick();
    await tick();
    expect(document.activeElement).toBe(
      q(container, "integration-wizard-claude-code-offer-install"),
    );
  });
});
