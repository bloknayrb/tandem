import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { runLoop } from "../../../src/server/local-model/loop.js";
import { chat, requestFailure } from "../../../src/server/local-model/ollama-client.js";

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

  it("surfaces an HTTP error body-free on the STREAMING path too (postLoopback drift guard)", async () => {
    // The streaming caller shares postLoopback's loopback-security contract with
    // postJson. This guards against fetchStream drifting off it: a non-2xx
    // streaming response must redact the body exactly like the non-streaming path.
    stubFetch(() => new Response("internal detail leak", { status: 500 }));
    await expect(
      chat({ config: V1, messages: [], tools: [], onContentDelta: () => {} }),
    ).rejects.toThrow(/HTTP 500/);
    stubFetch(() => new Response("internal detail leak", { status: 500 }));
    await expect(
      chat({ config: V1, messages: [], tools: [], onContentDelta: () => {} }),
    ).rejects.not.toThrow(/internal detail leak/);
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

describe("ollama-client — endpoint is rebuilt from the validated URL (#1295 L4/L5)", () => {
  const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));

  it("drops a fragment instead of welding it in front of the API path", async () => {
    const fetchMock = stubFetch(ok);
    await chat({
      config: { ...V1, endpoint: "http://127.0.0.1:11434#frag" },
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });
    // Trimming trailing slashes off the RAW string left the fragment attached,
    // producing `...:11434#frag/v1/chat/completions`, which fetch re-parses as
    // path `/` — a silent wrong-path request surfacing as "non-JSON response".
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("drops a query string the same way", async () => {
    const fetchMock = stubFetch(ok);
    await chat({
      config: { ...V1, endpoint: "http://127.0.0.1:11434/?k=v" },
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:11434/v1/chat/completions");
  });

  it("connects to 127.0.0.1 for a validated `localhost`, so check and connect agree", async () => {
    const fetchMock = stubFetch(ok);
    await chat({
      config: { ...V1, endpoint: "http://localhost:11434" },
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });
    // The literal-name match accepted `localhost`, but fetch would have resolved
    // it independently — validate-by-name-then-connect-by-name is the rebinding
    // shape. The dialed URL must carry the address, not the name.
    const dialed = fetchMock.mock.calls[0]?.[0] as string;
    expect(dialed).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(dialed).not.toContain("localhost");
  });

  it("still preserves a legitimate base path", async () => {
    // Positive control: the fix rebuilds the URL, so prove it does not also
    // discard a path the user deliberately configured (a reverse-proxied Ollama).
    const fetchMock = stubFetch(ok);
    await chat({
      config: { ...V1, endpoint: "http://127.0.0.1:11434/ollama/" },
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:11434/ollama/v1/chat/completions");
  });
});

// #1123 Decision L3 / Ruling L-c: one trailing `/v1` is dropped from the path
// in `baseUrl`, after validation, for both transports. Judged by the URL the
// request is built for, on the non-streaming (`postJson`) and streaming paths.
describe("ollama-client — a trailing /v1 in the saved address", () => {
  const okJson = () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      headers: { "content-type": "application/json" },
    });
  const okStream = () =>
    streamResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"]);

  const TABLE: Array<[string, string]> = [
    ["http://localhost:1234/v1", "http://127.0.0.1:1234/v1/chat/completions"],
    ["http://localhost:1234/v1/", "http://127.0.0.1:1234/v1/chat/completions"],
    ["http://localhost:1234/v1//", "http://127.0.0.1:1234/v1/chat/completions"],
    ["http://localhost:1234", "http://127.0.0.1:1234/v1/chat/completions"],
    // One `/v1` removed, never two.
    ["http://localhost:1234/v1/v1", "http://127.0.0.1:1234/v1/v1/chat/completions"],
    // `//v1`: the `/` before `v1` is preceded by `/`, so the path is kept.
    ["http://localhost:1234//v1", "http://127.0.0.1:1234//v1/v1/chat/completions"],
    // Case-sensitive.
    ["http://localhost:1234/V1", "http://127.0.0.1:1234/V1/v1/chat/completions"],
    ["http://localhost:1234/v1/proxy", "http://127.0.0.1:1234/v1/proxy/v1/chat/completions"],
    ["http://localhost:1234/apiv1", "http://127.0.0.1:1234/apiv1/v1/chat/completions"],
    ["http://localhost:1234/v10", "http://127.0.0.1:1234/v10/v1/chat/completions"],
    ["http://localhost:1234/v1x", "http://127.0.0.1:1234/v1x/v1/chat/completions"],
    // A query or fragment is still dropped (#1295 L5), and then `/v1` too.
    ["http://localhost:1234/v1?x=1#f", "http://127.0.0.1:1234/v1/chat/completions"],
    // IPv6 loopback (`validateEndpoint` accepts `::1`): the brackets are kept.
    ["http://[::1]:1234/v1", "http://[::1]:1234/v1/chat/completions"],
    ["http://[::1]:1234", "http://[::1]:1234/v1/chat/completions"],
  ];

  for (const [saved, expected] of TABLE) {
    it(`${saved} → ${expected} (non-streaming)`, async () => {
      const fetchMock = stubFetch(okJson);
      await chat({ config: { ...V1, endpoint: saved }, messages: [], tools: [] });
      expect(fetchMock.mock.calls[0][0]).toBe(expected);
    });

    it(`${saved} → ${expected} (streaming)`, async () => {
      const fetchMock = stubFetch(okStream);
      await chat({
        config: { ...V1, endpoint: saved },
        messages: [],
        tools: [],
        onContentDelta: () => {},
      });
      expect(fetchMock.mock.calls[0][0]).toBe(expected);
    });
  }

  it("the native transport drops it too (both build from baseUrl)", async () => {
    const fetchMock = stubFetch(
      () =>
        new Response(JSON.stringify({ message: { content: "ok" } }), {
          headers: { "content-type": "application/json" },
        }),
    );
    await chat({
      config: { ...NATIVE, endpoint: "http://localhost:11434/v1" },
      messages: [],
      tools: [],
    });
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:11434/api/chat");
  });

  it("the config passed in is not rewritten", async () => {
    stubFetch(okJson);
    const config = { ...V1, endpoint: "http://localhost:1234/v1" };
    await chat({ config, messages: [], tools: [] });
    expect(config.endpoint).toBe("http://localhost:1234/v1");
  });
});

/** The value `p` rejected with; fails the test if it resolved. */
async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

/** A body that yields `chunks`, one per read, then fails the next read with `err`. */
function erroringBody(chunks: string[], err: unknown): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.error(err);
    },
  });
}

