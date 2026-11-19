import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { classifyFailure, RUN_FAILURE_TEXT } from "../../../src/server/local-model/collaborator.js";
import { runLoop } from "../../../src/server/local-model/loop.js";
import { chat } from "../../../src/server/local-model/ollama-client.js";

/**
 * #1123 / #2422 R1.5: the local-model client's behaviour on the REAL
 * `loopbackFetch`, i.e. undici's own `fetch` with a private `Agent`.
 *
 * Every other suite runs with `loopbackFetch` delegating to the global `fetch`
 * (tests/setup/loopback-fetch-passthrough.ts), so `ollama-client.test.ts`
 * proves the client's logic against the global implementation only. This file
 * unmocks it, and replaces the global `fetch` with a spy that throws: a case
 * that passes here passed on undici, not on the global `fetch`.
 *
 * What it pins: a 3xx is refused, not followed (`redirect: "error"`); a timeout
 * mid-stream rejects with `name === "AbortError"`, so `runLoop` still reports
 * `timeout`; a caller abort still ends `aborted` and settles promptly; a body
 * over the cap is stopped with the "exceeded … cap" message; a non-JSON 200
 * still gives "local model returned a non-JSON response". And, end to end
 * through `runLoop` and `classifyFailure`, which message the user is shown for
 * each way a request fails here (ADR-039 P6): the client's failure tag survives
 * undici's own errors (a refused 3xx, a socket destroyed before the answer or
 * mid-stream), so the message is chosen from where the error arose.
 */
vi.unmock(import("../../../src/shared/loopback-fetch.js"));

const CAP = 4 * 1024 * 1024; // the collaborator's streamed-response cap
const servers: Server[] = [];
let globalFetchSpy: ReturnType<typeof vi.fn>;

