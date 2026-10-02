// @vitest-environment happy-dom

/**
 * Cowork setup ships dark (ADR-055) — the client half, at the shipped `false`.
 *
 * Every other Cowork suite either mounts a Cowork component directly or mocks
 * `COWORK_ENABLED` on, so none of them can see a gate removed from a PARENT.
 * This file runs the parents with the real literal, the real
 * `createCoworkStatus`, and Tauri genuinely on (`window.__TAURI_INTERNALS__`,
 * not a module mock of `isTauriRuntime`), which is the one configuration a
 * shipped desktop build is in.
 *
 * The claim is "a dark desktop build sends no `cowork_*` invoke", so the
 * instrument is the invoke spy rather than the DOM alone: the wizard's row and
 * its poller are two separate gated expressions, and a row that stays hidden
 * says nothing about whether the poller still ran.
 *
 * `App.svelte` is pinned from source. Nothing mounts App in tests (it needs a
 * Hocuspocus provider), and its gate is the one that matters most: the
 * admin-declined modal's poller runs unconditionally once mounted, every 30 s,
 * on every desktop run.
 *
 * The tutorial lives in `use-tutorial-cowork-dark.svelte.test.ts`: it needs
 * `createCoworkStatus` replaced, and `vi.mock` is file-wide.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTauriRuntime } from "../../src/client/cowork/cowork-helpers";
import type { TandemSettings } from "../../src/client/hooks/useTandemSettings.svelte";
import { COWORK_ENABLED } from "../../src/shared/constants";
import { coworkStatusFixture } from "../helpers/cowork-status-fixture";

const invokeSpy = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeSpy(cmd, args),
}));

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

vi.mock(import("../../src/client/hooks/useIntegrationWizard.svelte"), () => ({
  createIntegrationWizard: () => ({
    step: "connect" as const,
    detecting: false,
    existing: [],
    picked: [],
    applyResults: [],
    errorMessage: null,
    channelRegistered: null,
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

// With Tauri genuinely on, the wizard's autostart hook would go live.
vi.mock(import("../../src/client/hooks/useAutostart.svelte.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/hooks/useAutostart.svelte.js")>()),
  createAutostart: () => ({
    status: null,
    loading: false,
    error: null,
    toggle: vi.fn(async (_next: boolean) => {}),
  }),
}));

import IntegrationWizardModal from "../../src/client/components/IntegrationWizardModal.svelte";
import OnboardingTutorial from "../../src/client/components/OnboardingTutorial.svelte";
import SettingsClaudeCodeTab from "../../src/client/components/settings-tabs/SettingsClaudeCodeTab.svelte";

const byTestId = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-testid='${id}']`);

const coworkInvokes = () =>
  invokeSpy.mock.calls.map(([cmd]) => cmd).filter((cmd) => cmd.startsWith("cowork_"));

/**
 * Long enough for an ungated poller to have fired: its effect awaits the
 * dynamic `import("@tauri-apps/api/core")` and then invokes immediately, with
 * no interval in front of the first call.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("Cowork ships dark (ADR-055): the desktop client", () => {
  beforeEach(() => {
    invokeSpy.mockClear();
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ integrations: [] }) }),
    );
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.unstubAllGlobals();
  });

  it("runs at the shipped literal, with Tauri genuinely on", () => {
    // The controls. If either stops holding, every negative below passes for
    // the wrong reason: the browser build never showed Cowork to begin with.
    expect(COWORK_ENABLED).toBe(false);
    expect(isTauriRuntime()).toBe(true);
  });

  it("Settings → AI Assistant mounts no Cowork block and invokes nothing", async () => {
    const { container } = render(SettingsClaudeCodeTab, {
      props: {
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
      },
    });

    await waitFor(() => {
      expect(byTestId(container, "settings-modal-open-integration-wizard")).toBeTruthy();
    });
    // The fallback renders synchronously with the `{#await}`, so its absence
    // cannot be an artefact of checking before the lazy import resolved.
    expect(byTestId(container, "settings-modal-cowork-suspense-fallback")).toBeNull();
    await settle();
    expect(byTestId(container, "cowork-settings")).toBeNull();
    expect(coworkInvokes()).toEqual([]);
  });

  it("the wizard shows no Cowork row and its poller never runs", async () => {
    const { container } = render(IntegrationWizardModal, {
      props: { open: true, onClose: vi.fn() },
    });

    await waitFor(() => {
      expect(byTestId(container, "integration-wizard-more")).toBeTruthy();
    });
    expect(byTestId(container, "integration-wizard-cowork-setup")).toBeNull();
    expect(byTestId(container, "integration-wizard-more")?.textContent).not.toContain("Cowork");
    await settle();
    expect(coworkInvokes()).toEqual([]);
  });

  it("the tutorial card inserts no Cowork step even when handed an eligible status", () => {
    // `useTutorial` never produces a status while dark, so this prop is null in
    // the app. The component is gated anyway so its step count cannot disagree
    // with the hook's completion index; this is that gate's only witness.
    const { container } = render(OnboardingTutorial, {
      props: {
        currentStep: 3,
        onNext: vi.fn(),
        onDismiss: vi.fn(),
        coworkStatus: coworkStatusFixture(),
      },
    });
    expect(byTestId(container, "cowork-onboarding-step")).toBeNull();
    expect(container.textContent).toContain("You're ready!");
  });
});

describe("Cowork ships dark (ADR-055): App.svelte's admin-declined modal", () => {
  const app = readFileSync(
    join(import.meta.dirname, "..", "..", "src", "client", "App.svelte"),
    "utf8",
  );

  it("is mounted in exactly one place", () => {
    expect(app.match(/<CoworkAdminDeclinedModal\b/g)).toHaveLength(1);
  });

  it("sits directly under an {#if} that leads with COWORK_ENABLED", () => {
    const mount = app.indexOf("<CoworkAdminDeclinedModal");
    const open = app.lastIndexOf("{#if", mount);
    const condition = app.slice(open, app.indexOf("}", open) + 1);
    expect(condition).toBe("{#if COWORK_ENABLED && isTauriRuntime() && !shouldShowWizard}");
    // Nothing between the `{#if}` and the mount may close it.
    expect(app.slice(open, mount)).not.toContain("{/if}");
  });
});

/**
 * The cases above witness the parents that exist. This is the half that
 * notices a new one: a module that mounts a Cowork component or starts a
 * status or pre-flight hook is a new way to reach `cowork_*`, and it would
 * pass every other test here while doing so.
 */
