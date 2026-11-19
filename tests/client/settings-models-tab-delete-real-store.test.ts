// @vitest-environment happy-dom

/**
 * The only-row delete against the REAL Models store (#1123, ADR-039 item 27;
 * the brief's A5). The tab focuses the empty state's Add button after one
 * `tick()`, before the POST settles, on the strength of the store applying its
 * optimistic removal before that tick ends when no write is queued ahead
 * (`writeThrough` queues `runExclusive` on `_writeQueue.then`, and
 * `runExclusive` runs `applyRun` first). That is the store's timing, so it is
 * proven here with the store itself, its `fetch` stubbed and the POST held.
 * The other focus cases use store-shaped fakes (`settings-models-tab-focus.test.ts`).
 */

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TandemSettings } from "../../src/client/hooks/useTandemSettings.svelte";
import { asTandemOwnWindow } from "../helpers/models-write-access.svelte";

vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants.js")>()),
  BYO_MODELS_ENABLED: true as typeof import("../../src/shared/constants.js").BYO_MODELS_ENABLED,
}));

// Still poses for the tab's other two stores, so this file's wire holds the
// Models store's requests only.
vi.mock(import("../../src/client/hooks/useChatAnswerer.svelte"), async (importOriginal) => ({
  ...(await importOriginal()),
  createChatAnswerer: () => ({
    status: "pending" as const,
    known: false,
    answerer: "claude" as const,
    localModelState: "none" as const,
    runGeneration: null,
    reading: false,
    postPending: false,
    outcomeLine: null,
    setToClaudeDone: false,
    sentLocal: new Set<string>(),
    load: vi.fn(async () => ({ status: "dark" as const })),
    set: vi.fn(async () => {}),
    clearOutcome: vi.fn(),
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

const { _resetModelsStoreForTests, _settleReconcile, loadFromServer } = await import(
  "../../src/client/hooks/useModels.svelte.js"
);
const { default: SettingsModelsTab } = await import(
  "../../src/client/components/settings-tabs/SettingsModelsTab.svelte"
);

asTandemOwnWindow();

const ENTRY = {
  id: "only",
  provider: "local-ollama",
  displayName: "Qwen",
  modelId: "qwen2.5:14b",
  endpoint: "http://127.0.0.1:11434",
  enabled: true,
};

let heldPosts: Array<() => void> = [];

beforeEach(async () => {
  heldPosts = [];
  _resetModelsStoreForTests();
  _settleReconcile();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: { method?: string }) => {
      if ((init?.method ?? "GET").toUpperCase() === "POST") {
        await new Promise<void>((resolve) => heldPosts.push(resolve));
        return new Response(JSON.stringify({ etag: "etag-2" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          file: { schemaVersion: 1, models: [ENTRY], defaultModelId: "only" },
          etag: "etag-1",
        }),
        { status: 200 },
      );
    }),
  );
  await loadFromServer();
});
afterEach(() => {
  cleanup();
  _resetModelsStoreForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function drain() {
  for (let i = 0; i < 60; i++) await Promise.resolve();
  await tick();
}

describe("A5 with the real store: the only row, idle queue", () => {
  it("the empty state's Add button has focus right after tick, while the POST is still held", async () => {
    const v = render(SettingsModelsTab, {
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
    expect(v.getByTestId("model-row-only")).toBeTruthy();
    await fireEvent.click(v.getByTestId("model-delete-btn-only"));
    await tick();
    // fireEvent.click awaits one tick; the handler's own `await tick()` is the second.
    await fireEvent.click(v.getByTestId("model-delete-confirm-only"));
    await tick();
    expect(v.queryByTestId("models-empty-state")).not.toBeNull();
    expect(document.activeElement).toBe(v.getByTestId("model-add-btn"));
    await drain();
    expect(heldPosts.length).toBe(1);

    heldPosts[0]();
    await drain();
    expect(v.queryByTestId("model-row-only")).toBeNull();
    expect(document.activeElement).toBe(v.getByTestId("model-add-btn"));
  });
});
