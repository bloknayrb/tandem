import { afterEach, describe, expect, it, vi } from "vitest";
import { chat } from "../../../src/server/local-model/ollama-client.js";

const V1 = { endpoint: "http://127.0.0.1:11434", modelId: "m", transport: "v1" } as const;
const NATIVE = { endpoint: "http://127.0.0.1:11434", modelId: "m", transport: "native" } as const;

function stubFetch(impl: (url: string, init: RequestInit) => Response): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string, init: RequestInit) => impl(url, init));
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Build a streaming Response from string/byte chunks (one ReadableStream). */
function streamResponse(chunks: (string | Uint8Array)[], init?: ResponseInit): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
      controller.close();
    },
  });
  return new Response(stream, init);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ollama-client — transport normalization", () => {
  it("normalizes an OpenAI /v1 response (content + tool calls)", async () => {
    const fetchMock = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "ok",
                  tool_calls: [
                    {
                      id: "c1",
                      function: {
                        name: "comment_on_quote",
                        arguments: '{"quoted_text":"x","comment":"y"}',
                      },
                    },
                  ],
                },
              },
            ],
          }),
        ),
    );
    const res = await chat({ config: V1, messages: [], tools: [] });
    expect(res.content).toBe("ok");
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].name).toBe("comment_on_quote");
    expect(res.toolCalls[0].args).toEqual({ quoted_text: "x", comment: "y" });
    expect(res.toolCalls[0].parseError).toBeUndefined();
    // POSTs to the /v1 path and never follows a redirect.
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/v1/chat/completions",
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
  });

  it("records a parse fault for malformed tool-call arguments (no crash)", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    { id: "c1", function: { name: "comment_on_quote", arguments: "{not json" } },
                  ],
                },
              },
            ],
          }),
        ),
    );
    const res = await chat({ config: V1, messages: [], tools: [] });
    expect(res.toolCalls[0].args).toBeNull();
    expect(res.toolCalls[0].parseError).toBeDefined();
  });

  it("normalizes a native /api/chat response", async () => {
    const fetchMock = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            message: {
              content: "hi",
              tool_calls: [{ function: { name: "get_outline", arguments: {} } }],
            },
          }),
        ),
    );
    const res = await chat({ config: NATIVE, messages: [], tools: [] });
    expect(res.content).toBe("hi");
    expect(res.toolCalls[0].name).toBe("get_outline");
    expect(res.toolCalls[0].args).toEqual({});
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/chat",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("re-echoes assistant tool_calls (object args) and tool_name on the native transport", async () => {
    const fetchMock = stubFetch(() => new Response(JSON.stringify({ message: { content: "ok" } })));
    await chat({
      config: NATIVE,
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", name: "get_outline", args: { x: 1 }, rawArgs: '{"x":1}' }],
        },
        { role: "tool", content: "{}", tool_call_id: "c1", tool_name: "get_outline" },
      ],
      tools: [],
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      messages: {
        role: string;
        tool_calls?: { function: { name: string; arguments: unknown } }[];
        tool_name?: string;
      }[];
    };
    const asst = body.messages.find((m) => m.role === "assistant");
    expect(asst?.tool_calls?.[0].function.name).toBe("get_outline");
    // native sends the args as an OBJECT (not a JSON string like /v1)
    expect(asst?.tool_calls?.[0].function.arguments).toEqual({ x: 1 });
    const toolMsg = body.messages.find((m) => m.role === "tool");
    expect(toolMsg?.tool_name).toBe("get_outline");
  });
});

