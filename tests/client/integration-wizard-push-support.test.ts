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

import { cleanup, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetClientLog, readClientLog } from "../../src/client/utils/client-log";

import { CLAUDE_PLUGIN_INSTALL_COMMANDS } from "../../src/shared/constants.js";
import type { ApplyItemResult } from "../../src/shared/integrations/contract.js";
import { coworkStatusFixture } from "../helpers/cowork-status-fixture";
import { wizardStepCell } from "../helpers/wizard-step-cell.svelte";

// Mutable stubs the mocked hooks return; each test sets them BEFORE render.
const wizardStub: {
  picked: unknown[];
  applyResults: ApplyItemResult[];
  channelRegistered: boolean | null;
  /**
   * Delegated to a `$state` cell (#1432). A plain field here would be read
   * through the mock's getter without creating a reactive dependency, so
   * changing it would re-render nothing — see `wizard-step-cell.svelte.ts` for
   * what that hid.
   */
  step: string;
} = {
  picked: [],
  applyResults: [],
  channelRegistered: null,
  get step() {
    return wizardStepCell.value;
  },
  set step(next: string) {
    wizardStepCell.set(next);
  },
};

vi.mock("../../src/client/hooks/useIntegrationWizard.svelte", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createIntegrationWizard: () => ({
    // A GETTER, not a frozen literal (#1432). It was `step: "done"` while the
    // retry test below wrote `wizardStub.step` — a field nothing read, which
    // `tests/` being outside every tsconfig let through silently. The block
    // therefore never unmounted, so that test measured the manual
    // `pluginCopyResult = ""` while its comment described the unmount. With the
    // copy state now living in `PushRoutesInfo`, the unmount IS the reset, and
    // the mock has to model `step` faithfully for the test to reach it.
    get step() {
      return wizardStub.step;
    },
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
    reset: vi.fn(() => {
      // The real `reset()` sets `step = "connect"` (useIntegrationWizard.svelte.ts).
      wizardStub.step = "connect";
    }),
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

// Mutable, defaulting to `null` (no Cowork row) so the push-mode assertions
// below see the layout they were written against. One test flips it to reach
// the Cowork sub-view, which is the only way to unmount and remount the
// push-routes block.
const coworkStub: { status: unknown } = { status: null };

vi.mock("../../src/client/hooks/useCoworkStatus.svelte", () => ({
  createCoworkStatus: () => ({
    get status() {
      return coworkStub.status;
    },
    loading: false,
    error: null,
    refetch: vi.fn(async () => {}),
  }),
}));

vi.mock("../../src/client/cowork/cowork-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/cowork/cowork-helpers")>();
  return { ...actual, isTauriRuntime: () => coworkStub.status !== null };
});

// Spread, not re-declare — see `cowork-settings-mounted.test.ts` for the
// subset-drift this avoids.
vi.mock("../../src/client/cowork/cowork-invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/cowork/cowork-invoke")>()),
  loadInvoke: vi.fn(async () => vi.fn()),
  coworkToggleIntegration: vi.fn(async () => ({ ok: true })),
  coworkPreflightSubnet: vi.fn(async () => ({ status: "unavailable" })),
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
    wizardStepCell.reset();
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
 * primary distribution channel. Tandem shows them rather than running them (the
 * reason is on `CLAUDE_PLUGIN_INSTALL_COMMANDS`), so putting them where a
 * desktop user can see them IS the fix — and reaching both branches is the part
 * that keeps regressing.
 */
