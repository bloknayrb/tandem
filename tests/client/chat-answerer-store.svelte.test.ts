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
import type { ToastAction } from "../../src/client/hooks/useNotifications.svelte";
import type { ChatMessage, TandemNotification } from "../../src/shared/types";
import { drain, installHeldFetch } from "../helpers/held-fetch";
import { asTandemOwnWindow } from "../helpers/models-write-access.svelte";

vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants.js")>()),
  BYO_MODELS_ENABLED: true as typeof import("../../src/shared/constants.js").BYO_MODELS_ENABLED,
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

/** App's sink, as three spies ("Use it for chat", R3.3's judge). */
function makeSink() {
  return {
    push: vi.fn<(n: TandemNotification, action?: ToastAction) => void>(),
    dismiss: vi.fn<(id: string) => void>(),
    dismissActivity: vi.fn<(id: string) => void>(),
  };
}
const USE_IT_ACTION = { label: "Use it for chat", onClick: expect.any(Function), stay: true };

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

    // "No loop" must also hold for a retry on a timer. The store has none: its
    // only timers are each request's `AbortSignal.timeout` and the send-read
    // cap (`takeSendRead`, Ruling S-d), which only resolves a promise. Timers
    // are faked from the start of each case and advanced well past the
    // longest of them, so a retry scheduled on any delay up to that would
    // still be counted.
    const pastAnyRetryDelay = async () => {
      await vi.advanceTimersByTimeAsync(store.REQUEST_TIMEOUT_MS * 2);
      await drain();
    };
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
    });
    afterEach(() => {
      vi.useRealTimers();
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
      await pastAnyRetryDelay();
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
      await pastAnyRetryDelay();
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
  let sink: ReturnType<typeof makeSink>;
  const pushed = () => sink.push.mock.calls.map((c) => c[0]);
  beforeEach(() => {
    sink = makeSink();
    store.setChatAnswererToastSink(sink);
  });

  it("known Claude: shown once, severity info, the brief's text, marked in localStorage; a second save shows nothing", async () => {
    signalModelsWriteCommitted({ firstLocal: true });
    await (await held.request(1)).answer(200, known("claude"));
    expect(pushed().map((n) => [n.severity, n.message])).toEqual([
      ["info", store.FIRST_LOCAL_MODEL_TOAST_TEXT],
    ]);
    expect(sink.push.mock.calls[0][1]).toEqual(USE_IT_ACTION);
    expect(localStorage.getItem(store.FIRST_LOCAL_MODEL_TOAST_KEY)).toBe("1");
    signalModelsWriteCommitted({ firstLocal: true });
    await (await held.request(2)).answer(200, known("claude"));
    expect(pushed()).toHaveLength(1);
  });

  it("an add that is not the first local model: nothing", async () => {
    signalModelsWriteCommitted({ firstLocal: false });
    await (await held.request(1)).answer(200, known("claude"));
    expect(pushed()).toHaveLength(0);
  });

  it("known local: dropped and marked (it would be false)", async () => {
    signalModelsWriteCommitted({ firstLocal: true });
    await (await held.request(1)).answer(200, known("local"));
    expect(pushed()).toHaveLength(0);
    expect(localStorage.getItem(store.FIRST_LOCAL_MODEL_TOAST_KEY)).toBe("1");
  });

  it("not known: dropped unshown and unmarked", async () => {
    signalModelsWriteCommitted({ firstLocal: true });
    await (await held.request(1)).fail();
    expect(pushed()).toHaveLength(0);
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
    expect(pushed()).toHaveLength(1);
  });

  it("an install that already showed it (mark in storage): nothing", async () => {
    localStorage.setItem(store.FIRST_LOCAL_MODEL_TOAST_KEY, "1");
    signalModelsWriteCommitted({ firstLocal: true });
    await (await held.request(1)).answer(200, known("claude"));
    expect(pushed()).toHaveLength(0);
  });
});

