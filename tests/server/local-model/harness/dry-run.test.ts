/**
 * The dry run (#1123 brief, R1 "Judged by"): the measurement harness driven
 * with scripted, STREAMED model responses. No model, no network.
 *
 * What it proves:
 *  - a trial runs the shipped collaborator, loop, prompts, tools and client:
 *    what the loop sends equals what the product sends for the same message,
 *    checked against an INDEPENDENT run through the real event queue;
 *  - the reply that is scored is the text the user's chat row holds, on a
 *    clean exit, a timeout (fake timers, never a shorter timeout) and a budget
 *    exit (with the sink's flush timers controlled);
 *  - every ending is classified as the brief rules.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { classifyTrial } from "../../../../probe/local-model-spike/harness/classify.js";
import { evaluateTrial } from "../../../../probe/local-model-spike/harness/evaluate.js";
import { installFetchTap } from "../../../../probe/local-model-spike/harness/fetch-tap.js";
import { fixtureFor } from "../../../../probe/local-model-spike/harness/scenarios/index.js";
import type { Scenario } from "../../../../probe/local-model-spike/harness/scenarios/types.js";
import type { ScriptedTurn } from "../../../../probe/local-model-spike/harness/scripted-model.js";
import {
  runTrial,
  type TrialObservation,
  trialDeps,
} from "../../../../probe/local-model-spike/harness/trial.js";
import { addDoc, removeDoc } from "../../../../src/server/documents/registry-testing.js";
import {
  attachCtrlObservers,
  attachObservers,
  resetForTesting as resetQueue,
  subscribe,
  unsubscribe,
} from "../../../../src/server/events/queue.js";
import { loadMarkdown } from "../../../../src/server/file-io/markdown.js";
import {
  createLocalModelCollaborator,
  DEFAULT_COLLABORATOR_DEPS,
  TRUNCATION_MARKER,
} from "../../../../src/server/local-model/collaborator.js";
import {
  CHAT_SYSTEM_PROMPT,
  EDITING_SYSTEM_PROMPT,
  READ_TOOLS,
  type RunTurnOpts,
  runLocalModelTurn,
  TOOLS,
} from "../../../../src/server/local-model/index.js";
import { extractText } from "../../../../src/server/mcp/document-model.js";
import { findOccurrence } from "../../../../src/server/mcp/navigation.js";
import { getOrCreateDocument, removeDocument } from "../../../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_CHAT,
  Y_MAP_MODE,
  Y_MAP_SELECTION,
  Y_MAP_USER_AWARENESS,
} from "../../../../src/shared/constants.js";
import { withBrowser, withInternal } from "../../../../src/shared/origins.js";
import {
  advanceUntil,
  CONFIG,
  firstOf,
  manualStream,
  runScripted,
  scenario,
  stubScript,
  trialInput,
} from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  // The product logs each run error and each observer attach on stderr.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

function evaluate(s: Scenario, obs: TrialObservation) {
  return evaluateTrial({
    runId: "dry",
    trialId: `${s.id}#1`,
    repeat: 1,
    scenario: s,
    observation: obs,
    contextLength: "unknown",
  });
}

function record(s: Scenario, obs: TrialObservation) {
  const e = evaluate(s, obs);
  if (!e.scored) throw new Error(`expected a scored trial, got ${e.classification.detail}`);
  return e.record;
}

type Body = {
  model: string;
  stream: boolean;
  temperature: number;
  tools?: { function: { name: string } }[];
  tool_choice?: string;
  messages: { role: string; content: string }[];
};

function toolNames(body: unknown): string[] {
  return ((body as Body).tools ?? []).map((t) => t.function.name);
}

// ---------------------------------------------------------------------------
// The independent product side: the SAME message through the real event queue.
// ---------------------------------------------------------------------------

let refCounter = 0;

/**
 * Send a chat message the way the product receives one: the browser writes the
 * selection into the document's awareness map and the chat row into the
 * control document; the event queue's own observers build the event; the
 * collaborator is subscribed to the real queue. Nothing from `runTrial`.
 */
