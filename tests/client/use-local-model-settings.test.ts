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
/** Responses a test holds open; consumed before the scripted `gets`/`posts`. */
let held: Promise<Response>[] = [];
let signals: unknown[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function respond(reply: Reply | undefined): Promise<Response> {
  if (reply === undefined || reply === "network-error") {
    return Promise.reject(new TypeError("fetch failed"));
  }
  return Promise.resolve(jsonResponse(reply.status, reply.body));
}

beforeEach(() => {
  _resetLocalModelSettingsForTests();
  gets = [];
  posts = [];
  calls = [];
  held = [];
  signals = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({
        method,
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
      });
      signals.push(init?.signal);
      const waiting = held.shift();
      if (waiting) return waiting;
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

  it("a failed refresh drops back to unknown rather than keep a value that may be stale", async () => {
    const s = createLocalModelSettings();
    gets.push({ status: 200, body: { editing: true } });
    await s.load();
    expect(s.known).toBe(true);
    gets.push("network-error");
    await s.load();
    expect(s.known).toBe(false);
    expect(s.loadFailed).toBe(true);
  });

  it("a successful load clears a notice left by an earlier save", async () => {
    const s = createLocalModelSettings();
    posts.push({ status: 500, body: { editing: false, persisted: false, code: "X" } });
    await s.setEditing(true);
    expect(s.saveNotice).not.toBeNull();
    gets.push({ status: 200, body: { editing: false } });
    await s.load();
    expect(s.saveNotice).toBeNull();
  });

  it("every request carries a timeout signal, so a hung server cannot leave the box unsettled", async () => {
    const s = createLocalModelSettings();
    gets.push({ status: 200, body: { editing: false } });
    posts.push({ status: 200, body: { editing: true, persisted: true } });
    await s.load();
    await s.setEditing(true);
    expect(signals).toHaveLength(2);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("a load asked for before a save is applied before it, however late its answer arrives", async () => {
    const s = createLocalModelSettings();
    // The GET is HELD: its answer (off) arrives only after the click. If loads
    // and saves were not one queue, the late answer would overwrite the save.
    const heldGet = deferred<Response>();
    held.push(heldGet.promise);
    posts.push({ status: 200, body: { editing: true, persisted: true } });
    const loading = s.load();
    const saving = s.setEditing(true);
    await Promise.resolve();
    expect(calls.map((c) => c.method)).toEqual(["GET"]); // the POST waits its turn
    heldGet.resolve(jsonResponse(200, { editing: false }));
    await Promise.all([loading, saving]);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
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

  it("a failed On shows off, with a notice that it is off for now", async () => {
    const s = createLocalModelSettings();
    posts.push({ status: 500, body: { editing: false, persisted: false, code: "X" } });
    await s.setEditing(true);
    expect(s.editing).toBe(false);
    expect(s.known).toBe(true);
    expect(s.saveNotice).toMatch(/could not be switched on. It is off for now/);
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

  it("serializes overlapping saves: the second is not sent until the first has answered", async () => {
    const s = createLocalModelSettings();
    // The first POST is HELD. Unserialized, the second would go out at once and
    // the first's late answer (on) would be applied last.
    const heldPost = deferred<Response>();
    held.push(heldPost.promise);
    posts.push({ status: 200, body: { editing: false, persisted: true } });
    const a = s.setEditing(true);
    const b = s.setEditing(false);
    await Promise.resolve();
    expect(calls.map((c) => c.body)).toEqual([{ editing: true }]);
    heldPost.resolve(jsonResponse(200, { editing: true, persisted: true }));
    await Promise.all([a, b]);
    expect(calls.map((c) => c.body)).toEqual([{ editing: true }, { editing: false }]);
    expect(s.editing).toBe(false);
  });
});

/**
 * Round 2: while any save is outstanding the DISPLAYED value belongs to the
 * user's latest click. Every response here is held open with a deferred and
 * released by hand, and `editing` is sampled after each step, so an answer
 * that flips the box even briefly fails the test.
 *
 * Each "Catches the removal of…" comment below was reasoned through the held
 * ordering and then confirmed by running this file against a transform-time
 * mutation of the hook (a throwaway vite plugin; `src/` was not edited): each
 * mutation failed exactly the tests that name it, and nothing else.
 */
describe("useLocalModelSettings — the display follows the last click", () => {
  /** Hold the next `n` requests open, in the order they will be sent. */
  function hold(n: number) {
    const ds = Array.from({ length: n }, () => deferred<Response>());
    held.push(...ds.map((d) => d.promise));
    return ds;
  }

  /** The queue hands over in microtasks; wait until request number `n` is out. */
  async function sent(n: number): Promise<void> {
    await vi.waitFor(() => expect(calls).toHaveLength(n));
  }

  // Catches the removal of the `_savesOutstanding === 0` guard on the SUCCESS
  // arm of the load path (`if (_savesOutstanding === 0) { _editing = editing; …`).
  // Reasoned through the held ordering: the click raises the count to 1 before
  // the GET answers, the POST cannot be sent until the load's turn ends, so the
  // count is still 1 when the GET's `{editing:false}` lands. Without the guard
  // that answer is written and the sample taken straight after `await loading`
  // reads false.
  it("a click made while the mount read is in flight is never contradicted by that read's answer", async () => {
    const s = createLocalModelSettings();
    const [heldGet, heldPost] = hold(2);
    const loading = s.load();
    await sent(1);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);

    const saving = s.setEditing(true); // the click
    expect(s.editing).toBe(true); // from the instant of the click
    expect(s.known).toBe(true);

    heldGet.resolve(jsonResponse(200, { editing: false })); // the older answer says off
    await loading;
    expect(s.editing).toBe(true); // …and is not shown
    expect(s.known).toBe(true);
    expect(s.loadFailed).toBe(false);

    await sent(2); // only now does the POST go out
    expect(calls[1]).toEqual({ method: "POST", body: { editing: true } });
    expect(s.editing).toBe(true);

    heldPost.resolve(jsonResponse(200, { editing: true, persisted: true }));
    await saving;
    expect(s.editing).toBe(true);
    expect(s.known).toBe(true);
    expect(s.saveNotice).toBeNull();
    expect(calls).toHaveLength(2);
  });

  // Same guard, same line, opposite polarity of click and read: an Off clicked
  // over a read that answers On. Kept separate because this is the dangerous
  // direction — the box would show On after the user switched it off.
  it("an Off clicked during the read is not flipped back on by a read that answers on", async () => {
    const s = createLocalModelSettings();
    const [heldGet, heldPost] = hold(2);
    const loading = s.load();
    await sent(1);
    const saving = s.setEditing(false);
    expect(s.editing).toBe(false);

    heldGet.resolve(jsonResponse(200, { editing: true }));
    await loading;
    expect(s.editing).toBe(false);

    await sent(2);
    expect(calls[1]).toEqual({ method: "POST", body: { editing: false } });
    heldPost.resolve(jsonResponse(200, { editing: false, persisted: true }));
    await saving;
    expect(s.editing).toBe(false);
    expect(s.known).toBe(true);
  });

  // Catches the removal of `if (_savesOutstanding > 0) return;` in the save
  // path. Reasoned through the held ordering: both clicks raise the count to 2
  // synchronously; the first POST's `finally` lowers it to 1, so the early
  // return is what stops `_editing = editing` (true) and `_saveNotice = notice`
  // from being written. Without it the samples after `await first` read
  // editing true and a non-null notice.
  it("two rapid clicks: the first save's answer is not shown; the second's is", async () => {
    const s = createLocalModelSettings();
    const [heldFirst, heldSecond] = hold(2);
    const first = s.setEditing(true);
    expect(s.editing).toBe(true);
    const second = s.setEditing(false);
    expect(s.editing).toBe(false); // the last click

    await sent(1);
    expect(calls[0]).toEqual({ method: "POST", body: { editing: true } });
    expect(s.editing).toBe(false); // while the first POST is held

    // The first answer says on, and carries a notice-worthy `persisted: false`.
    heldFirst.resolve(jsonResponse(500, { editing: true, persisted: false, code: "X" }));
    await first;
    expect(s.editing).toBe(false); // STILL the last click
    expect(s.saveNotice).toBeNull(); // and no notice about a save nobody is looking at

    await sent(2);
    expect(calls[1]).toEqual({ method: "POST", body: { editing: false } });
    expect(s.editing).toBe(false);

    // The server's answer to the last click differs from the click itself, so
    // "shows the server's answer" is distinguishable from "shows the click".
    heldSecond.resolve(jsonResponse(500, { editing: true, persisted: false, code: "X" }));
    await second;
    expect(s.editing).toBe(true);
    expect(s.known).toBe(true);
    expect(s.saveNotice).toMatch(/on for now/);
    expect(calls).toHaveLength(2);
  });

  // Catches the removal of the `_savesOutstanding === 0` guard on the FAILURE
  // arm of the load path (`if (_savesOutstanding === 0) { _known = false;
  // _loadFailed = true; }`). Without it the samples after `await loading` read
  // known false / loadFailed true while the user's click is still on its way.
  it("a load that fails while a save is outstanding does not flip the store to unknown; the save's answer decides", async () => {
    const s = createLocalModelSettings();
    const [heldGet, heldPost] = hold(2);
    const loading = s.load();
    await sent(1);
    const saving = s.setEditing(true);

    heldGet.resolve(jsonResponse(503, { error: "UNAVAILABLE" })); // the read fails
    await loading;
    expect(s.known).toBe(true);
    expect(s.loadFailed).toBe(false);
    expect(s.editing).toBe(true);
    expect(s.loading).toBe(false);

    await sent(2);
    heldPost.resolve(jsonResponse(500, { editing: false, persisted: false, code: "X" }));
    await saving;
    expect(s.known).toBe(true); // the save's own answer: the server holds off
    expect(s.loadFailed).toBe(false);
    expect(s.editing).toBe(false);
    expect(s.saveNotice).toMatch(/could not be switched on/);
  });

  it("…and when that save cannot be answered or re-read either, its own failure is what makes the state unknown", async () => {
    const s = createLocalModelSettings();
    const [heldGet] = hold(1);
    posts.push("network-error");
    gets.push("network-error"); // the save's own re-read
    const loading = s.load();
    await sent(1);
    const saving = s.setEditing(true);
    heldGet.resolve(jsonResponse(503, { error: "UNAVAILABLE" }));
    await loading;
    expect(s.known).toBe(true); // not yet: the save has not answered
    await saving;
    expect(s.known).toBe(false);
    expect(s.loadFailed).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "GET"]);
  });
});

describe("useLocalModelSettings — loading", () => {
  it("is true from the call until the answer, and false after", async () => {
    const s = createLocalModelSettings();
    expect(s.loading).toBe(false);
    const heldGet = deferred<Response>();
    held.push(heldGet.promise);
    const loading = s.load();
    expect(s.loading).toBe(true); // synchronously, before the request is even sent
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(s.loading).toBe(true);
    heldGet.resolve(jsonResponse(200, { editing: true }));
    await loading;
    expect(s.loading).toBe(false);
  });

  it("is false again after a load that fails", async () => {
    const s = createLocalModelSettings();
    const heldGet = deferred<Response>();
    held.push(heldGet.promise);
    const loading = s.load();
    expect(s.loading).toBe(true);
    heldGet.resolve(jsonResponse(500, {}));
    await loading;
    expect(s.loading).toBe(false);
    expect(s.loadFailed).toBe(true);
  });

  it("is true during a refresh of an already-known value, which stays readable underneath", async () => {
    const s = createLocalModelSettings();
    gets.push({ status: 200, body: { editing: true } });
    await s.load();
    const heldGet = deferred<Response>();
    held.push(heldGet.promise);
    const refreshing = s.load();
    expect(s.loading).toBe(true);
    expect(s.known).toBe(true); // the tab, not the store, hides the value while loading
    heldGet.resolve(jsonResponse(200, { editing: false }));
    await refreshing;
    expect(s.loading).toBe(false);
    expect(s.editing).toBe(false);
  });

  it("a save alone does not raise it", async () => {
    const s = createLocalModelSettings();
    const heldPost = deferred<Response>();
    held.push(heldPost.promise);
    const saving = s.setEditing(true);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(s.loading).toBe(false);
    heldPost.resolve(jsonResponse(200, { editing: true, persisted: true }));
    await saving;
    expect(s.loading).toBe(false);
  });
});
