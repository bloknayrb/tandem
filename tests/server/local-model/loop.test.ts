import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { runLocalModelTurn } from "../../../src/server/local-model/index.js";
import { runLoop } from "../../../src/server/local-model/loop.js";
import { EDITING_OFF_MESSAGE, TOOLS } from "../../../src/server/local-model/tools.js";
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

/** One assistant turn carrying several tool calls — several dispatches of one run. */
function v1ToolCalls(calls: { name: string; args: Record<string, unknown> }[]): Response {
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
    // #1123: the editing permission. The pre-existing cases exercise the write
    // path, so the default here is ON; "runLoop — editing permission" below is
    // where it is switched off, flipped mid-run and left out.
    canEdit: () => true,
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

describe("runLoop — mid-turn doc swap (#2039)", () => {
  // Every case here flips `isDocCurrent` DURING the first `chat()` rather than
  // starting it false. A statically-false predicate is satisfied by a
  // top-of-loop check (it breaks before `chat()`, yielding turns === 0), which
  // would leave the real shape — the swap lands mid-await, so THIS turn's tool
  // calls dispatch onto the destroyed instance — pinned by nothing.

  it("stops a TOOL-ONLY turn before dispatch when the doc is swapped mid-await", async () => {
    let swapped = false;
    const fetchMock = vi.fn(async () => {
      swapped = true;
      return v1ToolCallArgs("comment_on_quote", { quoted_text: "body text here", comment: "x" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const opts = base({ isDocCurrent: () => !swapped, maxToolCalls: 9, maxTurns: 9 });
    const r = await runLoop(opts);

    expect(r.metrics.exit).toBe("doc-swapped");
    expect(r.metrics.turns).toBe(1); // chat() ran...
    expect(r.metrics.toolCalls).toBe(0); // ...but nothing dispatched
    expect(getAnnotationsMap(opts.ydoc).size).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops a FINAL-ANSWER turn with no finalContent when the doc is swapped mid-await", async () => {
    let swapped = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        swapped = true;
        return v1Text("the reply");
      }),
    );
    const r = await runLoop(base({ isDocCurrent: () => !swapped, maxTurns: 9 }));

    // Exiting `clean` here would hand the collaborator a reply to flush.
    expect(r.metrics.exit).toBe("doc-swapped");
    expect(r.metrics.turns).toBe(1);
    expect(r.finalContent).toBe("");
  });

  it("treats an omitted isDocCurrent as 'still current'", async () => {
    stubFetch(() => v1Text("all good"));
    const r = await runLoop(base({ maxTurns: 9 }));
    expect(r.metrics.exit).toBe("clean");
  });

  it("reports 'aborted', not 'doc-swapped', when both land during the same turn", async () => {
    // The abort must land DURING chat(): an already-aborted signal breaks at the
    // top-of-loop guard and never reaches either post-await check.
    const controller = new AbortController();
    let swapped = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort();
        swapped = true;
        return v1ToolCallArgs("comment_on_quote", { quoted_text: "body text here", comment: "x" });
      }),
    );
    const r = await runLoop(
      base({
        signal: controller.signal,
        isDocCurrent: () => !swapped,
        maxToolCalls: 9,
        maxTurns: 9,
      }),
    );

    expect(r.metrics.exit).toBe("aborted");
    expect(r.metrics.turns).toBe(1);
    expect(r.metrics.toolCalls).toBe(0);
  });

  it("forwards isDocCurrent into each tool dispatch (#2070)", async () => {
    // True at the turn boundary, false from the first dispatch on: only the
    // per-dispatch forward can turn the write into a refusal. A real reload
    // cannot land here (nothing awaits inside the tool-call loop), which is
    // why the arm is defence in depth and this is the only way to reach it.
    let calls = 0;
    stubFetch(() =>
      v1ToolCallArgs("comment_on_quote", { quoted_text: "body text here", comment: "x" }),
    );
    const opts = base({ isDocCurrent: () => calls++ === 0, maxToolCalls: 1, maxTurns: 9 });
    const r = await runLoop(opts);

    expect(r.metrics.toolCalls).toBe(1);
    const outcome = r.steps[0]?.toolCalls[0]?.outcome;
    expect(outcome).toMatchObject({ kind: "comment", ok: false, errorCode: "DOCUMENT_CHANGED" });
    expect(getAnnotationsMap(opts.ydoc).size, "nothing written").toBe(0);
  });

  it("runLocalModelTurn forwards isDocCurrent to the loop (production entry point)", async () => {
    // `runLocalModelTurn` hand-enumerates every forwarded field, so omitting
    // this one is silent — the option is optional and the direct-runLoop cases
    // above stay green.
    doc = makeMarkdownDoc("# H\n\nbody text here\n");
    stubFetch(() =>
      v1ToolCallArgs("comment_on_quote", { quoted_text: "body text here", comment: "x" }),
    );
    const r = await runLocalModelTurn({
      ydoc: doc,
      config: CONFIG,
      task: "go",
      isDocCurrent: () => false,
      editingAllowed: () => true,
    });

    expect(r.metrics.exit).toBe("doc-swapped");
    expect(r.metrics.toolCalls).toBe(0);
  });
});