async function referenceRun(
  s: Scenario,
  script: ScriptedTurn[],
): Promise<{ bodies: unknown[]; urls: string[]; opts: RunTurnOpts | null }> {
  vi.useFakeTimers();
  refCounter += 1;
  const docId = `reference-doc-${refCounter}`;
  const calls = stubScript(script);
  resetQueue();
  attachCtrlObservers();
  const ydoc = getOrCreateDocument(docId);
  loadMarkdown(ydoc, fixtureFor(s).markdown);
  addDoc(docId, {
    id: docId,
    filePath: `reference://${docId}.md`,
    format: "md",
    readOnly: false,
    source: "file",
  });
  attachObservers(docId, ydoc);
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  withInternal(ctrl, () => ctrl.getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_MODE, "tandem"));

  let opts: RunTurnOpts | null = null;
  const collab = createLocalModelCollaborator({
    ...trialDeps({ tier: s.tier, config: CONFIG }, async (o) => {
      opts = o;
      return runLocalModelTurn(o);
    }),
    subscribe,
    unsubscribe,
  });
  collab.__startForTests();
  try {
    if (s.selectedText !== undefined) {
      const hit = findOccurrence(extractText(ydoc), s.selectedText, 1);
      if ("error" in hit) throw new Error("selection not in the fixture");
      withBrowser(ydoc, () =>
        ydoc.getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_SELECTION, {
          from: hit.from,
          to: hit.to,
          selectedText: s.selectedText,
          timestamp: Date.now(),
        }),
      );
      await vi.advanceTimersByTimeAsync(10_000); // past the selection dwell
    }
    const messageId = `reference-msg-${refCounter}`;
    withBrowser(ctrl, () =>
      ctrl.getMap(Y_MAP_CHAT).set(messageId, {
        id: messageId,
        author: "user",
        text: s.prompt,
        timestamp: Date.now(),
        documentId: docId,
        read: false,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await advanceUntil(collab.__awaitCurrent(), 50);
    return { bodies: calls.map((c) => c.body), urls: calls.map((c) => c.url), opts };
  } finally {
    await collab.stop();
    resetQueue();
    removeDoc(docId);
    removeDocument(docId);
    ydoc.destroy();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
}

describe("a trial sends what the product sends for the same message", () => {
  const cases: { name: string; pick: () => Scenario }[] = [
    {
      name: "chat tier, inlined document, with a selection",
      pick: () => firstOf("editing-request", (s) => s.selectedText !== undefined),
    },
    {
      name: "chat tier, a document too long to inline",
      pick: () => firstOf("answerable", (s) => fixtureFor(s).shape?.size === "deep"),
    },
    { name: "editing tier", pick: () => firstOf("comment") },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const s = c.pick();
      const script: ScriptedTurn[] = [{ content: ["A plain ", "answer."] }];
      const reference = await referenceRun(s, script);
      const { obs, calls } = await runScripted(s, script);

      expect(reference.bodies.length).toBe(1);
      expect(calls.map((x) => x.body)).toEqual(reference.bodies);
      expect(calls.map((x) => new URL(x.url).pathname)).toEqual(
        reference.urls.map((u) => new URL(u).pathname),
      );

      // What the collaborator handed the shipped turn runner, in both runs.
      const ref = reference.opts as RunTurnOpts | null;
      expect(ref).not.toBeNull();
      expect(obs.turnOpts?.keys).toEqual(Object.keys(ref as RunTurnOpts).sort());
      expect(obs.turnOpts?.task).toBe(ref?.task);
      expect(obs.turnOpts?.includeFullText).toBe(ref?.includeFullText);
      expect(obs.turnOpts?.maxResponseBytes).toBe(ref?.maxResponseBytes);
      expect(obs.turnOpts?.temperature).toBe(ref?.temperature);
      expect(obs.turnOpts?.timeoutMs).toBe(ref?.timeoutMs);
      expect(obs.turnOpts?.hasHistory).toBe(ref?.history !== undefined);
    });
  }

  it("is the shipped prompt, tool list, transport and a streamed request, per tier", async () => {
    const chat = firstOf("answerable", (s) => fixtureFor(s).shape?.size === "inlined");
    const a = await runScripted(chat, [{ content: ["x"] }]);
    const chatBody = a.calls[0].body as Body;
    expect(chatBody.messages[0]).toEqual({ role: "system", content: CHAT_SYSTEM_PROMPT });
    expect(toolNames(chatBody)).toEqual(READ_TOOLS.map((t) => t.name));
    expect(chatBody.stream).toBe(true);
    expect(new URL(a.calls[0].url).pathname).toBe("/v1/chat/completions");
    expect(chatBody.messages).toHaveLength(2); // system + user: no history
    expect(chatBody.messages[1].content).toContain("<document>");
    expect(a.obs.turnOpts?.includeFullText).toBe(true);

    const deep = firstOf("answerable", (s) => fixtureFor(s).shape?.size === "deep");
    const b = await runScripted(deep, [{ content: ["x"] }]);
    expect((b.calls[0].body as Body).messages[1].content).not.toContain("<document>");
    expect(b.obs.turnOpts?.includeFullText).toBe(false);

    const editing = firstOf("replacement");
    const c = await runScripted(editing, [{ content: ["x"] }]);
    const editBody = c.calls[0].body as Body;
    expect(editBody.messages[0]).toEqual({ role: "system", content: EDITING_SYSTEM_PROMPT });
    expect(toolNames(editBody)).toEqual(TOOLS.map((t) => t.name));
  });

  it("leaves no collaborator dependency at its default", () => {
    const deps = trialDeps({ tier: "chat", config: CONFIG }, async () => {
      throw new Error("unused");
    });
    for (const key of Object.keys(DEFAULT_COLLABORATOR_DEPS)) {
      expect(deps, key).toHaveProperty(key);
    }
    for (const [key, value] of Object.entries(deps)) {
      if (key === "runTurn") continue;
      expect(value, key).not.toBe(
        (DEFAULT_COLLABORATOR_DEPS as unknown as Record<string, unknown>)[key],
      );
    }
    expect(deps.aiRefusal()).toBeNull();
  });
});

