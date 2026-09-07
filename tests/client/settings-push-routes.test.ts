// @vitest-environment happy-dom

/**
 * #1432 — the push routes need a home that survives dismissing the wizard.
 *
 * #1390 put the Tandem plugin's install commands in the wizard's push-mode
 * block. That block renders only under `step === "done"`, reached only by
 * completing an apply, and destroyed on dismiss — and reopening the wizard
 * lands on `connect`, not `done`. So a user who closed it once could reach the
 * commands again only by re-running an apply. These tests pin the persistent
 * copy in Settings → AI Assistant, its gating, and the honesty of the one
 * paragraph this feature authors.
 *
 * The shim paragraph is the load-bearing half. NOTHING in the app can register
 * the channel shim — `shouldRegisterChannelShim` is `override ?? false` and the
 * wizard's apply route passes no override — so every arm must name
 * `tandem setup --apply --with-channel-shim`, and the **desktop** arm must
 * carry `doctor.ts`'s caveat that the flag needs the npm package the desktop
 * app does not install (#1817 split the non-registered arm on
 * `isTauriRuntime()`, since the desktop build has no `tandem` command at all
 * to run that flag against).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TandemSettings } from "../../src/client/hooks/useTandemSettings.svelte";
import { CLAUDE_PLUGIN_INSTALL_COMMANDS } from "../../src/shared/constants.js";
import { coworkStatusFixture } from "../helpers/cowork-status-fixture";

// #1817: SettingsClaudeCodeTab's non-registered push-route arm splits on
// `isTauriRuntime()`. Mock it with a mutable cell (this file's precedent is
// `settings-claude-code-tab-cowork.test.ts:25-28`) so individual tests can
// force either branch; forcing Tauri-true also lazy-mounts CoworkSettings
// (`SettingsClaudeCodeTab.svelte:481-491`), whose `createCoworkStatus(() =>
// true)` holds a live `$effect` and a real `invoke` call, so those two are
// mocked alongside it (copied from that same file, `:25-47`).
let tauri = false;
vi.mock("../../src/client/cowork/cowork-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/cowork/cowork-helpers")>();
  return { ...actual, isTauriRuntime: () => tauri };
});
vi.mock("../../src/client/hooks/useCoworkStatus.svelte", () => ({
  createCoworkStatus: () => ({
    status: coworkStatusFixture({ vethernetCidr: null }),
    loading: false,
    error: null,
    refetch: vi.fn(async () => {}),
  }),
}));
vi.mock("../../src/client/cowork/cowork-invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/cowork/cowork-invoke")>()),
  loadInvoke: vi.fn(async () => vi.fn()),
  coworkToggleIntegration: vi.fn(async () => ({ ok: true })),
  coworkPreflightSubnet: vi.fn(async () => ({ status: "unavailable" })),
}));

import SettingsClaudeCodeTab from "../../src/client/components/settings-tabs/SettingsClaudeCodeTab.svelte";

function makeProps() {
  return {
    open: true,
    settings: {
      selectionDwellMs: 1000,
      selectionToolbar: true,
      marginView: false,
    } as TandemSettings,
    onUpdate: vi.fn(),
    connected: true,
    reconnectAttempts: 0,
    readOnly: false,
    notify: vi.fn(),
  };
}

const byTestId = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-testid='${id}']`);

/**
 * Route by URL. The tab makes two independent GETs and the arms under test
 * depend on which one answered what, so a single blanket `mockResolvedValue`
 * (what the sibling suites use) cannot express these cases.
 */
function mockApi(opts: {
  integrations?: { kind: string }[];
  integrationsOk?: boolean;
  existing?: unknown;
  existingOk?: boolean;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/api/integrations/existing")) {
        if (opts.existingOk === false) return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true, json: async () => opts.existing ?? { installs: [] } };
      }
      if (opts.integrationsOk === false) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => ({ integrations: opts.integrations ?? [] }) };
    }),
  );
}