describe("IntegrationWizardModal — push-mode copy (#1389, #1390)", () => {
  afterEach(() => {
    cleanup();
    wizardStub.picked = [];
    wizardStub.applyResults = [];
    wizardStub.channelRegistered = null;
    wizardStepCell.reset();
    coworkStub.status = null;
    vi.clearAllMocks();
    // Here rather than at the end of each clipboard test: `navigator` is a
    // global and the stub replaces it wholesale (no `userAgent`, no
    // `platform`). Unstubbing in the test body means one real assertion failure
    // leaves every later test in the worker running against the stripped
    // object, turning a single red into a cascade.
    vi.unstubAllGlobals();
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

    it(`labels the branch it rendered when the ${branch}`, async () => {
      // `data-push-mode` had no reader at all after #1389 renamed its values
      // from push/polling to shim/no-shim — dead metadata with a silently
      // changed contract. Asserted rather than deleted: it is the only handle
      // on WHICH arm rendered, and both arms now share one visual treatment.
      const { container } = mountPushMode(registered);
      await tick();
      expect(q(container, "integration-wizard-push-mode")?.getAttribute("data-push-mode")).toBe(
        registered ? "shim" : "no-shim",
      );
    });

    it(`names the plugin's version floor when the ${branch}`, async () => {
      // `docs/cli.md` records the failure mode this prevents: below 2.1.212 the
      // install succeeds and the monitor never runs, with nothing to say so. A
      // wizard that recommends the plugin without the floor sends a desktop
      // user to a silent no-op. `tests/docs/monitor-arming-claims.test.ts` does
      // read this file (it is in that suite's CARRIERS), but only to ban
      // unconditional-arming phrasings — nothing there asserts the floor is
      // PRESENT, so that assertion has to live here.
      const { container } = mountPushMode(registered);
      await tick();
      expect(q(container, "integration-wizard-push-mode")?.textContent ?? "").toContain("2.1.212");
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
    // Whitespace-normalised: the command lives in an inline `<code>` whose
    // source line-breaks would land in `textContent` verbatim. Without this the
    // test goes red on a re-wrap that changes no behaviour, and the natural
    // "fix" for that is to delete the assertion.
    const text = (q(container, "integration-wizard-push-mode")?.textContent ?? "").replace(
      /\s+/g,
      " ",
    );
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

  /** Click Copy and wait for the live region to settle on `expected`. */
  async function clickCopy(container: HTMLElement, expected: RegExp): Promise<void> {
    (q(container, "integration-wizard-plugin-copy") as HTMLButtonElement).click();
    // `waitFor`, not a tick count: the handler clears the status, awaits a
    // flush, then awaits `writeText` — a hand-counted number of hops is a
    // constant nobody can re-derive when the chain changes.
    await waitFor(() => {
      expect(q(container, "integration-wizard-plugin-copy-status")?.textContent ?? "").toMatch(
        expected,
      );
    });
  }

  it("copies both commands as one pasteable block", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { container } = mountPushMode(false);
    await tick();

    await clickCopy(container, /Copied/);

    expect(writeText).toHaveBeenCalledWith(CLAUDE_PLUGIN_INSTALL_COMMANDS.join("\n"));
    // The outcome is announced from a live region beside the button, not from
    // the button's own label — a changed accessible name on a button nobody is
    // focused on is announced by nothing.
    const status = q(container, "integration-wizard-plugin-copy-status");
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.textContent?.trim()).toBe("Copied");
  });

  it("empties the status between copies, so a repeat click is announced too", async () => {
    // A live region that does not CHANGE announces nothing. Re-assigning the
    // same string mutates no text node, so without the clear the second click
    // is silent — indistinguishable from an unwired button for exactly the
    // user this region exists for.
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => {}) } });
    const { container } = mountPushMode(false);
    await tick();

    await clickCopy(container, /Copied/);

    const status = q(container, "integration-wizard-plugin-copy-status") as HTMLElement;
    (q(container, "integration-wizard-plugin-copy") as HTMLButtonElement).click();
    // Same node throughout — the region must never be replaced, only refilled.
    await waitFor(() => {
      expect(status.textContent?.trim()).toBe("");
    });
    await waitFor(() => {
      expect(status.textContent?.trim()).toBe("Copied");
    });
    expect(q(container, "integration-wizard-plugin-copy-status")).toBe(status);
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
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    _resetClientLog();
    const { container } = mountPushMode(false);
    await tick();

    await clickCopy(container, /Couldn't copy/i);

    // The commands stay on screen to be selected by hand.
    expect(q(container, "integration-wizard-plugin-commands")?.textContent ?? "").toContain(
      CLAUDE_PLUGIN_INSTALL_COMMANDS[0],
    );
    // The user-facing string is the same for every clipboard failure, so the log
    // is the only thing that separates a denied permission from a missing API
    // from a CSP rejection. Without this the catch could stop logging and
    // nothing would notice.
    // Prefix is `[push-routes]` since #1432: the same component now renders in
    // Settings → AI Assistant, where a log blaming "[wizard]" names a surface
    // the user never opened. The console line is emitted by `logClientWarning`
    // itself (`[scope] event:`), so this assertion also pins the scope.
    expect(warn).toHaveBeenCalledWith("[push-routes] clipboard write failed:", expect.any(Error));
    // …and since #1439 it also lands in the client log, which the diagnostics
    // report drains — the console alone is a sink with no reader in a release
    // desktop build. The error NAME is the payload: it is what separates a
    // denied permission from a missing API from a policy rejection.
    expect(readClientLog()).toEqual([
      expect.objectContaining({
        level: "warn",
        scope: "push-routes",
        event: "clipboard write failed",
        detail: "Error: denied",
      }),
    ]);
  });

  it("does not carry a copy status back from the Cowork sub-view", async () => {
    // The push-routes block unmounts with the main view. A surviving status
    // remounts CREATED WITH its content, which is a live region announced by
    // nothing — #1376's defect, reintroduced inside the fix for it.
    coworkStub.status = coworkStatusFixture();
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => {}) } });
    const { container } = mountPushMode(false);
    await tick();

    await clickCopy(container, /Copied/);

    (q(container, "integration-wizard-cowork-setup") as HTMLButtonElement).click();
    await tick();
    expect(q(container, "integration-wizard-plugin-copy-status")).toBeNull();

    (q(container, "integration-wizard-cowork-back") as HTMLButtonElement).click();
    await waitFor(() => {
      expect(q(container, "integration-wizard-plugin-copy-status")).toBeTruthy();
    });
    expect(q(container, "integration-wizard-plugin-copy-status")?.textContent?.trim()).toBe("");
  });

  it("drops a copy result that lands after the user has left for the sub-view", async () => {
    // The clear is synchronous and the write is two awaits later, so a clear
    // alone cannot dominate an in-flight copy. Click Copy, click the Cowork row
    // before the clipboard settles, and without the token the continuation
    // writes "Copied" into an unmounted region — which then remounts holding
    // it, which is the very thing the clear exists to prevent.
    coworkStub.status = coworkStatusFixture();
    let release: (() => void) | undefined;
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        ),
      },
    });
    const { container } = mountPushMode(false);
    await tick();

    (q(container, "integration-wizard-plugin-copy") as HTMLButtonElement).click();
    await tick();
    (q(container, "integration-wizard-cowork-setup") as HTMLButtonElement).click();
    await tick();

    // The clipboard answers only now, with the block unmounted.
    release?.();
    await tick();
    await tick();

    (q(container, "integration-wizard-cowork-back") as HTMLButtonElement).click();
    await waitFor(() => {
      expect(q(container, "integration-wizard-plugin-copy-status")).toBeTruthy();
    });
    expect(q(container, "integration-wizard-plugin-copy-status")?.textContent?.trim()).toBe("");
  });

  /**
   * #1432. NOTHING in the app registers the channel shim: the apply route calls
   * `shouldRegisterChannelShim` with no override and it returns
   * `override ?? false`, and that call site says so outright — "There is
   * deliberately NO wizard checkbox … any docs claiming otherwise are wrong
   * (that claim was in three places until 2026-08-09)."
   *
   * The unregistered arm here said "come back here and register the channel
   * shim" until #1432 — a FOURTH instance, written four days after that sweep.
   * The registered arm said the shim was "registered HERE", the ambiguity that
   * makes the false one read as consistent, so both were rewritten.
   *
   * `tests/docs/channel-shim-optin-claims.test.ts` guards the wording across
   * every surface by regex; this one proves the corrected copy actually reaches
   * the screen, which the regex cannot see.
   */
  it("tells the user the ONLY thing that registers the shim: the CLI flag", async () => {
    const { container } = mountPushMode(false);
    await tick();
    const block = q(container, "integration-wizard-push-mode") as HTMLElement;
    const text = (block.textContent ?? "").replace(/\s+/g, " ");

    expect(text).toContain("tandem setup --apply --with-channel-shim");
    // doctor.ts's caveat. Omitting it sends a desktop user — the majority, and
    // the reason #1390 exists — to a binary their install does not ship.
    expect(text).toContain("which the desktop app does not install");
    // The route it must NOT offer.
    expect(text).not.toMatch(/come back here and register/i);
  });

  it("does not imply the wizard registered the shim when one is already there", async () => {
    const { container } = mountPushMode(true);
    await tick();
    const text = (
      (q(container, "integration-wizard-push-mode") as HTMLElement).textContent ?? ""
    ).replace(/\s+/g, " ");

    expect(text).toContain("already registered for Claude Code");
    expect(text).not.toMatch(/registered here/i);
  });

  /**
   * The pointer at the durable home, gated (#1432).
   *
   * Settings → AI Assistant renders the section on `hasIntegration` — an
   * `integrations.json` entry with `kind === "claude-code"`. Reaching "done"
   * implies the persist returned 200, so `picked` IS that flag one screen
   * earlier. Unconditional, the sentence would be false for an `other-mcp`-only
   * apply, which reaches this same block: it would point at a section that
   * never renders.
   */
  it("points at Settings only when a Claude Code entry will be there", async () => {
    wizardStub.channelRegistered = false;
    const { container: withCode } = mountDone([pickedCode()], [applied("claude-code-1")]);
    await tick();
    expect(q(withCode, "integration-wizard-settings-pointer")).toBeTruthy();
    expect(
      (q(withCode, "integration-wizard-settings-pointer")?.textContent ?? "").replace(/\s+/g, " "),
    ).toContain("AI Assistant");
    cleanup();

    wizardStub.channelRegistered = false;
    const { container: otherOnly } = mountDone(
      [
        {
          id: "other-1",
          config: {
            kind: "other-mcp",
            id: "other-1",
            label: "Some MCP client",
            configPath: "/home/u/.other.json",
            transport: "http",
            url: "http://127.0.0.1:3479/mcp",
          },
          hasStoredSecret: false,
          keychainUnavailable: false,
        },
      ],
      [applied("other-1")],
    );
    await tick();
    expect(q(otherOnly, "integration-wizard-settings-pointer")).toBeNull();
  });

  it("does not carry a copy status through a retry either", async () => {
    // `retryDetection` resets the status for the same reason `openCoworkView`
    // does — `wizard.reset()` takes `step` out of "done", which is what the
    // push-routes block gates on, so the block unmounts and would remount
    // holding "Copied". Its comment claimed parity with `openCoworkView`; the
    // tests did not, and deleting both lines here left the suite green.
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => {}) } });
    wizardStub.channelRegistered = false;
    // One error alongside the applied target, so the done step offers "Try
    // again" while the push-routes block is still on screen.
    const { container } = mountDone(
      [pickedCode(), pickedDesktop()],
      [applied("claude-code-1"), { id: "claude-desktop-1", status: "error", error: "nope" }],
    );
    await tick();

    await clickCopy(container, /Copied/);

    (q(container, "integration-wizard-done-retry") as HTMLButtonElement).click();
    await tick();

    // Back to "done" the way the wizard gets there, and the region must be
    // empty rather than remounting with its old text.
    wizardStub.step = "done";
    await waitFor(() => {
      expect(q(container, "integration-wizard-plugin-copy-status")).toBeTruthy();
    });
    expect(q(container, "integration-wizard-plugin-copy-status")?.textContent?.trim()).toBe("");
  });

  it("survives a WebView with no clipboard API at all", async () => {
    // Not the same path as a rejecting `writeText`: this throws a TypeError on
    // the property access itself. The `try` covers it only because the access
    // is inside the block — moving it out to a `const` above would reintroduce
    // an unhandled rejection with the same visible symptom.
    vi.stubGlobal("navigator", {});
    const { container } = mountPushMode(false);
    await tick();

    await clickCopy(container, /Couldn't copy/i);
  });
});
