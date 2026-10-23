/**
 * `/api` body limits and their ordering against the gates (#1981).
 *
 * The bug: `createMcpExpressApp`'s root `express.json()` (100 kB) sits in the
 * SDK sub-app, mounted at the ROOT above every `/api` registrar, and
 * body-parser skips a stream already consumed — so every `/api` body was read
 * at 100 kB and every route-level parser (`largeBody` 70 MB, the scratchpad's
 * 1 MiB, the licence pre-check) was dead. The fix is the pre-parse router in
 * `src/server/mcp/api-body-preparse.ts`.
 *
 * **Every request that sets a non-default `Host` (or a source address) goes
 * through raw `http.request`, never `fetch`.** `fetch` silently drops a
 * caller-set `Host` header, so a Host-negative case written with it would pass
 * for the wrong reason (it would arrive with the real `127.0.0.1:PORT`).
 *
 * Which specs discriminate this change: A (bodies over 100 kB now succeed),
 * the chunked licence case in B, and the `localhost` case in C (the per-route
 * Host check now answers BEFORE the body is read). D passed before the fix
 * too — auth and loopback already preceded the SDK parser — and guards against
 * a future reordering, not against this bug. E, F and G pin the shape.
 */

import { readFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resetForTesting as resetAnnotationStoreForTesting } from "../../src/server/annotations/store.js";
import { unwatchAll } from "../../src/server/file-watcher.js";
import * as integrationsRoutes from "../../src/server/integrations/api-routes.js";
import {
  createApiBodyPreParser,
  licenseBodyParser,
  ROUTE_OWNED_BODY_PARSERS,
  reloadBodyParser,
  sdkHostValidationFor,
  smallBodyParser,
} from "../../src/server/mcp/api-body-preparse.js";
import { rejectOversizeLicenseBody, scratchpadJsonBody } from "../../src/server/mcp/api-routes.js";
import { startMcpServerHttp } from "../../src/server/mcp/server.js";
import * as modelsRoutes from "../../src/server/models/api-routes.js";
import * as apiPaths from "../../src/shared/api-paths.js";
import { TAURI_HOSTNAME } from "../../src/shared/constants.js";
import * as integrationsContract from "../../src/shared/integrations/contract.js";
import { ERROR_CODE_BAD_ORIGIN } from "../../src/shared/integrations/contract.js";
import * as modelsContract from "../../src/shared/models/contract.js";
import { allocPort } from "../helpers/alloc-port.js";
import { mutatingRegistrations } from "../helpers/api-route-source.js";

type RawResponse = { status: number; headers: IncomingHttpHeaders; body: string };

type RawOpts = {
  method?: string;
  host: string;
  headers?: Record<string, string>;
  /** Full body, sent with an accurate Content-Length. */
  body?: string;
  /** Sent chunked (no Content-Length), in pieces of this many characters. */
  chunked?: { body: string; size: number };
  /**
   * Declare this Content-Length, write ONE byte, and never send the rest. The
   * promise resolves only if the server answers while the body is incomplete.
   */
  declaredButStalled?: number;
  localAddress?: string;
};

const STALL_ANSWER_MS = 2_000;

function raw(port: number, path: string, opts: RawOpts): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {
      Host: opts.host,
      "Content-Type": "application/json",
      ...opts.headers,
    };
    if (opts.body !== undefined) headers["Content-Length"] = Buffer.byteLength(opts.body);
    if (opts.declaredButStalled !== undefined) headers["Content-Length"] = opts.declaredButStalled;
    let timer: NodeJS.Timeout | undefined;
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: opts.method ?? "POST",
        headers,
        ...(opts.localAddress ? { localAddress: opts.localAddress } : {}),
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          data += c;
        });
        res.on("end", () => {
          if (timer) clearTimeout(timer);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data });
          if (opts.declaredButStalled !== undefined) req.destroy();
        });
      },
    );
    req.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    if (opts.declaredButStalled !== undefined) {
      timer = setTimeout(() => {
        req.destroy();
        reject(new Error(`no answer within ${STALL_ANSWER_MS} ms while the body was incomplete`));
      }, STALL_ANSWER_MS);
      req.write("{");
      return;
    }
    if (opts.chunked) {
      const { body, size } = opts.chunked;
      for (let i = 0; i < body.length; i += size) req.write(body.slice(i, i + size));
      req.end();
      return;
    }
    req.end(opts.body);
  });
}

