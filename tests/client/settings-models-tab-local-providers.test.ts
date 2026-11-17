// @vitest-environment happy-dom

/**
 * Settings → Models for #1123's LM Studio and "another local server"
 * (2026-11-15):
 *  - R1.2: an entry of EVERY provider in `VALID_MODEL_PROVIDERS` is listed,
 *    under its own label's heading (a hand-written group order used to drop
 *    an entry of any provider it missed, silently);
 *  - R4 (S1, S2): the two lines show in all five list states (loading, a
 *    foreign page whose read failed, a failed read, empty, listed), with chat
 *    known as Claude, known as the local model, and not known.
 * The REAL chat-answerer store runs with `fetch` held; the models list is a pose.
 */

import { cleanup, render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRegistryEntry } from "../../src/client/hooks/useTandemSettings";
import type { TandemSettings } from "../../src/client/hooks/useTandemSettings.svelte";
import { LOCAL_REQUEST_LINE, LOCAL_SERVERS_LINE } from "../../src/client/utils/local-model-copy";
import { isLocalProvider, VALID_MODEL_PROVIDERS } from "../../src/shared/models/contract";
import { PROVIDER_LABEL } from "../../src/shared/models/provider-ui";
import { installHeldFetch } from "../helpers/held-fetch";
import { asTandemOwnWindow } from "../helpers/models-write-access.svelte";

vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants.js")>()),
  BYO_MODELS_ENABLED: true as false,
}));

interface ModelsPose {
  models?: ModelRegistryEntry[];
  defaultModelId?: string | null;
  loading?: boolean;
  loadFailed?: boolean;
}
let pose: ModelsPose = {};

vi.mock(import("../../src/client/hooks/useModels.svelte"), () => ({
  createModels: () => ({
    get models() {
      return pose.models ?? [];
    },
    get defaultModelId() {
      return pose.defaultModelId ?? null;
    },
    saveError: null,
    get loading() {
      return pose.loading ?? false;
    },
    get loadFailed() {
      return pose.loadFailed ?? false;
    },
    reload: vi.fn(async () => {}),
    clearError: vi.fn(),
    addModel: vi.fn(async () => "id"),
    updateModel: vi.fn(async () => true),
    deleteModel: vi.fn(async () => {}),
    toggleEnabled: vi.fn(async () => {}),
    setDefault: vi.fn(async () => true),
  }),
}));

vi.mock(import("../../src/client/hooks/useLocalModelSettings.svelte"), () => ({
  createLocalModelSettings: () => ({
    editing: false,
    known: true,
    loading: false,
    loadFailed: false,
    saveNotice: null,
    load: vi.fn(async () => {}),
    setEditing: vi.fn(async () => {}),
  }),
}));

const store = await import("../../src/client/hooks/useChatAnswerer.svelte.js");
const { _setPageOriginForTests } = await import(
  "../../src/client/hooks/useModelsWriteAccess.svelte.js"
);
const { default: SettingsModelsTab } = await import(
  "../../src/client/components/settings-tabs/SettingsModelsTab.svelte"
);

asTandemOwnWindow();

let held: ReturnType<typeof installHeldFetch>;
beforeEach(() => {
  store._resetChatAnswererForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  held = installHeldFetch();
  pose = {};
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function entry(provider: ModelRegistryEntry["provider"]): ModelRegistryEntry {
  return {
    id: `m-${provider}`,
    provider,
    displayName: `Name ${provider}`,
    modelId: "id",
    enabled: true,
    ...(isLocalProvider(provider) ? { endpoint: "http://127.0.0.1:1234" } : { apiKeyRef: "ref" }),
  };
}

function mount() {
  return render(SettingsModelsTab, {
    props: {
      open: true,
      settings: { selectionDwellMs: 1000 } as TandemSettings,
      onUpdate: vi.fn(),
      connected: true,
      reconnectAttempts: 0,
      readOnly: false,
      notify: vi.fn(),
    },
  });
}

const known = (answerer: "claude" | "local") => ({
  answerer,
  localModelResolves: true,
  localModelState: "usable",
  runGeneration: "g1",
});

type Chat = "known Claude" | "known local" | "not known";
async function answerChatRead(chat: Chat) {
  const read = await held.request(1);
  if (chat === "known Claude") await read.answer(200, known("claude"));
  else if (chat === "known local") await read.answer(200, known("local"));
  else await read.answer(500, {});
}

function expectIntro(view: ReturnType<typeof mount>) {
  const intro = view.getByTestId("models-local-intro");
  const text = intro.textContent ?? "";
  expect(text).toContain(LOCAL_SERVERS_LINE);
  expect(text).toContain(LOCAL_REQUEST_LINE);
  expect(text).not.toMatch(/answers/i);
  // Between the chat-answerer section and the list.
  const section = view.getByTestId("chat-answerer-section");
  expect(section.compareDocumentPosition(intro) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

describe("R1.2: every provider's entry is listed under its own heading", () => {
  for (const provider of VALID_MODEL_PROVIDERS) {
    it(provider, () => {
      pose = { models: [entry(provider)], defaultModelId: null };
      const view = mount();
      const row = view.getByTestId(`model-row-${entry(provider).id}`);
      const group = row.parentElement?.parentElement;
      const heading = group?.querySelector(".settings-section-label");
      expect(heading?.textContent?.trim()).toBe(PROVIDER_LABEL[provider]);
    });
  }

  it("all of them at once, Anthropic's group first", () => {
    pose = { models: VALID_MODEL_PROVIDERS.map(entry), defaultModelId: null };
    const view = mount();
    for (const p of VALID_MODEL_PROVIDERS)
      expect(view.getByTestId(`model-row-m-${p}`)).toBeTruthy();
    const first = view.container.querySelector("[data-testid^='model-row-']");
    expect(first?.getAttribute("data-testid")).toBe("model-row-m-anthropic");
  });
});

describe("R4: S1 and S2 in every list state", () => {
  const states: Array<[string, ModelsPose]> = [
    ["loading", { loading: true }],
    ["load failed", { loadFailed: true }],
    ["empty", {}],
    ["listed", { models: [entry("local-lmstudio"), entry("local-other")] }],
  ];
  for (const [name, list] of states) {
    for (const chat of ["known Claude", "known local", "not known"] as const) {
      it(`${name}, chat ${chat}`, async () => {
        pose = list;
        const view = mount();
        await answerChatRead(chat);
        expectIntro(view);
      });
    }
  }

  it("a foreign page whose read failed (the branch that renders nothing)", () => {
    _setPageOriginForTests("http://localhost:3479");
    pose = { loadFailed: true };
    const view = mount();
    expect(view.queryByTestId("models-load-error")).toBeNull();
    expectIntro(view);
  });
});
