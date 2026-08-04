import express, { type Express } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getCodexApprovalBroker,
  registerCodexApprovalRoutes,
} from "../../../src/server/codex/approval-broker.js";
import {
  API_CODEX_APPROVAL_DECISION,
  API_CODEX_APPROVAL_REQUEST,
  API_CODEX_APPROVALS,
} from "../../../src/shared/api-paths.js";
import { TAURI_HOSTNAME } from "../../../src/shared/constants.js";

/**
 * `registerCodexApprovalRoutes` always wires to the module-level singleton
 * (`getCodexApprovalBroker()`) — there is no per-app broker injection like
 * `registerIntegrationsRoutes` has. Every test that creates a pending
 * approval MUST resolve or cancel it (directly asserted below, or via
 * `afterEach`), or it leaks into the next test in this file as a phantom
 * queue entry / `list()` row.
 */
const passthrough: import("express").Handler = (_req, _res, next) => next();

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  registerCodexApprovalRoutes(app, passthrough);
  return app;
}

function makeAppWithRemoteAddress(addr: string): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, "remoteAddress", { value: addr, configurable: true });
    next();
  });
  registerCodexApprovalRoutes(app, passthrough);
  return app;
}

interface RequestResult {
  status: number;
  body: unknown;
}

function request(
  app: Express,
  method: "GET" | "POST",
  url: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<RequestResult> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close();
        reject(new Error("no address"));
        return;
      }
      try {
        const headers: Record<string, string> = {
          Origin: `http://${TAURI_HOSTNAME}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(extraHeaders ?? {}),
        };
        const res = await fetch(`http://127.0.0.1:${address.port}${url}`, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const ct = res.headers.get("content-type") ?? "";
        const payload = ct.includes("application/json")
          ? await res.json().catch(() => null)
          : await res.text();
        resolve({ status: res.status, body: payload });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

/** Drain the shared broker so the next test starts from an empty queue. */
afterEach(() => {
  const broker = getCodexApprovalBroker();
  for (const view of broker.list()) broker.cancel(view.id);
});

describe(`GET ${API_CODEX_APPROVALS}`, () => {
  it("returns the pending queue for a loopback caller", async () => {
    const broker = getCodexApprovalBroker();
    const pending = broker.request("item/commandExecution/requestApproval", { command: "ls" });
    const app = makeApp();
    const res = await request(app, "GET", API_CODEX_APPROVALS);
    expect(res.status).toBe(200);
    expect((res.body as { approvals: Array<{ id: string }> }).approvals.map((a) => a.id)).toContain(
      pending.id,
    );
    broker.cancel(pending.id);
  });

  it("rejects a non-loopback caller with 403 (no origin gate needed — read-only)", async () => {
    const app = makeAppWithRemoteAddress("192.168.1.50");
    const res = await request(app, "GET", API_CODEX_APPROVALS);
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toBe("FORBIDDEN");
  });
});

describe(`POST ${API_CODEX_APPROVAL_DECISION}`, () => {
  it("rejects a non-allowlisted Origin before touching the broker (CSRF gate)", async () => {
    const app = makeApp();
    const res = await request(
      app,
      "POST",
      API_CODEX_APPROVAL_DECISION,
      { id: "whatever", decision: "accept" },
      { Origin: "http://evil.com" },
    );
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe("BAD_ORIGIN");
  });

  it("rejects a non-loopback caller even with an allowlisted Origin (origin gate then loopback gate)", async () => {
    const broker = getCodexApprovalBroker();
    const pending = broker.request("item/commandExecution/requestApproval", { command: "ls" });
    const app = makeAppWithRemoteAddress("192.168.1.50");
    const res = await request(app, "POST", API_CODEX_APPROVAL_DECISION, {
      id: pending.id,
      decision: "accept",
    });
    expect(res.status).toBe(403);
    // FORBIDDEN from requireLoopback, not the BAD_ORIGIN shape — origin was fine.
    expect((res.body as { error: string }).error).toBe("FORBIDDEN");
    broker.cancel(pending.id);
  });

  it("rejects an invalid decision value with 400", async () => {
    const broker = getCodexApprovalBroker();
    const pending = broker.request("item/commandExecution/requestApproval", { command: "ls" });
    const app = makeApp();
    const res = await request(app, "POST", API_CODEX_APPROVAL_DECISION, {
      id: pending.id,
      decision: "maybe-later",
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("BAD_REQUEST");
    broker.cancel(pending.id);
  });

  it("returns 404 for an id that isn't pending (never existed, already decided, or timed out)", async () => {
    const app = makeApp();
    const res = await request(app, "POST", API_CODEX_APPROVAL_DECISION, {
      id: "ghost-id",
      decision: "decline",
    });
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toBe("NOT_FOUND");
  });

  it("resolves the pending approval's result promise on a valid decision", async () => {
    const broker = getCodexApprovalBroker();
    const pending = broker.request("item/commandExecution/requestApproval", { command: "ls" });
    const app = makeApp();
    const res = await request(app, "POST", API_CODEX_APPROVAL_DECISION, {
      id: pending.id,
      decision: "accept",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    await expect(pending.result).resolves.toEqual({ decision: "accept" });
  });
});

describe(`POST ${API_CODEX_APPROVAL_REQUEST}`, () => {
  it("is NOT origin-gated — the worker is a local process, not a browser (evil Origin still reaches the loopback/token checks)", async () => {
    const app = makeApp();
    const res = await request(
      app,
      "POST",
      API_CODEX_APPROVAL_REQUEST,
      { method: "item/commandExecution/requestApproval", params: {} },
      { Origin: "http://evil.com", "x-tandem-codex-worker-token": "wrong" },
    );
    // Falls through the (absent) origin gate straight to the loopback check
    // (passes, since the test client is 127.0.0.1) and then token auth, which
    // fails — 401, not 403 BAD_ORIGIN. Proves there is no origin gate here.
    expect(res.status).toBe(401);
  });

  it("rejects a non-loopback caller regardless of worker token", async () => {
    const broker = getCodexApprovalBroker();
    const app = makeAppWithRemoteAddress("192.168.1.50");
    const res = await request(
      app,
      "POST",
      API_CODEX_APPROVAL_REQUEST,
      { method: "item/commandExecution/requestApproval", params: {} },
      { "x-tandem-codex-worker-token": broker.workerToken },
    );
    expect(res.status).toBe(403);
  });

  it("rejects a wrong worker token with 401", async () => {
    const app = makeApp();
    const res = await request(
      app,
      "POST",
      API_CODEX_APPROVAL_REQUEST,
      { method: "item/commandExecution/requestApproval", params: {} },
      { "x-tandem-codex-worker-token": "not-the-real-token" },
    );
    expect(res.status).toBe(401);
  });

  it("accepts the exact worker token (positive control for the 401 above)", async () => {
    const broker = getCodexApprovalBroker();
    const app = makeApp();
    const resultPromise = request(
      app,
      "POST",
      API_CODEX_APPROVAL_REQUEST,
      { method: "item/commandExecution/requestApproval", params: { command: "ls" } },
      { "x-tandem-codex-worker-token": broker.workerToken },
    );
    // Resolve it from the broker side once it shows up, so the HTTP call completes.
    await vi.waitFor(() => expect(broker.list().length).toBeGreaterThan(0));
    const [pending] = broker.list();
    broker.decide(pending.id, "accept");
    const res = await resultPromise;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ result: { decision: "accept" } });
  });

  it("rejects an unsupported method with 400", async () => {
    const broker = getCodexApprovalBroker();
    const app = makeApp();
    const res = await request(
      app,
      "POST",
      API_CODEX_APPROVAL_REQUEST,
      { method: "not/a/real/method", params: {} },
      { "x-tandem-codex-worker-token": broker.workerToken },
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("BAD_REQUEST");
  });

  it("cancels the pending approval when the client disconnects before a decision is made", async () => {
    const broker = getCodexApprovalBroker();
    const app = makeApp();
    const controller = new AbortController();

    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");

    const fetchPromise = fetch(`http://127.0.0.1:${address.port}${API_CODEX_APPROVAL_REQUEST}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tandem-codex-worker-token": broker.workerToken,
      },
      body: JSON.stringify({
        method: "item/commandExecution/requestApproval",
        params: { command: "disconnect-me" },
      }),
      signal: controller.signal,
    }).catch(() => undefined); // Aborting rejects the fetch promise itself — expected.

    // Wait for the broker to register the pending approval before disconnecting,
    // or the abort could race ahead of `broker.request()` and this test would
    // pass vacuously (nothing to cancel yet).
    await vi.waitFor(() => expect(broker.list().length).toBeGreaterThan(0));
    const [pending] = broker.list();

    controller.abort();
    await fetchPromise;

    // The route's `res.once("close", ...)` handler must have fired broker.cancel().
    await vi.waitFor(() => expect(broker.list().some((v) => v.id === pending.id)).toBe(false));
    server.close();
  });
});