function expectNoLeak(text: string): void {
  expect(text).not.toContain("node_modules");
  expect(text).not.toContain("<html");
  expect(text).not.toMatch(/\bat \S+:\d+:\d+/);
}

// ── A–C: one real server, loopback bind, no token ─────────────────────────────

describe("#1981 — /api bodies are parsed at their route's limit, after the gates", () => {
  let port: number;
  let server: Server;
  let HOST: string;
  let ORIGIN: string;
  const opened: string[] = [];

  beforeAll(async () => {
    port = await allocPort();
    server = await startMcpServerHttp(port, "127.0.0.1");
    HOST = `127.0.0.1:${port}`;
    ORIGIN = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    for (const documentId of opened) {
      await raw(port, apiPaths.API_CLOSE, { host: HOST, body: JSON.stringify({ documentId }) });
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    unwatchAll();
    resetAnnotationStoreForTesting();
  });

  describe("A — bodies over 100 kB reach their handler (the regression)", () => {
    let uploadedId: string | undefined;

    it("a 300 kB POST /api/upload answers 200 with a documentId", async () => {
      const body = JSON.stringify({ fileName: "big.md", content: `# T\n\n${"a".repeat(300_000)}` });
      expect(body.length).toBeGreaterThan(300_000);
      const res = await raw(port, apiPaths.API_UPLOAD, {
        host: HOST,
        headers: { Origin: ORIGIN },
        body,
      });
      expect(res.status, res.body.slice(0, 200)).toBe(200);
      const parsed = JSON.parse(res.body) as { data: { documentId: string } };
      expect(parsed.data.documentId).toEqual(expect.any(String));
      uploadedId = parsed.data.documentId;
      opened.push(uploadedId);
      // The CORS middleware now runs twice on a listed route (pre-parse router,
      // then the registration). `res.header` replaces, so each header is single.
      expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
      expect(res.headers.vary).toBe("Origin");
    });

    it("a ~300 kB POST /api/document/reload is not refused for size", async () => {
      expect(uploadedId).toBeDefined();
      const res = await raw(port, apiPaths.API_DOCUMENT_RELOAD, {
        host: HOST,
        headers: { Origin: ORIGIN },
        body: JSON.stringify({ documentId: uploadedId, markdown: `# R\n\n${"b".repeat(300_000)}` }),
      });
      expect(res.status, res.body.slice(0, 200)).not.toBe(413);
      expectNoLeak(res.body);
    });

    it("a ~500 kB POST /api/scratchpad answers 200 (its own 1 MiB parser now runs)", async () => {
      const res = await raw(port, apiPaths.API_SCRATCHPAD, {
        host: HOST,
        headers: { Origin: ORIGIN },
        body: JSON.stringify({ content: `# S\n\n${"c".repeat(500_000)}` }),
      });
      expect(res.status, res.body.slice(0, 200)).toBe(200);
      opened.push((JSON.parse(res.body) as { data: { documentId: string } }).data.documentId);
    });

    it("a POST /api/scratchpad over 1 MiB gets the scratchpad's own 413", async () => {
      const res = await raw(port, apiPaths.API_SCRATCHPAD, {
        host: HOST,
        headers: { Origin: ORIGIN },
        body: JSON.stringify({ content: "d".repeat(1024 * 1024 + 10) }),
      });
      expect(res.status).toBe(413);
      expect(JSON.parse(res.body)).toEqual({
        error: "PAYLOAD_TOO_LARGE",
        message: "Scratchpad content must be no larger than 1 MiB.",
      });
    });
  });

  describe("B — ceilings that must not move", () => {
    const OVER_100K = JSON.stringify({ documentId: "x", pad: "e".repeat(200_000) });

    it("a 200 kB POST /api/close (a 'small' row) is 413 JSON", async () => {
      const res = await raw(port, apiPaths.API_CLOSE, { host: HOST, body: OVER_100K });
      expect(res.status).toBe(413);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(JSON.parse(res.body)).toMatchObject({ error: "PAYLOAD_TOO_LARGE" });
      expectNoLeak(res.body);
    });

    it("a 200 kB POST to a route with no row (walkthrough-confirm) is 413 JSON", async () => {
      const res = await raw(port, integrationsContract.API_INTEGRATIONS_WALKTHROUGH_CONFIRM, {
        host: HOST,
        body: OVER_100K,
      });
      expect(res.status).toBe(413);
      expect(JSON.parse(res.body)).toMatchObject({ error: "PAYLOAD_TOO_LARGE" });
    });

    it("a chunked ~80 kB POST /api/license/activate (no Content-Length) is 413 at 64 KB", async () => {
      const res = await raw(port, apiPaths.API_LICENSE_ACTIVATE, {
        host: HOST,
        chunked: { body: JSON.stringify({ license: "f".repeat(80_000) }), size: 8_192 },
      });
      expect(res.status).toBe(413);
      expect(JSON.parse(res.body)).toMatchObject({ error: "PAYLOAD_TOO_LARGE" });
      expectNoLeak(res.body);
    });
  });

  describe("C — the Host gates answer before any body is read", () => {
    // The body names which check answered; the stall (80 MB declared, one byte
    // sent) is supporting evidence: body-parser holds an error until the stream
    // ends, so an answer while the body is incomplete came from a gate.
    const STALL = 80_000_000;

    it("Host: evil.com on /api/upload → the SDK Host check's 403", async () => {
      const res = await raw(port, apiPaths.API_UPLOAD, {
        host: "evil.com",
        declaredButStalled: STALL,
      });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({
        error: { message: "Invalid Host: evil.com" },
      });
    });

    it("Host: localhost:PORT on /api/upload → lanAwareApiMiddleware's 403, before the parse", async () => {
      const res = await raw(port, apiPaths.API_UPLOAD, {
        host: `localhost:${port}`,
        declaredButStalled: STALL,
      });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ error: "FORBIDDEN" });
    });

    for (const path of ["/api/models/secrets/%zz", "/api/integrations/secrets/%zz"]) {
      it(`${path} with Host: evil.com → the SDK 403, never a param-decode 400`, async () => {
        const res = await raw(port, path, { host: "evil.com", body: "{}" });
        expect(res.status).toBe(403);
        expect(res.body).toContain("Invalid Host: evil.com");
      });

      it(`${path} with an allowed Host → 400 JSON, leaking nothing (as before #1981)`, async () => {
        const res = await raw(port, path, { host: HOST, body: "{}" });
        expect(res.status).toBe(400);
        expect(res.headers["content-type"]).toMatch(/application\/json/);
        expectNoLeak(res.body);
      });
    }

    it("malformed JSON to /api/upload → 400 BAD_REQUEST JSON, no stack, no path", async () => {
      const res = await raw(port, apiPaths.API_UPLOAD, { host: HOST, body: '{"broken":' });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ error: "BAD_REQUEST" });
      expectNoLeak(res.body);
    });
  });
});