describe("one scenario per group, through the harness and the scorer", () => {
  it("chat tier: an answer from an inlined document passes; the planted value fails", async () => {
    const s = scenario("ans-ops-review-q3-revenue");
    const good = await runScripted(s, [
      { content: ["Third-quarter revenue was ", "$4.82 million."] },
    ]);
    expect(good.obs.reply).toBe("Third-quarter revenue was $4.82 million.");
    expect(record(s, good.obs).scorerPass).toBe(true);

    const bad = await runScripted(s, [{ content: ["Revenue was $4.41 million."] }]);
    const rec = record(s, bad.obs);
    expect(rec.scorerPass).toBe(false);
    expect(rec.score.failureMode).toBe("DISTRACTOR");
  });

  it("chat tier: a deep document is read with the shipped reading tools", async () => {
    const s = firstOf("answerable", (x) => fixtureFor(x).shape?.size === "deep");
    const heading = fixtureFor(s).shape?.facts?.find((f) => f.heading)?.heading ?? "";
    const { obs, calls } = await runScripted(s, [
      { content: ["Let me look."], toolCalls: [{ id: "c1", name: "get_outline", args: {} }] },
      { toolCalls: [{ id: "c2", name: "read_section", args: { heading } }] },
      { content: ["Here is what the section says."] },
    ]);
    expect(calls).toHaveLength(3);
    expect(obs.loop?.metrics.exit).toBe("clean");
    expect(obs.toolResults.map((t) => t.name)).toEqual(["get_outline", "read_section"]);
    expect(obs.toolResults[1].content).toContain("text");
    expect(obs.turns.map((t) => t.hadToolCalls)).toEqual([true, true, false]);
    expect(obs.reply).toBe("Here is what the section says.");
    expect(record(s, obs).toolSteps).toHaveLength(2);
  });

  it("chat tier: an unanswerable question passes on 'does not say', fails on a planted value", async () => {
    const s = firstOf("unanswerable");
    const good = await runScripted(s, [{ content: ["The document does not say."] }]);
    expect(record(s, good.obs).scorerPass).toBe(true);
    const silent = await runScripted(s, [{ content: ["It is probably fine."] }]);
    expect(record(s, silent.obs).score.failureMode).toBe("NO_NOT_STATED");
  });

  it("chat tier: an editing request passes when the reply quotes the target and offers text", async () => {
    const s = firstOf("editing-request", (x) => x.expect.kind === "offer-change");
    const target = s.expect.kind === "offer-change" ? s.expect.target : "";
    const good = await runScripted(s, [
      {
        content: [
          `I can't change the document, but I would rewrite "${target}" as: "${target.split(" ").reverse().join(" ")}"`,
        ],
      },
    ]);
    const rec = record(s, good.obs);
    expect(rec.scorerPass).toBe(true);
    expect(rec.writes.annotations).toEqual([]);

    const refusal = await runScripted(s, [{ content: ["I can't edit documents."] }]);
    expect(record(s, refusal.obs).scorerPass).toBe(false);
  });

  it("chat tier: a writing tool is refused by the shipped gate, and the claim is flagged for the reader", async () => {
    const s = firstOf("editing-request", (x) => x.selectedText !== undefined);
    const { obs, calls } = await runScripted(s, [
      {
        toolCalls: [
          {
            id: "w1",
            name: "comment_on_quote",
            args: { quoted_text: s.selectedText, comment: "x" },
          },
        ],
      },
      { content: ["I have fixed the sentence in the document."] },
    ]);
    expect(obs.writes.annotations).toEqual([]);
    expect(obs.loop?.steps[0].toolCalls[0].outcome).toMatchObject({
      kind: "refused",
      errorCode: "EDITING_OFF",
    });
    expect((calls[1].body as Body).tools).toBeUndefined(); // the text-only turn
    const rec = record(s, obs);
    expect(rec.claims.suspect).toBe(true);
    expect(rec.claims.flags[0].kind).toBe("text-changed");
  });

  it("chat tier: a no-action message passes on any reply", async () => {
    const s = firstOf("no-action");
    const { obs } = await runScripted(s, [{ content: ["You're welcome!"] }]);
    const rec = record(s, obs);
    expect(rec.scorerPass).toBe(true);
    expect(rec.claims.suspect).toBe(false);
  });

  it("editing tier: a comment and a replacement land through the shipped dispatch and score", async () => {
    const comment = scenario("comment-cost-material");
    const a = await runScripted(comment, [
      {
        toolCalls: [
          {
            id: "c1",
            name: "comment_on_quote",
            args: { quoted_text: "$18,200", comment: "Please verify this material cost figure." },
          },
        ],
      },
      { content: ["I left a comment on the material costs figure for you to review."] },
    ]);
    const recA = record(comment, a.obs);
    expect(recA.writes.annotations).toHaveLength(1);
    expect(recA.writes.annotations[0]).toMatchObject({ kind: "comment", anchoredText: "$18,200" });
    expect(recA.scorerPass).toBe(true);
    expect(recA.claims.suspect).toBe(false); // the claim is true: a comment landed
    expect(recA.claims.leakedIds).toEqual([]);

    const replacement = scenario("replace-cost-overhead");
    const b = await runScripted(replacement, [
      {
        toolCalls: [
          {
            id: "r1",
            name: "propose_replacement",
            args: { quoted_text: "$9,750", suggested_text: "$9,500" },
          },
        ],
      },
      { content: ["The change has been made and is now part of the document."] },
    ]);
    const recB = record(replacement, b.obs);
    expect(recB.writes.annotations[0]).toMatchObject({
      kind: "replacement",
      suggestedText: "$9,500",
    });
    expect(recB.scorerPass).toBe(true); // the scorer checks the write…
    expect(recB.claims.suspect).toBe(true); // …the claim check flags the reply for the reader
  });

  it("editing tier: a question, a nothing-to-change request and both thread paths", async () => {
    const question = firstOf("question");
    const q = await runScripted(question, [{ content: ["The labor cost figure is $42,500."] }]);
    expect(record(question, q.obs).scorerPass).toBe(true);

    const noop = firstOf("edit-no-action");
    const n = await runScripted(noop, [{ content: ["It is consistent; no change is needed."] }]);
    expect(record(noop, n.obs).scorerPass).toBe(true);

    const own = scenario("thread-own-comment");
    let createdId = "";
    const t = await runScripted(own, (i, body) => {
      if (i === 0) {
        return {
          toolCalls: [
            {
              id: "c1",
              name: "comment_on_quote",
              args: { quoted_text: "$18,200", comment: "Verify." },
            },
          ],
        };
      }
      if (i === 1) {
        const tool = (body.messages as { role: string; content: string }[]).find(
          (m) => m.role === "tool",
        );
        createdId = (JSON.parse(tool?.content ?? "{}") as { annotation_id: string }).annotation_id;
        return {
          toolCalls: [
            {
              id: "c2",
              name: "reply_to_annotation",
              args: { annotation_id: createdId, text: "Attach the invoice." },
            },
          ],
        };
      }
      return { content: [`I commented and replied under ${createdId}.`] };
    });
    const recT = record(own, t.obs);
    expect(recT.writes.replies).toHaveLength(1);
    expect(recT.scorerPass).toBe(true);
    expect(recT.claims.leakedIds).toEqual([createdId]); // an internal id reached the user

    const never = scenario("thread-never-given");
    const u = await runScripted(never, [
      {
        toolCalls: [
          {
            id: "g1",
            name: "reply_to_annotation",
            args: { annotation_id: "ann_1700000000000_abc123", text: "Booked." },
          },
        ],
      },
      { content: ["I replied in the thread about the launch date."] },
    ]);
    const recU = record(never, u.obs);
    expect(recU.writes.replies).toEqual([]);
    expect(recU.claims.flags.some((f) => f.kind === "reply")).toBe(true);
  });
});

