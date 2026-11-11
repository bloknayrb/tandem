/**
 * The two tiers of a local-model run (#1123 R2, ADR-039), driven through the
 * production entry point `runLocalModelTurn`.
 *
 * The tier is picked ONCE, when the run starts, from `editingAllowed`:
 *
 *  - chat (the default, and what every broken or missing permission gets): the
 *    model is offered exactly the reading tools and its prompts name no other;
 *  - editing: all of `TOOLS` and the editing prompt.
 *
 * and after that the permission is sticky-off: a run that started chat-tier is
 * never unlocked, and a run that saw "off" once never writes again.
 *
 * `fetch` is stubbed the way `loop.test.ts` does it, so the real chat client
 * builds the request and each call's `tools` and `messages` are read back off
 * the wire body — what the model was actually sent, not what the loop was
 * handed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { type RunTurnOpts, runLocalModelTurn } from "../../../src/server/local-model/index.js";
import {
  CHAT_SYSTEM_PROMPT,
  EDITING_SYSTEM_PROMPT,
} from "../../../src/server/local-model/prompts.js";
import {
  EDITING_OFF_MESSAGE,
  READ_TOOL_NAMES,
  READ_TOOLS,
  TOOLS,
} from "../../../src/server/local-model/tools.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../../src/shared/constants.js";
import type { Annotation } from "../../../src/shared/types.js";
import { makeMarkdownDoc } from "../../helpers/ydoc-factory.js";

const CONFIG = {
  endpoint: "http://127.0.0.1:11434",
  modelId: "m",
  transport: "v1",
  agentIdentity: { provider: "local-ollama", displayName: "Test Model" },
} as const;

const FIXTURE = "# H\n\nbody text here\n\nA second paragraph to quote.\n";
/** A task that names no tool, so anything found in a prompt is the template's. */
const TASK = "What is this document about?";

/** Writing tools, derived: a writing tool added later is covered unlisted. */
const WRITING_TOOL_NAMES = TOOLS.filter((t) => !READ_TOOLS.includes(t)).map((t) => t.name);

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}
interface Captured {
  /** names of the tools offered on this chat() call (empty if none were sent) */
  tools: string[];
  messages: { role: string; content: string }[];
}

function v1ToolCalls(calls: ToolCall[]): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: "",
            tool_calls: calls.map((c, i) => ({
              id: `c${i}`,
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          },
        },
      ],
    }),
  );
}
function v1Text(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
}

/**
 * Script the model: `turns[i]` answers the i-th chat() call (a list of tool
 * calls, or a string for a final plain-text answer); past the end it answers
 * "done". `before(i)` runs as the i-th call arrives — the place a test flips
 * the user's setting "while the model is thinking". Returns what each call was
 * sent.
 */
function scriptModel(
  turns: (ToolCall[] | string)[],
  before?: (callIndex: number) => void,
): Captured[] {
  const captured: Captured[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const index = captured.length;
      const body = JSON.parse(String(init.body)) as {
        tools?: { function: { name: string } }[];
        messages: { role: string; content: string }[];
      };
      captured.push({
        tools: (body.tools ?? []).map((t) => t.function.name),
        messages: body.messages,
      });
      before?.(index);
      const turn = turns[index] ?? "done";
      return typeof turn === "string" ? v1Text(turn) : v1ToolCalls(turn);
    }),
  );
  return captured;
}

let doc: Y.Doc | undefined;
afterEach(() => {
  vi.unstubAllGlobals();
  doc?.destroy();
  doc = undefined;
});

function run(extra: Partial<RunTurnOpts> & Pick<RunTurnOpts, "editingAllowed">) {
  doc ??= makeMarkdownDoc(FIXTURE);
  return runLocalModelTurn({ ydoc: doc, config: CONFIG, task: TASK, maxTurns: 9, ...extra });
}

function annotations(ydoc: Y.Doc): Annotation[] {
  return [...ydoc.getMap(Y_MAP_ANNOTATIONS).values()] as Annotation[];
}
function replyCount(ydoc: Y.Doc): number {
  return ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).size;
}
function toolResults(r: Awaited<ReturnType<typeof runLocalModelTurn>>): unknown[] {
  return r.messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
}
function namedWritingTools(text: string): string[] {
  return WRITING_TOOL_NAMES.filter((n) => text.includes(n));
}

const COMMENT_1: ToolCall = {
  name: "comment_on_quote",
  args: { quoted_text: "body text here", comment: "one" },
};
const COMMENT_2: ToolCall = {
  name: "comment_on_quote",
  args: { quoted_text: "A second paragraph", comment: "two" },
};