// ── D: auth and loopback still answer first (Linux: needs 127.0.0.2) ─────────

describe.skipIf(process.platform !== "linux")(
  "#1981 D — auth and enforceLoopbackMutation answer before the pre-parse router (Linux only — needs a bindable 127.0.0.2 source address)",
  () => {
    // Not the regression proof: this held before #1981 too. It pins that the
    // pre-parse router stays mounted below both, so a non-loopback peer never
    // gets a 70 MB body read on its behalf.
    const TOKEN = "test-token-1981-body-order";
    let port: number;
    let server: Server;

    beforeAll(async () => {
      port = await allocPort();
      server = await startMcpServerHttp(port, "127.0.0.1", TOKEN, "192.168.1.50");
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("no Authorization → 401 while the 80 MB body is still incomplete", async () => {
      const res = await raw(port, apiPaths.API_UPLOAD, {
        host: `127.0.0.1:${port}`,
        declaredButStalled: 80_000_000,
        localAddress: "127.0.0.2",
      });
      expect(res.status).toBe(401);
    });

    it("valid bearer → enforceLoopbackMutation's 403 BAD_ORIGIN while the body is incomplete", async () => {
      const res = await raw(port, apiPaths.API_UPLOAD, {
        host: `127.0.0.1:${port}`,
        headers: { Authorization: `Bearer ${TOKEN}` },
        declaredButStalled: 80_000_000,
        localAddress: "127.0.0.2",
      });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ code: ERROR_CODE_BAD_ORIGIN });
    });
  },
);