describe("what is scored is what the chat row holds", () => {
  it("on a timeout the scored reply is the partial text, with the product's notice", async () => {
    vi.useFakeTimers();
    const s = scenario("ans-ops-review-q3-revenue");
    const stream = manualStream();
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      stream.push({ content: ["Third-quarter revenue was $4.82 million, and"] });
      return stream.response(init); // …and then the model stalls
    });
    const obs = await advanceUntil(runTrial(trialInput(s)), 5000);
    expect(obs.loop?.metrics.exit).toBe("timeout");
    expect(obs.reply).toBe("Third-quarter revenue was $4.82 million, and");
    expect(obs.turns).toEqual([
      { turn: 1, text: "Third-quarter revenue was $4.82 million, and", hadToolCalls: null },
    ]);
    expect(obs.notices.map((n) => n.message)).toEqual([
      "The local model stopped before finishing (it ran out of time).",
    ]);
    const rec = record(s, obs);
    expect(rec.ending).toBe("timeout");
    expect(rec.score.pass).toBe(true); // the partial text holds the answer…
    expect(rec.scorerPass).toBe(false); // …and the trial is still a failure
  });

  it("a timeout before any response is a scored timeout, not infrastructure", async () => {
    vi.useFakeTimers();
    const s = scenario("ans-ops-review-q3-revenue");
    vi.stubGlobal(
      "fetch",
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );
    const obs = await advanceUntil(runTrial(trialInput(s)), 5000);
    expect(obs.loop?.metrics.exit).toBe("timeout");
    expect(obs.reply).toBe("");
    expect(classifyTrial(obs).ending).toBe("timeout");
  });

  /** A run that never stops calling tools; each turn streams a preamble first. */
  function loopingFetch(flushBeforeTurnEnds: boolean) {
    let n = 0;
    return async (_url: string, init: RequestInit) => {
      n += 1;
      const turn = n;
      const stream = manualStream();
      const res = stream.response(init);
      stream.push({ content: [`Checking part ${turn}.`] });
      const finish = () => {
        stream.push({ toolCalls: [{ id: `call-${turn}`, name: "get_outline", args: {} }] });
        stream.close();
      };
      // The sink commits a short preamble only when its flush timer fires
      // while the turn is still streaming.
      if (flushBeforeTurnEnds) setTimeout(finish, 500);
      else finish();
      return res;
    };
  }

  it("on a budget exit the scored reply is what the sink last committed: the final turn's preamble when its flush fired", async () => {
    vi.useFakeTimers();
    const s = scenario("ans-ops-review-q3-revenue");
    vi.stubGlobal("fetch", loopingFetch(true));
    const obs = await advanceUntil(runTrial(trialInput(s)), 100);
    expect(obs.loop?.metrics.exit).toBe("max_turns");
    const turns = obs.loop?.metrics.turns ?? 0;
    expect(obs.turns).toHaveLength(turns);
    expect(obs.reply).toBe(`Checking part ${turns}.`);
    expect(obs.notices.map((n) => n.message)).toEqual([
      "The local model stopped before finishing (it reached its step limit).",
    ]);
    expect(record(s, obs).ending).toBe("budget");
  });

  it("on a budget exit with no flush the chat row is empty, and that is what is scored", async () => {
    vi.useFakeTimers();
    const s = scenario("ans-ops-review-q3-revenue");
    vi.stubGlobal("fetch", loopingFetch(false));
    const obs = await advanceUntil(runTrial(trialInput(s)), 100);
    expect(obs.loop?.metrics.exit).toBe("max_turns");
    expect(obs.reply).toBe("");
    expect(obs.replyRows).toBe(0);
    // Every turn's text is still kept: the user may have seen none of it, but
    // the reader is shown all of it.
    expect(obs.turns.every((t) => t.text.startsWith("Checking part "))).toBe(true);
    const rec = record(s, obs);
    expect(rec.ending).toBe("budget");
    expect(rec.signals.emptyReply).toBe(true);
  });

  it("an empty final turn leaves an earlier preamble as the reply, and that is flagged", async () => {
    vi.useFakeTimers();
    const s = scenario("ans-ops-review-q3-revenue");
    let n = 0;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      n += 1;
      const stream = manualStream();
      const res = stream.response(init);
      if (n === 1) {
        stream.push({ content: ["Let me check the outline."] });
        setTimeout(() => {
          stream.push({ toolCalls: [{ id: "c1", name: "get_outline", args: {} }] });
          stream.close();
        }, 500);
      } else {
        stream.close(); // a final turn with no text and no tool call
      }
      return res;
    });
    const obs = await advanceUntil(runTrial(trialInput(s)), 100);
    expect(obs.loop?.metrics.exit).toBe("clean");
    expect(obs.reply).toBe("Let me check the outline.");
    expect(obs.notices).toEqual([]);
    expect(record(s, obs).signals.stalePreamble).toBe(true);
  });

  it("the sink's streaming cap is its own ending", async () => {
    const s = scenario("ans-ops-review-q3-revenue");
    const { obs } = await runScripted(s, [
      { content: Array.from({ length: 80 }, () => "y".repeat(1024)) },
    ]);
    expect(obs.reply.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(record(s, obs).ending).toBe("stream_cap");
  });
});