/** A forged, well-formed call to every writing tool: quotes that exist in the
 *  fixture. Throws on a writing tool it has no args for, so a new one cannot
 *  slip through with `{}`. */
function forgedWrites(annotationId: string): ToolCall[] {
  return WRITING_TOOL_NAMES.map((name) => {
    switch (name) {
      case "comment_on_quote":
        return { name, args: { quoted_text: "body text here", comment: "forged" } };
      case "propose_replacement":
        return { name, args: { quoted_text: "A second paragraph", suggested_text: "forged" } };
      case "reply_to_annotation":
        return { name, args: { annotation_id: annotationId, text: "forged" } };
      default:
        throw new Error(`forgedWrites: no args for writing tool "${name}" — add a case`);
    }
  });
}

const REFUSED = { error: "EDITING_OFF", message: EDITING_OFF_MESSAGE };

/** Everything that is not "a function returning exactly true". */
const NOT_ALLOWED: [label: string, value: unknown][] = [
  ["() => false", () => false],
  ["omitted", undefined],
  ["null", null],
  ["true (a boolean, not a function)", true],
  ['"yes" (a string)', "yes"],
  ["() => 1", () => 1],
  ['() => "yes"', () => "yes"],
  ["() => ({})", () => ({})],
  ["() => undefined", () => undefined],
];

function withPermission(value: unknown): Pick<RunTurnOpts, "editingAllowed"> {
  // `omitted` really leaves the key out, rather than setting it to undefined.
  return (value === undefined ? {} : { editingAllowed: value }) as unknown as Pick<
    RunTurnOpts,
    "editingAllowed"
  >;
}

describe("the derived tool sets", () => {
  it("are both non-empty, so the tier checks below are checking something", () => {
    expect(WRITING_TOOL_NAMES.length).toBeGreaterThan(0);
    expect(READ_TOOLS.length).toBeGreaterThan(0);
  });
});

describe("runLocalModelTurn — chat tier (#1123 R2.6, R2.7)", () => {
  for (const [label, value] of NOT_ALLOWED) {
    describe(`editingAllowed ${label}`, () => {
      for (const includeFullText of [true, false]) {
        it(`offers exactly the reading tools and names no writing tool (includeFullText: ${includeFullText})`, async () => {
          const sent = scriptModel(["hello"]);
          const r = await run({ ...withPermission(value), includeFullText });

          expect(r.metrics.exit).toBe("clean");
          expect(sent).toHaveLength(1);
          // R2.7: the tool list the model is sent is exactly the reading tools.
          expect([...(sent[0]?.tools ?? [])].sort()).toEqual([...READ_TOOL_NAMES].sort());
          expect(namedWritingTools(JSON.stringify(sent[0]?.tools))).toEqual([]);

          // R2.6: neither prompt describes a tool the model does not have.
          const [system, user] = sent[0]?.messages ?? [];
          expect(system?.role).toBe("system");
          expect(system?.content).toBe(CHAT_SYSTEM_PROMPT);
          expect(namedWritingTools(system?.content ?? "")).toEqual([]);
          expect(user?.role).toBe("user");
          expect(user?.content).toContain(TASK);
          expect(namedWritingTools(user?.content ?? "")).toEqual([]);
          // The arm really was the one asked for.
          expect(user?.content.includes("<document>")).toBe(includeFullText);
        });
      }

      it("a forged call to every writing tool creates nothing", async () => {
        doc = makeMarkdownDoc(FIXTURE);
        let writes = 0;
        doc.on("afterTransaction", () => writes++);
        scriptModel([forgedWrites("ann_forged")]);
        const r = await run(withPermission(value));

        expect(r.metrics.toolCalls).toBe(WRITING_TOOL_NAMES.length);
        expect(r.steps[0]?.toolCalls.map((c) => c.outcome)).toEqual(
          WRITING_TOOL_NAMES.map((tool) => ({ kind: "refused", tool, errorCode: "EDITING_OFF" })),
        );
        expect(writes, "no Y.Doc transaction at all").toBe(0);
        expect(annotations(doc)).toEqual([]);
        expect(replyCount(doc)).toBe(0);
      });
    });
  }

  it("the whole request body names no writing tool on any call of the run", async () => {
    // A chat-tier run that reads: two calls, and the second carries the tool
    // result back. Nothing sent on either mentions a writing tool.
    const sent = scriptModel([[{ name: "get_outline", args: {} }], "summary"]);
    const r = await run({ editingAllowed: () => false });
    expect(r.finalContent).toBe("summary");
    expect(sent).toHaveLength(2);
    for (const call of sent) {
      expect(namedWritingTools(JSON.stringify(call))).toEqual([]);
      expect([...call.tools].sort()).toEqual([...READ_TOOL_NAMES].sort());
    }
    expect(r.steps[0]?.toolCalls[0]?.outcome).toEqual({ kind: "read" });
  });
});

