// @vitest-environment happy-dom

/**
 * The editor's read of who answers chat (#1123 part B, R1, R2.4, R3): the
 * store in `hooks/useChatAnswerer.svelte.ts`, with the REAL store and only
 * `fetch` stubbed (answers held open and released by hand).
 *
 * `BYO_MODELS_ENABLED` is flipped on by mocking the constant; the dark
 * guarantee is `chat-answerer-store-dark.test.ts`.
 */

import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, TandemNotification } from "../../src/shared/types";
import { drain, installHeldFetch } from "../helpers/held-fetch";
import { asTandemOwnWindow } from "../helpers/models-write-access.svelte";

vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants.js")>()),
  BYO_MODELS_ENABLED: true as false,
}));

const store = await import("../../src/client/hooks/useChatAnswerer.svelte.js");
const { signalModelsWriteCommitted } = await import(
  "../../src/client/models/models-write-signal.js"
);
const { modelsWriteWasRefused } = await import("../../src/client/models/write-refusal.js");
const { _setPageOriginForTests } = await import(
  "../../src/client/hooks/useModelsWriteAccess.svelte.js"
);
const { API_MODELS_CHAT_ANSWERER, ANSWERER_CLAUDE_NOTICE_KEY, ANSWERER_LOCAL_NOTICE_KEY } =
  await import("../../src/shared/models/contract.js");

asTandemOwnWindow();

let held: ReturnType<typeof installHeldFetch>;
const state = store.createChatAnswerer();

const known = (answerer: "claude" | "local", extra: Record<string, unknown> = {}) => ({
  answerer,
  localModelResolves: false,
  localModelState: "none",
  runGeneration: "gen-1",
  ...extra,
});

