/**
 * #1123 part C: how a local-model run ends in chat. Every case is driven
 * through the SHIPPED collaborator, `runLocalModelTurn` / `runLoop` and client,
 * with a hand-driven stream and fake timers (brief R6), so a flush lands
 * mid-turn exactly where a test says.
 *
 *  - R2: text inside `<think>` is never shown — asserted at every flush, as the
 *    editor composes it (the sidecar's text while present, else the row's).
 *  - R1: a run's row is removed exactly where a toast says it stopped without
 *    replying or that its reply was not delivered.
 *  - R3: a `clean` run that showed nothing gets the no-reply notice, in the
 *    same Y.Doc update as its run state.
 *
 * Endings outside the removal set are compared with master in
 * `run-ending-parity.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bumpContentGeneration } from "../../../src/server/documents/content-generation.js";
import {
  CHAT_NOTICE_TEXT,
  TRUNCATION_MARKER,
} from "../../../src/server/local-model/collaborator.js";
import { type RunTurnOpts, runLocalModelTurn } from "../../../src/server/local-model/index.js";
import {
  resetThinkFilterScannedForTests,
  shownText,
  thinkFilterScannedForTests,
} from "../../../src/server/local-model/think-filter.js";
import {
  removeClaudeChatMessage,
  unansweredUserChatKeys,
  updateClaudeChatMessage,
} from "../../../src/server/mcp/awareness.js";
import { LOCAL_RUN_GENERATION as G } from "../../../src/server/models/local-run-generation.js";
import { getOrCreateDocument } from "../../../src/server/yjs/provider.js";
import { CTRL_ROOM } from "../../../src/shared/constants.js";
import { withInternal } from "../../../src/shared/origins.js";
import {
  chatMap,
  collaborator,
  microtasks,
  noticeRows,
  PAST_FLUSH_MS,
  type Request,
  replyRows,
  resetWorld,
  row,
  setMode,
  settle,
  setupDoc,
  shownNow,
  streamFetch,
  streamMap,
  swapDoc,
  toasts,
  userChat,
} from "./run-ending-helpers.js";

const refuse = vi.hoisted(() => ({ on: false }));
vi.mock("../../../src/server/license/ai-refusal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/server/license/ai-refusal.js")>();
  return {
    ...actual,
    aiRefusal: () =>
      refuse.on
        ? { error: "LICENSE_REQUIRED" as const, kind: "unlicensed" as const, message: "x" }
        : null,
  };
});

const CAP = 64 * 1024;
const NOTICE = "Your local model produced no reply.";
/** A hidden block's text: long enough to pass the 80-character flush trigger. */
const SECRET = `secret reasoning ${"s".repeat(100)}`;

