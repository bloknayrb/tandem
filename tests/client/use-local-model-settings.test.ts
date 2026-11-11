// @vitest-environment happy-dom

/**
 * The client mirror of the server's "let local models comment and suggest
 * changes" setting (#1123). The store is flag-gated, so this file mocks
 * `BYO_MODELS_ENABLED=true` to exercise the lit path — the same seam
 * `use-models-loading.test.ts` uses. The dark half is in
 * `use-local-model-settings-dark.test.ts`.
 *
 * Contract: the checkbox must never show a state the server does not hold.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants.js")>()),
  BYO_MODELS_ENABLED: true as false,
}));

const { _resetLocalModelSettingsForTests, createLocalModelSettings } = await import(
  "../../src/client/hooks/useLocalModelSettings.svelte.js"
);

type Reply = { status: number; body: unknown } | "network-error";

let gets: Reply[] = [];
let posts: Reply[] = [];
let calls: { method: string; body?: unknown }[] = [];

function respond(reply: Reply | undefined): Promise<Response> {
  if (reply === undefined || reply === "network-error") {
    return Promise.reject(new TypeError("fetch failed"));
  }
  return Promise.resolve(
    new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

beforeEach(() => {
  _resetLocalModelSettingsForTests();
  gets = [];
  posts = [];
  calls = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({
        method,
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
      });
      return respond(method === "POST" ? posts.shift() : gets.shift());
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useLocalModelSettings — load", () => {
  it("is unknown until the server answers, then shows the server's value", async () => {
    const s = createLocalModelSettings();
    expect(s.known).toBe(false);
    gets.push({ status: 200, body: { editing: true } });
    await s.load();
    expect(s.known).toBe(true);
    expect(s.editing).toBe(true);
    expect(s.loadFailed).toBe(false);
  });

  it("a failed load stays unknown and says so; a retry recovers", async () => {
    const s = createLocalModelSettings();
    gets.push("network-error");
    await s.load();
    expect(s.known).toBe(false);
    expect(s.loadFailed).toBe(true);
    gets.push({ status: 200, body: { editing: false } });
    await s.load();
    expect(s.known).toBe(true);
    expect(s.loadFailed).toBe(false);
  });

  it("treats a non-OK or malformed answer as a failed load, never as off", async () => {
    const s = createLocalModelSettings();
    gets.push({ status: 403, body: { error: "FORBIDDEN" } });
    await s.load();
    expect(s.known).toBe(false);
    gets.push({ status: 200, body: { editing: "true" } });
    await s.load();
    expect(s.known).toBe(false);
    expect(s.loadFailed).toBe(true);
  });

  it("dedupes overlapping loads into one request", async () => {
    const s = createLocalModelSettings();
    gets.push({ status: 200, body: { editing: false } });
    await Promise.all([s.load(), s.load()]);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
  });

  it("a load that began before a save cannot overwrite what the save learned", async () => {
    const s = createLocalModelSettings();
    gets.push({ status: 200, body: { editing: false } });
    posts.push({ status: 200, body: { editing: true, persisted: true } });
    const loading = s.load();
    const saving = s.setEditing(true);
    await Promise.all([loading, saving]);
    expect(s.editing).toBe(true);
  });
});

describe("useLocalModelSettings — save", () => {
  it("applies optimistically, posts the boolean, and adopts the server's answer", async () => {
    const s = createLocalModelSettings();
    posts.push({ status: 200, body: { editing: true, persisted: true } });
    const saving = s.setEditing(true);
    expect(s.editing).toBe(true); // before the network settles
    await saving;
    expect(calls).toEqual([{ method: "POST", body: { editing: true } }]);
    expect(s.editing).toBe(true);
    expect(s.saveNotice).toBeNull();
  });

  it("a failed On shows off, with a notice that it stays off", async () => {
    const s = createLocalModelSettings();
    posts.push({ status: 500, body: { editing: false, persisted: false, code: "X" } });
    await s.setEditing(true);
    expect(s.editing).toBe(false);
    expect(s.known).toBe(true);
    expect(s.saveNotice).toMatch(/stays off/);
  });

  it("a failed Off still shows off, and warns it may be on again after a restart", async () => {
    const s = createLocalModelSettings();
    posts.push({ status: 500, body: { editing: false, persisted: false, code: "X" } });
    await s.setEditing(false);
    expect(s.editing).toBe(false);
    expect(s.saveNotice).toMatch(/on again after Tandem restarts/);
  });

  it("an On the server holds but could not save shows on, and says it may not last", async () => {
    const s = createLocalModelSettings();
    posts.push({ status: 500, body: { editing: true, persisted: false, code: "X" } });
    await s.setEditing(true);
    expect(s.editing).toBe(true);
    expect(s.saveNotice).toMatch(/on for now/);
  });

  it("a network failure asks the server, and shows what it says rather than the click", async () => {
    const s = createLocalModelSettings();
    posts.push("network-error");
    gets.push({ status: 200, body: { editing: true } });
    await s.setEditing(false);
    expect(s.editing).toBe(true); // the Off did not land: do not show off
    expect(s.saveNotice).toMatch(/could not be saved/);
  });

  it("when neither the save nor the re-read works, the state is unknown, not off", async () => {
    const s = createLocalModelSettings();
    posts.push("network-error");
    gets.push("network-error");
    await s.setEditing(false);
    expect(s.known).toBe(false);
    expect(s.loadFailed).toBe(true);
    expect(s.saveNotice).not.toBeNull();
  });

  it("serializes overlapping saves, so the last click is the last request", async () => {
    const s = createLocalModelSettings();
    posts.push({ status: 200, body: { editing: true, persisted: true } });
    posts.push({ status: 200, body: { editing: false, persisted: true } });
    const a = s.setEditing(true);
    const b = s.setEditing(false);
    await Promise.all([a, b]);
    expect(calls.map((c) => c.body)).toEqual([{ editing: true }, { editing: false }]);
    expect(s.editing).toBe(false);
  });
});
