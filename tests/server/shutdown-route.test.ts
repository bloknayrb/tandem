/**
 * Route-level tests for POST /api/shutdown (#1088) — the graceful-shutdown
 * trigger the Tauri shell calls before hard-killing the sidecar on restart.
 *
 * Exercises:
 * - loopback POST without an Origin header (the Tauri shell's reqwest client)
 *   → 202, injected shutdown fn invoked after the response is delivered;
 * - Origin allowlisting (present-but-foreign Origin → 403 before invocation);
 * - the unconditional loopback gate (non-loopback remote → 403, even though
 *   assertLoopbackForMutation would not fire outside LAN-unauth mode);
 * - 202-then-shutdown ordering (shutdown deferred to the response "close");
 * - one-shot semantics on double-POST.
 *
 * The injected shutdown fn is a mock — the real one calls process.exit, which
 * must never run inside a vitest worker.
 */
import { EventEmitter } from "node:events";

import express, { type Express } from "express";
import { describe, expect, it, vi } from "vitest";
import { makeShutdownHandler } from "../../src/server/mcp/routes/shutdown.js";
import { API_SHUTDOWN } from "../../src/shared/api-paths.js";
import { TAURI_HOSTNAME } from "../../src/shared/constants.js";

function buildApp(requestShutdown: (reason: string) => void): Express {
  const app = express();
  app.post(API_SHUTDOWN, makeShutdownHandler({ requestShutdown }));
  return app;
}

/** POST against a real loopback listener so req.socket.remoteAddress is 127.0.0.1. */
async function post(
  app: Express,
  headers: Record<string, string> = {},
  times = 1,
): Promise<Array<{ status: number; body: unknown }>> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close();
        reject(new Error("no address"));
        return;
      }
      try {
        const results: Array<{ status: number; body: unknown }> = [];
        for (let i = 0; i < times; i++) {
          const res = await fetch(`http://127.0.0.1:${address.port}${API_SHUTDOWN}`, {
            method: "POST",
            headers,
          });
          results.push({ status: res.status, body: await res.json().catch(() => null) });
        }
        resolve(results);
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

/** Minimal req/res stubs for unit-driving the handler without a socket. */
function fakeReq(remoteAddress: string | undefined, origin?: string) {
  return {
    socket: { remoteAddress },
    headers: origin !== undefined ? { origin } : {},
    // biome-ignore lint/suspicious/noExplicitAny: minimal Express stub
  } as any;
}
function fakeRes() {
  const emitter = new EventEmitter();
  const res = {
    statusCode: 0,
    jsonBody: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.jsonBody = body;
      return this;
    },
    once: emitter.once.bind(emitter),
    emit: emitter.emit.bind(emitter),
  };
  return res;
}

describe("POST /api/shutdown (#1088)", () => {
  it("returns 202 and invokes the shutdown fn for a loopback POST with no Origin", async () => {
    const requestShutdown = vi.fn();
    const [res] = await post(buildApp(requestShutdown));
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ data: { shuttingDown: true, alreadyInProgress: false } });
    // The shutdown fires on the response "close" event — after the body has
    // been delivered to the client (which fetch just observed).
    await vi.waitFor(() => expect(requestShutdown).toHaveBeenCalledWith(API_SHUTDOWN));
    expect(requestShutdown).toHaveBeenCalledTimes(1);
  });

  it("accepts an allowlisted (Tauri WebView) Origin", async () => {
    const requestShutdown = vi.fn();
    const [res] = await post(buildApp(requestShutdown), { Origin: `http://${TAURI_HOSTNAME}` });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(requestShutdown).toHaveBeenCalledTimes(1));
  });

  it("rejects a non-allowlisted Origin with 403 before invoking shutdown", async () => {
    const requestShutdown = vi.fn();
    const [res] = await post(buildApp(requestShutdown), { Origin: "http://attacker.example" });
    expect(res.status).toBe(403);
    // Give any stray deferred invocation a tick to surface.
    await new Promise((r) => setTimeout(r, 20));
    expect(requestShutdown).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback remote address with 403 (unconditional loopback gate)", () => {
    const requestShutdown = vi.fn();
    const handler = makeShutdownHandler({ requestShutdown });
    const res = fakeRes();
    // biome-ignore lint/suspicious/noExplicitAny: minimal Express stub
    handler(fakeReq("192.168.1.50"), res as any, () => {});
    expect(res.statusCode).toBe(403);
    res.emit("close");
    expect(requestShutdown).not.toHaveBeenCalled();
  });

  it("rejects an undefined remote address (fail-closed)", () => {
    const requestShutdown = vi.fn();
    const handler = makeShutdownHandler({ requestShutdown });
    const res = fakeRes();
    // biome-ignore lint/suspicious/noExplicitAny: minimal Express stub
    handler(fakeReq(undefined), res as any, () => {});
    expect(res.statusCode).toBe(403);
    expect(requestShutdown).not.toHaveBeenCalled();
  });

  it("responds 202 BEFORE running shutdown — invocation waits for response close", () => {
    const requestShutdown = vi.fn();
    const handler = makeShutdownHandler({ requestShutdown });
    const res = fakeRes();
    // biome-ignore lint/suspicious/noExplicitAny: minimal Express stub
    handler(fakeReq("127.0.0.1"), res as any, () => {});
    // Response already written, shutdown NOT yet invoked.
    expect(res.statusCode).toBe(202);
    expect(requestShutdown).not.toHaveBeenCalled();
    // Once the response has been handed to the socket, shutdown runs.
    res.emit("close");
    expect(requestShutdown).toHaveBeenCalledTimes(1);
    expect(requestShutdown).toHaveBeenCalledWith(API_SHUTDOWN);
  });

  it("invokes the shutdown fn exactly once on double-POST", async () => {
    const requestShutdown = vi.fn();
    const [first, second] = await post(buildApp(requestShutdown), {}, 2);
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ data: { shuttingDown: true, alreadyInProgress: false } });
    expect(second.status).toBe(202);
    expect(second.body).toEqual({ data: { shuttingDown: true, alreadyInProgress: true } });
    await vi.waitFor(() => expect(requestShutdown).toHaveBeenCalledTimes(1));
    // And it stays at one even after everything settles.
    await new Promise((r) => setTimeout(r, 20));
    expect(requestShutdown).toHaveBeenCalledTimes(1);
  });

  it("IPv6 and IPv4-mapped loopback addresses pass the gate", () => {
    for (const addr of ["::1", "::ffff:127.0.0.1"]) {
      const requestShutdown = vi.fn();
      const handler = makeShutdownHandler({ requestShutdown });
      const res = fakeRes();
      // biome-ignore lint/suspicious/noExplicitAny: minimal Express stub
      handler(fakeReq(addr), res as any, () => {});
      expect(res.statusCode).toBe(202);
      res.emit("close");
      expect(requestShutdown).toHaveBeenCalledTimes(1);
    }
  });
});