beforeEach(() => {
  store._resetChatAnswererForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
  held = installHeldFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const gets = () => held.calls.filter((c) => c.method === "GET");
const posts = () => held.calls.filter((c) => c.method === "POST");

/** Read once and answer it. */
async function readAs(status: number, body: unknown) {
  const p = store.requestRead();
  const call = await held.request(held.calls.length + 1);
  await call.answer(status, body);
  return p;
}

describe("a read's outcome (R1.1, R1.3)", () => {
  for (const s of ["usable", "none", "no-default-chosen", "endpoint-rejected", "no-endpoint"]) {
    it(`200 with the state ${s}: known, with that state and the run id`, async () => {
      await readAs(200, known("local", { localModelState: s, localModelResolves: s === "usable" }));
      expect(state.status).toBe("known");
      expect(state.answerer).toBe("local");
      expect(state.localModelState).toBe(s);
      expect(state.runGeneration).toBe("gen-1");
      expect(held.calls[0].url.endsWith(API_MODELS_CHAT_ANSWERER)).toBe(true);
    });
  }

  it("200 with no state (the server's check threw): known, the state 'threw'", async () => {
    await readAs(200, { answerer: "local", localModelResolves: false, runGeneration: "g" });
    expect(state.status).toBe("known");
    expect(state.localModelState).toBe("threw");
  });

  it("200 with a state outside the enum: failed, never shown", async () => {
    await readAs(200, known("local", { localModelState: "http://127.0.0.1:11434" }));
    expect(state.status).toBe("failed");
  });

  it("403 OWN_WINDOW_ONLY: refused, and the write latch is NOT set (R2.6)", async () => {
    await readAs(403, { error: "FORBIDDEN", code: "OWN_WINDOW_ONLY" });
    expect(state.status).toBe("refused");
    expect(modelsWriteWasRefused()).toBe(false);
  });

  it("404: unavailable (R2.7)", async () => {
    await readAs(404, { error: "NOT_FOUND" });
    expect(state.status).toBe("unavailable");
  });

  it("a thrown fetch on a foreign page: unreadable", async () => {
    _setPageOriginForTests("http://localhost:3479");
    const p = store.requestRead();
    await (await held.request(1)).fail();
    await p;
    expect(state.status).toBe("unreadable");
  });

  it("a thrown fetch on Tandem's own page: failed", async () => {
    const p = store.requestRead();
    await (await held.request(1)).fail();
    await p;
    expect(state.status).toBe("failed");
  });

  it("a timeout: failed", async () => {
    const p = store.requestRead();
    await (await held.request(1)).timeout();
    await p;
    expect(state.status).toBe("failed");
  });

  it("a re-read keeps the last known answer until it settles", async () => {
    await readAs(200, known("local"));
    const p = store.requestRead();
    const second = await held.request(2);
    expect(state.status).toBe("known");
    expect(state.answerer).toBe("local");
    expect(state.reading).toBe(true);
    await second.answer(200, known("claude"));
    await p;
    expect(state.answerer).toBe("claude");
    expect(state.reading).toBe(false);
  });
});

describe("one queued read (Ruling B-3)", () => {
  it("triggers during an in-flight read queue exactly one more; further ones add nothing", async () => {
    store.requestRead();
    const first = await held.request(1);
    const a = store.requestRead();
    const b = store.requestRead();
    store.noteNotifyNotice(ANSWERER_LOCAL_NOTICE_KEY);
    expect(a).toBe(b);
    await drain();
    expect(gets()).toHaveLength(1);
    await first.answer(200, known("claude"));
    const second = await held.request(2);
    await second.answer(200, known("local"));
    expect(await a).toMatchObject({ status: "known", answerer: "local" });
    await drain();
    expect(gets()).toHaveLength(2);
  });
});

describe("never inside a reaction (R1.2)", () => {
  it("a trigger fired inside a $derived writes no $state synchronously", async () => {
    let value = 0;
    const cleanup = $effect.root(() => {
      const d = $derived.by(() => {
        store.noteNotifyNotice(ANSWERER_CLAUDE_NOTICE_KEY);
        store.noteNoticeRowArrived();
        return 1;
      });
      $effect(() => {
        value = d;
      });
    });
    // Would throw `state_unsafe_mutation` if a trigger wrote `$state` here.
    expect(() => flushSync()).not.toThrow();
    expect(value).toBe(1);
    expect(state.reading).toBe(false);
    await drain();
    expect(gets()).toHaveLength(1);
    cleanup();
  });
});

describe("the triggers (R1.2)", () => {
  it("connect: the first sync reads; a new server process clears runGeneration only, then reads", async () => {
    const docA = {};
    store.noteCtrlSynced(docA);
    await (await held.request(1)).answer(200, known("local", { localModelState: "usable" }));
    expect(state.runGeneration).toBe("gen-1");
    store.noteCtrlSynced(docA); // same doc: nothing
    await drain();
    expect(gets()).toHaveLength(1);
    store.noteCtrlSynced({}); // a new process
    await drain();
    expect(state.runGeneration).toBeNull();
    expect(state.status).toBe("known");
    expect(state.answerer).toBe("local");
    expect(state.localModelState).toBe("usable");
    await (await held.request(2)).answer(200, known("local", { runGeneration: "gen-2" }));
    expect(state.runGeneration).toBe("gen-2");
  });

  it("a read started against the old process is not adopted after a new one is detected", async () => {
    store.noteCtrlSynced({});
    const old = await held.request(1);
    store.noteCtrlSynced({});
    await old.answer(200, known("local", { runGeneration: "gen-old" }));
    expect(state.runGeneration).toBeNull();
    await (await held.request(2)).answer(200, known("local", { runGeneration: "gen-new" }));
    expect(state.runGeneration).toBe("gen-new");
  });

  it("a notify-stream notice with one of the switch's keys reads; any other key does not", async () => {
    store.noteNotifyNotice("something-else");
    store.noteNotifyNotice(undefined);
    await drain();
    expect(gets()).toHaveLength(0);
    for (const key of [
      "local-model-answerer-claude",
      "local-model-answerer-local",
      "local-model-settings-changed",
    ]) {
      store.noteNotifyNotice(key);
      await (await held.request(gets().length + 1)).answer(200, known("claude"));
    }
    expect(gets()).toHaveLength(3);
  });

  it("a notice row arriving reads", async () => {
    store.noteNoticeRowArrived();
    await held.request(1);
    expect(gets()).toHaveLength(1);
  });

  it("heldForLocalModel: the first value is a baseline; a change reads", async () => {
    store.noteHeld(false);
    store.noteHeld(false);
    await drain();
    expect(gets()).toHaveLength(0);
    store.noteHeld(true);
    await held.request(1);
    expect(gets()).toHaveLength(1);
  });

  it("a successful models write reads (useModels' signal)", async () => {
    signalModelsWriteCommitted({ firstLocal: false });
    await held.request(1);
    expect(gets()).toHaveLength(1);
  });

  describe("the user rows (live only)", () => {
    const doc = {};
    const user = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
      id,
      author: "user",
      text: "q",
      timestamp: 1,
      read: false,
      ...extra,
    });
    const observe = (messages: ChatMessage[]) =>
      store.observeChatForAnswerer({ doc, synced: true, messages });

    it("history never triggers; nothing before the sync", async () => {
      store.observeChatForAnswerer({
        doc,
        synced: false,
        messages: [user("a", { localRun: { status: "running", generation: "g9" } })],
      });
      observe([
        user("a", { localRun: { status: "running", generation: "g9" } }),
        user("b", { read: true }),
      ]);
      await drain();
      expect(gets()).toHaveLength(0);
    });

    it("localRun running with an unread generation: once per generation", async () => {
      await readAs(200, known("local"));
      observe([user("a")]);
      observe([user("a", { localRun: { status: "running", generation: "g9" } })]);
      await (await held.request(2)).answer(200, known("local"));
      observe([
        user("a", { localRun: { status: "running", generation: "g9" } }),
        user("b", { localRun: { status: "running", generation: "g9" } }),
      ]);
      // The store's own generation: no read either.
      observe([user("c", { localRun: { status: "running", generation: "gen-1" } })]);
      await drain();
      expect(gets()).toHaveLength(2);
    });

    it("localRun appearing while the read is known Claude reads", async () => {
      await readAs(200, known("claude"));
      observe([user("a")]);
      observe([
        user("a", { localRun: { status: "stopped", reason: "no-reply", generation: "gen-1" } }),
      ]);
      await held.request(2);
      expect(gets()).toHaveLength(2);
    });

    it("read or delivered gained while the read is known local reads; while known Claude it does not", async () => {
      await readAs(200, known("claude"));
      observe([user("a")]);
      observe([user("a", { read: true })]);
      await drain();
      expect(gets()).toHaveLength(1);
      await readAs(200, known("local"));
      observe([user("a", { read: true }), user("b")]);
      observe([user("a", { read: true }), user("b", { delivered: true })]);
      await held.request(3);
      expect(gets()).toHaveLength(3);
    });
  });

  it("this window's send in the local period reads, and is recorded for 'Sent to your local model'", async () => {
    await readAs(200, known("local", { localModelState: "usable" }));
    const msg = { id: "u1", author: "user", text: "q", timestamp: 1, read: false } as ChatMessage;
    store.noteChatSent(msg, { aiOff: false, held: false });
    expect(state.sentLocal.has("u1")).toBe(true);
    const reread = await held.request(2);
    // While its own re-read is in flight the read is still known local.
    expect(state.status).toBe("known");
    expect(state.answerer).toBe("local");
    await reread.answer(200, known("local"));
  });

  it("a send under a licence refusal, or with the read not known local, is not recorded", async () => {
    const msg = (id: string) =>
      ({ id, author: "user", text: "q", timestamp: 1, read: false }) as ChatMessage;
    // Pending: not recorded, and (review round 1 item 2) one read.
    store.noteChatSent(msg("pending"), { aiOff: false, held: false });
    await (await held.request(1)).answer(200, known("local"));
    store.noteChatSent(msg("refused"), { aiOff: true, held: false });
    // A send in the local period re-reads: answer it.
    await (await held.request(2)).answer(200, known("claude"));
    store.noteChatSent(msg("claude"), { aiOff: false, held: false });
    await drain();
    expect([...state.sentLocal]).toEqual([]);
    // Known Claude: a send reads nothing.
    expect(gets()).toHaveLength(2);
  });

  it("history's running generation is a baseline: no read on the first chat change (review round 1, item 9)", async () => {
    await readAs(200, known("local"));
    const doc = {};
    const old = {
      id: "h",
      author: "user",
      text: "q",
      timestamp: 1,
      read: false,
      localRun: { status: "running", generation: "crashed" },
    } as ChatMessage;
    store.observeChatForAnswerer({ doc, synced: true, messages: [old] });
    store.observeChatForAnswerer({
      doc,
      synced: true,
      messages: [old, { ...old, id: "h2", localRun: undefined }],
    });
    await drain();
    expect(gets()).toHaveLength(1);
  });

  describe("a failed re-read during a real local period (review round 1, item 2)", () => {
    const doc = {};
    const user = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
      id,
      author: "user",
      text: "q",
      timestamp: 1,
      read: false,
      ...extra,
    });

    it("this window's send while the read is not known reads once", async () => {
      await readAs(200, known("local"));
      const p = store.requestRead();
      await (await held.request(2)).timeout();
      await p;
      expect(state.status).toBe("failed");
      // Not in the local period any more (nothing held), so only the new
      // trigger can read.
      store.noteChatSent(user("u1"), { aiOff: false, held: false });
      // The read the trigger started fails too: nothing more is read (no loop).
      await (await held.request(3)).fail();
      await drain();
      expect(state.status).toBe("failed");
      expect(gets()).toHaveLength(3);
    });

    it("a user row's localRun appearing while the read is not known reads once", async () => {
      const p = store.requestRead();
      await (await held.request(1)).fail();
      await p;
      expect(state.status).toBe("failed");
      store.observeChatForAnswerer({ doc, synced: true, messages: [user("a")] });
      const after = [
        user("a", { localRun: { status: "stopped", reason: "error", generation: "g9" } }),
      ];
      store.observeChatForAnswerer({ doc, synced: true, messages: after });
      // The read the trigger started fails too, and the same messages are
      // observed once more: nothing more is read (no loop).
      await (await held.request(2)).fail();
      await drain();
      store.observeChatForAnswerer({ doc, synced: true, messages: after });
      await drain();
      expect(state.status).toBe("failed");
      expect(gets()).toHaveLength(2);
    });
  });
});

