import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  _pushEventForTests,
  resetForTesting,
  subscribe,
  unsubscribe,
} from "../../src/server/events/queue.js";
import { aiRefusal, aiRefusalFor } from "../../src/server/license/ai-refusal.js";
import { GATE_ENABLED } from "../../src/server/license/gate-flag.js";
import type { LicenseState } from "../../src/server/license/license-types.js";
import { trialFilePath } from "../../src/server/license/paths.js";
import { appendClaudeChatMessage } from "../../src/server/mcp/awareness.js";
import {
  closeMcpSession,
  startMcpServerHttp,
  startMcpServerStdio,
} from "../../src/server/mcp/server.js";
import { TANDEM_PURCHASE_URL } from "../../src/shared/constants.js";
import { LICENSE_REQUIRED } from "../../src/shared/license-copy.js";
import { allocPort } from "../helpers/alloc-port.js";

/**
 * The licence decision for Tandem's AI surfaces (#1521) — its pure core, and
 * "behaviour-identical when dark": with the gate dark, every admission
 * point admits, even over a `trial.json` that would refuse on an armed build.
 *
 * The armed half is `license-armed-restricted.test.ts`. The supervisor and the
 * local-model collaborator default to this same `aiRefusal`, so its dark `null`
 * is their dark admission; their refusal paths are pinned with an injected
 * decision in their own suites.
 */

const RESTRICTED: LicenseState = {
  gateActive: true,
  status: "restricted",
  updateWindowCurrent: false,
};

describe("aiRefusalFor (pure)", () => {
  it("admits a dark build", () => {
    expect(aiRefusalFor({ gateActive: false })).toBeNull();
  });

  it("admits a trial and a licence", () => {
    expect(
      aiRefusalFor({
        gateActive: true,
        status: "trial",
        updateWindowCurrent: false,
        trial: { firstRunAt: "", expiresAt: "", daysRemaining: 3 },
      }),
    ).toBeNull();
    expect(
      aiRefusalFor({
        gateActive: true,
        status: "licensed",
        licenseId: "id",
        updateWindowCurrent: true,
        license: {
          id: "id",
          email: "e",
          type: "personal",
          createdAt: "",
          expiresAt: null,
          version: "1.0",
          keyId: "0123456789abcdef",
        },
      }),
    ).toBeNull();
  });

  it("refuses restricted as `unlicensed`, carrying the purchase URL", () => {
    const refusal = aiRefusalFor(RESTRICTED);
    expect(refusal).toMatchObject({ error: LICENSE_REQUIRED, kind: "unlicensed" });
    expect(refusal?.message).toContain(TANDEM_PURCHASE_URL);
    expect(refusal?.message).toMatch(/stays fully editable/);
  });

  it.each(["BAD_SIGNATURE", "MALFORMED", "UNSUPPORTED_VERSION", "UNKNOWN"] as const)(
    "refuses restricted + %s as `unverifiable`, never with the purchase URL",
    (code) => {
      const refusal = aiRefusalFor({ ...RESTRICTED, licenseUnverifiable: code });
      expect(refusal).toMatchObject({ error: LICENSE_REQUIRED, kind: "unverifiable" });
      expect(refusal?.message).toMatch(/^Tandem's AI features are off because your license/);
      expect(refusal?.message).not.toContain(TANDEM_PURCHASE_URL);
    },
  );
});

describe("dark: every admission point admits (#1521)", () => {
  const DAY = 86_400_000;
  let dir: string;
  let saved: string | undefined;
  let httpServer: Server;
  let port: number;

  beforeAll(async () => {
    saved = process.env.TANDEM_APP_DATA_DIR;
    // A 30-day-old trial: armed, this refuses everywhere. Dark, it must not.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-license-dark-"));
    fs.writeFileSync(
      trialFilePath(dir),
      JSON.stringify({ version: 1, firstRunAt: new Date(Date.now() - 30 * DAY).toISOString() }),
    );
    process.env.TANDEM_APP_DATA_DIR = dir;
    port = await allocPort();
    httpServer = await startMcpServerHttp(port, "127.0.0.1");
  });

  afterAll(async () => {
    resetForTesting();
    await closeMcpSession();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    if (saved === undefined) delete process.env.TANDEM_APP_DATA_DIR;
    else process.env.TANDEM_APP_DATA_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is actually dark", () => {
    expect(GATE_ENABLED).toBe(false);
    expect(aiRefusal()).toBeNull();
  });

  it("POST /mcp initialize mints a session", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
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
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "dark", version: "1" },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
    expect(await res.text()).not.toContain(LICENSE_REQUIRED);
  });

  it("GET /mcp is not a licence refusal", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(await res.text()).not.toContain(LICENSE_REQUIRED);
  });

  it("SSE /api/events streams", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: ctrl.signal });
    expect(res.status).toBe(200);
    ctrl.abort();
  });

  it("WS /api/wake opens", async () => {
    const opened = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/wake`);
      ws.on("open", () => {
        ws.close();
        resolve(true);
      });
      ws.on("unexpected-response", () => resolve(false));
      ws.on("error", () => resolve(false));
    });
    expect(opened).toBe(true);
  });

  it("Claude's chat write is admitted", () => {
    expect(appendClaudeChatMessage("dark hello")).toMatchObject({ ok: true });
  });

  it("the fan-out delivers to an external subscriber", () => {
    const cb = vi.fn();
    subscribe(cb, "external", { onRevoke: () => cb("revoked") });
    _pushEventForTests({
      id: "evt_dark",
      timestamp: Date.now(),
      type: "chat:message",
      payload: { messageId: "m-dark", text: "hi", replyTo: null, anchor: null },
    });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).not.toHaveBeenCalledWith("revoked");
    unsubscribe(cb);
  });

  it("stdio server mode serves initialize", async () => {
    const [client, server] = InMemoryTransport.createLinkedPair();
    const answer = new Promise<Record<string, unknown>>((resolve) => {
      client.onmessage = (m) => resolve(m as unknown as Record<string, unknown>);
    });
    await startMcpServerStdio({ wsPort: 1, mcpPort: 2 }, server);
    await client.start();
    await client.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "d", version: "1" },
      },
    } as never);
    const msg = await answer;
    await client.close();
    expect(msg.result).toBeDefined();
  });
});