describe("ollama-client — security/robustness", () => {
  it("rejects a non-loopback endpoint at fetch time (validate-at-use)", async () => {
    const fetchMock = stubFetch(() => new Response("{}"));
    await expect(
      chat({
        config: { endpoint: "http://192.168.1.9:11434", modelId: "m", transport: "v1" },
        messages: [],
        tools: [],
      }),
    ).rejects.toThrow(/invalid local-model endpoint/);
    expect(fetchMock).not.toHaveBeenCalled(); // never even dialed out
  });

  it("aborts a response that exceeds the byte cap", async () => {
    stubFetch(() => new Response("x".repeat(10_000)));
    await expect(
      chat({ config: V1, messages: [], tools: [], maxResponseBytes: 100 }),
    ).rejects.toThrow(/cap/);
  });

  it("throws a body-free error on a 200 with a non-JSON body (distinct from a network fault)", async () => {
    stubFetch(() => new Response("<html>not json</html>", { status: 200 }));
    await expect(chat({ config: V1, messages: [], tools: [] })).rejects.toThrow(
      /non-JSON response/,
    );
    // the raw body must not leak into the thrown message
    await expect(chat({ config: V1, messages: [], tools: [] })).rejects.not.toThrow(/html/);
  });

  it("surfaces an HTTP error by status (raw body not in the thrown message)", async () => {
    stubFetch(() => new Response("internal detail leak", { status: 500 }));
    await expect(chat({ config: V1, messages: [], tools: [] })).rejects.toThrow(/HTTP 500/);
    await expect(chat({ config: V1, messages: [], tools: [] })).rejects.not.toThrow(
      /internal detail leak/,
    );
  });
});