describe("endings and what counts as a scored trial", () => {
  const s = () => scenario("ans-ops-review-q3-revenue");

  it("connection refused and a missing model are infrastructure: not scored", async () => {
    const refused = await runScripted(s(), [{ connectionError: "ECONNREFUSED" }]);
    expect(classifyTrial(refused.obs)).toEqual({
      ending: "infrastructure",
      detail: "fetch-threw:ECONNREFUSED",
    });
    expect(evaluate(s(), refused.obs).scored).toBe(false);

    const missing = await runScripted(s(), [{ status: 404 }]);
    expect(classifyTrial(missing.obs)).toEqual({ ending: "infrastructure", detail: "http-404" });
  });

  it("a connection refused on a LATER turn is still infrastructure, whatever was streamed before", async () => {
    const { obs } = await runScripted(s(), [
      { content: ["Let me read it."], toolCalls: [{ id: "c1", name: "get_outline", args: {} }] },
      { connectionError: "ECONNREFUSED" },
    ]);
    expect(obs.turns[0].text).toBe("Let me read it.");
    expect(classifyTrial(obs).ending).toBe("infrastructure");
  });

  it("an HTTP 500, an unreadable body and a stream that breaks after text are scored failures", async () => {
    const http500 = await runScripted(s(), [{ status: 500 }]);
    expect(classifyTrial(http500.obs)).toEqual({ ending: "error", detail: "http-500" });
    expect(record(s(), http500.obs).scorerPass).toBe(false);

    vi.stubGlobal("fetch", async () => new Response("<html>proxy</html>", { status: 200 }));
    const html = await runTrial(trialInput(s()));
    expect(classifyTrial(html)).toEqual({ ending: "error", detail: "unreadable" });

    const stream = manualStream();
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      stream.push({ content: ["Revenue was"] });
      setTimeout(() => stream.fail(new Error("socket closed")), 30);
      return stream.response(init);
    });
    const broke = await runTrial(trialInput(s()));
    expect(broke.loop?.metrics.exit).toBe("error");
    expect(classifyTrial(broke).ending).toBe("error");
    expect(broke.reply).toBe("Revenue was"); // the partial text the product flushed
  });

  it("the response-size cap is a scored failure", async () => {
    const big = "z".repeat(64 * 1024);
    // One unterminated line larger than the product's wire cap.
    vi.stubGlobal("fetch", async () => {
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            for (let i = 0; i < 80; i++) c.enqueue(enc.encode(big));
            c.close();
          },
        }),
      );
    });
    const obs = await runTrial(trialInput(s()));
    expect(classifyTrial(obs)).toEqual({ ending: "error", detail: "response-cap" });
  });

  it("a clean exit whose raw stream carried an error frame is a scored failure", async () => {
    const { obs } = await runScripted(s(), [
      {
        extraFrames: [{ error: { message: "model runner crashed" } }],
        content: ["Revenue was $4.82 million."],
      },
    ]);
    expect(obs.loop?.metrics.exit).toBe("clean");
    const rec = record(s(), obs);
    expect(rec.ending).toBe("error_frame");
    expect(rec.scorerPass).toBe(false);
  });

  it("a clean exit whose raw stream the tap could not read to its end is not scored as completed (review L7)", async () => {
    const { obs } = await runScripted(s(), [{ content: ["Revenue was $4.82 million."] }]);
    expect(classifyTrial(obs)).toEqual({ ending: "completed", detail: "clean" });
    const unread = { ...obs, fetches: obs.fetches.map((f) => ({ ...f, readIncomplete: true })) };
    expect(classifyTrial(unread)).toEqual({
      ending: "infrastructure",
      detail: "tap-read-incomplete",
    });
    // An error frame that WAS read still decides first.
    const both = {
      ...unread,
      fetches: unread.fetches.map((f, i) => (i === 0 ? { ...f, errorFrame: true } : f)),
    };
    expect(classifyTrial(both).ending).toBe("error_frame");
  });
});

