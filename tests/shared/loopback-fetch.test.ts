import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isLoopbackTarget, loopbackFetch } from "../../src/shared/loopback-fetch.js";

// Every test file runs with `loopbackFetch` delegating to the global `fetch`
// (tests/setup/loopback-fetch-passthrough.ts). This one tests the real routing.
vi.unmock(import("../../src/shared/loopback-fetch.js"));

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

async function listen(handler: Parameters<typeof createServer>[1], host = "127.0.0.1") {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => r());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("address");
  return addr.port;
}

describe("uses the real module in this file", () => {
  it("is not the passthrough mock", async () => {
    const actual = await vi.importActual<typeof import("../../src/shared/loopback-fetch.js")>(
      "../../src/shared/loopback-fetch.js",
    );
    expect(loopbackFetch).toBe(actual.loopbackFetch);
  });
});

describe("isLoopbackTarget: the two literals Tandem writes", () => {
  it.each([
    ["http://127.0.0.1:3479/mcp", true],
    ["http://[::1]:3479/mcp", true],
    ["http://127.0.0.1/health", true],
    ["http://localhost:3479/mcp", false],
    ["http://127.0.0.2:3479/mcp", false],
    ["http://192.168.1.5:3479/mcp", false],
    ["https://example.com/", false],
    ["http://127.0.0.1.example.com/", false],
    ["http://user@example.com:80@127.0.0.1/", true],
    ["not a url", false],
  ])("%s → %s", (url, expected) => {
    expect(isLoopbackTarget(url)).toBe(expected);
  });

  it("reads a URL object and a Request", () => {
    expect(isLoopbackTarget(new URL("http://[::1]:1/"))).toBe(true);
    expect(isLoopbackTarget(new Request("http://127.0.0.1:1/"))).toBe(true);
    expect(isLoopbackTarget(new Request("http://example.com/"))).toBe(false);
  });
});

describe("loopbackFetch", () => {
  it("does not touch the global fetch for a loopback URL, and the request arrives intact", async () => {
    const seen: { auth?: string; custom?: string; method?: string; body: string }[] = [];
    const port = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({
          auth: req.headers.authorization,
          custom: req.headers["x-custom"] as string | undefined,
          method: req.method,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      });
    });
    const globalSpy = vi.fn(async () => new Response("global"));
    vi.stubGlobal("fetch", globalSpy);

    const res = await loopbackFetch(`http://127.0.0.1:${port}/x`, {
      method: "POST",
      headers: new Headers({ Authorization: "Bearer t", "X-Custom": "1" }),
      body: "payload",
      signal: AbortSignal.any([new AbortController().signal, AbortSignal.timeout(5_000)]),
    });
    expect(await res.text()).toBe("ok");
    expect(globalSpy).not.toHaveBeenCalled();
    expect(seen).toEqual([{ auth: "Bearer t", custom: "1", method: "POST", body: "payload" }]);
  });

  it("uses the global fetch, with the same arguments, for any other host", async () => {
    const globalSpy = vi.fn(async () => new Response("global"));
    vi.stubGlobal("fetch", globalSpy);
    const init = { method: "GET", headers: { a: "b" } };
    for (const url of [
      "http://localhost:3479/mcp",
      "http://192.168.1.5:3479/mcp",
      "https://example.com/",
    ]) {
      globalSpy.mockClear();
      const res = await loopbackFetch(url, init);
      expect(await res.text()).toBe("global");
      expect(globalSpy).toHaveBeenCalledTimes(1);
      expect(globalSpy).toHaveBeenCalledWith(url, init);
    }
  });

  it("passes redirect: 'manual' through: a 302 is returned, not followed", async () => {
    let hits = 0;
    const port = await listen((req, res) => {
      hits += 1;
      if (req.url === "/start") res.writeHead(302, { location: "/elsewhere" }).end();
      else res.writeHead(200).end("followed");
    });
    const res = await loopbackFetch(`http://127.0.0.1:${port}/start`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/elsewhere");
    expect(hits).toBe(1);
  });

  it("streams: a chunk written after the response began arrives before the response ends", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("first\n\n");
      setTimeout(() => res.write("second\n\n"), 150);
      setTimeout(() => res.end(), 600);
    });
    const res = await loopbackFetch(`http://127.0.0.1:${port}/events`);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const decoder = new TextDecoder();
    const t0 = Date.now();
    const got: { text: string; at: number }[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got.push({ text: decoder.decode(value), at: Date.now() - t0 });
    }
    const joined = got.map((g) => g.text).join("");
    expect(joined).toBe("first\n\nsecond\n\n");
    const second = got.find((g) => g.text.includes("second"));
    // It arrived while the stream was still open, not with the final flush.
    expect(second?.at).toBeLessThan(450);
  });

  it("honours an abort signal", async () => {
    const port = await listen(() => {
      /* never answers */
    });
    const ctrl = new AbortController();
    const p = loopbackFetch(`http://127.0.0.1:${port}/hang`, { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 50);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reaches a [::1] server; skipped where the host has no IPv6", async (ctx) => {
    let port: number;
    try {
      port = await listen((_req, res) => res.end("v6"), "::1");
    } catch {
      ctx.skip();
      return;
    }
    const res = await loopbackFetch(`http://[::1]:${port}/`);
    expect(await res.text()).toBe("v6");
  });
});