describe("ollama-client — streaming (#1123 M1.2)", () => {
  it("streams v1 SSE content deltas, accumulates the same content, sends stream:true", async () => {
    const fetchMock = stubFetch(() =>
      streamResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
        "data: [DONE]\n",
      ]),
    );
    const deltas: string[] = [];
    const res = await chat({
      config: V1,
      messages: [],
      tools: [],
      onContentDelta: (d) => deltas.push(d),
    });
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(res.content).toBe("Hello");
    expect(res.toolCalls).toHaveLength(0);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((JSON.parse(init.body as string) as { stream: boolean }).stream).toBe(true);
  });

  it("streams native NDJSON content and terminates on done:true", async () => {
    const fetchMock = stubFetch(() =>
      streamResponse([
        '{"message":{"content":"Hi"},"done":false}\n',
        '{"message":{"content":" there"},"done":false}\n',
        '{"message":{"content":""},"done":true}\n',
        // a line after done must never be reached:
        '{"message":{"content":" LEAK"},"done":false}\n',
      ]),
    );
    const deltas: string[] = [];
    const res = await chat({
      config: NATIVE,
      messages: [],
      tools: [],
      onContentDelta: (d) => deltas.push(d),
    });
    expect(deltas).toEqual(["Hi", " there"]);
    expect(res.content).toBe("Hi there");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/chat",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  // C1: a multi-byte codepoint split at the BYTE level across chunks must not
  // decode to U+FFFD on both sides (one streaming TextDecoder, not per-chunk).
  it("reassembles a multi-byte UTF-8 codepoint split across chunk boundaries", async () => {
    const enc = new TextEncoder();
    const bytes = enc.encode('data: {"choices":[{"delta":{"content":"café"}}]}\n');
    const splitAt = bytes.indexOf(0xc3) + 1; // between the two bytes of é (0xc3 0xa9)
    stubFetch(() =>
      streamResponse([bytes.slice(0, splitAt), bytes.slice(splitAt), "data: [DONE]\n"]),
    );
    const res = await chat({ config: V1, messages: [], tools: [], onContentDelta: () => {} });
    expect(res.content).toBe("café");
    expect(res.content).not.toContain("�");
  });

  it("buffers a data frame split across two chunks (no throw, no loss)", async () => {
    stubFetch(() =>
      streamResponse(['data: {"choices":[{"delta":{"con', 'tent":"split"}}]}\n', "data: [DONE]\n"]),
    );
    const res = await chat({ config: V1, messages: [], tools: [], onContentDelta: () => {} });
    expect(res.content).toBe("split");
  });

  // C2: v1 fragments tool_call args across many deltas keyed by `index`; the
  // accumulator must reassemble into the SAME RawToolCall the non-stream path gives.
  it("reassembles a tool_call whose arguments are fragmented across ≥3 deltas", async () => {
    stubFetch(() =>
      streamResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"comment_on_quote"}}]}}]}\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"quoted_text\\":"}}]}}]}\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\",\\"comment\\":"}}]}}]}\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"y\\"}"}}]}}]}\n',
        "data: [DONE]\n",
      ]),
    );
    const res = await chat({ config: V1, messages: [], tools: [], onContentDelta: () => {} });
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].id).toBe("c1");
    expect(res.toolCalls[0].name).toBe("comment_on_quote");
    expect(res.toolCalls[0].args).toEqual({ quoted_text: "x", comment: "y" });
    expect(res.toolCalls[0].parseError).toBeUndefined();
  });

  it("keeps two parallel tool_calls distinct (keyed by index, not arrival order)", async () => {
    stubFetch(() =>
      streamResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"get_outline","arguments":"{}"}},{"index":1,"id":"b","function":{"name":"read_section","arguments":"{\\"heading\\":"}}]}}]}\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\\"Intro\\"}"}}]}}]}\n',
        "data: [DONE]\n",
      ]),
    );
    const res = await chat({ config: V1, messages: [], tools: [], onContentDelta: () => {} });
    expect(res.toolCalls.map((t) => t.name)).toEqual(["get_outline", "read_section"]);
    expect(res.toolCalls[1].args).toEqual({ heading: "Intro" });
  });

  it("records a parse fault (not a dropped call) for a malformed reassembled tool_call", async () => {
    stubFetch(() =>
      streamResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"x","arguments":"{not json"}}]}}]}\n',
        "data: [DONE]\n",
      ]),
    );
    const res = await chat({ config: V1, messages: [], tools: [], onContentDelta: () => {} });
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].args).toBeNull();
    expect(res.toolCalls[0].parseError).toBeDefined();
  });

  // H1: the cap counts RAW bytes pre-decode and checks per chunk, so a giant
  // newline-less line can't grow the buffer unbounded.
  it("aborts an over-cap stream (newline-less flood)", async () => {
    stubFetch(() => streamResponse(["x".repeat(10_000)]));
    await expect(
      chat({
        config: V1,
        messages: [],
        tools: [],
        maxResponseBytes: 100,
        onContentDelta: () => {},
      }),
    ).rejects.toThrow(/cap/);
  });

  // M2: a 200 streaming body with zero recognizable frames (a proxy HTML page)
  // throws the body-free non-JSON error — the raw body must not leak.
  it("throws body-free on a 200 streaming HTML body (no valid frames)", async () => {
    stubFetch(() => streamResponse(["<html>secret proxy detail</html>\n"]));
    await expect(
      chat({ config: V1, messages: [], tools: [], onContentDelta: () => {} }),
    ).rejects.toThrow(/non-JSON response/);
    stubFetch(() => streamResponse(["<html>secret proxy detail</html>\n"]));
    await expect(
      chat({ config: V1, messages: [], tools: [], onContentDelta: () => {} }),
    ).rejects.not.toThrow(/secret proxy detail/);
  });

  it("ignores SSE keep-alive/comment lines without dropping content", async () => {
    stubFetch(() =>
      streamResponse([
        ": keep-alive\n",
        "\n",
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n',
        "data: [DONE]\n",
      ]),
    );
    const res = await chat({ config: V1, messages: [], tools: [], onContentDelta: () => {} });
    expect(res.content).toBe("ok");
  });

  // M1: the timeout wraps the WHOLE streaming read — a stream that stalls after
  // headers is killed, never hangs. (Real short timeout; the stub honors the signal.)
  it("aborts a stalled stream via the timeout (no hang)", async () => {
    stubFetch((_url, init) => {
      const sig = init.signal as AbortSignal;
      const stream = new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>((_res, rej) => {
            const fail = () => rej(new DOMException("aborted", "AbortError"));
            if (sig.aborted) fail();
            else sig.addEventListener("abort", fail, { once: true });
          });
        },
      });
      return new Response(stream, { status: 200 });
    });
    await expect(
      chat({ config: V1, messages: [], tools: [], timeoutMs: 50, onContentDelta: () => {} }),
    ).rejects.toThrow();
  });
});
