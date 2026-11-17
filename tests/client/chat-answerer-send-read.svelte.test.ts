// @vitest-environment happy-dom

/**
 * The send-time toast's wait (#1123, #2433 M1): a chat send's own
 * chat-answerer read (`noteChatSent`'s record), taken by App's addressed-ai
 * handler (`takeSendRead`) and settled after the probe
 * (`settleSendLocalPeriod`). The REAL store with only `fetch` stubbed (held
 * open and released by hand); `BYO_MODELS_ENABLED` is mocked on, as in
 * `chat-answerer-store.svelte.test.ts`. The dark half is
 * `chat-answerer-store-dark.test.ts`; App's call sites are pinned in
 * `app-chat-answerer-wiring.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../src/shared/types";
import { drain, installHeldFetch } from "../helpers/held-fetch";
import { asTandemOwnWindow } from "../helpers/models-write-access.svelte";

vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants.js")>()),
  BYO_MODELS_ENABLED: true as false,
}));

const store = await import("../../src/client/hooks/useChatAnswerer.svelte.js");
type ReadOutcome = import("../../src/client/hooks/useChatAnswerer.svelte.js").ReadOutcome;

asTandemOwnWindow();

let held: ReturnType<typeof installHeldFetch>;
const state = store.createChatAnswerer();

const known = (answerer: "claude" | "local") => ({
  answerer,
  localModelResolves: false,
  localModelState: "none",
  runGeneration: "gen-1",
});

let n = 0;
const msg = (): ChatMessage =>
  ({ id: `u${++n}`, author: "user", text: "q", timestamp: n, read: false }) as ChatMessage;

/** A chat send as App makes it: `noteChatSent`, then the handler's take. */
function sendAndTake(heldFlag = false) {
  store.noteChatSent(msg(), { aiOff: false, held: heldFlag });
  return store.takeSendRead();
}

/** Track a promise's settlement without awaiting it. */
function track<T>(p: Promise<T>) {
  const t: { done: boolean; value?: T } = { done: false };
  void p.then((v) => {
    t.done = true;
    t.value = v;
  });
  return t;
}

const gets = () => held.calls.filter((c) => c.method === "GET");

/** Read once and answer it. */
async function readAs(status: number, body: unknown) {
  const p = store.requestRead();
  const call = await held.request(held.calls.length + 1);
  await call.answer(status, body);
  return p;
}

beforeEach(() => {
  store._resetChatAnswererForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  held = installHeldFetch();
});

afterEach(() => {
  vi.useRealTimers();
  store._resetChatAnswererForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the race, both orders (read not known, nothing held)", () => {
  it("(a) the read settles known local after the take, before the settle call: true", async () => {
    const take = sendAndTake();
    expect(take).not.toBeNull();
    expect(take?.localPeriodAtSend).toBe(false);
    await (await held.request(1)).answer(200, known("local"));
    expect(await store.settleSendLocalPeriod(take!)).toBe(true);
  });

  it("(b) the read settles known local after the settle call: true, and not before", async () => {
    const take = sendAndTake();
    const settled = track(store.settleSendLocalPeriod(take!));
    const call = await held.request(1);
    await drain();
    expect(settled.done).toBe(false);
    await call.answer(200, known("local"));
    expect(settled).toEqual({ done: true, value: true });
  });

  it("(c) the read settles known Claude: false", async () => {
    const take = sendAndTake();
    await (await held.request(1)).answer(200, known("claude"));
    expect(await store.settleSendLocalPeriod(take!)).toBe(false);
  });

  it("(d) the read fails: the value at the send (false)", async () => {
    const take = sendAndTake();
    await (await held.request(1)).fail();
    expect(state.status).toBe("failed");
    expect(await store.settleSendLocalPeriod(take!)).toBe(false);
  });

  for (const [label, status, body] of [
    ["refused", 403, { error: "FORBIDDEN", code: "OWN_WINDOW_ONLY" }],
    ["unavailable", 404, { error: "NOT_FOUND" }],
  ] as const) {
    it(`(e) the read ends ${label}: the value at the send`, async () => {
      const heldTake = sendAndTake(true);
      expect(heldTake?.localPeriodAtSend).toBe(true);
      await (await held.request(1)).answer(status, body);
      expect(state.status).toBe(label);
      expect(await store.settleSendLocalPeriod(heldTake!)).toBe(true);

      const take = sendAndTake(false);
      await (await held.request(2)).answer(status, body);
      expect(await store.settleSendLocalPeriod(take!)).toBe(false);
    });
  }
});