// ── E: the copied Host check answers exactly as the SDK's ────────────────────

describe("#1981 E — sdkHostValidationFor matches createMcpExpressApp's Host check", () => {
  type Config = { host: string; allowedHosts?: string[] };
  const CONFIGS: Config[] = [
    { host: "127.0.0.1" },
    { host: "localhost" },
    { host: "::1" },
    {
      host: "0.0.0.0",
      allowedHosts: ["127.0.0.1", "localhost", "[::1]", "192.168.1.50", TAURI_HOSTNAME],
    },
    { host: "0.0.0.0" },
    { host: "::" },
    // Unreachable in production while LAN_BIND_ENABLED is false; parity only.
    { host: "192.168.1.5" },
  ];
  const HOSTS = [
    "127.0.0.1:1",
    "localhost:1",
    "[::1]:1",
    "evil.com",
    TAURI_HOSTNAME,
    "192.168.1.50:1",
    "not a host[",
  ];

  async function listen(app: ReturnType<typeof express>): Promise<{ port: number; srv: Server }> {
    const srv = createHttpServer(app as unknown as Parameters<typeof createHttpServer>[0]);
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
    return { port: (srv.address() as { port: number }).port, srv };
  }

  /** `POST /x HTTP/1.0` with no Host line at all — `http.request` always adds one. */
  function noHostRequest(port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const sock = connect(port, "127.0.0.1", () => {
        sock.write("POST /x HTTP/1.0\r\nContent-Length: 0\r\n\r\n");
      });
      let data = "";
      sock.setEncoding("utf8");
      sock.on("data", (c: string) => {
        data += c;
      });
      sock.on("end", () => resolve(data));
      sock.on("error", reject);
    });
  }

  /** Status line + body, without headers that legitimately vary (Date, ETag). */
  function statusAndBody(rawResponse: string): string {
    const [head, ...rest] = rawResponse.split("\r\n\r\n");
    return `${head.split("\r\n")[0]}\n${rest.join("\r\n\r\n")}`;
  }

  for (const cfg of CONFIGS) {
    it(`host=${cfg.host}${cfg.allowedHosts ? " + allowedHosts" : ""}`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const sdk = createMcpExpressApp(cfg) as unknown as ReturnType<typeof express>;
        sdk.post("/x", (_req: unknown, res: { status(n: number): { json(b: unknown): void } }) =>
          res.status(200).json({ ok: true }),
        );
        const copy = express();
        copy.use(sdkHostValidationFor(cfg.host, cfg.allowedHosts));
        copy.post("/x", (_req: unknown, res: { status(n: number): { json(b: unknown): void } }) =>
          res.status(200).json({ ok: true }),
        );
        const a = await listen(sdk);
        const b = await listen(copy);
        try {
          for (const host of HOSTS) {
            const ra = await raw(a.port, "/x", { host, body: "{}" });
            const rb = await raw(b.port, "/x", { host, body: "{}" });
            expect({ host, status: rb.status, body: rb.body }).toEqual({
              host,
              status: ra.status,
              body: ra.body,
            });
          }
          expect(statusAndBody(await noHostRequest(b.port))).toBe(
            statusAndBody(await noHostRequest(a.port)),
          );
        } finally {
          a.srv.close();
          b.srv.close();
        }
      } finally {
        warn.mockRestore();
      }
    });
  }
});

// ── F: the table matches the registrations ────────────────────────────────────