const claudeCodeInstall = (channelValid: boolean) => ({
  installs: [
    {
      target: { kind: "claude-code", configPath: "/home/u/.claude.json" },
      status: "ok",
      ...(channelValid
        ? { channelEntry: { command: "node" }, channelValidation: { status: "valid" } }
        : {}),
    },
  ],
});

/** Text with whitespace and NBSPs flattened, so wrapped copy matches. */
const flat = (el: HTMLElement | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("Settings → AI Assistant — persistent push routes (#1432)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    tauri = false;
  });

  it("renders the section, with both plugin install commands verbatim", async () => {
    mockApi({ integrations: [{ kind: "claude-code" }] });
    const { container } = render(SettingsClaudeCodeTab, { props: makeProps() });

    await waitFor(() => {
      expect(byTestId(container, "settings-modal-push-routes")).toBeTruthy();
    });
    const section = byTestId(container, "settings-modal-push-routes") as HTMLElement;
    // Verbatim, from the shared constant — not a paraphrase a user cannot run.
    for (const cmd of CLAUDE_PLUGIN_INSTALL_COMMANDS) {
      expect(section.textContent).toContain(cmd);
    }
    // All three routes must be described, not just the plugin.
    expect(flat(section)).toContain("built-in Monitor watch");
    expect(flat(section)).toContain("channel shim");
  });

  it("copies the commands and announces the outcome from the live region", async () => {
    mockApi({ integrations: [{ kind: "claude-code" }] });
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { container } = render(SettingsClaudeCodeTab, { props: makeProps() });

    await waitFor(() => {
      expect(byTestId(container, "settings-modal-push-routes")).toBeTruthy();
    });
    const section = byTestId(container, "settings-modal-push-routes") as HTMLElement;
    const copyBtn = [...section.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Copy",
    );
    expect(copyBtn).toBeTruthy();
    copyBtn?.click();

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(CLAUDE_PLUGIN_INSTALL_COMMANDS.join("\n"));
    });
    await waitFor(() => {
      const status = section.querySelector("[role='status']");
      expect(status?.textContent?.trim()).toBe("Copied");
    });
  });

  it("hides the section when the only integration is Claude Desktop", async () => {
    // #1299: for a stdio target push does not fail, it does not exist. Offering
    // three routes that cannot apply is that bug pointed the other way.
    mockApi({ integrations: [{ kind: "claude-desktop" }] });
    const { container } = render(SettingsClaudeCodeTab, { props: makeProps() });

    await waitFor(() => {
      expect(byTestId(container, "settings-modal-connect-ai-callout")).toBeTruthy();
    });
    expect(byTestId(container, "settings-modal-push-routes")).toBeNull();
  });

  it("hides the section when the integrations load fails, keeping the error banner", async () => {
    mockApi({ integrationsOk: false });
    const { container } = render(SettingsClaudeCodeTab, { props: makeProps() });

    await waitFor(() => {
      expect(byTestId(container, "settings-modal-working-directory-load-error")).toBeTruthy();
    });
    expect(byTestId(container, "settings-modal-push-routes")).toBeNull();
  });

  it("says the shim is already registered only when it read that it is", async () => {
    mockApi({ integrations: [{ kind: "claude-code" }], existing: claudeCodeInstall(true) });
    const { container } = render(SettingsClaudeCodeTab, { props: makeProps() });

    await waitFor(() => {
      expect(flat(byTestId(container, "settings-modal-push-routes-shim"))).toContain(
        "already registered",
      );
    });
    const text = flat(byTestId(container, "settings-modal-push-routes-shim"));
    expect(text).toContain("claude --dangerously-load-development-channels server:tandem-channel");
  });

  for (const [label, opts] of [
    ["no channel entry", { existing: claudeCodeInstall(false) }],
    ["a failed read", { existingOk: false }],
  ] as const) {
    it(`names the CLI flag on ${label} (non-Tauri runtime)`, async () => {
      tauri = false;
      mockApi({ integrations: [{ kind: "claude-code" }], ...opts });
      const { container } = render(SettingsClaudeCodeTab, { props: makeProps() });

      await waitFor(() => {
        expect(byTestId(container, "settings-modal-push-routes-shim")).toBeTruthy();
      });
      const text = flat(byTestId(container, "settings-modal-push-routes-shim"));
      // The instruction must be the one that works. Nothing in the app can
      // register the shim, so anything pointing at the wizard is false.
      expect(text).toContain("tandem setup --apply --with-channel-shim");
      // #1817: the npm-package caveat moved to the Tauri-only arm — this
      // (non-Tauri) arm has a working `tandem` command, so it does not carry it.
      expect(text).not.toContain("npm install -g tandem-editor");
      // And it must NOT claim a state it could not read.
      expect(text).not.toContain("already registered");
    });
  }

  // #1817: the desktop app has no `tandem` command at all, so the
  // non-registered arm splits on `isTauriRuntime()` — the desktop copy names
  // the npm install step before the setup command that needs it.
  it("names the npm install step before the setup command under Tauri", async () => {
    tauri = true;
    mockApi({ integrations: [{ kind: "claude-code" }], existing: claudeCodeInstall(false) });
    const { container } = render(SettingsClaudeCodeTab, { props: makeProps() });

    await waitFor(() => {
      expect(byTestId(container, "settings-modal-push-routes-shim")).toBeTruthy();
    });
    const text = flat(byTestId(container, "settings-modal-push-routes-shim"));
    expect(text).toContain("npm install -g tandem-editor@latest");
    expect(text).toContain("desktop app doesn't include the");
    expect(text).toContain("Keep the global installed");
    expect(text).toContain("tandem setup --apply --with-channel-shim");
  });

  it("names the setup command with no npm install step off Tauri", async () => {
    tauri = false;
    mockApi({ integrations: [{ kind: "claude-code" }], existing: claudeCodeInstall(false) });
    const { container } = render(SettingsClaudeCodeTab, { props: makeProps() });

    await waitFor(() => {
      expect(byTestId(container, "settings-modal-push-routes-shim")).toBeTruthy();
    });
    const text = flat(byTestId(container, "settings-modal-push-routes-shim"));
    expect(text).toContain("tandem setup --apply --with-channel-shim");
    expect(text).not.toContain("npm install -g tandem-editor");
  });
});