describe("the local period after the wait", () => {
  it("always-live is wrong: known local at the send, nothing held, the read fails: true", async () => {
    await readAs(200, known("local"));
    const take = sendAndTake(false);
    expect(take?.localPeriodAtSend).toBe(true);
    await (await held.request(2)).fail();
    expect(state.known).toBe(false);
    expect(await store.settleSendLocalPeriod(take!)).toBe(true);
  });

  it("live checks known: an earlier known local, a failed re-read, the send's read fails: false", async () => {
    await readAs(200, known("local"));
    const reread = store.requestRead();
    await (await held.request(2)).fail();
    await reread;
    expect(state.status).toBe("failed");
    expect(state.answerer).toBe("local");
    const take = sendAndTake(false);
    expect(take?.localPeriodAtSend).toBe(false);
    await (await held.request(3)).fail();
    expect(await store.settleSendLocalPeriod(take!)).toBe(false);
  });
});

describe("the cap runs from the take", () => {
  it("queued behind a hung read: resolves at REQUEST_TIMEOUT_MS after the take, not before", async () => {
    void store.requestRead();
    await held.request(1); // the in-flight read's fetch, recorded before the fake clock
    vi.useFakeTimers();
    const take = sendAndTake();
    const settled = track(store.settleSendLocalPeriod(take!));
    await vi.advanceTimersByTimeAsync(store.REQUEST_TIMEOUT_MS - 1);
    await drain();
    expect(settled.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await drain();
    expect(settled).toEqual({ done: true, value: false });
    // The queued read never started: the in-flight one never settled.
    expect(gets()).toHaveLength(1);
  });

  it("the cap has already run out when settle is called: it resolves without waiting", async () => {
    void store.requestRead();
    await held.request(1);
    vi.useFakeTimers();
    const take = sendAndTake();
    // A slow probe: the whole cap passes before the handler settles.
    await vi.advanceTimersByTimeAsync(store.REQUEST_TIMEOUT_MS);
    const settled = track(store.settleSendLocalPeriod(take!));
    await drain();
    expect(settled).toEqual({ done: true, value: false });
  });
});

describe("whose read is waited on", () => {
  it("the send's own queued read, not the read already in flight", async () => {
    void store.requestRead(); // another trigger's read
    const inFlight = await held.request(1);
    const take = sendAndTake();
    const settled = track(store.settleSendLocalPeriod(take!));
    await inFlight.fail();
    expect(state.status).toBe("failed");
    expect(settled.done).toBe(false);
    const own = await held.request(2);
    await drain();
    expect(settled.done).toBe(false);
    await own.answer(200, known("local"));
    expect(settled).toEqual({ done: true, value: true });
  });

  it("two sends: each take resolves with its own send's read (by settle order)", async () => {
    const first = sendAndTake();
    const firstRead = await held.request(1);
    const second = sendAndTake();
    const s1 = track(store.settleSendLocalPeriod(first!));
    const s2 = track(store.settleSendLocalPeriod(second!));
    await firstRead.answer(200, known("local"));
    expect(s1).toEqual({ done: true, value: true });
    expect(s2.done).toBe(false);
    const secondRead = await held.request(2);
    await drain();
    expect(s2.done).toBe(false);
    await secondRead.answer(200, known("claude"));
    expect(s2).toEqual({ done: true, value: false });
  });

  it("one read per send: the take and the settle add no GET", async () => {
    store.noteChatSent(msg(), { aiOff: false, held: false });
    await (await held.request(1)).answer(200, known("local"));
    const alone = gets().length;

    store._resetChatAnswererForTests();
    held = installHeldFetch();
    const take = sendAndTake();
    await (await held.request(1)).answer(200, known("local"));
    await store.settleSendLocalPeriod(take!);
    await drain();
    expect(gets().length).toBe(alone);
    expect(alone).toBe(1);
  });
});

describe("never rejects, and no read means no record", () => {
  it("a planted record whose read rejects: the value at the send", async () => {
    let reject!: (e: unknown) => void;
    const read = new Promise<ReadOutcome>((_, r) => {
      reject = r;
    });
    store._setSendReadForTests(read, true);
    const take = store.takeSendRead();
    reject(new Error("boom"));
    expect(await store.settleSendLocalPeriod(take!)).toBe(true);
  });

  it("a planted read that rejects after a take nobody settles: no unhandled rejection", async () => {
    let reject!: (e: unknown) => void;
    const read = new Promise<ReadOutcome>((_, r) => {
      reject = r;
    });
    store._setSendReadForTests(read, false);
    expect(store.takeSendRead()).not.toBeNull();
    reject(new Error("boom"));
    await drain();
    // vitest fails the run on an unhandled rejection; reaching here is the pass.
  });

  it("the take clears the record", () => {
    sendAndTake();
    expect(store.takeSendRead()).toBeNull();
  });

  it("a send with the read known Claude records nothing, replacing an earlier record", async () => {
    // An earlier send left a record untaken (a Solo or fast-path return).
    store.noteChatSent(msg(), { aiOff: false, held: false });
    await (await held.request(1)).answer(200, known("claude"));
    expect(state.answerer).toBe("claude");
    store.noteChatSent(msg(), { aiOff: false, held: false });
    expect(store.takeSendRead()).toBeNull();
    await drain();
    expect(gets()).toHaveLength(1);
  });
});