describe("#1981 F — ROUTE_OWNED_BODY_PARSERS lists every route-level body parser", () => {
  const VALUES = new Map<string, string>();
  for (const mod of [
    apiPaths,
    integrationsContract,
    modelsContract,
    integrationsRoutes,
    modelsRoutes,
  ]) {
    for (const [name, value] of Object.entries(mod)) {
      if (name.startsWith("API_") && typeof value === "string") VALUES.set(name, value);
    }
  }
  const DEAD =
    "a route-level body parser not listed in ROUTE_OWNED_BODY_PARSERS is dead code (#1981)";

  it("every registration that names a parser has the matching row, and nothing else does", () => {
    const expected = new Map<string, string>();
    for (const reg of mutatingRegistrations()) {
      let kinds: string[] | undefined;
      if (/\brejectOversizeLicenseBody\b/.test(reg.call)) kinds = ["license"];
      else if (/\bscratchpadJsonBody\b/.test(reg.call)) kinds = ["scratchpad"];
      else if (/\blargeBody\b/.test(reg.call)) kinds = ["upload", "reload", "small"];
      if (!kinds) continue;
      expect(reg.method, `${reg.constant}: the pre-parse router registers POST only`).toBe("post");
      const path = VALUES.get(reg.constant);
      expect(path, `${reg.constant}: path constant not resolvable`).toBeDefined();
      const kind = ROUTE_OWNED_BODY_PARSERS[path as string];
      expect(kinds, `${reg.file} ${reg.constant}: ${DEAD}`).toContain(kind);
      expected.set(path as string, kind);
    }
    expect(Object.keys(ROUTE_OWNED_BODY_PARSERS).sort()).toEqual([...expected.keys()].sort());
  });

  it("the 70 MB parser has exactly one row, /api/upload", () => {
    expect(ROUTE_OWNED_BODY_PARSERS[apiPaths.API_UPLOAD]).toBe("upload");
    expect(Object.values(ROUTE_OWNED_BODY_PARSERS).filter((k) => k === "upload")).toHaveLength(1);
  });
});

// ── G: the router's shape ─────────────────────────────────────────────────────

describe("#1981 G — the pre-parse router never answers a success", () => {
  const SRC_PATH = fileURLToPath(
    new URL("../../src/server/mcp/api-body-preparse.ts", import.meta.url),
  );
  const code = readFileSync(SRC_PATH, "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("source: no response writes, no app registrations, the Host gate first", () => {
    expect(code).not.toMatch(/\bres\.(json|send|status|end)\b/);
    expect(code).not.toMatch(/\bapp\./);
    const gate = code.indexOf("router.use(sdkHostGate)");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(code.indexOf("router.post("));
  });

  it("runtime: stack[0] is the path-less gate; each route is POST-only, mw first, a parser last", () => {
    const sdkHostGate = vi.fn();
    const mw = vi.fn();
    const largeBody = vi.fn();
    const router = createApiBodyPreParser({ sdkHostGate, mw, largeBody }) as unknown as {
      stack: Array<{
        handle: unknown;
        route?: {
          path: string | string[];
          methods: Record<string, boolean>;
          stack: Array<{ handle: unknown }>;
        };
      }>;
    };
    expect(router.stack[0].handle).toBe(sdkHostGate);
    expect(router.stack[0].route).toBeUndefined();

    const parsers = new Set<unknown>([
      largeBody,
      reloadBodyParser,
      smallBodyParser,
      licenseBodyParser,
      scratchpadJsonBody,
    ]);
    const paths: string[] = [];
    for (const layer of router.stack.slice(1)) {
      const route = layer.route;
      expect(route, "every layer after the gate is a route").toBeDefined();
      if (!route) continue;
      expect(route.methods).toEqual({ post: true });
      expect(route.stack[0].handle).toBe(mw);
      expect(parsers.has(route.stack[route.stack.length - 1].handle)).toBe(true);
      for (const h of route.stack.slice(1, -1)) expect(h.handle).toBe(rejectOversizeLicenseBody);
      paths.push(...(Array.isArray(route.path) ? route.path : [route.path]));
    }
    expect(paths.sort()).toEqual(Object.keys(ROUTE_OWNED_BODY_PARSERS).sort());
  });
});
