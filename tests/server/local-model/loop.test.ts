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

describe("runLoop — abort", () => {
  it("exits 'aborted' immediately when the signal is already aborted (no model call)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await runLoop(base({ signal: AbortSignal.abort() }));
    expect(r.metrics.exit).toBe("aborted");
    expect(r.metrics.turns).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
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
