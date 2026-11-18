// @vitest-environment happy-dom

/**
 * The first-run window with the REAL Models store (#1123; Bryan's pick of
 * 2026-11-18, review round 1 of #2462: "The window's model becomes Default").
 * Only `fetch` is stubbed. Choosing a model in the window counts as the user
 * choosing the Default, replacing any earlier one. When the add's own write
 * already marked it (an empty registry) there is no second write; otherwise
 * the window sets it with `setDefault`, a chosen default whose POST carries
 * no `autoDefaultId`.
 */

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetModelsStoreForTests,
  _settleReconcile,
  createModels,
} from "../../src/client/hooks/useModels.svelte.js";
import { API_MODELS } from "../../src/shared/models/contract.js";
import { asTandemOwnWindow } from "../helpers/models-write-access.svelte";

const { default: FirstRunModelPickerModal } = await import(
  "../../src/client/components/FirstRunModelPickerModal.svelte"
);

asTandemOwnWindow();

type Body = {
  file: { models: { id: string }[]; defaultModelId: string | null };
  autoDefaultId?: string;
};
let bodies: Body[] = [];
let statuses: number[] = [];
let serverFile: { schemaVersion: 1; models: unknown[]; defaultModelId: string | null };
let etag = 0;

function stub() {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (u.includes("/secrets/")) return new Response(null, { status: 204 });
    if (method === "POST" && u.endsWith(API_MODELS)) {
      bodies.push(JSON.parse(init?.body as string) as Body);
      const status = statuses.length > 0 ? (statuses.shift() as number) : 200;
      if (status === 200) {
        return new Response(JSON.stringify({ etag: `e-${++etag}` }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: "MODELS_STALE", etag: "srv" }), { status });
    }
    return new Response(JSON.stringify({ file: serverFile, etag: "srv" }), { status: 200 });
  });
}

const local = (name: string, enabled = true) => ({
  provider: "local-ollama" as const,
  displayName: name,
  modelId: `m-${name}`,
  endpoint: "http://127.0.0.1:11434",
  enabled,
});
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  bodies = [];
  statuses = [];
  etag = 0;
  serverFile = { schemaVersion: 1, models: [], defaultModelId: null };
  _resetModelsStoreForTests();
  _settleReconcile();
  vi.stubGlobal("fetch", stub());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Save "qwen" through the window; returns the POSTs it made and the store. */
async function saveThroughWindow() {
  const store = createModels();
  const before = bodies.length;
  const onComplete = vi.fn();
  const m = render(FirstRunModelPickerModal, { props: { onComplete } });
  await fireEvent.input(m.getByTestId("first-run-modelid"), { target: { value: "qwen" } });
  await fireEvent.click(m.getByTestId("first-run-save"));
  await flush();
  expect(onComplete).toHaveBeenCalledTimes(1);
  const added = store.models.find((e) => e.modelId === "qwen");
  expect(added).toBeDefined();
  return { store, posts: bodies.slice(before), id: (added as { id: string }).id };
}

describe("the first-run window's model becomes the Default (real store)", () => {
  it("(a) an empty registry: one POST, marked by the add, no setDefault", async () => {
    const { store, posts, id } = await saveThroughWindow();
    expect(posts).toHaveLength(1);
    expect(posts[0].file.defaultModelId).toBe(id);
    expect(posts[0].autoDefaultId).toBe(id);
    expect(store.defaultModelId).toBe(id);
  });

  it("(b) another enabled local became the default by a 409 reload between offer and Save: setDefault, no marker", async () => {
    serverFile = {
      schemaVersion: 1,
      models: [{ id: "X", ...local("X") }],
      defaultModelId: "X",
    };
    statuses = [409, 200];
    const { store, posts, id } = await saveThroughWindow();
    // The add (409 + retry, the retry unmarked: X is the default), then the window's setDefault.
    expect(posts).toHaveLength(3);
    expect("autoDefaultId" in posts[1]).toBe(false);
    expect(posts[1].file.defaultModelId).toBe("X");
    expect(posts[2].file.defaultModelId).toBe(id);
    expect("autoDefaultId" in posts[2]).toBe(false);
    expect(store.defaultModelId).toBe(id);
  });

  it("(c) another enabled local, unmarked: setDefault, no marker", async () => {
    const seed = createModels();
    await seed.addModel(local("A"));
    await seed.setDefault(null);
    const { store, posts, id } = await saveThroughWindow();
    expect(posts).toHaveLength(2);
    expect(posts[0].file.defaultModelId).toBeNull(); // two enabled: the rule is silent
    expect("autoDefaultId" in posts[0]).toBe(false);
    expect(posts[1].file.defaultModelId).toBe(id);
    expect("autoDefaultId" in posts[1]).toBe(false);
    expect(store.defaultModelId).toBe(id);
  });

  for (const [what, entry] of [
    [
      "a cloud default",
      { provider: "anthropic" as const, displayName: "C", modelId: "c", enabled: true },
    ],
    ["a switched-off default", local("D", false)],
  ] as const) {
    it(`(d) ${what}: setDefault, no marker`, async () => {
      const seed = createModels();
      const old = (await seed.addModel(entry)) as string;
      await seed.setDefault(old);
      const { store, posts, id } = await saveThroughWindow();
      expect(posts).toHaveLength(2);
      expect(posts[0].file.defaultModelId).toBe(old);
      expect("autoDefaultId" in posts[0]).toBe(false);
      expect(posts[1].file.defaultModelId).toBe(id);
      expect("autoDefaultId" in posts[1]).toBe(false);
      expect(store.defaultModelId).toBe(id);
    });
  }
});