beforeEach(() => {
  vi.useFakeTimers();
  refuse.on = false;
  resetWorld();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const OUTLINE = (id = "c1") => ({ toolCalls: [{ id, name: "get_outline", args: {} }] });
const COMMENT = {
  toolCalls: [
    {
      id: "w1",
      name: "comment_on_quote",
      args: { quoted_text: "The body says hello.", comment: "c" },
    },
  ],
};

/**
 * Push `chunks` into one turn; after each, pass both flush triggers (the
 * clock past STREAM_FLUSH_MS; the chunks are long enough for the 80-char
 * trigger where a case needs it) and record what the editor shows.
 */
async function streamTurn(req: Request, chunks: string[], messageId = "u1"): Promise<string[]> {
  const seen: string[] = [];
  for (const c of chunks) {
    req.stream.push({ content: [c] });
    await vi.advanceTimersByTimeAsync(PAST_FLUSH_MS);
    seen.push(shownNow(messageId));
  }
  return seen;
}

/** One clean turn of `chunks`; returns every intermediate shown text and the final one. */
async function cleanTurn(chunks: string[]) {
  const net = streamFetch();
  setupDoc("d");
  const collab = collaborator();
  collab.onEvent(userChat("u1", "d"));
  const r1 = await net.next();
  const seen = await streamTurn(r1, chunks);
  r1.stream.close();
  await settle(collab);
  return { seen, final: shownNow("u1") };
}

function expectNoSecret(seen: string[]) {
  for (const s of seen) {
    expect(s).not.toContain("secret");
    expect(s).not.toMatch(/<thi?n?k?/i);
  }
}

describe("hiding <think> (R2)", () => {
  it("a closed block opening the turn is never shown", async () => {
    const { seen, final } = await cleanTurn([`<think>${SECRET}`, `${SECRET}</think>`, "Answer."]);
    expectNoSecret(seen);
    expect(final).toBe("Answer.");
  });

  it("a closed block after text is never shown", async () => {
    const { seen, final } = await cleanTurn(["Lead text. ", `<think>${SECRET}`, "</think> More."]);
    expectNoSecret(seen);
    expect(final).toBe("Lead text.  More.");
  });

  it("<think>a</think> <think>b: a second block at the turn's start hides the rest", async () => {
    const { seen, final } = await cleanTurn(["<think>a</think> <think>b", SECRET]);
    expectNoSecret(seen);
    expect(final).toBe("");
    expect(replyRows("u1")).toEqual([]);
  });

  it("nested-looking <think>a<think>b</think>c: the first close wins", async () => {
    const { seen, final } = await cleanTurn([`<think>a ${SECRET}<think>b ${SECRET}`, "</think>c"]);
    expectNoSecret(seen);
    expect(final).toBe("c");
  });

  it("an unclosed block opening the turn after whitespace hides the rest of the turn", async () => {
    const { seen, final } = await cleanTurn(["  \n<think>", SECRET, SECRET]);
    expectNoSecret(seen);
    expect(final).toBe("");
    expect(noticeRows("u1").map((m) => m.text)).toEqual([NOTICE]);
  });

  it("an unclosed block later in the text is held while streaming and shown, as written, at a clean end", async () => {
    const { seen, final } = await cleanTurn(["Answer. ", `<think>${SECRET}`, SECRET]);
    expectNoSecret(seen);
    expect(final).toBe(`Answer. <think>${SECRET}${SECRET}`);
  });

  it("the same held block is dropped at a tool-call turn's end", async () => {
    const net = streamFetch();
    setupDoc("d");
    const collab = collaborator();
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    const seen = await streamTurn(r1, ["Lead. ", `<think>${SECRET}`]);
    r1.stream.push(OUTLINE());
    r1.stream.close();
    const r2 = await net.next();
    seen.push(...(await streamTurn(r2, ["Final answer."])));
    r2.stream.close();
    await settle(collab);
    expectNoSecret(seen);
    expect(shownNow("u1")).toBe("Final answer.");
  });

  it("the same held block is dropped at a timeout", async () => {
    const net = streamFetch();
    setupDoc("d");
    const collab = collaborator();
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    const seen = await streamTurn(r1, ["Answer so far ", `<think>${SECRET}`]);
    await vi.advanceTimersByTimeAsync(181_000);
    await settle(collab);
    expectNoSecret(seen);
    expect(shownNow("u1")).toBe("Answer so far ");
    expect(row("u1")?.localRun?.reason).toBe("timeout");
  });

  it("the same held block is dropped at an error", async () => {
    const net = streamFetch();
    setupDoc("d");
    const collab = collaborator();
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    const seen = await streamTurn(r1, ["Answer so far ", `<think>${SECRET}`]);
    r1.stream.fail(new Error("socket hang up"));
    await settle(collab);
    expectNoSecret(seen);
    expect(shownNow("u1")).toBe("Answer so far ");
    expect(row("u1")?.localRun?.reason).toBe("error");
  });

  it("<THINK> is a tag (case-insensitive)", async () => {
    const { seen, final } = await cleanTurn([`<THINK>${SECRET}`, "</Think>Answer."]);
    expectNoSecret(seen);
    expect(final).toBe("Answer.");
  });

  it("<think foo>, <thinking> and <reasoning> are text, shown as written", async () => {
    const text = "<think foo>x</think foo> <thinking>y</thinking> <reasoning>z</reasoning> done";
    const { final } = await cleanTurn([text]);
    expect(final).toBe(text);
  });

  it("a lone </think> stays visible", async () => {
    const { final } = await cleanTurn(["reasoning</think>Answer."]);
    expect(final).toBe("reasoning</think>Answer.");
  });

  it("a block in one turn does not leak into the next", async () => {
    const net = streamFetch();
    setupDoc("d");
    const collab = collaborator();
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    const seen = await streamTurn(r1, [`<think>${SECRET}`]);
    r1.stream.push(OUTLINE());
    r1.stream.close();
    const r2 = await net.next();
    seen.push(...(await streamTurn(r2, ["Answer, ", "no tags."])));
    r2.stream.close();
    await settle(collab);
    expectNoSecret(seen);
    expect(shownNow("u1")).toBe("Answer, no tags.");
  });

  it("a tag split across chunks, with a flush between <thi and nk>: <thi was never shown", async () => {
    const net = streamFetch();
    setupDoc("d");
    const collab = collaborator();
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    const seen = await streamTurn(r1, [
      `Answer ${"a".repeat(90)} <thi`,
      `nk>${SECRET}</think> done`,
    ]);
    r1.stream.close();
    await settle(collab);
    expect(seen[0]).toBe(`Answer ${"a".repeat(90)} `);
    expectNoSecret(seen);
    expect(shownNow("u1")).toBe(`Answer ${"a".repeat(90)}  done`);
  });

  it("held text over the cap, released at a clean end, is exactly the cap plus the marker", async () => {
    const lead = "Start ";
    const held = `<think>${"z".repeat(CAP + 5000)}`;
    const net = streamFetch();
    setupDoc("d");
    const collab = collaborator();
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    await streamTurn(r1, [lead]);
    for (let i = 0; i < held.length; i += 8192)
      r1.stream.push({ content: [held.slice(i, i + 8192)] });
    await vi.advanceTimersByTimeAsync(PAST_FLUSH_MS);
    expect(shownNow("u1")).toBe(lead);
    r1.stream.close();
    await settle(collab);
    expect(shownNow("u1")).toBe((lead + held).slice(0, CAP) + TRUNCATION_MARKER);
    expect(row("u1")?.localRun?.status).toBe("replied");
  });

  it("a long block opening the turn, over the cap, then a short answer: the answer, no marker", async () => {
    const net = streamFetch();
    setupDoc("d");
    const collab = collaborator();
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    const block = `<think>${"q".repeat(CAP + 5000)}</think>`;
    for (let i = 0; i < block.length; i += 8192)
      r1.stream.push({ content: [block.slice(i, i + 8192)] });
    await vi.advanceTimersByTimeAsync(PAST_FLUSH_MS);
    expect(shownNow("u1")).toBe("");
    await streamTurn(r1, ["The answer."]);
    r1.stream.close();
    await settle(collab);
    expect(shownNow("u1")).toBe("The answer.");
    expect(row("u1")?.localRun?.status).toBe("replied");
  });

  it("cost: characters scanned are at most 2 × the input (k = 2), under the wire cap", async () => {
    // Text built to make the filter back off as often as possible: candidate
    // tags that fail on their last character, and `<` runs.
    const unit = "<thinx <<<</think <think <thi</thinkx ";
    const text = unit.repeat(Math.floor((512 * 1024) / unit.length));
    resetThinkFilterScannedForTests();
    const net = streamFetch();
    setupDoc("d");
    const collab = collaborator();
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    for (let i = 0; i < text.length; i += 16384)
      r1.stream.push({ content: [text.slice(i, i + 16384)] });
    r1.stream.close();
    await settle(collab);
    expect(thinkFilterScannedForTests()).toBeGreaterThanOrEqual(Math.min(text.length, CAP));
    expect(thinkFilterScannedForTests()).toBeLessThanOrEqual(2 * text.length);
  });

  it("shownText, the harness's form, agrees with the stream", () => {
    expect(shownText("<think>a</think>b", true)).toBe("b");
    expect(shownText("a <think>b", true)).toBe("a <think>b");
    expect(shownText("a <think>b", false)).toBe("a ");
    expect(shownText("a <thi", false)).toBe("a <thi");
  });
});

describe("the removal set (R1)", () => {
  const editingOff: Array<[string, () => void, boolean, string]> = [
    [
      "editing-off",
      () => setMode("tandem"),
      false,
      "The local model stopped without replying: it tried to comment on or change the document, which local models were not allowed to do for that reply. Ask again for an answer in chat.",
    ],
    [
      "solo",
      () => setMode("solo"),
      true,
      "The local model stopped without replying: it tried to comment on or change the document, which local models do not do in Solo mode. Ask again for an answer in chat.",
    ],
    [
      "mode-unknown",
      () => setMode(null),
      true,
      "The local model stopped without replying: it tried to comment on or change the document, which local models do not do while Tandem cannot tell whether it is in Solo or Tandem mode. Ask again for an answer in chat.",
    ],
  ];
  for (const [reason, mode, enabled, toast] of editingOff) {
    it(`editing_off (${reason}): a flushed preamble is removed; exact run state and toast`, async () => {
      const net = streamFetch();
      setupDoc("d");
      mode();
      const collab = collaborator({ editingState: () => ({ enabled, offEpoch: 0 }) });
      collab.onEvent(userChat("u1", "d"));
      const r1 = await net.next();
      const seen = await streamTurn(r1, ["I will add a comment on that sentence."]);
      expect(seen[0]).toBe("I will add a comment on that sentence.");
      r1.stream.push(COMMENT);
      r1.stream.close();
      const r2 = await net.next();
      await streamTurn(r2, ["  "]);
      r2.stream.close();
      await settle(collab);
      expect(replyRows("u1")).toEqual([]);
      expect(noticeRows("u1")).toEqual([]);
      expect(streamMap().size).toBe(0);
      expect(row("u1")?.localRun).toEqual({ status: "stopped", reason, generation: G });
      expect(toasts("d")).toEqual([{ severity: "info", message: toast }]);
    });
  }

  it("editing_off after the sink cap truncated the row: removed, no sidecar, no marker", async () => {
    // The cap's marker write and its abort share one deferred task (#1292),
    // so a committed marker always ends the run `aborted`; what reaches an
    // editing_off end is a row whose cap has tripped with the task pending.
    // Only the timers are faked here, so the stream's own I/O scheduling runs
    // and the next turn arrives with the cap's task still pending.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const net = streamFetch();
    setupDoc("d");
    const collab = collaborator();
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    await streamTurn(r1, ["Let me comment on it."]);
    expect(shownNow("u1")).toBe("Let me comment on it.");
    r1.stream.push({ content: ["w".repeat(CAP + 10)] });
    r1.stream.push(COMMENT);
    r1.stream.close();
    // Real I/O turns (setImmediate is not faked here) until the next turn's
    // request arrives; no fake timer is advanced, so the cap's task waits.
    for (let i = 0; i < 1000 && net.requests.length < 2; i++) {
      await new Promise((r) => setImmediate(r));
    }
    const r2 = await net.next();
    r2.stream.push({ content: [" "] });
    r2.stream.close();
    for (let i = 0; i < 1000 && row("u1")?.localRun?.status === "running"; i++) {
      await new Promise((r) => setImmediate(r));
    }
    await settle(collab);
    expect(rows().filter((m) => m.author === "claude")).toEqual([]);
    expect(streamMap().size).toBe(0);
    expect(row("u1")?.localRun).toEqual({
      status: "stopped",
      reason: "editing-off",
      generation: G,
    });
  });

  async function swappedRun(swap: (ydoc: ReturnType<typeof setupDoc>) => void) {
    const net = streamFetch();
    const ydoc = setupDoc("d");
    const collab = collaborator();
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    await streamTurn(r1, ["Let me check the outline first."]);
    r1.stream.push(OUTLINE());
    r1.stream.close();
    const r2 = await net.next();
    const seen = await streamTurn(r2, ["The body says"]);
    expect(seen[0]).toBe("The body says");
    swap(ydoc);
    r2.stream.push({ content: [" hello."] });
    r2.stream.close();
    await settle(collab);
  }

  it("doc-swapped, same instance (content replaced): preamble and partial removed", async () => {
    const touches: string[] = [];
    chatMap().observe((e) => {
      for (const [k, c] of e.changes.keys) touches.push(`${c.action}:${k}`);
    });
    await swappedRun((ydoc) => bumpContentGeneration(ydoc));
    // The row was minted, then deleted with its sidecar in one update: never
    // folded first (a fold would show as an `update` of the row).
    const replyTouches = touches.filter((t) => !t.endsWith(":u1"));
    expect(replyTouches.map((t) => t.split(":")[0])).toEqual(["add", "delete"]);
    expect(rows().filter((m) => m.author === "claude")).toEqual([]);
    expect(streamMap().size).toBe(0);
    expect(row("u1")?.localRun).toEqual({
      status: "stopped",
      reason: "content-replaced",
      generation: G,
    });
    expect(toasts("d")).toEqual([
      {
        severity: "warning",
        message:
          "The local model stopped: this document's content was replaced mid-turn (reloaded or edited in source view), so it stopped early — any comments it already added were carried over where their text survived, but its reply was not delivered. Ask again to continue.",
      },
    ]);
  });

  it("doc-swapped, a new instance (reconnected): preamble and partial removed", async () => {
    await swappedRun(() => swapDoc("d"));
    expect(rows().filter((m) => m.author === "claude")).toEqual([]);
    expect(streamMap().size).toBe(0);
    expect(row("u1")?.localRun).toEqual({
      status: "stopped",
      reason: "reconnected",
      generation: G,
    });
    expect(toasts("d")).toEqual([
      {
        severity: "warning",
        message:
          "The local model stopped: this document reconnected mid-turn, so it stopped early — any comments it already added are still there, but its reply was not delivered. Ask again to continue.",
      },
    ]);
  });

  it("three preambles then a removal-set ending: the row is removed once, at the end, never mid-run", async () => {
    const net = streamFetch();
    setupDoc("d");
    const deletes: string[] = [];
    chatMap().observe((e) => {
      for (const [k, c] of e.changes.keys) if (c.action === "delete") deletes.push(k);
    });
    const collab = collaborator();
    collab.onEvent(userChat("u1", "d"));
    for (let t = 1; t <= 3; t++) {
      const r = await net.next();
      const seen = await streamTurn(r, [`Checking part ${t}.`]);
      expect(seen[0]).toBe(`Checking part ${t}.`);
      r.stream.push(OUTLINE(`c${t}`));
      r.stream.close();
      expect(deletes).toEqual([]);
    }
    const r4 = await net.next();
    await streamTurn(r4, ["Now I will comment."]);
    r4.stream.push(COMMENT);
    r4.stream.close();
    const r5 = await net.next();
    r5.stream.close();
    await settle(collab);
    expect(deletes).toHaveLength(1);
    expect(replyRows("u1")).toEqual([]);
    expect(row("u1")?.localRun).toEqual({
      status: "stopped",
      reason: "editing-off",
      generation: G,
    });
  });
});

describe("removeClaudeChatMessage guards (the new chat writer)", () => {
  function put(id: string, msg: Partial<import("../../../src/shared/types.js").ChatMessage>) {
    const ctrl = getOrCreateDocument(CTRL_ROOM);
    withInternal(ctrl, () =>
      chatMap().set(id, { id, author: "claude", text: "t", timestamp: 1, read: true, ...msg }),
    );
  }

  it("keeps Claude's own tandem_reply row (no agentIdentity) and a notice row", () => {
    put("r1", { replyTo: "u1" });
    put("n1", { replyTo: "u1", chatNotice: "no-reply" });
    expect(removeClaudeChatMessage("r1")).toBe(false);
    expect(removeClaudeChatMessage("n1")).toBe(false);
    expect(row("r1")).toBeDefined();
    expect(row("n1")).toBeDefined();
  });

  it("removes a local-model reply row and its sidecar together", () => {
    put("l1", { agentIdentity: { provider: "local-ollama", displayName: "M" } });
    updateClaudeChatMessage("l1", "streamed text");
    expect(streamMap().has("l1")).toBe(true);
    let updates = 0;
    const ctrl = getOrCreateDocument(CTRL_ROOM);
    const onUpdate = () => {
      updates += 1;
    };
    ctrl.on("update", onUpdate);
    expect(removeClaudeChatMessage("l1")).toBe(true);
    ctrl.off("update", onUpdate);
    expect(updates).toBe(1);
    expect(row("l1")).toBeUndefined();
    expect(streamMap().has("l1")).toBe(false);
  });

  it("deletes an orphan sidecar whose row was cleared, and never re-creates the row", () => {
    put("l2", { agentIdentity: { provider: "local-ollama", displayName: "M" } });
    updateClaudeChatMessage("l2", "streamed text");
    const ctrl = getOrCreateDocument(CTRL_ROOM);
    withInternal(ctrl, () => chatMap().delete("l2"));
    expect(removeClaudeChatMessage("l2")).toBe(true);
    expect(row("l2")).toBeUndefined();
    expect(streamMap().has("l2")).toBe(false);
  });
});

function rows() {
  return [...chatMap().values()] as import("../../../src/shared/types.js").ChatMessage[];
}

describe("the no-reply notice (R3)", () => {
  function expectNotice() {
    const n = noticeRows("u1");
    expect(n.map((m) => [m.author, m.chatNotice, m.text, m.replyTo, m.documentId])).toEqual([
      ["claude", "no-reply", NOTICE, "u1", "d"],
    ]);
    expect(n[0].agentIdentity).toBeUndefined();
    expect(replyRows("u1")).toEqual([]);
    expect(row("u1")?.localRun).toEqual({ status: "stopped", reason: "no-reply", generation: G });
    expect(toasts("d")).toEqual([]);
  }

  it("the text is the brief's", () => {
    expect(CHAT_NOTICE_TEXT["no-reply"]).toBe(NOTICE);
  });

  it("a clean run with an empty last turn and no flush", async () => {
    await cleanTurn([]);
    expectNotice();
  });

  it("a lead-in discarded unflushed at a tool call, then an empty last turn", async () => {
    const net = streamFetch();
    setupDoc("d");
    const collab = collaborator();
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    r1.stream.push({ content: ["Let me check."] });
    r1.stream.push(OUTLINE());
    r1.stream.close();
    const r2 = await net.next();
    r2.stream.close();
    await settle(collab);
    expectNotice();
  });

  it("the same output with a flush before the tool call keeps the lead-in as the reply (D-C1)", async () => {
    const net = streamFetch();
    setupDoc("d");
    const collab = collaborator();
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    await streamTurn(r1, ["Let me check."]);
    r1.stream.push(OUTLINE());
    r1.stream.close();
    const r2 = await net.next();
    r2.stream.close();
    await settle(collab);
    expect(noticeRows("u1")).toEqual([]);
    expect(replyRows("u1").map((m) => m.text)).toEqual(["Let me check."]);
    expect(row("u1")?.localRun?.status).toBe("replied");
  });

  it("a run whose only text was a <think> block", async () => {
    await cleanTurn([`<think>${SECRET}</think>`]);
    expectNotice();
  });

  it("a run whose reasoning came only in a separate field", async () => {
    const net = streamFetch();
    setupDoc("d");
    const collab = collaborator();
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    r1.stream.push({
      extraFrames: [{ choices: [{ delta: { reasoning: "The answer is hello." } }] }],
    });
    r1.stream.push({ extraFrames: [{ choices: [{ delta: { thinking: "Still thinking." } }] }] });
    r1.stream.close();
    await settle(collab);
    expectNotice();
  });

  it("one Y.Doc update carries the notice and the run state", async () => {
    const updates: Set<string>[] = [];
    chatMap().observe((e) => updates.push(new Set(e.changes.keys.keys())));
    await cleanTurn([]);
    const noticeId = noticeRows("u1")[0]?.id;
    expect(noticeId).toBeDefined();
    const carrying = updates.filter((keys) => keys.has(noticeId as string));
    expect(carrying).toHaveLength(1);
    expect(carrying[0].has("u1")).toBe(true);
  });

  it("is written synchronously in the run's finally: there before the run settles, and a newer run is not aborted by it", async () => {
    const net = streamFetch();
    setupDoc("d");
    const collab = collaborator();
    collab.onEvent(userChat("u1", "d", "first"));
    const r1 = await net.next();
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");
    const abortCalls = () => abortSpy.mock.calls.length;
    r1.stream.close();
    await microtasks(5000);
    await collab.__awaitCurrent();
    // No timer has run since the stream closed: the notice was not posted on
    // a later task, as `postNotice` would have.
    expect(noticeRows("u1").map((m) => m.chatNotice)).toEqual(["no-reply"]);
    // And posting it aborted nothing (`postNotice` aborts `current`).
    expect(abortCalls()).toBe(0);
    collab.onEvent(userChat("u2", "d", "second"));
    const r2 = await net.next();
    await streamTurn(r2, ["Second answer."], "u2");
    r2.stream.close();
    await settle(collab);
    expect(row("u1")?.localRun).toEqual({ status: "stopped", reason: "no-reply", generation: G });
    expect(row("u2")?.localRun?.status).toBe("replied");
    expect(replyRows("u2").map((m) => m.text)).toEqual(["Second answer."]);
  });

  it("none when the switch moved to Claude first; the run state is still written", async () => {
    const net = streamFetch();
    setupDoc("d");
    let answerer: "local" | "claude" = "local";
    const collab = collaborator({
      chatAnswerer: () => answerer,
      runTurn: async (o: RunTurnOpts) => {
        const res = await runLocalModelTurn(o);
        answerer = "claude";
        return res;
      },
    });
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    r1.stream.close();
    await settle(collab);
    expect(noticeRows("u1")).toEqual([]);
    expect(row("u1")?.localRun).toEqual({ status: "stopped", reason: "no-reply", generation: G });
  });

  it("none when the licence refuses; the run state is still written", async () => {
    const net = streamFetch();
    setupDoc("d");
    const collab = collaborator({
      runTurn: async (o: RunTurnOpts) => {
        const res = await runLocalModelTurn(o);
        refuse.on = true;
        return res;
      },
    });
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    r1.stream.close();
    await settle(collab);
    expect(rows().filter((m) => m.author === "claude")).toEqual([]);
    expect(row("u1")?.localRun).toEqual({ status: "stopped", reason: "no-reply", generation: G });
  });

  it("none when the user's message row was cleared mid-run", async () => {
    const net = streamFetch();
    setupDoc("d");
    const collab = collaborator();
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    const ctrl = getOrCreateDocument(CTRL_ROOM);
    withInternal(ctrl, () => chatMap().clear());
    r1.stream.close();
    await settle(collab);
    expect(rows()).toEqual([]);
  });

  it("is never counted as an answer: the message stays owed to Claude", async () => {
    await cleanTurn([]);
    expect(noticeRows("u1")).toHaveLength(1);
    expect(unansweredUserChatKeys()).toContain("u1");
  });
});
