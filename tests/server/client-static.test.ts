import fs from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FRAME_ANCESTORS_CSP, mountClient } from "../../src/server/mcp/client-static.js";
import { startMcpServerHttp } from "../../src/server/mcp/server.js";
import { allocPort } from "../helpers/alloc-port.js";

/**
 * Tandem's page cannot be loaded inside another page (#2404, R2).
 *
 * Every response that serves the client's document carries
 * `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`
 * as response headers. The E2E suite is no evidence for this: Playwright loads
 * the client from Vite, and under tsx or vitest the bundle's sibling `client/`
 * directory does not exist, so the static block is not mounted at all. These
 * cases mount it over a directory of their own — on a bare app, and on the real
 * server through its injectable `clientDir`.
 */

const INDEX_HTML = "<!doctype html><title>Tandem</title><div id=app></div>\n";
const ASSET_JS = "console.log('tandem');\n";

function makeClientDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-client-static-"));
  fs.writeFileSync(path.join(dir, "index.html"), INDEX_HTML, "utf8");
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "assets", "app.js"), ASSET_JS, "utf8");
  return dir;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * A conditional GET through `node:http`. Not `fetch`: given an `If-None-Match`
 * the Fetch spec adds `Cache-Control: no-cache`, which makes the server answer
 * 200 — a browser's own revalidation carries no such header.
 */
function conditionalGet(
  url: string,
  etag: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "GET", headers: { "If-None-Match": etag } }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

function expectFramingRefusedRaw(headers: Record<string, string | string[] | undefined>): void {
  expect(headers["content-security-policy"]).toBe("frame-ancestors 'none'");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["access-control-allow-origin"]).toBeUndefined();
}

function expectFramingRefused(res: Response): void {
  expect(res.headers.get("content-security-policy")).toBe(FRAME_ANCESTORS_CSP);
  expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  // Critical Rule 8: the document is never made cross-origin readable.
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
}

function expectNoFramingHeaders(res: Response): void {
  expect(res.headers.get("x-frame-options")).toBeNull();
  expect(res.headers.get("content-security-policy") ?? "").not.toContain("frame-ancestors");
}

describe("mountClient: the framing headers on everything the client mount serves (#2404)", () => {
  let dir: string;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    dir = makeClientDir();
    const app = express();
    mountClient(app, dir);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const addr = server.address();
    if (typeof addr !== "object" || addr === null) throw new Error("no address");
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ["the root", "/"],
    ["index.html by name", "/index.html"],
    ["a client-side route (the SPA fallback)", "/some/client/route"],
    ["a deep client-side route with a query", "/a/b/c?x=1"],
  ])("GET %s serves the document with both headers", async (_label, p) => {
    const res = await fetch(`${base}${p}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
    expectFramingRefused(res);
  });

  it("an asset carries them too", async () => {
    const res = await fetch(`${base}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ASSET_JS);
    expectFramingRefused(res);
  });

  it.each(["/", "/index.html", "/some/client/route"])("HEAD %s carries both headers", async (p) => {
    const res = await fetch(`${base}${p}`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expectFramingRefused(res);
  });

  it.each([
    ["the static index", "/"],
    ["the SPA fallback", "/some/client/route"],
  ])("a conditional GET of %s answered 304 carries both headers", async (_label, p) => {
    const first = await fetch(`${base}${p}`);
    const etag = first.headers.get("etag");
    expect(etag).toEqual(expect.any(String));
    await first.text();
    const second = await conditionalGet(`${base}${p}`, etag as string);
    expect(second.status).toBe(304);
    expectFramingRefusedRaw(second.headers);
  });

  it.each(["http://127.0.0.1:8080", "https://evil.example", "null"])(
    "an Origin request header (%s) earns no Access-Control-Allow-Origin",
    async (origin) => {
      for (const p of ["/", "/some/client/route", "/assets/app.js"]) {
        const res = await fetch(`${base}${p}`, { headers: { Origin: origin } });
        await res.text();
        expectFramingRefused(res);
      }
    },
  );
});

describe("the real server: the served document refuses framing; /api, /mcp and /health are unaffected (#2404)", () => {
  let dir: string;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    dir = makeClientDir();
    const port = await allocPort();
    server = await startMcpServerHttp(
      port,
      "127.0.0.1",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      dir,
    );
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(["/", "/index.html", "/a/client/route"])(
    "GET %s is the document, with both headers",
    async (p) => {
      const res = await fetch(`${base}${p}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(INDEX_HTML);
      expectFramingRefused(res);
    },
  );

  it("HEAD / and a 304 carry them", async () => {
    const head = await fetch(`${base}/`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expectFramingRefused(head);
    const first = await fetch(`${base}/`);
    await first.text();
    const etag = first.headers.get("etag") as string;
    const again = await conditionalGet(`${base}/`, etag);
    expect(again.status).toBe(304);
    expectFramingRefusedRaw(again.headers);
  });

  it("an unknown GET under /api falls to the SPA fallback, and so carries them", async () => {
    const res = await fetch(`${base}/api/no-such-route`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
    expectFramingRefused(res);
  });

  it("GET /api/info does not carry them", async () => {
    const res = await fetch(`${base}/api/info`);
    expect(res.status).toBe(200);
    await res.text();
    expectNoFramingHeaders(res);
  });

  it("GET /health does not carry them", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    await res.text();
    expectNoFramingHeaders(res);
  });

  it("a POST /mcp response does not carry them", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "client-static-test", version: "0" },
        },
      }),
    });
    await res.text();
    // Answered by the MCP handler, not by the client mount.
    expect(res.status).toBe(200);
    expectNoFramingHeaders(res);
  });

  it("an /api route keeps its own CORS answer for an allowlisted origin", async () => {
    const origin = base;
    const res = await fetch(`${base}/api/info`, { headers: { Origin: origin } });
    await res.text();
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expectNoFramingHeaders(res);
  });
});