describe("runLocalModelTurn — editing tier", () => {
  it("offers all of TOOLS and the editing system prompt", async () => {
    const sent = scriptModel(["hello"]);
    await run({ editingAllowed: () => true });

    expect(sent[0]?.tools).toEqual(TOOLS.map((t) => t.name));
    expect(sent[0]?.messages[0]).toEqual({ role: "system", content: EDITING_SYSTEM_PROMPT });
    expect(sent[0]?.messages[1]?.content).toContain("when anchoring");
  });

  it("writes: a comment lands, stamped with the model's identity", async () => {
    scriptModel([[COMMENT_1], "done"]);
    const r = await run({ editingAllowed: () => true });
    expect(r.steps[0]?.toolCalls[0]?.outcome).toMatchObject({ kind: "comment", ok: true });
    expect(annotations(doc as Y.Doc).map((a) => a.content)).toEqual(["one"]);
    expect(annotations(doc as Y.Doc)[0]?.agentIdentity).toEqual(CONFIG.agentIdentity);
  });

  it("reads the permission once at start and once per writing dispatch, not per read", async () => {
    let reads = 0;
    scriptModel([[{ name: "get_outline", args: {} }, COMMENT_1, COMMENT_2], "done"]);
    await run({
      editingAllowed: () => {
        reads += 1;
        return true;
      },
    });
    expect(reads).toBe(3);
    expect(annotations(doc as Y.Doc)).toHaveLength(2);
  });
});

describe("runLocalModelTurn — the tier is fixed at run start (#1123 R2.4)", () => {
  it("a run that STARTED chat-tier is not unlocked by switching editing on between two dispatches", async () => {
    let editing = false;
    const sent = scriptModel(
      [[{ name: "get_outline", args: {} }], forgedWrites("ann_forged")],
      (i) => {
        // After the first dispatch, before the second: the user switches it on.
        if (i === 1) editing = true;
      },
    );
    const r = await run({ editingAllowed: () => editing });

    expect(editing, "the flip really happened mid-run").toBe(true);
    expect(r.steps[0]?.toolCalls[0]?.outcome).toEqual({ kind: "read" });
    expect(r.steps[1]?.toolCalls.map((c) => c.outcome)).toEqual(
      WRITING_TOOL_NAMES.map((tool) => ({ kind: "refused", tool, errorCode: "EDITING_OFF" })),
    );
    expect(annotations(doc as Y.Doc)).toEqual([]);
    expect(replyCount(doc as Y.Doc)).toBe(0);
    // Still a chat-tier run on the wire: the tool list did not grow either.
    for (const call of sent) {
      expect([...call.tools].sort()).toEqual([...READ_TOOL_NAMES].sort());
      expect(call.messages[0]?.content).toBe(CHAT_SYSTEM_PROMPT);
    }
  });

  it("switching on within a single turn's dispatches does not unlock the later ones either", async () => {
    // No await separates the calls of one turn, so the flip is made from inside
    // the permission itself: "off" at run start, "on" for every read after.
    let reads = 0;
    scriptModel([forgedWrites("ann_forged")]);
    const r = await run({ editingAllowed: () => reads++ > 0 });

    expect(r.steps[0]?.toolCalls.every((c) => c.outcome.kind === "refused")).toBe(true);
    expect(annotations(doc as Y.Doc)).toEqual([]);
  });

  it("the next run, started after the switch-on, is an editing run", async () => {
    // "On" applies from the next run — the other half of the rule above.
    let editing = false;
    scriptModel(["first"]);
    await run({ editingAllowed: () => editing });
    editing = true;
    const sent = scriptModel([[COMMENT_1], "second"]);
    await run({ editingAllowed: () => editing });
    expect(sent[0]?.tools).toEqual(TOOLS.map((t) => t.name));
    expect(annotations(doc as Y.Doc).map((a) => a.content)).toEqual(["one"]);
  });
});