afterEach(async () => {
  expect(globalFetchSpy, "a loopback request reached the global fetch").not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

function stubGlobalFetch() {
  globalFetchSpy = vi.fn(async () => {
    throw new Error("the global fetch must not be used for a loopback request");
  });
  vi.stubGlobal("fetch", globalFetchSpy);
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  stubGlobalFetch();
  const server = createServer((req, res) => {
    // Drain the request body before answering.
    req.resume();
    req.on("end", () => handler(req, res));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("address");
  return { base: `http://127.0.0.1:${addr.port}`, port: addr.port };
}

const config = (endpoint: string) => ({
  endpoint,
  modelId: "m",
  transport: "v1" as const,
  agentIdentity: { provider: "local-ollama" as const, displayName: "Test Model" },
});

const sse = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

function loop(endpoint: string, extra: Partial<Parameters<typeof runLoop>[0]> = {}) {
  return runLoop({
    ydoc: new Y.Doc(),
    config: config(endpoint),
    tools: [],
    systemPrompt: "sys",
    userPrompt: "hi",
    canEdit: () => false,
    maxTurns: 1,
    ...extra,
  });
}

describe("uses the real loopbackFetch in this file", () => {
  it("a chat succeeds with the global fetch replaced by a throwing spy", async () => {
    const { base } = await listen((_req, res) => {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ choices: [{ message: { content: "real-undici" } }] }));
    });
    const r = await chat({ config: config(base), messages: [], tools: [] });
    expect(r.content).toBe("real-undici");
  });
});

describe("the local-model client on undici (#1123, #2422)", () => {
  it("a 3xx is refused, never followed (redirect: 'error')", async () => {
    const target = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    let targetHits = 0;
    servers[0]?.on("request", () => {
      targetHits += 1;
    });
    let redirectorHits = 0;
    const { base } = await listen((_req, res) => {
      redirectorHits += 1;
      res.writeHead(302, { location: `${target.base}/v1/chat/completions` }).end();
    });
    const err = await chat({ config: config(base), messages: [], tools: [] }).catch(
      (e: unknown) => e,
    );
    // The request reached the redirecting server, and undici refused the 3xx
    // itself (its `redirect: "error"` rejection), rather than failing earlier.
    expect(redirectorHits).toBe(1);
    expect(err).toBeInstanceOf(TypeError);
    expect((err as TypeError).message).toBe("fetch failed");
    expect(String((err as { cause?: { message?: unknown } }).cause?.message)).toMatch(/redirect/i);
    expect(targetHits).toBe(0);
  });

  it("a timeout mid-stream rejects with an AbortError, so runLoop reports timeout", async () => {
    const { base } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("first"));
      // then stall: no more frames, no end. The 2 s budget covers connect,
      // headers and this first frame even on a loaded machine.
    });
    const deltas: string[] = [];
    // A caller signal that never fires, so `AbortSignal.any` is on the path.
    const caller = new AbortController();
    const err = await chat({
      config: config(base),
      messages: [],
      tools: [],
      timeoutMs: 2_000,
      signal: caller.signal,
      onContentDelta: (d) => deltas.push(d),
    }).catch((e: unknown) => e);
    expect(deltas).toEqual(["first"]);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("AbortError");

    const r = await loop(base, {
      timeoutMs: 2_000,
      signal: new AbortController().signal,
      onContentDelta: () => {},
    });
    expect(r.metrics.exit).toBe("timeout");
  });

  it("a timeout before the headers rejects with an AbortError too", async () => {
    const { base } = await listen(() => {
      // never answer
    });
    const err = await chat({ config: config(base), messages: [], tools: [], timeoutMs: 300 }).catch(
      (e: unknown) => e,
    );
    expect((err as Error).name).toBe("AbortError");
  });

  it("a caller abort mid-stream ends aborted, promptly, with no timeout to fall back on", async () => {
    const { base } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("first"));
    });
    const ctrl = new AbortController();
    const started = Date.now();
    const r = await loop(base, {
      timeoutMs: 600_000,
      signal: ctrl.signal,
      onContentDelta: () => ctrl.abort(),
    });
    expect(r.metrics.exit).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it.each([
    ["non-streaming", false],
    ["streaming", true],
  ])(
    "a %s body over the 4 MiB cap is stopped and gives the too-large message",
    async (_label, streaming) => {
      const { base } = await listen((_req, res) => {
        res.writeHead(200, {
          "content-type": streaming ? "text/event-stream" : "application/json",
        });
        // `:` lines are SSE comments, so the streamed read keeps reading them.
        const chunk = `:${"x".repeat(64 * 1024 - 2)}\n`;
        for (let i = 0; i < CAP / chunk.length + 4; i++) res.write(chunk);
        res.end();
      });
      const r = await loop(base, {
        maxResponseBytes: CAP,
        ...(streaming ? { onContentDelta: () => {} } : {}),
      });
      expect(r.metrics.exit).toBe("error");
      expect(r.metrics.errorMessage).toBe(`local model response exceeded ${CAP}-byte cap`);
      expect(classifyFailure(r.metrics)).toBe(RUN_FAILURE_TEXT["too-large"]);
    },
  );

  it("a non-JSON 200 gives the non-JSON message", async () => {
    const { base } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" }).end("<html>proxy page</html>");
    });
    const r = await loop(base);
    expect(r.metrics.errorMessage).toBe("local model returned a non-JSON response");
    expect(classifyFailure(r.metrics)).toBe(RUN_FAILURE_TEXT.unreadable);
  });

  it.each([
    [401, "refused-access"],
    [404, "not-found"],
    [400, "bad-request"],
    [503, "server-error"],
  ] as const)("a server answering HTTP %i gives the %s message", async (status, cause) => {
    const { base } = await listen((_req, res) => {
      res.writeHead(status, { "content-type": "text/plain" }).end("server detail");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await loop(base);
    errorSpy.mockRestore();
    expect(r.metrics.exit).toBe("error");
    expect(classifyFailure(r.metrics)).toBe(RUN_FAILURE_TEXT[cause]);
  });

  it("a server that destroys the socket before answering gives the unreachable message", async () => {
    const { base } = await listen((req) => {
      req.socket.destroy();
    });
    const r = await loop(base);
    expect(r.metrics.exit).toBe("error");
    expect(classifyFailure(r.metrics)).toBe(RUN_FAILURE_TEXT.unreachable);
  });

  it("a refused 3xx, through runLoop, gives the unreachable message", async () => {
    const { base } = await listen((_req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1:1/v1/chat/completions" }).end();
    });
    const r = await loop(base);
    expect(r.metrics.exit).toBe("error");
    expect(classifyFailure(r.metrics)).toBe(RUN_FAILURE_TEXT.unreachable);
  });

  it("a stream destroyed after the client saw its first frame gives the unreachable message", async () => {
    let answer: ServerResponse | undefined;
    const { base } = await listen((_req, res) => {
      answer = res;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("first"));
    });
    const deltas: string[] = [];
    const r = await loop(base, {
      timeoutMs: 30_000,
      onContentDelta: (d) => {
        deltas.push(d);
        // Destroyed only once the client has the frame, so the failure is a
        // read that fails mid-stream, not a request that never completed.
        answer?.destroy();
      },
    });
    expect(deltas).toEqual(["first"]);
    expect(r.metrics.exit).toBe("error");
    expect(classifyFailure(r.metrics)).toBe(RUN_FAILURE_TEXT.unreachable);
  });
});
