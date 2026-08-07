import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { runLoop } from "../../../src/server/local-model/loop.js";
import { TOOLS } from "../../../src/server/local-model/tools.js";
import type { Annotation } from "../../../src/shared/types.js";
import { getAnnotationsMap, makeMarkdownDoc } from "../../helpers/ydoc-factory.js";

const CONFIG = {
  endpoint: "http://127.0.0.1:11434",
  modelId: "m",
  transport: "v1",
  agentIdentity: { provider: "local-ollama", displayName: "Test Model" },
} as const;

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

describe("runLoop — agent identity threading (#1123 M3)", () => {
  it("stamps config.agentIdentity onto an annotation the loop produces", async () => {
    // The PRODUCTION path is runLoop → dispatch (not a direct dispatch call).
    // Deleting `agentIdentity: config.agentIdentity` in loop.ts must fail here.
    stubFetch(() =>
      v1ToolCallArgs("comment_on_quote", { quoted_text: "body text here", comment: "x" }),
    );
    const opts = base({ maxToolCalls: 1, maxTurns: 99 });
    await runLoop(opts);
    const map = getAnnotationsMap(opts.ydoc);
    expect(map.size).toBe(1);
    const ann = [...map.values()][0] as Annotation;
    expect(ann.agentIdentity).toEqual(CONFIG.agentIdentity);
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

  it("classifies a CALLER-initiated AbortError as 'aborted', not 'error'", async () => {
    // The caller's signal is what makes this "aborted" rather than "timeout":
    // the user superseded / closed / switched, so the exit is silent by design.
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort();
        throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
      }),
    );
    const r = await runLoop(base({ signal: controller.signal }));
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

describe("runLoop — aggregate wall-clock deadline (#1295 L6)", () => {
  it("stops on the run deadline with its own exit reason, not max_turns", async () => {
    stubFetch(() => v1ToolCall("get_outline")); // never terminates on its own
    const r = await runLoop(base({ runDeadlineMs: 1, maxTurns: 99, maxToolCalls: 99 }));

    // The distinction is the whole point of the fix. The collaborator branches
    // on `max_turns` to tell the user the model "reached its step limit" — a
    // lie for a wall-clock exit, and it sends them to raise maxTurns for what
    // is really a stalling endpoint.
    expect(r.metrics.exit).toBe("timeout");
    expect(r.metrics.exit).not.toBe("max_turns");

    // And it must be self-consistent: a timeout exit reports turns BELOW the
    // budget, which is exactly why reusing "max_turns" would corrupt the metric.
    expect(r.metrics.turns).toBeLessThan(99);
  });

  it("does not fire when the run finishes inside the budget", async () => {
    // Positive control on the same sample: without this, the assertion above
    // would also pass against an implementation that always exits "timeout".
    stubFetch(() => v1Text("done"));
    const r = await runLoop(base({ runDeadlineMs: 60_000 }));
    expect(r.metrics.exit).toBe("clean");
    expect(r.finalContent).toBe("done");
  });

  it("clamps the per-turn timeout to the remaining budget", async () => {
    // A deadline checked only at the top of the loop lets a turn that starts one
    // millisecond inside the budget run the full per-turn timeout past it.
    // The stub must HONOUR the abort signal. A stub that merely sleeps and then
    // resolves is testing itself, not the clamp — the first draft of this test
    // did exactly that and passed against an unclamped timeout.
    let abortedAfterMs: number | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            const t0 = Date.now();
            const signal = init.signal as AbortSignal | undefined;
            signal?.addEventListener("abort", () => {
              abortedAfterMs = Date.now() - t0;
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
            // Never resolves on its own: only the timeout can end this turn.
          }),
      ),
    );

    await runLoop(base({ runDeadlineMs: 50, timeoutMs: 600_000, maxTurns: 1 }));

    // Unclamped, the turn would have been governed by the 600s per-turn timeout
    // and this test would hang rather than abort in tens of milliseconds.
    expect(abortedAfterMs).toBeDefined();
    expect(abortedAfterMs).toBeLessThan(5_000);
  });

  it("reports 'timeout' when the budget expires DURING a turn, not 'aborted'", async () => {
    // The clamp above is exactly what made the `timeout` exit unreachable: it
    // hands chat() a timeout expiring AT the deadline, so the in-flight turn
    // always aborts before the loop can come back around to its top-of-loop
    // deadline check. Every wall-clock expiry therefore arrived as an
    // AbortError — and `aborted` is deliberately SILENT in the collaborator, so
    // a run that stalled out told the user nothing at all.
    //
    // Note what the sibling test above does NOT do: it asserts only that the
    // abort fired promptly, never what `exit` became. The 'timeout' assertion
    // in the first test of this block reaches its branch only because
    // runDeadlineMs:1 lets a synchronously-resolving stub complete a turn past
    // the deadline — no endpoint takes real time there. This is the case a real
    // stalling endpoint produces.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            const signal = init.signal as AbortSignal | undefined;
            signal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
            // Never resolves: only the clamped per-turn timeout can end this.
          }),
      ),
    );

    const r = await runLoop(base({ runDeadlineMs: 50, timeoutMs: 600_000, maxTurns: 99 }));

    expect(r.metrics.exit).toBe("timeout");
    expect(r.metrics.exit).not.toBe("aborted");
    expect(r.metrics.errorMessage).toBeUndefined();
  });

  it("a plain per-turn timeout is also 'timeout' (no caller abort involved)", async () => {
    // Same silent-failure class, reached without the run budget: with the
    // shipped defaults the FIRST turn is not clamped (300 s budget > 180 s
    // per-turn), so a stalling endpoint hits `timeoutMs` and ends the whole run
    // there. Bucketing that as `aborted` would leave the primary stalling case
    // silent even with the budget-expiry fix in place.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            const signal = init.signal as AbortSignal | undefined;
            signal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          }),
      ),
    );

    // timeoutMs well below the remaining budget → the clamp is NOT the binding
    // constraint, so this exercises the per-turn timer specifically.
    const r = await runLoop(base({ runDeadlineMs: 600_000, timeoutMs: 30, maxTurns: 99 }));

    expect(r.metrics.exit).toBe("timeout");
  });
});