describe("the switch (R2.4)", () => {
  async function switchTo(
    value: "claude" | "local",
    status: number,
    body: unknown,
    reread: unknown = known("claude"),
  ) {
    const n = held.calls.length;
    const done = store.setChatAnswerer(value);
    expect(state.postPending).toBe(true);
    const post = await held.request(n + 1);
    expect(post).toMatchObject({ method: "POST", body: { answerer: value } });
    await post.answer(status, body);
    const get = await held.request(n + 2);
    expect(get.method).toBe("GET");
    if (reread === "fail") await get.fail();
    else await get.answer(200, reread);
    await done;
  }

  beforeEach(async () => {
    await readAs(200, known("claude"));
  });

  it("200: adopted, re-read, no line", async () => {
    await switchTo("local", 200, { answerer: "local", persisted: true }, known("local"));
    expect(state.answerer).toBe("local");
    expect(state.outcomeLine).toBeNull();
    expect(state.postPending).toBe(false);
  });

  it("409 SUPERSEDED: adopted, no line", async () => {
    await switchTo("local", 409, {
      answerer: "claude",
      persisted: true,
      code: "CHAT_ANSWERER_SUPERSEDED",
    });
    expect(state.answerer).toBe("claude");
    expect(state.outcomeLine).toBeNull();
  });

  it("500, body equal, the request Claude: the not-fully-saved line", async () => {
    await switchTo("claude", 500, {
      answerer: "claude",
      persisted: false,
      code: "CHAT_ANSWERER_WRITE_FAILED",
    });
    expect(state.outcomeLine).toBe(store.CHAT_ANSWERER_OUTCOME_LINES.claudeNotSaved);
  });

  it("500, body equal, the request the local model: the not-saved line", async () => {
    await switchTo(
      "local",
      500,
      { answerer: "local", persisted: false, code: "CHAT_ANSWERER_WRITE_FAILED" },
      known("local"),
    );
    expect(state.outcomeLine).toBe(store.CHAT_ANSWERER_OUTCOME_LINES.localNotSaved);
    expect(state.answerer).toBe("local");
  });

  it("500, body differs (a refused switch to the local model): still Claude", async () => {
    await switchTo("local", 500, {
      answerer: "claude",
      persisted: false,
      code: "CHAT_ANSWERER_WRITE_FAILED",
    });
    expect(state.outcomeLine).toBe(store.CHAT_ANSWERER_OUTCOME_LINES.localRefused);
    expect(state.answerer).toBe("claude");
  });

  it("403 OWN_WINDOW_ONLY: the write latch, a re-read, no line", async () => {
    await switchTo("local", 403, { code: "OWN_WINDOW_ONLY" });
    expect(modelsWriteWasRefused()).toBe(true);
    expect(state.outcomeLine).toBeNull();
  });

  it("a failed POST: 'could not be confirmed', showing the re-read", async () => {
    const done = store.setChatAnswerer("local");
    await (await held.request(2)).fail();
    await (await held.request(3)).answer(200, known("claude"));
    await done;
    expect(state.outcomeLine).toBe(store.CHAT_ANSWERER_OUTCOME_LINES.unconfirmed);
  });

  it("a timed-out POST whose re-read fails too", async () => {
    const done = store.setChatAnswerer("local");
    await (await held.request(2)).timeout();
    await (await held.request(3)).fail();
    await done;
    expect(state.outcomeLine).toBe(store.CHAT_ANSWERER_OUTCOME_LINES.unconfirmedUnread);
  });

  it("a second press while one is pending sends nothing", async () => {
    const done = store.setChatAnswerer("local");
    void store.setChatAnswerer("local");
    await drain();
    expect(posts()).toHaveLength(1);
    await (await held.request(2)).answer(200, { answerer: "local", persisted: true });
    await (await held.request(3)).answer(200, known("local"));
    await done;
  });

  it("a second press during the first press's re-read sends nothing (review round 1, item 9)", async () => {
    const done = store.setChatAnswerer("local");
    await (await held.request(2)).answer(200, { answerer: "local", persisted: true });
    await held.request(3); // the re-read is in flight
    expect(state.postPending).toBe(true);
    void store.setChatAnswerer("claude");
    await drain();
    expect(posts()).toHaveLength(1);
    await held.calls[2].answer(200, known("local"));
    await done;
    expect(state.postPending).toBe(false);
  });

  it("a clear during a press (the tab closed) keeps that press's line from being written (review round 1, item 9)", async () => {
    const done = store.setChatAnswerer("local");
    store.clearChatAnswererOutcome();
    await (await held.request(2)).answer(500, {
      answerer: "claude",
      persisted: false,
      code: "CHAT_ANSWERER_WRITE_FAILED",
    });
    await (await held.request(3)).answer(200, known("claude"));
    await done;
    expect(state.outcomeLine).toBeNull();
  });

  it("a line is cleared by a later read that answers differently", async () => {
    await switchTo("claude", 500, {
      answerer: "claude",
      persisted: false,
      code: "CHAT_ANSWERER_WRITE_FAILED",
    });
    expect(state.outcomeLine).not.toBeNull();
    await readAs(200, known("local"));
    expect(state.outcomeLine).toBeNull();
  });
});