describe("Cowork ships dark (ADR-055): who can reach a Cowork surface", () => {
  const CLIENT = join(import.meta.dirname, "..", "..", "src", "client");

  /** The Cowork surface itself: these mount and poll unconditionally by design. */
  const isLeaf = (rel: string) =>
    rel.startsWith("cowork/") ||
    /^components\/Cowork\w+\.svelte$/.test(rel) ||
    /^hooks\/useCowork\w+\.svelte\.ts$/.test(rel);

  // The component as an import specifier, quotes included: a bare filename
  // match also catches prose (`utils/checkbox-sync.ts` names one in a comment).
  const REACHES =
    /["'][^"']*\/Cowork(?:Settings|AdminDeclinedModal|OnboardingStep)\.svelte["']|\bcreate(?:CoworkStatus|SubnetPreflight)\s*\(/;

  const PARENTS = [
    "App.svelte",
    "components/IntegrationWizardModal.svelte",
    "components/OnboardingTutorial.svelte",
    "components/settings-tabs/SettingsClaudeCodeTab.svelte",
    "hooks/useTutorial.svelte.ts",
  ];
  /** Mounts all three ungated, and is stripped from the shipped build. */
  const DEV_ONLY = ["svelte-harness/registry.ts"];

  const reaching = readdirSync(CLIENT, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(?:svelte|ts)$/.test(e.name))
    .map((e) => join(e.parentPath, e.name))
    .map((abs) => ({
      rel: abs.slice(CLIENT.length + 1).replace(/\\/g, "/"),
      text: readFileSync(abs, "utf8"),
    }))
    .filter((f) => !isLeaf(f.rel) && REACHES.test(f.text));

  it("only the known parents do", () => {
    expect(reaching.map((f) => f.rel).sort()).toEqual([...PARENTS, ...DEV_ONLY].sort());
  });

  it("and every shipped one reads the literal", () => {
    const ungated = reaching
      .filter((f) => !DEV_ONLY.includes(f.rel) && !f.text.includes("COWORK_ENABLED"))
      .map((f) => f.rel);
    expect(ungated).toEqual([]);
  });
});