describe("runLocalModelTurn — switching editing off mid-run (#1123 R2.4)", () => {
  it("refuses the second dispatch, and the tool message tells the model editing is off", async () => {
    let editing = true;
    scriptModel([[COMMENT_1], [COMMENT_2], "answered in chat"], (i) => {
      if (i === 1) editing = false;
    });
    const r = await run({ editingAllowed: () => editing });

    // The first write landed, the second did not.
    expect(annotations(doc as Y.Doc).map((a) => a.content)).toEqual(["one"]);
    expect(r.steps[0]?.toolCalls[0]?.outcome).toMatchObject({ kind: "comment", ok: true });
    expect(r.steps[1]?.toolCalls[0]?.outcome).toEqual({
      kind: "refused",
      tool: "comment_on_quote",
      errorCode: "EDITING_OFF",
    });

    const results = toolResults(r);
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toEqual(REFUSED);
    expect(EDITING_OFF_MESSAGE).toMatch(/switched off/i);
    expect(EDITING_OFF_MESSAGE).toMatch(/answer the user in plain text/i);

    // The run is not killed: the model is told, and answers.
    expect(r.metrics.exit).toBe("clean");
    expect(r.finalContent).toBe("answered in chat");
    expect(r.metrics.anchorResolutionFailures).toBe(0);
  });

  it("the refusal reaches the model on its next call", async () => {
    let editing = true;
    const sent = scriptModel([[COMMENT_1], [COMMENT_2], "ok"], (i) => {
      if (i === 1) editing = false;
    });
    await run({ editingAllowed: () => editing });

    const lastCall = sent[2];
    const toolMessages = lastCall?.messages.filter((m) => m.role === "tool") ?? [];
    expect(JSON.parse(toolMessages[1]?.content ?? "null")).toEqual(REFUSED);
  });

  it("is sticky: off on one dispatch, then on again — the later writing dispatch is still refused", async () => {
    let editing = true;
    scriptModel([[COMMENT_1], [COMMENT_2], forgedWrites("placeholder"), "done"], (i) => {
      if (i === 1) editing = false; // seen off by the second dispatch
      if (i === 2) editing = true; // back on before the third
    });
    const r = await run({ editingAllowed: () => editing });

    expect(editing, "editing really was back on for the last dispatch").toBe(true);
    expect(r.steps[1]?.toolCalls[0]?.outcome.kind).toBe("refused");
    expect(r.steps[2]?.toolCalls.map((c) => c.outcome)).toEqual(
      WRITING_TOOL_NAMES.map((tool) => ({ kind: "refused", tool, errorCode: "EDITING_OFF" })),
    );
    // Only the write made before the switch-off exists.
    expect(annotations(doc as Y.Doc).map((a) => a.content)).toEqual(["one"]);
    expect(replyCount(doc as Y.Doc)).toBe(0);
  });

  it("sticky covers a reply into a thread the same run created while editing was on", async () => {
    // The id is real — the run minted it — so only the latch stands between the
    // forged reply and the thread.
    let editing = true;
    let annotationId = "";
    const turns: (ToolCall[] | string)[] = [[COMMENT_1], [COMMENT_2], [], "done"];
    scriptModel(turns, (i) => {
      if (i === 1) editing = false;
      if (i === 2) {
        editing = true;
        annotationId = annotations(doc as Y.Doc)[0]?.id ?? "";
        turns[2] = [
          { name: "reply_to_annotation", args: { annotation_id: annotationId, text: "t" } },
        ];
      }
    });
    const r = await run({ editingAllowed: () => editing });

    expect(annotationId).not.toBe("");
    expect(r.steps[2]?.toolCalls[0]?.outcome).toEqual({
      kind: "refused",
      tool: "reply_to_annotation",
      errorCode: "EDITING_OFF",
    });
    expect(replyCount(doc as Y.Doc)).toBe(0);
    expect(r.metrics.replyFailures).toBe(0);
  });

  it("a non-boolean answer mid-run is 'off', and sticks", async () => {
    const answers: unknown[] = [true, 1, true];
    let i = 0;
    scriptModel([[COMMENT_1, COMMENT_2], "done"]);
    const r = await run({
      editingAllowed: (() => answers[Math.min(i++, answers.length - 1)]) as () => boolean,
    });
    // start: true (editing tier); first dispatch: 1 → refused; second: true → still refused.
    expect(r.steps[0]?.toolCalls.map((c) => c.outcome.kind)).toEqual(["refused", "refused"]);
    expect(annotations(doc as Y.Doc)).toEqual([]);
  });
});
