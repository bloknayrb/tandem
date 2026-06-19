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

  it("surfaces an HTTP error by status (raw body not in the thrown message)", async () => {
    stubFetch(() => new Response("internal detail leak", { status: 500 }));
    await expect(chat({ config: V1, messages: [], tools: [] })).rejects.toThrow(/HTTP 500/);
    await expect(chat({ config: V1, messages: [], tools: [] })).rejects.not.toThrow(
      /internal detail leak/,
    );
  });
});
