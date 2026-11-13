/**
 * The fingerprint: one hash over everything the model sees or is limited by in
 * a trial (brief R3.5). A run records it; `fingerprint.json` holds the current
 * one; a test in `check` fails when they differ, so a change to a prompt, a
 * tool, a refusal text or the call shape cannot land without someone saying so.
 *
 * NOTHING here is restated. Each value is either the product's own export,
 * called (`systemPromptFor`, `buildUserPrompt`, `TOOLS`, `dispatch`), or is
 * CAPTURED from scripted runs through the shipped collaborator: the request
 * bodies a stubbed `fetch` received, the options the collaborator handed the
 * turn runner, the turn and tool-call counts at which a looping run stops, the
 * timeouts the client armed, and where the sink cuts an over-long reply.
 *
 * It uses no test-framework API, so `measure.ts` (under tsx) and the test
 * (under vitest) compute the same value. It replaces `fetch`, `setTimeout` and
 * `Date.now` while it runs and checks, by identity, that each is put back.
 */
import * as Y from "yjs";

import { loadMarkdown } from "../../../src/server/file-io/markdown.js";
import { INLINE_CHAR_LIMIT } from "../../../src/server/local-model/collaborator.js";
import {
  buildUserPrompt,
  dispatch,
  type LocalModelConfig,
  READ_TOOLS,
  systemPromptFor,
  TOOLS,
} from "../../../src/server/local-model/index.js";
import { extractText } from "../../../src/server/mcp/document-model.js";
import { canonicalJson } from "./record.js";
import { harnessConfig } from "./model-config.js";
import { sha256Hex } from "./paths.js";
import { scriptedFetch, type ScriptedTurn } from "./scripted-model.js";
import { runTrial, type Tier } from "./trial.js";

const DOC = `# Fingerprint Document

The first paragraph states that the budget is 500 dollars for the first phase.

## Second Section

The second paragraph says the team will ship the beta in eight weeks.
`;

const SELECTION = "the budget is 500 dollars";
const TASK = "FINGERPRINT TASK";
/** How far the scripted server moves the clock during the first turn. */
const CLOCK_STEP_MS = 200_000;

const ID_SHAPE = /\b(ann|rpl|msg|evt|ntf)_\d+_[a-z0-9]+\b/g;

function normalise(value: unknown): unknown {
  if (typeof value === "string") return value.replace(ID_SHAPE, "$1_<id>");
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalise(v)]),
    );
  }
  return value;
}

function scratch(): Y.Doc {
  const doc = new Y.Doc();
  loadMarkdown(doc, DOC);
  return doc;
}

/** Tool-result and refusal texts, from the product's own dispatch. */
function dispatchTexts(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const doc = scratch();
  const allow = { ydoc: doc, canEdit: () => true };
  const deny = { ydoc: doc, canEdit: () => false };
  const run = (label: string, name: string, args: Record<string, unknown> | null, ctx = allow) => {
    const outcome = dispatch(name, args, ctx);
    out[label] = outcome.result;
    return outcome;
  };
  try {
    run("outline", "get_outline", {});
    run("section", "read_section", { heading: "Second Section" });
    run("section-missing", "read_section", { heading: "No Such Heading" });
    const made = run("comment", "comment_on_quote", {
      quoted_text: "the budget is 500 dollars",
      comment: "c",
    });
    run("comment-not-found", "comment_on_quote", { quoted_text: "absent text", comment: "c" });
    run("comment-heading", "comment_on_quote", { quoted_text: "Second Section", comment: "c" });
    run("replacement", "propose_replacement", {
      quoted_text: "eight weeks",
      suggested_text: "ten weeks",
    });
    run("replacement-over-heading", "propose_replacement", {
      quoted_text: "first phase.\n## Second Section\nThe second",
      suggested_text: "x",
    });
    const id = made.effect.kind === "comment" ? (made.effect.annotationId ?? "") : "";
    run("reply", "reply_to_annotation", { annotation_id: id, text: "r" });
    run("reply-unknown-id", "reply_to_annotation", { annotation_id: "ann_0_none", text: "r" });
    run("malformed-args", "comment_on_quote", null);
    run("unknown-tool-editing", "no_such_tool", {});
    run("editing-off", "comment_on_quote", { quoted_text: "eight weeks", comment: "c" }, deny);
    run("unknown-tool-chat", "no_such_tool", {}, deny);
    run("document-changed", "comment_on_quote", { quoted_text: "eight weeks", comment: "c" }, {
      ...allow,
      isDocCurrent: () => false,
    } as typeof allow);
  } finally {
    doc.destroy();
  }
  return out;
}