describe("'Use it for chat' (the brief's R2, R3, R4)", () => {
  let sink: ReturnType<typeof makeSink>;
  beforeEach(() => {
    sink = makeSink();
    store.setChatAnswererToastSink(sink);
  });

  const N = store.USE_IT_FOR_CHAT_NOTICES;
  const notice = (n: (typeof N)[keyof typeof N]) => ({
    id: expect.any(String),
    type: "launcher",
    severity: n.severity,
    dedupKey: n.dedupKey,
    message: n.message,
    timestamp: expect.any(Number),
  });
  const confirmation = () => ({
    id: expect.any(String),
    type: "launcher",
    severity: "info",
    message: store.FIRST_LOCAL_MODEL_TOAST_TEXT,
    dedupKey: "first-local-model-chat",
    timestamp: expect.any(Number),
  });
  /** Pushes after the confirmation. */
  const notices = () => sink.push.mock.calls.slice(1);

  /** The first local model saved; its read answers `body`. Returns the id. */
  async function pushConfirmation(body: unknown = known("claude")): Promise<string> {
    const n = held.calls.length;
    signalModelsWriteCommitted({ firstLocal: true });
    await (await held.request(n + 1)).answer(200, body);
    expect(sink.push).toHaveBeenCalledTimes(1);
    return (sink.push.mock.calls[0][0] as TandemNotification).id;
  }
  /** Press through the toast's own button, never the store function. */
  const click = () => (sink.push.mock.calls[0][1] as ToastAction).onClick();
  const expectWithdrawn = (id: string) => {
    expect(sink.dismiss).toHaveBeenCalledTimes(1);
    expect(sink.dismiss).toHaveBeenCalledWith(id);
    expect(sink.dismissActivity).toHaveBeenCalledTimes(1);
    expect(sink.dismissActivity).toHaveBeenCalledWith(id);
  };
  const expectKept = async (id: string) => {
    expect(sink.dismiss).not.toHaveBeenCalled();
    expect(sink.dismissActivity).not.toHaveBeenCalled();
    // The id is kept: a later known-local read still takes the row down.
    await readAs(200, known("local"));
    expectWithdrawn(id);
  };

  it("the label and the five notices, word for word (R4)", () => {
    expect(store.USE_IT_FOR_CHAT_LABEL).toBe("Use it for chat");
    expect(N).toEqual({
      set: {
        severity: "info",
        dedupKey: "use-it-for-chat-set",
        message: "Chat was set to your local model.",
      },
      notSaved: {
        severity: "warning",
        dedupKey: "use-it-for-chat-not-saved",
        message:
          "Chat was set to your local model, but Tandem could not save that choice, so chat may be set back to Claude when Tandem restarts.",
      },
      refused: {
        severity: "warning",
        dedupKey: "use-it-for-chat-refused",
        message: "Chat could not be set to your local model. It was left set to Claude.",
      },
      notConfirmed: {
        severity: "warning",
        dedupKey: "use-it-for-chat-not-confirmed",
        message:
          "Tandem could not confirm that chat was set to your local model. Check Who answers your chat in Settings → Models.",
      },
      notRead: {
        severity: "warning",
        dedupKey: "use-it-for-chat-not-read",
        message:
          "Tandem did not change who answers your chat, because it could not read the current setting. Check Who answers your chat in Settings → Models.",
      },
    });
  });

  describe("the push (R2)", () => {
    for (const [label, body] of [
      ["usable", known("claude", { localModelState: "usable", localModelResolves: true })],
      ["none", known("claude", { localModelState: "none" })],
      [
        "absent (the check threw)",
        { answerer: "claude", localModelResolves: false, runGeneration: "gen-1" },
      ],
    ] as const) {
      it(`known Claude, state ${label}: the confirmation with the staying action; no POST`, async () => {
        await pushConfirmation(body);
        expect(sink.push).toHaveBeenCalledWith(confirmation(), USE_IT_ACTION);
        await drain();
        expect(posts()).toHaveLength(0);
      });
    }

    it("the guard: a Settings switch to local settles while the push's read is held, which then answers Claude: nothing", async () => {
      await readAs(200, known("claude"));
      signalModelsWriteCommitted({ firstLocal: true });
      const pushRead = await held.request(2);
      const done = store.setChatAnswerer("local");
      await (await held.request(3)).answer(200, { answerer: "local", persisted: true });
      await pushRead.answer(200, known("claude"));
      await (await held.request(4)).answer(200, known("local"));
      await done;
      expect(sink.push).not.toHaveBeenCalled();
    });
  });

  it("a sink whose push throws does not spend the offer: unmarked, and the next first local model pushes it (review round 1)", async () => {
    sink.push.mockImplementationOnce(() => {
      throw new Error("sink gone");
    });
    signalModelsWriteCommitted({ firstLocal: true });
    await (await held.request(1)).answer(200, known("claude"));
    expect(localStorage.getItem(store.FIRST_LOCAL_MODEL_TOAST_KEY)).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      "[chat-answerer] the first-local-model toast failed",
      expect.any(Error),
    );
    signalModelsWriteCommitted({ firstLocal: true });
    await (await held.request(2)).answer(200, known("claude"));
    expect(sink.push).toHaveBeenCalledTimes(2);
    expect(sink.push).toHaveBeenLastCalledWith(confirmation(), USE_IT_ACTION);
    expect(localStorage.getItem(store.FIRST_LOCAL_MODEL_TOAST_KEY)).toBe("1");
    // The failed push's id was dropped: a known-local read withdraws only the shown one.
    await readAs(200, known("local"));
    const shown = (sink.push.mock.calls[1][0] as TandemNotification).id;
    expect(sink.dismiss.mock.calls).toEqual([[shown]]);
    expect(sink.dismissActivity.mock.calls).toEqual([[shown]]);
  });

  it("a push that throws leaves no id behind: a later known-local read dismisses nothing", async () => {
    sink.push.mockImplementationOnce(() => {
      throw new Error("sink gone");
    });
    signalModelsWriteCommitted({ firstLocal: true });
    await (await held.request(1)).answer(200, known("claude"));
    await readAs(200, known("local"));
    expect(sink.dismiss).not.toHaveBeenCalled();
    expect(sink.dismissActivity).not.toHaveBeenCalled();
  });

  describe("through the button", () => {
    it("a push that throws during a press leaves nothing unhandled", async () => {
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        await pushConfirmation();
        sink.push.mockImplementation(() => {
          throw new Error("sink gone");
        });
        click();
        await (await held.request(2)).fail(); // X, whose push throws
        await drain();
        await new Promise((r) => setTimeout(r, 0));
        expect(unhandled).not.toHaveBeenCalled();
        expect(console.warn).toHaveBeenCalledWith(
          "[chat-answerer] Use it for chat failed",
          expect.any(Error),
        );
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    });
  });

  describe("SwitchResult (R3.1), one row per exit", () => {
    async function result(status: number, body: unknown, value: "claude" | "local" = "local") {
      const n = held.calls.length;
      const done = store.setChatAnswerer(value);
      await (await held.request(n + 1)).answer(status, body);
      await (await held.request(n + 2)).answer(200, known("claude"));
      return done;
    }
    const answered = (effective: string, saved: boolean, superseded: boolean) => ({
      kind: "answered",
      effective,
      saved,
      superseded,
    });
    const SUP = "CHAT_ANSWERER_SUPERSEDED";
    const WF = "CHAT_ANSWERER_WRITE_FAILED";

    it("local while not known: not-sent, nothing fetched", async () => {
      expect(await store.setChatAnswerer("local")).toEqual({ kind: "not-sent" });
      await drain();
      expect(held.calls).toHaveLength(0);
    });

    describe("with a known read", () => {
      beforeEach(async () => {
        await readAs(200, known("claude"));
      });

      it("a switch pending: not-sent", async () => {
        const first = store.setChatAnswerer("claude");
        expect(await store.setChatAnswerer("local")).toEqual({ kind: "not-sent" });
        await (await held.request(2)).answer(200, { answerer: "claude", persisted: true });
        await (await held.request(3)).answer(200, known("claude"));
        expect(await first).toEqual(answered("claude", true, false));
      });

      it("200 local: answered, saved", async () => {
        expect(await result(200, { answerer: "local", persisted: true })).toEqual(
          answered("local", true, false),
        );
      });
      it("409 superseded local, persisted true and false", async () => {
        expect(await result(409, { answerer: "local", persisted: true, code: SUP })).toEqual(
          answered("local", true, true),
        );
        expect(await result(409, { answerer: "local", persisted: false, code: SUP })).toEqual(
          answered("local", false, true),
        );
      });
      it("409 superseded Claude", async () => {
        expect(await result(409, { answerer: "claude", persisted: true, code: SUP })).toEqual(
          answered("claude", true, true),
        );
      });
      it("500 write-failed, Claude and local", async () => {
        expect(await result(500, { answerer: "claude", persisted: false, code: WF })).toEqual(
          answered("claude", false, false),
        );
        expect(await result(500, { answerer: "local", persisted: false, code: WF })).toEqual(
          answered("local", false, false),
        );
      });
      for (const [label, status, body] of [
        ["403 OWN_WINDOW_ONLY", 403, { code: "OWN_WINDOW_ONLY" }],
        ["404", 404, { error: "NOT_FOUND" }],
        ["400", 400, { error: "BAD_REQUEST" }],
        ["409 without the code", 409, { answerer: "local", persisted: true }],
        ["an unreadable 200", 200, "not a body"],
      ] as const) {
        it(`${label}: unconfirmed`, async () => {
          expect(await result(status, body)).toEqual({ kind: "unconfirmed" });
        });
      }
      it("a throw and a timeout: unconfirmed", async () => {
        let done = store.setChatAnswerer("local");
        await (await held.request(2)).fail();
        await (await held.request(3)).answer(200, known("claude"));
        expect(await done).toEqual({ kind: "unconfirmed" });
        done = store.setChatAnswerer("local");
        await (await held.request(4)).timeout();
        await (await held.request(5)).answer(200, known("claude"));
        expect(await done).toEqual({ kind: "unconfirmed" });
      });
    });

    it("a press, a clear while its POST is held, then 200 local: still answered local saved, and S", async () => {
      const id = await pushConfirmation();
      click();
      await (await held.request(2)).answer(200, known("claude"));
      const post = await held.request(3);
      store.clearChatAnswererOutcome();
      await post.answer(200, { answerer: "local", persisted: true });
      await (await held.request(4)).answer(200, known("local"));
      await drain();
      expect(notices()).toEqual([[notice(N.set)]]);
      expectWithdrawn(id);
    });
  });

  describe("the press (R3.2)", () => {
    it("row 2: a press during a pending Settings switch reads nothing, sends nothing, shows nothing", async () => {
      await pushConfirmation();
      const done = store.setChatAnswerer("local");
      const post = await held.request(2);
      click();
      await drain();
      expect(gets()).toHaveLength(1);
      expect(posts()).toHaveLength(1);
      await post.answer(500, {
        answerer: "local",
        persisted: false,
        code: "CHAT_ANSWERER_WRITE_FAILED",
      });
      await (await held.request(3)).answer(200, known("local"));
      await done;
      await drain();
      expect(posts()).toHaveLength(1);
      expect(notices()).toEqual([]);
      expect(state.outcomeLine).toBe(store.CHAT_ANSWERER_OUTCOME_LINES.localNotSaved);
    });

    it("row 3: the press's own read answers known local: no POST, nothing shown, withdrawn", async () => {
      const id = await pushConfirmation();
      click();
      await (await held.request(2)).answer(200, known("local"));
      await drain();
      expect(posts()).toHaveLength(0);
      expect(notices()).toEqual([]);
      expectWithdrawn(id);
    });

    it("not adopted: a Settings switch started during the press's read: nothing shown, one POST in all", async () => {
      await pushConfirmation();
      click();
      const pressRead = await held.request(2);
      const done = store.setChatAnswerer("claude");
      const post = await held.request(3);
      await pressRead.answer(200, known("claude"));
      await post.answer(200, { answerer: "claude", persisted: true });
      await (await held.request(4)).answer(200, known("claude"));
      await done;
      await drain();
      expect(posts()).toHaveLength(1);
      expect(notices()).toEqual([]);
    });

    it("rows read the STORE: a press whose read is not adopted (a new server process) and fails still sends, by the store's known Claude", async () => {
      const id = await pushConfirmation();
      store.noteCtrlSynced({});
      await (await held.request(2)).answer(200, known("claude"));
      click();
      const pressRead = await held.request(3);
      store.noteCtrlSynced({}); // a new process: the press's read is not adopted
      await pressRead.fail();
      expect(state.known).toBe(true);
      await vi.waitFor(() => expect(posts()).toHaveLength(1));
      expect(posts()[0].body).toEqual({ answerer: "local" });
      await posts()[0].answer(200, { answerer: "local", persisted: true });
      for (let i = 0; i < 3; i++) {
        await drain();
        for (const c of held.calls.slice(3))
          if (c.method === "GET") await c.answer(200, known("local"));
      }
      await drain();
      expect(posts()).toHaveLength(1);
      expect(notices()).toEqual([[notice(N.set)]]);
      expectWithdrawn(id);
    });

    it("row 4: the press's read fails: no POST, X once, the confirmation kept", async () => {
      const id = await pushConfirmation();
      click();
      await (await held.request(2)).fail();
      await drain();
      expect(posts()).toHaveLength(0);
      expect(notices()).toEqual([[notice(N.notRead)]]);
      await expectKept(id);
    });

    it("row 4 with no confirmation pushed: X once (no early return on a missing id)", async () => {
      const done = store.pressUseItForChat();
      await (await held.request(1)).fail();
      await done;
      expect(sink.push.mock.calls).toEqual([[notice(N.notRead)]]);
      expect(posts()).toHaveLength(0);
    });

    describe("row 5: one POST, reported by its result", () => {
      async function press(status: number, body: unknown, reread: unknown) {
        const id = await pushConfirmation();
        click();
        await (await held.request(2)).answer(200, known("claude"));
        const post = await held.request(3);
        expect(post.method).toBe("POST");
        expect(post.body).toEqual({ answerer: "local" });
        if (status === 0) await post.fail();
        else if (status === -1) await post.timeout();
        else await post.answer(status, body);
        const get = await held.request(4);
        if (reread === "fail") await get.fail();
        else await get.answer(200, reread);
        await drain();
        expect(posts()).toHaveLength(1);
        expect(state.outcomeLine).toBeNull();
        return id;
      }
      const SUP = "CHAT_ANSWERER_SUPERSEDED";
      const WF = "CHAT_ANSWERER_WRITE_FAILED";

      it("S: 200 local, the re-read known local", async () => {
        const id = await press(200, { answerer: "local", persisted: true }, known("local"));
        expect(notices()).toEqual([[notice(N.set)]]);
        expectWithdrawn(id);
      });
      it("S: 200 local, the re-read failing", async () => {
        const id = await press(200, { answerer: "local", persisted: true }, "fail");
        expect(notices()).toEqual([[notice(N.set)]]);
        expectWithdrawn(id);
      });
      it("U: 500 write-failed with local in effect", async () => {
        const id = await press(
          500,
          { answerer: "local", persisted: false, code: WF },
          known("local"),
        );
        expect(notices()).toEqual([[notice(N.notSaved)]]);
        expectWithdrawn(id);
      });
      it("S: 409 superseded local, persisted", async () => {
        const id = await press(
          409,
          { answerer: "local", persisted: true, code: SUP },
          known("local"),
        );
        expect(notices()).toEqual([[notice(N.set)]]);
        expectWithdrawn(id);
      });
      it("U: 409 superseded local, not persisted", async () => {
        const id = await press(
          409,
          { answerer: "local", persisted: false, code: SUP },
          known("local"),
        );
        expect(notices()).toEqual([[notice(N.notSaved)]]);
        expectWithdrawn(id);
      });
      it("nothing: 409 superseded Claude (another choice won)", async () => {
        const id = await press(
          409,
          { answerer: "claude", persisted: true, code: SUP },
          known("claude"),
        );
        expect(notices()).toEqual([]);
        await expectKept(id);
      });

      // Review rounds 1 and 2: any other result, first match — the store
      // known local after the re-read, S; the POST's own answer naming Claude
      // in effect, R; anything else, N (a store still saying Claude may be
      // stale, so it never gives R).
      describe("a refused or failed write (500 write-failed, Claude in effect)", () => {
        const refused = { answerer: "claude", persisted: false, code: WF };
        it("store known Claude: R (a new string, not Settings' line)", async () => {
          const id = await press(500, refused, known("claude"));
          expect(notices()).toEqual([[notice(N.refused)]]);
          expect(N.refused.message).not.toBe(store.CHAT_ANSWERER_OUTCOME_LINES.localRefused);
          await expectKept(id);
        });
        it("store known local (another window set it): S, and the confirmation withdrawn", async () => {
          const id = await press(500, refused, known("local"));
          expect(notices()).toEqual([[notice(N.set)]]);
          expectWithdrawn(id);
        });
        it("store not known (the re-read failed): R, on the server's own answer", async () => {
          const id = await press(500, refused, "fail");
          expect(notices()).toEqual([[notice(N.refused)]]);
          await expectKept(id);
        });
      });

      describe("unconfirmed", () => {
        for (const [label, status, body] of [
          ["403", 403, { code: "OWN_WINDOW_ONLY" }],
          ["404", 404, { error: "NOT_FOUND" }],
          ["a network failure", 0, null],
        ] as const) {
          it(`${label}, store known Claude: N (the response does not state the answerer)`, async () => {
            const id = await press(status, body, known("claude"));
            expect(notices()).toEqual([[notice(N.notConfirmed)]]);
            await expectKept(id);
          });
        }
        it("a POST that timed out but landed, store known local: S, and the confirmation withdrawn", async () => {
          const id = await press(-1, null, known("local"));
          expect(notices()).toEqual([[notice(N.set)]]);
          expectWithdrawn(id);
        });
        it("a server restart during the switch: the POST timed out but landed, its re-read (answering local) is dropped as a new process's, the stale store still says Claude: N, not R", async () => {
          const id = await pushConfirmation();
          store.noteCtrlSynced({});
          await (await held.request(2)).answer(200, known("claude"));
          click();
          await (await held.request(3)).answer(200, known("claude"));
          const post = await held.request(4);
          await post.timeout();
          const reread = await held.request(5);
          store.noteCtrlSynced({}); // a new server process: this re-read is not adopted
          await reread.answer(200, known("local")); // the POST landed
          // The press has decided: the store is the stale Claude it held.
          expect(state.known).toBe(true);
          expect(state.answerer).toBe("claude");
          expect(notices()).toEqual([[notice(N.notConfirmed)]]);
          await (await held.request(6)).answer(200, known("claude"));
          await drain();
          expect(posts()).toHaveLength(1);
          expect(notices()).toEqual([[notice(N.notConfirmed)]]);
          await expectKept(id);
        });
        it("a POST that timed out, store not known (the re-read failed): N", async () => {
          const id = await press(-1, null, "fail");
          expect(notices()).toEqual([[notice(N.notConfirmed)]]);
          await expectKept(id);
        });
      });
    });

    it("the switch counter: store not known, a press, then 'Set chat to Claude' sent during the press's read, which settles while that POST is on the wire: the press is silent (review round 2)", async () => {
      const id = await pushConfirmation();
      await readAs(403, { code: "OWN_WINDOW_ONLY" }); // the store is not known
      click();
      const pressRead = await held.request(3);
      const done = store.setChatAnswerer("claude"); // allowed while not known
      const post = await held.request(4);
      await pressRead.answer(403, { code: "OWN_WINDOW_ONLY" });
      await drain();
      expect(notices()).toEqual([]);
      await post.answer(200, { answerer: "claude", persisted: true });
      await (await held.request(5)).answer(403, { code: "OWN_WINDOW_ONLY" });
      await done;
      await drain();
      expect(posts()).toHaveLength(1);
      expect(notices()).toEqual([]);
      await expectKept(id);
    });

    it("a full Settings switch to Claude during the press's read: the press sends nothing and shows nothing (review round 1)", async () => {
      const id = await pushConfirmation();
      click();
      const pressRead = await held.request(2);
      const done = store.setChatAnswerer("claude");
      await (await held.request(3)).answer(200, { answerer: "claude", persisted: true });
      await pressRead.answer(200, known("claude"));
      await (await held.request(4)).answer(200, known("claude"));
      await done;
      await drain();
      expect(posts()).toHaveLength(1);
      expect(posts()[0].body).toEqual({ answerer: "claude" });
      expect(notices()).toEqual([]);
      await expectKept(id);
    });
  });

  describe("the withdrawal (R3.3)", () => {
    it("an adopted known-local read withdraws once", async () => {
      const id = await pushConfirmation();
      await readAs(200, known("local"));
      await readAs(200, known("local"));
      expectWithdrawn(id);
    });

    it("a Settings switch to local answered 200 whose re-read fails withdraws once (direct write)", async () => {
      const id = await pushConfirmation();
      const done = store.setChatAnswerer("local");
      await (await held.request(2)).answer(200, { answerer: "local", persisted: true });
      await (await held.request(3)).fail();
      await done;
      expectWithdrawn(id);
    });

    it("a Settings switch to local answered 500 write-failed (local in effect) whose re-read fails withdraws once (direct write)", async () => {
      const id = await pushConfirmation();
      const done = store.setChatAnswerer("local");
      await (await held.request(2)).answer(500, {
        answerer: "local",
        persisted: false,
        code: "CHAT_ANSWERER_WRITE_FAILED",
      });
      await (await held.request(3)).fail();
      await done;
      expectWithdrawn(id);
    });

    it("a refused page's 'Set chat to Claude' answered 409 superseded naming local withdraws once (read not known)", async () => {
      const id = await pushConfirmation();
      await readAs(403, { code: "OWN_WINDOW_ONLY" });
      const done = store.setChatAnswerer("claude");
      await (await held.request(3)).answer(409, {
        answerer: "local",
        persisted: true,
        code: "CHAT_ANSWERER_SUPERSEDED",
      });
      await (await held.request(4)).answer(403, { code: "OWN_WINDOW_ONLY" });
      await done;
      expect(state.known).toBe(false);
      expectWithdrawn(id);
    });

    it("a known-Claude read (state none, and absent) and a failed read withdraw nothing", async () => {
      await pushConfirmation();
      await readAs(200, known("claude"));
      await readAs(200, { answerer: "claude", localModelResolves: false, runGeneration: "g" });
      const p = store.requestRead();
      await (await held.request(held.calls.length + 1)).fail();
      await p;
      expect(sink.dismiss).not.toHaveBeenCalled();
      expect(sink.dismissActivity).not.toHaveBeenCalled();
    });

    it("a known-local read that is not adopted (a Claude switch in flight) withdraws nothing", async () => {
      await pushConfirmation();
      const done = store.setChatAnswerer("claude");
      const post = await held.request(2);
      const read = store.requestRead();
      await (await held.request(3)).answer(200, known("local"));
      await read;
      await post.answer(200, { answerer: "claude", persisted: true });
      await (await held.request(4)).answer(200, known("claude"));
      await done;
      expect(sink.dismiss).not.toHaveBeenCalled();
      expect(sink.dismissActivity).not.toHaveBeenCalled();
    });

    it("a throwing dismiss leaves the read and the switch resolved, and warns", async () => {
      await pushConfirmation();
      sink.dismiss.mockImplementation(() => {
        throw new Error("gone");
      });
      await expect(readAs(200, known("local"))).resolves.toMatchObject({ status: "known" });
      expect(sink.dismissActivity).toHaveBeenCalledTimes(1);
      expect(console.warn).toHaveBeenCalledWith(
        "[chat-answerer] could not dismiss the confirmation",
        expect.any(Error),
      );
    });

    it("a throwing dismiss during a switch: setChatAnswerer still resolves with its result", async () => {
      await pushConfirmation();
      sink.dismiss.mockImplementation(() => {
        throw new Error("gone");
      });
      const done = store.setChatAnswerer("local");
      await (await held.request(2)).answer(200, { answerer: "local", persisted: true });
      await (await held.request(3)).answer(200, known("local"));
      await expect(done).resolves.toEqual({
        kind: "answered",
        effective: "local",
        saved: true,
        superseded: false,
      });
      expect(sink.dismissActivity).toHaveBeenCalledTimes(1);
    });
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