describe("'Set chat to Claude' on a refused page (R2.6)", () => {
  it("a 200 sets the 'Chat was set to Claude.' latch and keeps the read refused", async () => {
    store._resetChatAnswererForTests();
    await readAs(403, { code: "OWN_WINDOW_ONLY" });
    const done = store.setChatAnswerer("claude");
    await (await held.request(2)).answer(200, { answerer: "claude", persisted: true });
    await (await held.request(3)).answer(403, { code: "OWN_WINDOW_ONLY" });
    await done;
    expect(state.setToClaudeDone).toBe(true);
    expect(state.status).toBe("refused");
    expect(state.known).toBe(false);
  });
});

describe("the first local model's toast (R3)", () => {
  let pushed: TandemNotification[];
  beforeEach(() => {
    pushed = [];
    store.setChatAnswererToastSink((n) => pushed.push(n));
  });

  it("known Claude: shown once, severity info, the brief's text, marked in localStorage; a second save shows nothing", async () => {
    signalModelsWriteCommitted({ firstLocal: true });
    await (await held.request(1)).answer(200, known("claude"));
    expect(pushed.map((n) => [n.severity, n.message])).toEqual([
      ["info", store.FIRST_LOCAL_MODEL_TOAST_TEXT],
    ]);
    expect(localStorage.getItem(store.FIRST_LOCAL_MODEL_TOAST_KEY)).toBe("1");
    signalModelsWriteCommitted({ firstLocal: true });
    await (await held.request(2)).answer(200, known("claude"));
    expect(pushed).toHaveLength(1);
  });

  it("an add that is not the first local model: nothing", async () => {
    signalModelsWriteCommitted({ firstLocal: false });
    await (await held.request(1)).answer(200, known("claude"));
    expect(pushed).toHaveLength(0);
  });

  it("known local: dropped and marked (it would be false)", async () => {
    signalModelsWriteCommitted({ firstLocal: true });
    await (await held.request(1)).answer(200, known("local"));
    expect(pushed).toHaveLength(0);
    expect(localStorage.getItem(store.FIRST_LOCAL_MODEL_TOAST_KEY)).toBe("1");
  });

  it("not known: dropped unshown and unmarked", async () => {
    signalModelsWriteCommitted({ firstLocal: true });
    await (await held.request(1)).fail();
    expect(pushed).toHaveLength(0);
    expect(localStorage.getItem(store.FIRST_LOCAL_MODEL_TOAST_KEY)).toBeNull();
  });

  it("storage throwing on read and on write: shown once, remembered in memory for this run", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    signalModelsWriteCommitted({ firstLocal: true });
    await (await held.request(1)).answer(200, known("claude"));
    signalModelsWriteCommitted({ firstLocal: true });
    await (await held.request(2)).answer(200, known("claude"));
    expect(pushed).toHaveLength(1);
  });

  it("an install that already showed it (mark in storage): nothing", async () => {
    localStorage.setItem(store.FIRST_LOCAL_MODEL_TOAST_KEY, "1");
    signalModelsWriteCommitted({ firstLocal: true });
    await (await held.request(1)).answer(200, known("claude"));
    expect(pushed).toHaveLength(0);
  });
});

describe("the local period's label (Ruling B-16, B-17)", () => {
  const read = (status: string, answerer: string, localModelState: string) =>
    ({ status, answerer, localModelState }) as Parameters<typeof store.localChatSettingFor>[0];
  it("a known read always wins over held", () => {
    expect(store.localChatSettingFor(read("known", "claude", "usable"), true)).toBeNull();
    expect(store.localChatSettingFor(read("known", "local", "usable"), false)).toBe("local");
    expect(store.localChatSettingFor(read("known", "local", "threw"), false)).toBe("local");
    for (const s of ["none", "no-default-chosen", "endpoint-rejected", "no-endpoint"]) {
      expect(store.localChatSettingFor(read("known", "local", s), false)).toBe("unusable");
    }
  });
  it("not known: held decides", () => {
    for (const status of ["pending", "refused", "unreadable", "failed", "unavailable"]) {
      expect(store.localChatSettingFor(read(status, "claude", "none"), true)).toBe("local");
      expect(store.localChatSettingFor(read(status, "claude", "none"), false)).toBeNull();
    }
  });
});