function userPrompts(): Record<string, string> {
  const doc = scratch();
  try {
    const out: Record<string, string> = {};
    for (const tier of ["chat", "editing"] as const) {
      out[`${tier}-inline`] = buildUserPrompt(doc, TASK, true, tier);
      out[`${tier}-long`] = buildUserPrompt(doc, TASK, false, tier);
    }
    return out;
  } finally {
    doc.destroy();
  }
}

/** Markdown whose extracted text is exactly `length` characters. */
function markdownOfLength(length: number): string {
  let body = "a".repeat(length);
  for (let i = 0; i < 8; i++) {
    const doc = new Y.Doc();
    loadMarkdown(doc, body);
    const got = extractText(doc).length;
    doc.destroy();
    if (got === length) return body;
    body = "a".repeat(Math.max(1, body.length + (length - got)));
  }
  throw new Error(`could not build a document of ${length} extracted characters`);
}

export interface FingerprintResult {
  fingerprint: string;
  /** The captured values, for a diff when the fingerprint changes. */
  inputs: Record<string, unknown>;
}

export async function computeFingerprint(): Promise<FingerprintResult> {
  const config: LocalModelConfig = harnessConfig("fingerprint-model", "http://127.0.0.1:11434");
  const inputs: Record<string, unknown> = {
    systemPrompts: { chat: systemPromptFor("chat"), editing: systemPromptFor("editing") },
    userPrompts: userPrompts(),
    tools: { editing: TOOLS, chat: READ_TOOLS },
    dispatch: dispatchTexts(),
  };

  const realFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;
  const realNow = Date.now;
  let clockOffset = 0;
  let largestDelay = 0;

  const scripted = async (
    tier: Tier,
    markdown: string,
    script: Parameters<typeof scriptedFetch>[0],
    selectedText?: string,
  ) => {
    const stub = scriptedFetch(script);
    globalThis.fetch = stub.fetch;
    try {
      const obs = await runTrial({ markdown, prompt: TASK, selectedText, tier, config });
      return { obs, calls: stub.calls };
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  try {
    // 1. One clean turn per tier, with a selection: the request the product sends.
    const request: Record<string, unknown> = {};
    for (const tier of ["chat", "editing"] as const) {
      const { obs, calls } = await scripted(tier, DOC, [{ content: ["ok"] }], SELECTION);
      request[tier] = {
        path: new URL(calls[0].url).pathname,
        body: calls[0].body,
        redirect: calls[0].init?.redirect,
        turnOptionKeys: obs.turnOpts?.keys,
        composedTask: obs.turnOpts?.task,
        includeFullText: obs.turnOpts?.includeFullText,
        maxResponseBytes: obs.turnOpts?.maxResponseBytes,
        history: obs.turnOpts?.hasHistory,
      };
    }
    inputs.request = request;

    // 2. Where the product stops inlining the document.
    const atLimit = await scripted("chat", markdownOfLength(INLINE_CHAR_LIMIT), [{ content: ["ok"] }]);
    const over = await scripted("chat", markdownOfLength(INLINE_CHAR_LIMIT + 1), [{ content: ["ok"] }]);
    inputs.inline = {
      limit: INLINE_CHAR_LIMIT,
      inlinedAtLimit: atLimit.obs.turnOpts?.includeFullText,
      inlinedOverLimit: over.obs.turnOpts?.includeFullText,
    };

    // 3. Budgets: where a run that never stops calling tools is stopped.
    const oneCall = (i: number): ScriptedTurn => ({
      toolCalls: [{ id: `call-${i}`, name: "get_outline", args: {} }],
    });
    const turnBudget = await scripted("chat", DOC, (i) => oneCall(i));
    const manyCalls = await scripted("chat", DOC, (i) => ({
      toolCalls: Array.from({ length: 7 }, (_, k) => ({
        id: `call-${i}-${k}`,
        name: "get_outline",
        args: {},
      })),
    }));
    inputs.budgets = {
      turnBudget: {
        exit: turnBudget.obs.loop?.metrics.exit,
        turns: turnBudget.obs.loop?.metrics.turns,
      },
      toolCallBudget: {
        exit: manyCalls.obs.loop?.metrics.exit,
        toolCalls: manyCalls.obs.loop?.metrics.toolCalls,
      },
    };

    // 4. A refused writing call in the chat tier, and the tool-less turn after it.
    const refused = await scripted("chat", DOC, [
      {
        toolCalls: [
          { id: "call-w", name: "comment_on_quote", args: { quoted_text: "eight weeks", comment: "c" } },
        ],
      },
      { content: ["plain answer"] },
    ]);
    inputs.editingOff = {
      exit: refused.obs.loop?.metrics.exit,
      secondRequest: refused.calls[1]?.body,
    };

    // 5. An editing-tier write and what the model is told about it.
    const wrote = await scripted("editing", DOC, [
      {
        toolCalls: [
          { id: "call-c", name: "comment_on_quote", args: { quoted_text: "eight weeks", comment: "c" } },
        ],
      },
      { content: ["done"] },
    ]);
    inputs.editingWrite = { secondRequest: wrote.calls[1]?.body };

    // 6. Timeouts: the largest timer armed before each request is the client's
    //    timeout for that turn. The scripted server moves the clock during the
    //    first turn, so the second turn's timer shows what is left of the run
    //    deadline.
    const armed: number[] = [];
    globalThis.setTimeout = ((handler: () => void, delay?: number, ...rest: unknown[]) => {
      largestDelay = Math.max(largestDelay, delay ?? 0);
      return (realSetTimeout as (...a: unknown[]) => unknown)(handler, delay, ...rest);
    }) as typeof setTimeout;
    // A fully virtual clock: it moves only when the scripted server moves it,
    // so a slow machine cannot change what is captured.
    const clockBase = realNow();
    Date.now = () => clockBase + clockOffset;
    const timed = await scripted("chat", DOC, (i) => {
      armed.push(largestDelay);
      largestDelay = 0;
      if (i === 0) {
        clockOffset += CLOCK_STEP_MS;
        return oneCall(0);
      }
      return { content: ["ok"] };
    });
    globalThis.setTimeout = realSetTimeout;
    Date.now = realNow;
    inputs.timeouts = {
      clockStepMs: CLOCK_STEP_MS,
      firstTurnTimeoutMs: armed[0],
      secondTurnTimeoutMs: armed[1],
      exit: timed.obs.loop?.metrics.exit,
    };

    // 7. The sink's cap on a streamed reply: how long a runaway reply gets.
    const flood = await scripted("chat", DOC, [
      { content: Array.from({ length: 80 }, () => "x".repeat(1024)) },
    ]);
    inputs.sinkCap = {
      replyLength: flood.obs.reply.length,
      tail: flood.obs.reply.slice(-80),
    };
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
    Date.now = realNow;
  }
  if (
    globalThis.fetch !== realFetch ||
    globalThis.setTimeout !== realSetTimeout ||
    Date.now !== realNow
  ) {
    throw new Error("fingerprint capture did not restore fetch, setTimeout or Date.now");
  }

  const normalised = normalise(inputs) as Record<string, unknown>;
  return { fingerprint: sha256Hex(canonicalJson(normalised)).slice(0, 32), inputs: normalised };
}
