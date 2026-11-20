// @vitest-environment happy-dom

/**
 * #1123 (LM Studio and "another local server", 2026-11-15), the dark
 * requirement: with `BYO_MODELS_ENABLED` false (forced by this file's mock),
 * the two surfaces a dark build mounts that this change touches still render
 * as before — Settings has no Models tab, and the wizard's AI-models row is
 * the "coming soon" line — and no string of the change's copy appears in
 * either.
 */

import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings } from "../../src/client/hooks/useTandemSettings";
import {
  endpointHint,
  LOCAL_REQUEST_LINE,
  LOCAL_SERVERS_LINE,
  PICKER_LOCAL_SUBTITLE,
  PICKER_MODEL_ID_HINT,
  PICKER_TITLE,
  pickerSaveReason,
} from "../../src/client/utils/local-model-copy";
import { BYO_MODELS_ENABLED } from "../../src/shared/constants";
import { LOCAL_ENDPOINT_PREFILL } from "../../src/shared/models/provider-ui";
import { installLocalStorageStub } from "../helpers/local-storage-stub.js";

// This whole file is the dark state, so it forces the flag off whatever the
// shipped literal says (#1123: the suite holds in both states).
vi.mock(import("../../src/shared/constants"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants")>()),
  BYO_MODELS_ENABLED: false as typeof import("../../src/shared/constants").BYO_MODELS_ENABLED,
}));

// isTauriRuntime → false: the Cowork row hides (its poller early-returns) but the
// AI-models row is not Tauri-gated, so it still renders. Keeps the mock set lean.
vi.mock(import("../../src/client/cowork/cowork-helpers"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/cowork/cowork-helpers")>();
  return { ...actual, isTauriRuntime: () => false };
});

vi.mock(import("../../src/client/hooks/useCoworkStatus.svelte"), () => ({
  createCoworkStatus: () => ({
    status: null,
    loading: false,
    error: null,
    refetch: vi.fn(async () => true),
  }),
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

// Empty-connect MCP state — keeps the MAIN view + More section rendered.
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

const { default: IntegrationWizardModal } = await import(
  "../../src/client/components/IntegrationWizardModal.svelte"
);
const { default: SettingsModal } = await import("../../src/client/components/SettingsModal.svelte");

const NEW_COPY = [
  LOCAL_SERVERS_LINE,
  LOCAL_REQUEST_LINE,
  endpointHint(""),
  endpointHint(LOCAL_ENDPOINT_PREFILL["local-ollama"]),
  endpointHint(LOCAL_ENDPOINT_PREFILL["local-lmstudio"]),
  PICKER_LOCAL_SUBTITLE,
  // #1123, the first-run window (PR 4a part 1): its title, hint and Save's
  // three reasons.
  PICKER_TITLE,
  PICKER_MODEL_ID_HINT,
  pickerSaveReason({ endpoint: "", modelId: "x" }) as string,
  pickerSaveReason({ endpoint: "x", modelId: "" }) as string,
  pickerSaveReason({ endpoint: "", modelId: "" }) as string,
  "Set up a local AI model, such as Ollama, LM Studio or llama.cpp",
  "LM Studio",
  "Other local server",
  // #1123, cloud providers hidden: an old cloud entry's sentence, its window's
  // title and the cloud headings' suffix.
  "This provider can't be used in Tandem.",
  "Model unavailable",
  "(API key)",
  // #1123, the add-model window's fields: Save's four reasons and the label
  // (only the first-run window renders that label today, and it never mounts
  // dark). Literals, never built from the product's strings.
  "Enter a Model ID to save.",
  "Enter an Endpoint to save.",
  "The Endpoint must start with http:// and name this computer as 127.0.0.1, localhost or [::1], with no user name or password.",
  "The Endpoint is not a complete address. Check it, including the port number (for example http://127.0.0.1:11434).",
  "Display name (optional)",
  // 26a, 26c: the first-run window's two address reasons and the document-text
  // sentences (the add-model window; neither mounts dark).
  "The Endpoint URL must start with http:// and name this computer as 127.0.0.1, localhost or [::1], with no user name or password.",
  "The Endpoint URL is not a complete address. Check it, including the port number (for example http://127.0.0.1:11434).",
  "For this model, Tandem sends your document's text only to the Endpoint address you enter. The model server at that address may pass it on.",
];

function expectNoNewCopy(text: string) {
  for (const s of NEW_COPY) expect(text).not.toContain(s);
}

beforeEach(() => {
  installLocalStorageStub();
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("flag off: nothing a dark build shows changes", () => {
  it("the anchor: the file-level mock applied, so the flag reads false here", () => {
    expect(BYO_MODELS_ENABLED).toBe(false);
  });

  it("Settings has no Models tab, and none of the new copy", async () => {
    const view = render(SettingsModal, {
      props: {
        open: true,
        onClose: vi.fn(),
        settings: loadSettings(),
        onUpdate: vi.fn(),
        connected: true,
        reconnectAttempts: 0,
      },
    });
    await tick();
    expect(view.container.querySelector("[data-testid^='settings-modal-tab-']")).not.toBeNull();
    expect(view.container.querySelector("[data-testid='settings-modal-tab-models']")).toBeNull();
    expect(view.queryByTestId("models-local-intro")).toBeNull();
    expectNoNewCopy(document.body.textContent ?? "");
  });

  it("the wizard's AI-models row is exactly today's dark row", async () => {
    const { container } = render(IntegrationWizardModal, {
      props: { open: true, onClose: vi.fn() },
    });
    await tick();
    const more = container.querySelector("[data-testid='integration-wizard-more']");
    const row = Array.from(more?.querySelectorAll(".iw-more-row") ?? []).find(
      (r) => r.querySelector(".iw-more-row-name")?.textContent?.trim() === "AI models",
    );
    expect(row).toBeTruthy();
    expect(row?.classList.contains("iw-more-row-disabled")).toBe(true);
    expect(row?.querySelector(".iw-more-row-detail")?.textContent?.trim()).toBe(
      "Bring your own model — coming soon",
    );
    expect(container.querySelector("[data-testid='integration-wizard-models-setup']")).toBeNull();
    expectNoNewCopy(document.body.textContent ?? "");
  });
});
