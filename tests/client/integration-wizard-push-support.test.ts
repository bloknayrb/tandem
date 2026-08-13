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

import { CLAUDE_PLUGIN_INSTALL_COMMANDS } from "../../src/shared/constants.js";
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

  it("keeps the push-mode block off a stdio-only selection entirely", async () => {
    // Guards the `whatsNext !== "stdio-only"` half of the gate: with only
    // Claude Desktop picked, the per-row line is the whole story and a block of
    // Claude Code push routes would be advice the user cannot act on.
    wizardStub.channelRegistered = false;
    const { container } = mountDone([pickedDesktop()], [applied("claude-desktop-1")]);
    await tick();
    expect(q(container, "integration-wizard-push-mode")).toBeNull();
    expect(q(container, "integration-wizard-plugin")).toBeNull();
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

/**
 * The push-mode block's copy (#1389, #1390).
 *
 * #1389: the block has two branches keyed on whether the channel shim is
 * registered, and the registered one used to drop the built-in Monitor watch
 * entirely — reading as if the `--dangerously-load-development-channels` flag
 * were the only route a hand-started session had. Registering the shim does not
 * take the watch away, so the user who followed the wizard's own advice was the
 * one who lost the free option.
 *
 * #1390: the two plugin install commands existed only as `tandem setup` console
 * output, which a desktop-app user never sees — and the desktop app is the
 * primary distribution channel. Tandem cannot run them either way (registering
 * a marketplace is Claude Code's own trust boundary), so showing them IS the
 * fix, and showing them in both branches is the part that keeps regressing.
 */
describe("IntegrationWizardModal — push-mode copy (#1389, #1390)", () => {
  afterEach(() => {
    cleanup();
    wizardStub.picked = [];
    wizardStub.applyResults = [];
    wizardStub.channelRegistered = null;
    vi.clearAllMocks();
  });

  function mountPushMode(channelRegistered: boolean) {
    wizardStub.channelRegistered = channelRegistered;
    return mountDone([pickedCode()], [applied("claude-code-1")]);
  }

  for (const registered of [true, false]) {
    const branch = registered ? "channel registered" : "channel not registered";

    it(`names the built-in Monitor watch when the ${branch}`, async () => {
      const { container } = mountPushMode(registered);
      await tick();
      const text = q(container, "integration-wizard-push-mode")?.textContent ?? "";
      expect(text).toMatch(/built-in Monitor/i);
      // The precondition, not just the option: it is granted per account, so a
      // user told to use it without being told it may not be there reads a
      // missing tool as Tandem being broken.
      expect(text).toMatch(/per account/i);
    });

    it(`offers the plugin install commands when the ${branch}`, async () => {
      const { container } = mountPushMode(registered);
      await tick();
      const commands = q(container, "integration-wizard-plugin-commands")?.textContent ?? "";
      for (const cmd of CLAUDE_PLUGIN_INSTALL_COMMANDS) expect(commands).toContain(cmd);
      expect(q(container, "integration-wizard-plugin-copy")).toBeTruthy();
    });

    it(`does not tell the user to ask Claude to watch when the ${branch}`, async () => {
      // The watch is automatic on first Tandem use as of the ADR-049 amendment;
      // asking is a recovery step. `tests/docs/wake-availability-claims.test.ts`
      // bans this wording on README and the user guide — this wizard carries the
      // same claim and was written before the correction.
      const { container } = mountPushMode(registered);
      await tick();
      expect(q(container, "integration-wizard-push-mode")?.textContent ?? "").not.toMatch(
        /ask Claude to watch/i,
      );
    });
  }

  it("keeps the flag as the registered branch's own instruction, with its argument", async () => {
    // A bare `--dangerously-load-development-channels` does not enable the
    // Tandem channel; it needs `server:tandem-channel` after it. The old copy
    // named the flag alone, which is a command that silently does nothing.
    const { container } = mountPushMode(true);
    await tick();
    const text = q(container, "integration-wizard-push-mode")?.textContent ?? "";
    expect(text).toContain("--dangerously-load-development-channels server:tandem-channel");
  });

  it("points an unregistered user back here for the gate-independent route", async () => {
    const { container } = mountPushMode(false);
    await tick();
    const text = q(container, "integration-wizard-push-mode")?.textContent ?? "";
    expect(text).toMatch(/channel shim/i);
    // Not merely mentioned — offered as the answer to both Monitor gates being
    // shut, which is the only thing that makes it worth a flag on every session.
    expect(text).toMatch(/neither gate|no Monitor tool/i);
  });

  it("copies both commands as one pasteable block", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { container } = mountPushMode(false);
    await tick();

    (q(container, "integration-wizard-plugin-copy") as HTMLButtonElement).click();
    // Two ticks: the label is written after an awaited `writeText`, so it lands
    // a microtask after the click's own flush.
    await tick();
    await tick();

    expect(writeText).toHaveBeenCalledWith(CLAUDE_PLUGIN_INSTALL_COMMANDS.join("\n"));
    expect(q(container, "integration-wizard-plugin-copy")?.textContent?.trim()).toBe("Copied");
    vi.unstubAllGlobals();
  });

  it("says so on the button when the clipboard refuses", async () => {
    // The WebView denies clipboard access in more situations than it grants it,
    // and a silent no-op button is indistinguishable from a copy that worked.
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error("denied");
        }),
      },
    });
    const { container } = mountPushMode(false);
    await tick();

    (q(container, "integration-wizard-plugin-copy") as HTMLButtonElement).click();
    await tick();
    await tick();

    expect(q(container, "integration-wizard-plugin-copy")?.textContent ?? "").toMatch(
      /Copy failed/i,
    );
    // The commands stay on screen to be selected by hand.
    expect(q(container, "integration-wizard-plugin-commands")?.textContent ?? "").toContain(
      CLAUDE_PLUGIN_INSTALL_COMMANDS[0],
    );
    vi.unstubAllGlobals();
  });
});