describe("visible reasoning (R2.7)", () => {
  const s = () => scenario("ans-ops-review-q3-revenue");

  it("inline reasoning reaches the reply and is marked", async () => {
    const { obs } = await runScripted(s(), [
      {
        content: [
          "<think>The Q2 figure was $4.41 million, so…</think>",
          "Revenue was $4.82 million.",
        ],
      },
    ]);
    const rec = record(s(), obs);
    expect(rec.signals.reasoning).toBe("inline");
    expect(rec.signals.replyShowsReasoning).toBe(true);
    // Scored on what the user sees: the reasoning names the planted value.
    expect(rec.scorerPass).toBe(false);
    expect(rec.scorerPassWithoutReasoning).toBe(true);
  });

  it("reasoning in a separate field is dropped by the product and recorded by the tap", async () => {
    const { obs } = await runScripted(s(), [
      {
        extraFrames: [{ choices: [{ delta: { reasoning_content: "thinking about Q3…" } }] }],
        content: ["Revenue was $4.82 million."],
      },
    ]);
    const rec = record(s(), obs);
    expect(rec.reply).toBe("Revenue was $4.82 million.");
    expect(rec.signals.reasoning).toBe("separate");
    expect(rec.signals.replyShowsReasoning).toBe(false);
    expect(rec.scorerPass).toBe(true);
  });

  it("an answer given only as reasoning leaves the user with nothing, and is recorded as that", async () => {
    const { obs } = await runScripted(s(), [
      { extraFrames: [{ choices: [{ delta: { reasoning: "The answer is $4.82 million." } }] }] },
    ]);
    expect(obs.loop?.metrics.exit).toBe("clean");
    expect(obs.reply).toBe("");
    expect(obs.notices).toEqual([]);
    const rec = record(s(), obs);
    expect(rec.signals.reasoning).toBe("reasoning-only");
    expect(rec.signals.emptyReply).toBe(true);
    expect(rec.scorerPass).toBe(false);
  });

  it("no reasoning is recorded as none", async () => {
    const { obs } = await runScripted(s(), [{ content: ["Revenue was $4.82 million."] }]);
    expect(record(s(), obs).signals.reasoning).toBe("none");
  });
});

