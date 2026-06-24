import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { runLoop } from "../../../src/server/local-model/loop.js";
import { TOOLS } from "../../../src/server/local-model/tools.js";
import { makeMarkdownDoc } from "../../helpers/ydoc-factory.js";

const CONFIG = { endpoint: "http://127.0.0.1:11434", modelId: "m", transport: "v1" } as const;

function v1ToolCall(name: string): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: { content: "", tool_calls: [{ id: "c", function: { name, arguments: "{}" } }] },
        },
      ],
    }),
  );
}
function v1Text(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
}
function v1ToolCallArgs(name: string, args: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: "",
            tool_calls: [{ id: "c", function: { name, arguments: JSON.stringify(args) } }],
          },
        },
      ],
    }),
  );
}

// A Response body is single-use, so the loop's repeated chat() calls each need a
// FRESH Response — pass a factory, not a shared instance.
function stubFetch(factory: () => Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => factory()),
  );
}

let doc: Y.Doc | undefined;
afterEach(() => {
  vi.unstubAllGlobals();
  doc?.destroy();
  doc = undefined;
});

function base(extra: Partial<Parameters<typeof runLoop>[0]> = {}) {
  doc = makeMarkdownDoc("# H\n\nbody text here\n");
  return {
    ydoc: doc,
    config: CONFIG,
    tools: TOOLS,
    systemPrompt: "sys",
    userPrompt: "do x",
    ...extra,
  };
}

describe("runLoop — exits", () => {
  it("exits clean on a text-only turn and returns finalContent", async () => {
    stubFetch(() => v1Text("all good"));
    const r = await runLoop(base());
    expect(r.metrics.exit).toBe("clean");
    expect(r.finalContent).toBe("all good");
    expect(r.metrics.turns).toBe(1);
  });

  it("stops at the tool-call budget", async () => {
    stubFetch(() => v1ToolCall("get_outline")); // always a tool call
    const r = await runLoop(base({ maxToolCalls: 2, maxTurns: 99 }));
    expect(r.metrics.exit).toBe("max_tool_calls");
    expect(r.metrics.toolCalls).toBe(2);
  });

  it("stops at the turn budget", async () => {
    stubFetch(() => v1ToolCall("get_outline"));
    const r = await runLoop(base({ maxTurns: 2, maxToolCalls: 99 }));
    expect(r.metrics.exit).toBe("max_turns");
    expect(r.metrics.turns).toBe(2);
  });
});

describe("runLoop — metric tallies", () => {
  it("counts a heading-overlap rejection as an anchor-resolution failure (not just ANCHOR_NOT_FOUND)", async () => {
    // base() doc is "# H\n\nbody text here\n"; quoting the heading marker "# H"
    // is found but rejected by rejectHeadingOverlap — a failure the metric used
    // to ignore.
    stubFetch(() => v1ToolCallArgs("comment_on_quote", { quoted_text: "# H", comment: "x" }));
    const r = await runLoop(base({ maxToolCalls: 1, maxTurns: 99 }));
    expect(r.metrics.anchorResolutionFailures).toBe(1);
  });

  it("counts a failed reply_to_annotation in replyFailures", async () => {
    stubFetch(() => v1ToolCallArgs("reply_to_annotation", { annotation_id: "nope", text: "hi" }));
    const r = await runLoop(base({ maxToolCalls: 1, maxTurns: 99 }));
    expect(r.metrics.replyFailures).toBe(1);
  });
});

describe("runLoop — abort", () => {
  it("exits 'aborted' immediately when the signal is already aborted (no model call)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await runLoop(base({ signal: AbortSignal.abort() }));
    expect(r.metrics.exit).toBe("aborted");
    expect(r.metrics.turns).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not dispatch a turn's tools when the signal aborts during chat() (abort lost the race)", async () => {
    // fetch resolves SUCCESSFULLY with a mutating tool call, but flips the abort
    // flag first — simulating a supersede/close/switch that fired mid-await yet
    // lost the race to the fetch completing (so no AbortError is thrown).
    // dispatch() is synchronous, so the post-await re-check is the only point
    // that can stop this turn's writes from landing on the abandoned doc.
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      return v1ToolCallArgs("comment_on_quote", { quoted_text: "body text", comment: "x" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await runLoop(base({ signal: controller.signal, maxToolCalls: 9, maxTurns: 9 }));
    expect(r.metrics.exit).toBe("aborted");
    expect(r.metrics.turns).toBe(1); // chat() ran once...
    expect(r.metrics.toolCalls).toBe(0); // ...but no tool was dispatched
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies a thrown AbortError as 'aborted', not 'error'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
      }),
    );
    const r = await runLoop(base());
    expect(r.metrics.exit).toBe("aborted");
    expect(r.metrics.errorMessage).toBeUndefined();
  });

  it("classifies an unexpected throw as 'error' with a message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    const r = await runLoop(base());
    expect(r.metrics.exit).toBe("error");
    expect(r.metrics.errorMessage).toMatch(/connection refused/);
  });
});
