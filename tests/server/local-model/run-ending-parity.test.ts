/**
 * Part C (#1123) leaves every ending outside the removal set exactly as it was
 * (brief R1.3), and changes nothing the model is sent (R2.8). Each script here
 * is driven through the real loop with a hand-driven stream; what it leaves —
 * chat rows, `localRun`, sidecar entries and toasts, with ids and timestamps
 * normalised (R6) — is compared with what master left for the same script.
 *
 * The expected values in `__fixtures__/part-c-master.json` were captured by
 * running this file, with `TANDEM_CAPTURE_PART_C=1`, against master at
 * b57d850 (which contains #2419, 86ff4e20) before any part C change. They are
 * never regenerated from the branch: a mismatch is a change of behaviour.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bumpContentGeneration } from "../../../src/server/documents/content-generation.js";
import { removeDoc } from "../../../src/server/documents/registry-testing.js";
import { type RunTurnOpts, runLocalModelTurn } from "../../../src/server/local-model/index.js";
import type { TandemEvent } from "../../../src/shared/events/types.js";
import {
  collaborator,
  PAST_FLUSH_MS,
  resetWorld,
  settle,
  setupDoc,
  snapshot,
  streamFetch,
  swapDoc,
  userChat,
} from "./run-ending-helpers.js";

const FIXTURE = join(process.cwd(), "tests/server/local-model/__fixtures__/part-c-master.json");
const CAPTURE = process.env.TANDEM_CAPTURE_PART_C === "1";
const expected: Record<string, unknown> =
  !CAPTURE && existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, "utf8")) : {};
const captured: Record<string, unknown> = {};

function check(name: string, value: unknown) {
  if (CAPTURE) {
    captured[name] = value;
    return;
  }
  expect(value).toEqual(expected[name]);
}

afterAll(() => {
  if (CAPTURE) writeFileSync(FIXTURE, `${JSON.stringify(captured, null, 2)}\n`);
});

beforeEach(() => {
  vi.useFakeTimers();
  resetWorld();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const OUTLINE = { toolCalls: [{ id: "c1", name: "get_outline", args: {} }] };

function closedEvent(type: "document:closed" | "document:switched", documentId: string) {
  return {
    id: "e",
    type,
    timestamp: Date.now(),
    documentId,
    payload: {},
  } as unknown as TandemEvent;
}

describe("endings outside the removal set are as on master (R1.3)", () => {
  it("clean, a flushed preamble then an empty last turn: the preamble is the reply", async () => {
    const net = streamFetch();
    setupDoc("d");
    const collab = collaborator();
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    r1.stream.push({ content: ["Let me check the outline."] });
    await vi.advanceTimersByTimeAsync(PAST_FLUSH_MS);
    r1.stream.push(OUTLINE);
    r1.stream.close();
    const r2 = await net.next();
    r2.stream.close();
    await settle(collab);
    check("clean-empty-after-preamble", snapshot("d"));
  });

  it("clean, an answer", async () => {
    const net = streamFetch();
    setupDoc("d");
    const collab = collaborator();
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    r1.stream.push({ content: ["The body ", "says hello."] });
    await vi.advanceTimersByTimeAsync(PAST_FLUSH_MS);
    r1.stream.push({ content: [" That is all."] });
    r1.stream.close();
    await settle(collab);
    check("clean-answer", snapshot("d"));
  });

  it("clean, over the sink cap: the marker row", async () => {
    const net = streamFetch();
    setupDoc("d");
    const collab = collaborator();
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    r1.stream.push({ content: Array.from({ length: 70 }, () => "y".repeat(1024)) });
    r1.stream.close();
    await settle(collab);
    check("clean-cap", snapshot("d"));
  });

  it("the step limit, each turn's preamble flushed", async () => {
    const net = streamFetch();
    setupDoc("d");
    const collab = collaborator();
    collab.onEvent(userChat("u1", "d"));
    for (let turn = 1; turn <= 12; turn++) {
      const r = await net.next();
      r.stream.push({ content: [`Checking part ${turn}.`] });
      await vi.advanceTimersByTimeAsync(PAST_FLUSH_MS);
      r.stream.push({ toolCalls: [{ id: `c${turn}`, name: "get_outline", args: {} }] });
      r.stream.close();
    }
    await settle(collab);
    check("step-limit", snapshot("d"));
  });

  it("a timeout, with a flushed partial and an unflushed tail", async () => {
    const net = streamFetch();
    setupDoc("d");
    const collab = collaborator();
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    r1.stream.push({ content: ["The body says"] });
    await vi.advanceTimersByTimeAsync(PAST_FLUSH_MS);
    r1.stream.push({ content: [" hel"] });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(181_000);
    await settle(collab);
    check("timeout", snapshot("d"));
  });

  it("an error after text: what flushFinal commits", async () => {
    const net = streamFetch();
    setupDoc("d");
    const collab = collaborator();
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    r1.stream.push({ content: ["The body says"] });
    await vi.advanceTimersByTimeAsync(PAST_FLUSH_MS);
    r1.stream.push({ content: [" hello <"] });
    await vi.advanceTimersByTimeAsync(10);
    r1.stream.fail(new Error("socket hang up"));
    await settle(collab);
    check("error", snapshot("d"));
  });

  it("a throw in runTurn after text was shown", async () => {
    const net = streamFetch();
    setupDoc("d");
    const collab = collaborator({
      runTurn: async (o: RunTurnOpts) => {
        await runLocalModelTurn(o);
        throw new Error("boom");
      },
    });
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    r1.stream.push({ content: ["The body says hello."] });
    await vi.advanceTimersByTimeAsync(PAST_FLUSH_MS);
    r1.stream.close();
    await settle(collab);
    check("throw", snapshot("d"));
  });

  for (const cause of [
    "newer chat",
    "document closed",
    "document switched",
    "switch to Claude",
  ] as const) {
    it(`an abort (${cause}) after a flushed partial`, async () => {
      const net = streamFetch();
      setupDoc("d");
      setupDoc("d2");
      let answerer: "local" | "claude" = "local";
      let onSwitch: (now: "local" | "claude") => void = () => {};
      const collab = collaborator({
        chatAnswerer: () => answerer,
        onChatAnswererChanged: (cb) => {
          onSwitch = cb;
          return () => {};
        },
      });
      collab.__startForTests();
      collab.onEvent(userChat("u1", "d"));
      const r1 = await net.next();
      r1.stream.push({ content: ["The body says"] });
      await vi.advanceTimersByTimeAsync(PAST_FLUSH_MS);
      r1.stream.push({ content: [" hel"] });
      if (cause === "newer chat") collab.onEvent(userChat("u2", "d"));
      if (cause === "document closed") collab.onEvent(closedEvent("document:closed", "d"));
      if (cause === "document switched") collab.onEvent(closedEvent("document:switched", "d2"));
      if (cause === "switch to Claude") {
        answerer = "claude";
        onSwitch("claude");
      }
      if (cause === "newer chat") {
        const r2 = await net.next();
        r2.stream.push({ content: ["Second answer."] });
        r2.stream.close();
      }
      await settle(collab);
      await settle(collab);
      check(`abort-${cause}`, snapshot("d"));
    });
  }

  it("content replaced after the loop's last check (the !stillOwner arm)", async () => {
    const net = streamFetch();
    const ydoc = setupDoc("d");
    const collab = collaborator({
      runTurn: async (o: RunTurnOpts) => {
        const res = await runLocalModelTurn(o);
        bumpContentGeneration(ydoc);
        return res;
      },
    });
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    r1.stream.push({ content: ["The body says"] });
    await vi.advanceTimersByTimeAsync(PAST_FLUSH_MS);
    r1.stream.push({ content: [" hello."] });
    r1.stream.close();
    await settle(collab);
    check("not-still-owner", snapshot("d"));
  });

  it("doc-swapped whose lookup finds the document closed", async () => {
    const net = streamFetch();
    setupDoc("d");
    const collab = collaborator({
      runTurn: async (o: RunTurnOpts) => {
        const res = await runLocalModelTurn(o);
        removeDoc("d");
        return res;
      },
    });
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    r1.stream.push({ content: ["Let me look."] });
    await vi.advanceTimersByTimeAsync(PAST_FLUSH_MS);
    swapDoc("d");
    r1.stream.push({ content: [" Still looking."] });
    r1.stream.close();
    await settle(collab);
    check("doc-swapped-closed", snapshot("d"));
  });

  it("doc-swapped on the same instance whose token test fails: no toast, the row stays", async () => {
    const net = streamFetch();
    const ydoc = setupDoc("d");
    let collab: ReturnType<typeof collaborator> | null = null;
    collab = collaborator({
      runTurn: async (o: RunTurnOpts) => {
        const res = await runLocalModelTurn(o);
        if (o.task === "first") {
          // A newer chat claims the slot between the loop's return and the
          // terminal checks.
          collab?.onEvent(userChat("u2", "d", "second"));
          await Promise.resolve();
        }
        return res;
      },
    });
    collab.onEvent(userChat("u1", "d", "first"));
    const r1 = await net.next();
    r1.stream.push({ content: ["Let me look at the body."] });
    await vi.advanceTimersByTimeAsync(PAST_FLUSH_MS);
    bumpContentGeneration(ydoc);
    r1.stream.push({ content: [" More."] });
    r1.stream.close();
    const r2 = await net.next();
    r2.stream.push({ content: ["Second answer."] });
    r2.stream.close();
    await settle(collab);
    await settle(collab);
    check("doc-swapped-token-fail", snapshot("d"));
  });
});

describe("text with no <think> trips the cap and ends as on master (R2.4)", () => {
  it("a candidate tag at the cap: '<' as the character that reaches it", async () => {
    const net = streamFetch();
    setupDoc("d");
    const collab = collaborator();
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    r1.stream.push({ content: ["x".repeat(64 * 1024 - 1), "<"] });
    await vi.advanceTimersByTimeAsync(PAST_FLUSH_MS);
    // The cap's abort has errored the stream by now, as a real one would be.
    try {
      r1.stream.close();
    } catch {
      // already errored by the abort
    }
    await settle(collab);
    check("cap-at-pending-tag", snapshot("d"));
  });
});

describe("R4 endings with nothing shown are as on master", () => {
  it("a throw in runTurn, nothing shown", async () => {
    const net = streamFetch();
    setupDoc("d");
    const collab = collaborator({
      runTurn: async (o: RunTurnOpts) => {
        await runLocalModelTurn(o);
        throw new Error("boom");
      },
    });
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    r1.stream.close();
    await settle(collab);
    check("throw-nothing-shown", snapshot("d"));
  });

  it("an abort (newer chat), nothing shown", async () => {
    const net = streamFetch();
    setupDoc("d");
    const collab = collaborator();
    collab.onEvent(userChat("u1", "d"));
    await net.next();
    collab.onEvent(userChat("u2", "d"));
    const r2 = await net.next();
    r2.stream.push({ content: ["Second answer."] });
    r2.stream.close();
    await settle(collab);
    await settle(collab);
    check("abort-nothing-shown", snapshot("d"));
  });

  it("the !stillOwner arm, nothing shown", async () => {
    const net = streamFetch();
    const ydoc = setupDoc("d");
    const collab = collaborator({
      runTurn: async (o: RunTurnOpts) => {
        const res = await runLocalModelTurn(o);
        bumpContentGeneration(ydoc);
        return res;
      },
    });
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    r1.stream.close();
    await settle(collab);
    check("not-still-owner-nothing-shown", snapshot("d"));
  });
});

describe("what the model is sent does not change (R2.8)", () => {
  it("a <think> block plus a tool call: the second request is byte-identical to master's", async () => {
    const net = streamFetch();
    setupDoc("d");
    const collab = collaborator();
    collab.onEvent(userChat("u1", "d"));
    const r1 = await net.next();
    r1.stream.push({
      content: ["<think>The user wants the body.", " I will read the outline.</think>"],
    });
    await vi.advanceTimersByTimeAsync(PAST_FLUSH_MS);
    r1.stream.push({ content: ["Let me check."] });
    r1.stream.push(OUTLINE);
    r1.stream.close();
    const r2 = await net.next();
    r2.stream.push({ content: ["The body says hello."] });
    r2.stream.close();
    await settle(collab);
    check("second-request-body", r2.bodyText);
  });
});