describe("PushRoutesInfo — reduced motion (#1432)", () => {
  /**
   * The copy button came with `.iw-btn`'s transition, and the wizard neutralises
   * it TWICE — once for the OS preference, once for the in-app `reduceMotion`
   * setting (`body.tandem-reduce-motion`, applied in App.svelte). Svelte
   * compiles both with the wizard's scope hash, so neither reaches a button
   * rendered by this component; they had to be re-authored here.
   *
   * Source-level rather than rendered: happy-dom evaluates no media queries and
   * jsdom-style CSSOM cannot answer "would this transition be suppressed". This
   * pins presence, not effect — stated plainly rather than dressed up.
   */
  const src = readFileSync(
    join(import.meta.dirname, "..", "..", "src", "client", "components", "PushRoutesInfo.svelte"),
    "utf-8",
  );

  it("carries a transition on the copy button", () => {
    expect(src).toMatch(/\.pr-copy-btn\s*\{[^}]*transition:/);
  });

  it("suppresses it for the OS preference", () => {
    expect(src).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.pr-copy-btn\s*\{[^}]*transition:\s*none/,
    );
  });

  it("suppresses it for the in-app reduceMotion setting", () => {
    expect(src).toMatch(
      /:global\(body\.tandem-reduce-motion\)\s*\.pr-copy-btn\s*\{[^}]*transition:\s*none/,
    );
  });
});
