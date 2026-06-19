import { afterEach, describe, expect, it, vi } from "vitest";
import { chat } from "../../../src/server/local-model/ollama-client.js";

const V1 = { endpoint: "http://127.0.0.1:11434", modelId: "m", transport: "v1" } as const;
const NATIVE = { endpoint: "http://127.0.0.1:11434", modelId: "m", transport: "native" } as const;

function stubFetch(impl: (url: string, init: RequestInit) => Response): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string, init: RequestInit) => impl(url, init));
  vi.stubGlobal("fetch", fn);
  return fn;
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