describe("the fetch tap observes and changes nothing", () => {
  it("passes the request through by identity and puts fetch back", async () => {
    const seen: { input: unknown; init: unknown }[] = [];
    const base = (async (input: unknown, init: unknown) => {
      seen.push({ input, init });
      return new Response("data: [DONE]\n\n");
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", base);
    const tap = installFetchTap();
    const init: RequestInit = { method: "POST", body: "{}", redirect: "error" };
    await fetch("http://127.0.0.1:11434/v1/chat/completions", init);
    await fetch("http://127.0.0.1:11434/api/version");
    await tap.settle();
    expect(seen[0].init).toBe(init);
    expect(seen[0].input).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(tap.records).toHaveLength(1); // the metadata path is not observed
    expect(globalThis.fetch).toBe(base);
  });

  it("cancels a clone the product stopped reading, so a cut stream cannot run on", async () => {
    let cancelled = false;
    const enc = new TextEncoder();
    vi.stubGlobal("fetch", async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    });
    const tap = installFetchTap();
    const res = await fetch("http://127.0.0.1:11434/v1/chat/completions", { body: "{}" });
    await res.body?.cancel(); // the product gives up on its side
    await tap.settle(20);
    expect(cancelled).toBe(true);
    expect(tap.records[0].readIncomplete).toBe(true);
  });

  it("settle marks the response it could not finish reading, not whichever came last (review L7)", async () => {
    const enc = new TextEncoder();
    let call = 0;
    vi.stubGlobal("fetch", async () => {
      call += 1;
      if (call === 1) {
        // A stream that never ends.
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
              return new Promise((r) => setTimeout(r, 5));
            },
          }),
        );
      }
      return new Response('data: {"choices":[{"delta":{"content":"b"}}]}\n\ndata: [DONE]\n\n');
    });
    const tap = installFetchTap();
    const first = await fetch("http://127.0.0.1:11434/v1/chat/completions", { body: "{}" });
    // The product gives up on its side. (A tee branch's cancel settles only
    // once the other branch is cancelled too, which settle() does below.)
    const gaveUp = first.body?.cancel();
    const second = await fetch("http://127.0.0.1:11434/v1/chat/completions", { body: "{}" });
    await second.text();
    await tap.settle(30);
    await gaveUp;
    expect(tap.records.map((r) => r.readIncomplete)).toEqual([true, false]);
  });

  it("a scratch document used by a trial starts with nothing written", async () => {
    const doc = new Y.Doc();
    loadMarkdown(doc, "# T\n\nBody.");
    expect(doc.getMap("annotations").size).toBe(0);
    doc.destroy();
  });
});