describe("runLoop — editing permission (#1123 R2.3, R2.4)", () => {
  const COMMENT = { name: "comment_on_quote", args: { quoted_text: "body text", comment: "one" } };
  const COMMENT_2 = {
    name: "comment_on_quote",
    args: { quoted_text: "text here", comment: "two" },
  };

  /** The tool messages handed back to the model, parsed, in order. */
  function toolResults(r: Awaited<ReturnType<typeof runLoop>>): Record<string, unknown>[] {
    return r.messages
      .filter((m) => m.role === "tool")
      .map((m) => JSON.parse(m.content) as Record<string, unknown>);
  }

  it("reads canEdit on EVERY dispatch: switched off between two dispatches of one turn, the second is refused", async () => {
    // One assistant turn, two tool calls. Nothing awaits between them, so only a
    // per-dispatch read of the permission can tell them apart.
    let turn = 0;
    stubFetch(() => (turn++ === 0 ? v1ToolCalls([COMMENT, COMMENT_2]) : v1Text("done")));
    let reads = 0;
    const opts = base({ canEdit: () => reads++ === 0, maxTurns: 9, maxToolCalls: 9 });
    const r = await runLoop(opts);

    expect(reads, "one read per writing dispatch").toBe(2);
    const outcomes = r.steps[0]?.toolCalls.map((c) => c.outcome);
    expect(outcomes?.[0]).toMatchObject({ kind: "comment", ok: true });
    expect(outcomes?.[1]).toEqual({
      kind: "refused",
      tool: "comment_on_quote",
      errorCode: "EDITING_OFF",
    });

    // The first write landed; the second did not.
    const stored = [...getAnnotationsMap(opts.ydoc).values()] as Annotation[];
    expect(stored.map((a) => a.content)).toEqual(["one"]);

    // And the model is TOLD, in the tool message it gets back, that editing is off.
    const results = toolResults(r);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toEqual({ error: "EDITING_OFF", message: EDITING_OFF_MESSAGE });
    expect(String(results[1]?.message)).toMatch(/switched off/i);
    expect(r.metrics.exit).toBe("clean");
  });

  it("switched off between two TURNS of one run: the first write lands, the second is refused", async () => {
    let editing = true;
    let turn = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        turn += 1;
        if (turn === 1) return v1ToolCalls([COMMENT]);
        if (turn === 2) {
          // The user flips the setting while the model is thinking.
          editing = false;
          return v1ToolCalls([COMMENT_2]);
        }
        return v1Text("answered in chat");
      }),
    );
    const opts = base({ canEdit: () => editing, maxTurns: 9, maxToolCalls: 9 });
    const r = await runLoop(opts);

    const stored = [...getAnnotationsMap(opts.ydoc).values()] as Annotation[];
    expect(stored.map((a) => a.content)).toEqual(["one"]);
    expect(r.steps[1]?.toolCalls[0]?.outcome).toEqual({
      kind: "refused",
      tool: "comment_on_quote",
      errorCode: "EDITING_OFF",
    });
    expect(toolResults(r)[1]).toEqual({ error: "EDITING_OFF", message: EDITING_OFF_MESSAGE });
    // The run goes on: the model gets its refusal and can still answer.
    expect(r.metrics.exit).toBe("clean");
    expect(r.finalContent).toBe("answered in chat");
  });

  it("a caller that omits canEdit gets no writes (fail-closed)", async () => {
    let turn = 0;
    stubFetch(() =>
      turn++ === 0
        ? v1ToolCalls([
            COMMENT,
            {
              name: "propose_replacement",
              args: { quoted_text: "body text here", suggested_text: "x" },
            },
            { name: "reply_to_annotation", args: { annotation_id: "any", text: "t" } },
          ])
        : v1Text("done"),
    );
    const { canEdit: _omitted, ...withoutPermission } = base({ maxTurns: 9, maxToolCalls: 9 });
    let writes = 0;
    withoutPermission.ydoc.on("afterTransaction", () => writes++);
    const r = await runLoop(withoutPermission as unknown as Parameters<typeof runLoop>[0]);

    expect(r.metrics.toolCalls).toBe(3);
    expect(r.steps[0]?.toolCalls.map((c) => c.outcome.kind)).toEqual([
      "refused",
      "refused",
      "refused",
    ]);
    expect(writes, "no Y.Doc transaction at all").toBe(0);
    expect(getAnnotationsMap(withoutPermission.ydoc).size).toBe(0);
  });

  it("still serves the reading tools when canEdit says no", async () => {
    let turn = 0;
    stubFetch(() => (turn++ === 0 ? v1ToolCall("get_outline") : v1Text("done")));
    const r = await runLoop(base({ canEdit: () => false, maxTurns: 9 }));
    expect(r.steps[0]?.toolCalls[0]?.outcome).toEqual({ kind: "read" });
    expect(toolResults(r)[0]).toHaveProperty("outline");
  });

  it("a refused call counts in neither anchorResolutionFailures nor replyFailures", async () => {
    // Those two tally what the model got WRONG. The same calls with editing on
    // are counted (see "runLoop — metric tallies"): a heading-overlap quote and
    // a reply to an id that does not exist.
    let turn = 0;
    stubFetch(() =>
      turn++ === 0
        ? v1ToolCalls([
            { name: "comment_on_quote", args: { quoted_text: "# H", comment: "x" } },
            {
              name: "propose_replacement",
              args: { quoted_text: "not there", suggested_text: "x" },
            },
            { name: "reply_to_annotation", args: { annotation_id: "nope", text: "hi" } },
          ])
        : v1Text("done"),
    );
    const r = await runLoop(base({ canEdit: () => false, maxTurns: 9, maxToolCalls: 9 }));

    expect(r.metrics.toolCalls).toBe(3);
    expect(r.metrics.anchorResolutionFailures).toBe(0);
    expect(r.metrics.replyFailures).toBe(0);
    expect(r.metrics.flatOnlyAnchors).toBe(0);
    expect(r.steps[0]?.toolCalls.map((c) => c.outcome.kind)).toEqual([
      "refused",
      "refused",
      "refused",
    ]);
  });

  it("control: the same three calls ARE counted with editing on", async () => {
    let turn = 0;
    stubFetch(() =>
      turn++ === 0
        ? v1ToolCalls([
            { name: "comment_on_quote", args: { quoted_text: "# H", comment: "x" } },
            {
              name: "propose_replacement",
              args: { quoted_text: "not there", suggested_text: "x" },
            },
            { name: "reply_to_annotation", args: { annotation_id: "nope", text: "hi" } },
          ])
        : v1Text("done"),
    );
    const r = await runLoop(base({ maxTurns: 9, maxToolCalls: 9 }));
    expect(r.metrics.anchorResolutionFailures).toBe(2);
    expect(r.metrics.replyFailures).toBe(1);
  });
});