const sseFrame = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

const abortError = () =>
  Object.assign(new Error("The operation was aborted"), { name: "AbortError" });

/**
 * #1123 (ADR-039 P6): why a request failed is a tag on the thrown value, set
 * where the error arose, and the value thrown is the very one that arose.
 */
describe("ollama-client — failure tags", () => {
  it("a rejected fetch rethrows the same error, tagged unreachable", async () => {
    const original = new Error("connection refused");
    stubFetch(() => {
      throw original;
    });
    const err = await rejectionOf(chat({ config: V1, messages: [], tools: [] }));
    expect(err).toBe(original);
    expect(requestFailure(err)).toEqual({ kind: "unreachable" });
  });

  it("a fetch rejected with an AbortError rethrows it untagged", async () => {
    const original = abortError();
    stubFetch(() => {
      throw original;
    });
    const err = await rejectionOf(chat({ config: V1, messages: [], tools: [] }));
    expect(err).toBe(original);
    expect(requestFailure(err)).toBeUndefined();
  });

  for (const [label, value] of [
    ["a string", "boom"],
    ["undefined", undefined],
    ["null", null],
  ] as const) {
    it(`a fetch rejected with ${label} rethrows that value untagged, and the loop ends error with it`, async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw value;
        }),
      );
      const err = await rejectionOf(chat({ config: V1, messages: [], tools: [] }));
      expect(err).toBe(value);
      expect(requestFailure(err)).toBeUndefined();

      const r = await runLoop({
        ydoc: new Y.Doc(),
        config: { ...V1, agentIdentity: { provider: "local-ollama", displayName: "T" } },
        tools: [],
        systemPrompt: "sys",
        userPrompt: "hi",
        canEdit: () => false,
        maxTurns: 1,
      });
      expect(r.metrics.exit).toBe("error");
      expect(r.metrics.errorMessage).toBe(String(value));
      expect(r.metrics.failure).toBeUndefined();
    });
  }

  for (const status of [404, 400, 401, 503]) {
    for (const streaming of [false, true]) {
      it(`HTTP ${status} keeps its message and is tagged with its status (${streaming ? "streaming" : "non-streaming"})`, async () => {
        stubFetch(() => new Response("detail", { status }));
        const err = await rejectionOf(
          chat({
            config: V1,
            messages: [],
            tools: [],
            ...(streaming ? { onContentDelta: () => {} } : {}),
          }),
        );
        expect((err as Error).message).toBe(`local model endpoint returned HTTP ${status}`);
        expect(requestFailure(err)).toEqual({ kind: "http", status });
      });
    }
  }

  it("a non-JSON 200 is tagged unreadable", async () => {
    stubFetch(() => new Response("<html>x</html>", { status: 200 }));
    const err = await rejectionOf(chat({ config: V1, messages: [], tools: [] }));
    expect((err as Error).message).toBe("local model returned a non-JSON response");
    expect(requestFailure(err)).toEqual({ kind: "unreadable" });
  });

  it("a stream with no valid frame is tagged unreadable", async () => {
    stubFetch(() => streamResponse(["<html>x</html>\n"]));
    const err = await rejectionOf(
      chat({ config: V1, messages: [], tools: [], onContentDelta: () => {} }),
    );
    expect((err as Error).message).toBe("local model returned a non-JSON response");
    expect(requestFailure(err)).toEqual({ kind: "unreadable" });
  });

  for (const streaming of [false, true]) {
    it(`a body over the cap is tagged too-large (${streaming ? "streaming" : "non-streaming"})`, async () => {
      stubFetch(() => streamResponse([`:${"x".repeat(10_000)}\n`]));
      const err = await rejectionOf(
        chat({
          config: V1,
          messages: [],
          tools: [],
          maxResponseBytes: 100,
          ...(streaming ? { onContentDelta: () => {} } : {}),
        }),
      );
      expect((err as Error).message).toBe("local model response exceeded 100-byte cap");
      expect(requestFailure(err)).toEqual({ kind: "too-large" });
    });
  }

  it("a stream that fails after one frame rethrows the same error, tagged unreachable", async () => {
    const original = new Error("socket hang up");
    stubFetch(() => new Response(erroringBody([sseFrame("first")], original)));
    const deltas: string[] = [];
    const err = await rejectionOf(
      chat({ config: V1, messages: [], tools: [], onContentDelta: (d) => deltas.push(d) }),
    );
    expect(deltas).toEqual(["first"]);
    expect(err).toBe(original);
    expect(requestFailure(err)).toEqual({ kind: "unreachable" });
  });

  it("a mid-stream read rejected with a TypeError (undici's 'terminated') is tagged unreachable", async () => {
    const original = new TypeError("terminated");
    stubFetch(() => new Response(erroringBody([sseFrame("first")], original)));
    const err = await rejectionOf(
      chat({ config: V1, messages: [], tools: [], onContentDelta: () => {} }),
    );
    expect(err).toBe(original);
    expect(requestFailure(err)).toEqual({ kind: "unreachable" });
  });

  it("a non-streaming body that fails after one chunk rethrows the same error, tagged unreachable", async () => {
    const original = new Error("socket hang up");
    stubFetch(() => new Response(erroringBody(['{"choices":'], original)));
    const err = await rejectionOf(chat({ config: V1, messages: [], tools: [] }));
    expect(err).toBe(original);
    expect(requestFailure(err)).toEqual({ kind: "unreachable" });
  });

  for (const streaming of [false, true]) {
    it(`a body read rejected with an AbortError rethrows it untagged (${streaming ? "streaming" : "non-streaming"})`, async () => {
      const original = abortError();
      stubFetch(() => new Response(erroringBody([sseFrame("first")], original)));
      const err = await rejectionOf(
        chat({
          config: V1,
          messages: [],
          tools: [],
          ...(streaming ? { onContentDelta: () => {} } : {}),
        }),
      );
      expect(err).toBe(original);
      expect(requestFailure(err)).toBeUndefined();
    });
  }

  it("a throw from onContentDelta is rethrown untagged", async () => {
    const original = new TypeError("sink bug");
    stubFetch(() => streamResponse([sseFrame("first"), "data: [DONE]\n\n"]));
    const err = await rejectionOf(
      chat({
        config: V1,
        messages: [],
        tools: [],
        onContentDelta: () => {
          throw original;
        },
      }),
    );
    expect(err).toBe(original);
    expect(requestFailure(err)).toBeUndefined();
  });

  it("an invalid endpoint keeps its message and is untagged", async () => {
    stubFetch(() => new Response("{}"));
    const err = await rejectionOf(
      chat({
        config: { endpoint: "http://192.168.1.9:11434", modelId: "m", transport: "v1" },
        messages: [],
        tools: [],
      }),
    );
    expect((err as Error).message).toMatch(/^invalid local-model endpoint \(/);
    expect(requestFailure(err)).toBeUndefined();
  });
});
