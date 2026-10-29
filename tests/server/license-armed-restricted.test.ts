import type { Server } from "node:http";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

/**
 * The armed fixture for #1521 — **where `GATE_ENABLED` is really `true`** and
 * every AI admission point is probed through the real disk path.
 *
 * Policy (ADR-040 as amended 2026-10-11): "after the 14 day trial, tandem
 * remains a usable editor, but with no AI features". So, armed and keyless:
 * the editor stays writable, and the AI is refused where it gets in — `/mcp`,
 * Claude's chat writes, push/wake (SSE and the wake socket), the approval
 * relay, stdio server mode. Every refusal is paired with a fresh-trial twin
 * that is admitted, because a probe that only ever sees refusals cannot tell
 * "refuses when unlicensed" from "refuses always".
 *
 * `vi.hoisted` carries exactly ONE line — the env var — because it runs before
 * this file's own imports, and `GATE_ENABLED` is read once at import
 * (`gate-flag.ts`). The app-data dir is switched per test instead:
 * `resolveAppDataDir()` re-reads `process.env` on every call, which is also
 * what makes a mid-session flip testable.
 *
 * Nothing here flips a shipped const: `LICENSE_GATE_ENABLED` stays `false` in
 * `tsup.config.ts`. This exercises the ARMED gate via the `TANDEM_LICENSE_GATE`
 * env fallback that `readGateFlag` reads under tsx/vitest.
 */
vi.hoisted(() => {
  process.env.TANDEM_LICENSE_GATE = "1";
});

// The backup-restore probe writes a pre-overwrite snapshot, whose first write
// per root sets a Windows ACL by spawning icacls — not for a unit test. Same
// stub as restore-backup.test.ts and mcp-wire-codes.test.ts.
vi.mock(import("../../src/server/integrations/acl-win.js"), () => ({
  setRestrictiveAcl: vi.fn().mockResolvedValue(undefined),
}));

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAnnotationLifecycle } from "../../src/server/annotations/lifecycle.js";
import { resetForTesting as resetAnnotationStoreForTesting } from "../../src/server/annotations/store.js";
import { addDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import {
  getDeliveryState,
  resetDeliveryStateForTests,
} from "../../src/server/events/delivery-state.js";
import {
  _pushEventForTests,
  getSubscriberCount,
  resetForTesting,
  subscribe,
  unsubscribe,
  wasEmittedViaChannel,
} from "../../src/server/events/queue.js";
import type { TandemEvent } from "../../src/server/events/types.js";
import { WAKE_CLOSE_LICENSE_REQUIRED } from "../../src/server/events/wake-socket.js";
import {
  _resetDocBackupGateForTests,
  listDocBackups,
  snapshotBeforeFirstWrite,
} from "../../src/server/file-io/doc-backup.js";
import { unwatchAll } from "../../src/server/file-watcher.js";
import { defaultSubscribeDuringGap } from "../../src/server/launcher/supervisor.js";
import { aiRefusal } from "../../src/server/license/ai-refusal.js";
import { GATE_ENABLED } from "../../src/server/license/gate-flag.js";
import { resolveLiveLicenseState } from "../../src/server/license/license-state.js";
import { licenseFilePath, trialFilePath } from "../../src/server/license/paths.js";
import { appendClaudeChatMessage } from "../../src/server/mcp/awareness.js";
import { extractText } from "../../src/server/mcp/document-model.js";
import {
  closeMcpSession,
  hasAnyMcpSession,
  startMcpServerHttp,
  startMcpServerStdio,
} from "../../src/server/mcp/server.js";
import { resolveAppDataDir } from "../../src/server/platform.js";
import { getDocument, getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  TANDEM_PURCHASE_URL,
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
  Y_MAP_AWARENESS,
  Y_MAP_CHAT,
  Y_MAP_CLAUDE,
  Y_MAP_DOCUMENT_META,
  Y_MAP_EXTERNAL_CONFLICT,
} from "../../src/shared/constants.js";
import {
  AI_REFUSAL_RECONNECT_HINT,
  LICENSE_REQUIRED,
  LICENSE_REQUIRED_RPC_CODE,
} from "../../src/shared/license-copy.js";
import { withBrowser, withInternal } from "../../src/shared/origins.js";
import type { ExternalConflictState } from "../../src/shared/types.js";
import { allocPort } from "../helpers/alloc-port.js";
import { timeoutMs } from "../helpers/timing.js";
import { createMinimalDocx, seedAcceptedSuggestion } from "../helpers/wire-code-fixtures.js";
import { rangeOf } from "../helpers/ydoc-factory.js";

const DAY = 86_400_000;
const MCP_ACCEPT = "application/json, text/event-stream";

const createdDirs: string[] = [];

/** A fresh app-data fixture with a `trial.json` `daysAgo` old, pointed at by the env. */
function useTrial(daysAgo: number): string {
  // The `tandem-` prefix is required: `tests/server/platform.test.ts` asserts
  // `SESSION_DIR` contains "tandem".
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-license-armed-"));
  createdDirs.push(dir);
  fs.writeFileSync(
    trialFilePath(dir),
    JSON.stringify({ version: 1, firstRunAt: new Date(Date.now() - daysAgo * DAY).toISOString() }),
  );
  process.env.TANDEM_APP_DATA_DIR = dir;
  return dir;
}

const useExpired = () => useTrial(30);
const useFreshTrial = () => useTrial(1);

/** Expired trial PLUS a `license.json` that fails to verify — the paying-customer refusal. */
function useUnverifiable(): void {
  const dir = useExpired();
  fs.writeFileSync(licenseFilePath(dir), JSON.stringify({ version: 1, blob: "not-a-license" }));
}

let savedAppDataDir: string | undefined;
let savedGateFlag: string | undefined;
let httpServer: Server;
let baseUrl: string;
let port: number;

beforeAll(async () => {
  savedAppDataDir = process.env.TANDEM_APP_DATA_DIR;
  savedGateFlag = process.env.TANDEM_LICENSE_GATE;
  port = await allocPort();
  baseUrl = `http://127.0.0.1:${port}`;
  httpServer = await startMcpServerHttp(port, "127.0.0.1");
});

beforeEach(() => {
  useExpired();
});

afterEach(() => {
  resetForTesting();
});

afterAll(async () => {
  await closeMcpSession();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  // Quiesce before deleting the dirs, as production shutdown does. A watcher
  // left on a deleted file EPERMs on Windows, and a debounced annotation save
  // fires into a deleted dir; both log after this file has finished, and a log
  // still in flight at worker teardown fails the whole run (#1937).
  unwatchAll();
  resetAnnotationStoreForTesting();
  // Restore by ABSENCE: `process.env.X = undefined` writes the STRING "undefined".
  if (savedAppDataDir === undefined) delete process.env.TANDEM_APP_DATA_DIR;
  else process.env.TANDEM_APP_DATA_DIR = savedAppDataDir;
  if (savedGateFlag === undefined) delete process.env.TANDEM_LICENSE_GATE;
  else process.env.TANDEM_LICENSE_GATE = savedGateFlag;
  for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function initBody(id: number | string = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "armed-probe", version: "1.0.0" },
    },
  };
}

async function postMcp(
  body: unknown,
  sessionId?: string,
): Promise<{ status: number; sessionId: string | null; text: string }> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: MCP_ACCEPT,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    sessionId: res.headers.get("mcp-session-id"),
    text: await res.text(),
  };
}

/** Open a full session (initialize + initialized). Only works while admitted. */
async function openSession(): Promise<string> {
  const init = await postMcp(initBody());
  expect(init.sessionId).toBeTruthy();
  const sid = init.sessionId as string;
  await postMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, sid);
  return sid;
}

function chatEvent(messageId: string): TandemEvent {
  return {
    id: `evt_${Date.now()}_${messageId}`,
    timestamp: Date.now(),
    type: "chat:message",
    payload: { messageId, text: "hello", replyTo: null, anchor: null },
  };
}

describe("armed and keyless (#1521)", () => {
  // Anti-vacuity, first: without it every refusal below could pass on a dark
  // build only because nothing ran.
  it("is actually armed, and the fixture actually resolves restricted", () => {
    expect(GATE_ENABLED).toBe(true);
    expect(resolveLiveLicenseState()).toMatchObject({ gateActive: true, status: "restricted" });
  });

  it('firstRunAt: "" resolves restricted, not a perpetual trial (#1788)', () => {
    const dir = useExpired();
    fs.writeFileSync(trialFilePath(dir), JSON.stringify({ version: 1, firstRunAt: "" }));
    expect(resolveLiveLicenseState()).toMatchObject({ gateActive: true, status: "restricted" });
  });

  describe("aiRefusal", () => {
    it("refuses an unlicensed install with the purchase URL", () => {
      expect(aiRefusal()).toMatchObject({ error: LICENSE_REQUIRED, kind: "unlicensed" });
      expect(aiRefusal()?.message).toContain(TANDEM_PURCHASE_URL);
    });

    it("refuses an unverifiable licence WITHOUT the purchase URL", () => {
      useUnverifiable();
      const refusal = aiRefusal();
      expect(refusal).toMatchObject({ error: LICENSE_REQUIRED, kind: "unverifiable" });
      expect(refusal?.message).toMatch(/could not be verified/);
      expect(refusal?.message).not.toContain(TANDEM_PURCHASE_URL);
    });

    it("admits a fresh trial (positive twin)", () => {
      useFreshTrial();
      expect(aiRefusal()).toBeNull();
    });
  });

  describe("POST /mcp", () => {
    it("refuses initialize with 200 + a -32003 JSON-RPC error and creates no session", async () => {
      const res = await postMcp(initBody(7));
      expect(res.status).toBe(200);
      expect(res.sessionId).toBeNull();
      const body = JSON.parse(res.text);
      expect(body.id).toBe(7);
      expect(body.error.code).toBe(LICENSE_REQUIRED_RPC_CODE);
      expect(body.error.message).toContain(TANDEM_PURCHASE_URL);
      // The host marks the server failed after this, so the copy says to reconnect.
      expect(body.error.message).toContain(AI_REFUSAL_RECONNECT_HINT);
      expect(body.error.data).toEqual({
        error: LICENSE_REQUIRED,
        kind: "unlicensed",
        purchaseUrl: TANDEM_PURCHASE_URL,
      });
      expect(hasAnyMcpSession()).toBe(false);
    });

    it("refuses an unverifiable install with no purchase URL anywhere", async () => {
      useUnverifiable();
      const res = await postMcp(initBody());
      const body = JSON.parse(res.text);
      expect(body.error.data).toEqual({ error: LICENSE_REQUIRED, kind: "unverifiable" });
      expect(res.text).not.toContain(TANDEM_PURCHASE_URL);
    });

    it("answers a batch with an array carrying the request's own id", async () => {
      const res = await postMcp([initBody("batch-1")]);
      const body = JSON.parse(res.text);
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe("batch-1");
      expect(body[0].error.data.error).toBe(LICENSE_REQUIRED);
    });

    it("answers a bare notification 202 with no body", async () => {
      const res = await postMcp({ jsonrpc: "2.0", method: "notifications/initialized" });
      expect(res.status).toBe(202);
      expect(res.text).toBe("");
    });

    it("admits initialize on a fresh trial (positive twin)", async () => {
      useFreshTrial();
      const res = await postMcp(initBody());
      expect(res.status).toBe(200);
      expect(res.sessionId).toBeTruthy();
      expect(res.text).not.toContain(LICENSE_REQUIRED);
      await closeMcpSession();
    });

    it("refuses mid-session after the trial expires, and closes the session", async () => {
      useFreshTrial();
      const sid = await openSession();
      expect(hasAnyMcpSession()).toBe(true);

      // Flip mid-session: the very next request is refused.
      useExpired();
      const refused = await postMcp({ jsonrpc: "2.0", id: 9, method: "tools/list" }, sid);
      expect(refused.status).toBe(200);
      expect(JSON.parse(refused.text).error.data.error).toBe(LICENSE_REQUIRED);
      // Mid-session the next call heals by itself, so no reconnect hint.
      expect(JSON.parse(refused.text).error.message).not.toContain(AI_REFUSAL_RECONNECT_HINT);
      expect(hasAnyMcpSession()).toBe(false);

      // Back to admitted: the closed session is gone (404), not silently revived.
      useFreshTrial();
      const stale = await postMcp({ jsonrpc: "2.0", id: 10, method: "tools/list" }, sid);
      expect(stale.status).toBe(404);
    });
  });

  describe("GET /mcp", () => {
    it("refuses with 403 and the envelope, never a 200 the SDK would parse as SSE", async () => {
      const res = await fetch(`${baseUrl}/mcp`, { headers: { Accept: "text/event-stream" } });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: LICENSE_REQUIRED, kind: "unlicensed" });
    });

    it("closes the live session it names while refused", async () => {
      useFreshTrial();
      const sid = await openSession();
      useExpired();
      const res = await fetch(`${baseUrl}/mcp`, {
        headers: { Accept: "text/event-stream", "mcp-session-id": sid },
      });
      expect(res.status).toBe(403);
      await res.text();
      expect(hasAnyMcpSession()).toBe(false);
    });

    it("opens the stream for a live session on a fresh trial (positive twin)", async () => {
      useFreshTrial();
      const sid = await openSession();
      const ctrl = new AbortController();
      const res = await fetch(`${baseUrl}/mcp`, {
        headers: { Accept: "text/event-stream", "mcp-session-id": sid },
        signal: ctrl.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
      ctrl.abort();
      expect(hasAnyMcpSession()).toBe(true);
      await closeMcpSession();
    });
  });

  describe("DELETE /mcp", () => {
    it("is admitted while refused, so teardown works", async () => {
      useFreshTrial();
      const sid = await openSession();
      useExpired();
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "DELETE",
        headers: { "mcp-session-id": sid },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain(LICENSE_REQUIRED);
      expect(hasAnyMcpSession()).toBe(false);
    });
  });

  describe("Claude's presence when a refusal closes the last session", () => {
    async function openDocWithClaudePresent(): Promise<string> {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-license-presence-"));
      createdDirs.push(dir);
      const file = path.join(dir, "presence.md");
      fs.writeFileSync(file, "# Presence\n\nBody.\n");
      const opened = await fetch(`${baseUrl}/api/open`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: file }),
      });
      const docId = ((await opened.json()) as { data: { documentId: string } }).data.documentId;
      const doc = getOrCreateDocument(docId);
      withInternal(doc, () =>
        doc.getMap(Y_MAP_AWARENESS).set(Y_MAP_CLAUDE, { active: true, status: "working" }),
      );
      return docId;
    }
    const claudeActive = (docId: string) =>
      (getDocument(docId)?.getMap(Y_MAP_AWARENESS).get(Y_MAP_CLAUDE) as { active?: boolean })
        ?.active;

    it("is cleared only when the refusal closes the LAST session", async () => {
      useFreshTrial();
      const a = await openSession();
      const b = await openSession();
      const docId = await openDocWithClaudePresent();
      useExpired();

      await postMcp({ jsonrpc: "2.0", id: 20, method: "tools/list" }, a);
      expect(hasAnyMcpSession()).toBe(true); // b remains
      expect(claudeActive(docId)).toBe(true);

      await postMcp({ jsonrpc: "2.0", id: 21, method: "tools/list" }, b);
      expect(hasAnyMcpSession()).toBe(false);
      expect(claudeActive(docId)).toBe(false);
    });
  });

  describe("stdio server mode (TANDEM_TRANSPORT=stdio)", () => {
    async function initOverStdio(): Promise<Record<string, unknown>> {
      const [client, server] = InMemoryTransport.createLinkedPair();
      const answer = new Promise<Record<string, unknown>>((resolve) => {
        client.onmessage = (m) => resolve(m as unknown as Record<string, unknown>);
      });
      await startMcpServerStdio({ wsPort: 1, mcpPort: 2 }, server);
      await client.start();
      await client.send(initBody(3) as never);
      const msg = await answer;
      await client.close();
      return msg;
    }

    it("refuses at start: every request gets the licence error", async () => {
      const msg = await initOverStdio();
      expect(msg.id).toBe(3);
      expect((msg.error as { data: { error: string } }).data.error).toBe(LICENSE_REQUIRED);
    });

    it("serves a fresh trial normally (positive twin)", async () => {
      useFreshTrial();
      const msg = await initOverStdio();
      expect(msg.result).toBeDefined();
      expect(msg.error).toBeUndefined();
    });
  });

  describe("Claude's chat writes", () => {
    function chatRow(id: string) {
      return getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_CHAT).get(id) as
        | { read?: boolean }
        | undefined;
    }

    it("appendClaudeChatMessage refuses and writes nothing", () => {
      const before = getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_CHAT).size;
      const result = appendClaudeChatMessage("hi");
      expect(result).toMatchObject({ ok: false, refusal: { kind: "unlicensed" } });
      expect(getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_CHAT).size).toBe(before);
    });

    it("appendClaudeChatMessage admits on a fresh trial (positive twin)", () => {
      useFreshTrial();
      expect(appendClaudeChatMessage("hi")).toMatchObject({ ok: true });
    });

    it("POST /api/channel-reply answers 403 and stamps nothing read", async () => {
      const ctrl = getOrCreateDocument(CTRL_ROOM);
      withBrowser(ctrl, () =>
        ctrl.getMap(Y_MAP_CHAT).set("u-armed", {
          id: "u-armed",
          author: "user",
          text: "question",
          timestamp: Date.now(),
          read: false,
        }),
      );
      const res = await fetch(`${baseUrl}/api/channel-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "answer", replyTo: "u-armed" }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: LICENSE_REQUIRED, kind: "unlicensed" });
      expect(chatRow("u-armed")?.read).toBe(false);
    });

    it("POST /api/channel-reply refuses BEFORE validating the body (403, not 400)", async () => {
      const res = await fetch(`${baseUrl}/api/channel-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: 42 }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: LICENSE_REQUIRED });
    });

    it("the same malformed body is a 400 on a fresh trial (positive twin)", async () => {
      useFreshTrial();
      const res = await fetch(`${baseUrl}/api/channel-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: 42 }),
      });
      expect(res.status).toBe(400);
    });

    it("POST /api/channel-reply is admitted on a fresh trial (positive twin)", async () => {
      useFreshTrial();
      const res = await fetch(`${baseUrl}/api/channel-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "answer" }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("push: SSE /api/events", () => {
    it("refuses with 403 before any frame — a Last-Event-ID replays nothing", async () => {
      const res = await fetch(`${baseUrl}/api/events`, {
        headers: { Accept: "text/event-stream", "Last-Event-ID": "evt_unknown" },
      });
      expect(res.status).toBe(403);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      expect(await res.json()).toMatchObject({ error: LICENSE_REQUIRED });
    });

    it("streams on a fresh trial (positive twin)", async () => {
      useFreshTrial();
      const ctrl = new AbortController();
      const res = await fetch(`${baseUrl}/api/events`, { signal: ctrl.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
      ctrl.abort();
    });
  });

  describe("push: WS /api/wake", () => {
    it("refuses the upgrade with 403 and a JSON body", async () => {
      const outcome = await new Promise<{ status?: number; body: string }>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/wake`);
        ws.on("unexpected-response", (_req, res) => {
          let body = "";
          res.on("data", (c: Buffer) => {
            body += c.toString("utf8");
          });
          res.on("end", () => resolve({ status: res.statusCode, body }));
        });
        ws.on("open", () => {
          ws.close();
          resolve({ body: "opened" });
        });
        ws.on("error", () => {});
      });
      expect(outcome.status).toBe(403);
      expect(JSON.parse(outcome.body)).toMatchObject({ error: LICENSE_REQUIRED });
    });

    it("opens on a fresh trial (positive twin)", async () => {
      useFreshTrial();
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
  });

  describe("push: the fan-out", () => {
    it("a refused event is not tracked as pushed and starts no wake clock", () => {
      const cb = vi.fn();
      subscribe(cb, "external");
      _pushEventForTests(chatEvent("m-refused"));
      expect(cb).not.toHaveBeenCalled();
      expect(wasEmittedViaChannel("m-refused")).toBe(false);
      expect(getDeliveryState(Date.now(), getSubscriberCount()).state).not.toBe("awaiting-poll");
      unsubscribe(cb);
    });

    it("an admitted event is tracked (positive twin)", () => {
      useFreshTrial();
      const cb = vi.fn();
      subscribe(cb, "external");
      _pushEventForTests(chatEvent("m-admitted"));
      expect(cb).toHaveBeenCalledTimes(1);
      expect(wasEmittedViaChannel("m-admitted")).toBe(true);
      // The twin of the refused case's "starts no wake clock".
      expect(getDeliveryState(Date.now(), getSubscriberCount()).state).toBe("awaiting-poll");
      unsubscribe(cb);
    });

    it("revokes consumers with onRevoke; one without (the supervisor) is skipped, then woken after flipping back", () => {
      useFreshTrial();
      const revoked = vi.fn();
      const sse = vi.fn();
      const supervisorLike = vi.fn();
      subscribe(sse, "external", { onRevoke: revoked });
      subscribe(supervisorLike, "external");

      useExpired();
      _pushEventForTests(chatEvent("m-1"));
      expect(revoked).toHaveBeenCalledTimes(1);
      expect(sse).not.toHaveBeenCalled();
      expect(supervisorLike).not.toHaveBeenCalled();
      // Revoked is unsubscribed; the supervisor stays attached.
      expect(getSubscriberCount()).toBe(1);

      useFreshTrial();
      _pushEventForTests(chatEvent("m-2"));
      expect(supervisorLike).toHaveBeenCalledTimes(1);
      expect(sse).not.toHaveBeenCalled();
      unsubscribe(supervisorLike);
    });

    it("the supervisor's gap watch owes no wake for an event refused for the AI", () => {
      // The gap watch is an INTERNAL subscriber, which the fan-out never skips;
      // it must read the push's own refusal. A chat sent while unlicensed must
      // not reach Claude later as an owed wake.
      const owed = vi.fn();
      const stop = defaultSubscribeDuringGap(owed);
      _pushEventForTests(chatEvent("m-gap-refused"));
      expect(owed).not.toHaveBeenCalled();
      stop();
    });

    it("the gap watch owes a wake for an admitted event (positive twin)", () => {
      useFreshTrial();
      const owed = vi.fn();
      const stop = defaultSubscribeDuringGap(owed);
      _pushEventForTests(chatEvent("m-gap-admitted"));
      expect(owed).toHaveBeenCalledTimes(1);
      stop();
    });

    it("ends a live SSE stream when an event arrives while refused", async () => {
      useFreshTrial();
      const res = await fetch(`${baseUrl}/api/events`);
      expect(res.status).toBe(200);
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      await reader.read(); // ": connected"
      useExpired();
      _pushEventForTests(chatEvent("m-sse"));
      // Drain until the server ends the response.
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
      expect(getSubscriberCount()).toBe(0);
    });

    it("closes a live wake socket with 4403 and a short reason", async () => {
      useFreshTrial();
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/wake`);
      await new Promise<void>((resolve) => ws.on("open", () => resolve()));
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
      });
      useExpired();
      _pushEventForTests(chatEvent("m-ws"));
      const { code, reason } = await closed;
      expect(code).toBe(WAKE_CLOSE_LICENSE_REQUIRED);
      expect(reason).toBe(LICENSE_REQUIRED);
      expect(Buffer.byteLength(reason)).toBeLessThanOrEqual(123);
    });
  });

  /**
   * `/health`'s delivery state under a refusal (#1521, PR 2). Both misreadings
   * need a forward outstanding at expiry: an ask recorded while licensed.
   * Refused events are never recorded, so the forward is pushed on a fresh
   * trial first. Each case flips back to a trial for the twin, which must read
   * the raw state again — the fix is read-time and must not stick.
   */
  describe("GET /health delivery while refused", () => {
    async function deliveryState(): Promise<string> {
      const res = await fetch(`${baseUrl}/health`);
      const body = (await res.json()) as { delivery?: { state: string } };
      if (!body.delivery) throw new Error("loopback /health carried no delivery");
      return body.delivery.state;
    }

    it("a revoked last consumer reads license-refused, not consumer-detached", async () => {
      resetDeliveryStateForTests();
      useFreshTrial();
      const sse = vi.fn();
      subscribe(sse, "external", { onRevoke: vi.fn() });
      _pushEventForTests(chatEvent("m-health-1"));
      expect(await deliveryState()).toBe("awaiting-poll");

      useExpired();
      _pushEventForTests(chatEvent("m-health-2")); // revokes the SSE consumer
      expect(getSubscriberCount()).toBe(0);
      expect(await deliveryState()).toBe("license-refused");

      useFreshTrial();
      expect(await deliveryState()).toBe("consumer-detached");
      resetDeliveryStateForTests();
    });

    it("a surviving no-onRevoke subscriber reads license-refused, not awaiting-poll", async () => {
      resetDeliveryStateForTests();
      useFreshTrial();
      const supervisorLike = vi.fn();
      subscribe(supervisorLike, "external");
      _pushEventForTests(chatEvent("m-health-3"));

      useExpired();
      _pushEventForTests(chatEvent("m-health-4"));
      expect(getSubscriberCount()).toBe(1);
      expect(await deliveryState()).toBe("license-refused");

      useFreshTrial();
      expect(await deliveryState()).toBe("awaiting-poll");
      unsubscribe(supervisorLike);
      resetDeliveryStateForTests();
    });
  });

  describe("the editor is never refused (#1521 acceptance)", () => {
    it("POST /api/scratchpad succeeds armed", async () => {
      const res = await fetch(`${baseUrl}/api/scratchpad`, {
        method: "POST",
        // The route's own CSRF gate (#1295) wants an allowlisted Origin.
        headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:5173" },
        body: JSON.stringify({ content: "keyless editing works" }),
      });
      expect(res.status).toBe(200);
    });

    it("POST /api/open with force: true succeeds armed", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-license-open-"));
      createdDirs.push(dir);
      const file = path.join(dir, "note.md");
      fs.writeFileSync(file, "# Note\n\nBody.\n");
      const first = await fetch(`${baseUrl}/api/open`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: file }),
      });
      expect(first.status).toBe(200);
      const forced = await fetch(`${baseUrl}/api/open`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: file, force: true }),
      });
      expect(forced.status).toBe(200);
      expect(await forced.text()).not.toContain(LICENSE_REQUIRED);
    });

    /**
     * The six document-mutating `/api` routes the browser drives (#1521
     * acceptance). Each probe asserts the route's REAL success body and the
     * state change it made, so it fails if the route is refused for any reason
     * — a `licenseGateMiddleware` remounted on it answers 403 LICENSE_REQUIRED
     * before the handler runs. "Not LICENSE_REQUIRED" alone would also pass on
     * a 400 from a malformed body, which proves nothing about the gate.
     *
     * The twin: every probe first proves, against this same server at this same
     * moment, that the AI IS being refused (`POST /mcp initialize` → -32003). A
     * fixture that silently resolved licensed would fail there rather than let
     * the success below read as "the editor survives restriction".
     */
    const ORIGIN = "http://127.0.0.1:5173";

    async function expectAiRefusedNow(): Promise<void> {
      const res = await postMcp(initBody("armed-twin"));
      expect(res.sessionId).toBeNull();
      expect(JSON.parse(res.text).error.code).toBe(LICENSE_REQUIRED_RPC_CODE);
    }

    async function postApi(route: string, body: unknown): Promise<{ status: number; json: any }> {
      const res = await fetch(`${baseUrl}${route}`, {
        method: "POST",
        // Four of the six carry `assertOriginAllowlisted` (#1121 F6); sending an
        // allowlisted Origin to the other two is what the browser does anyway.
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() };
    }

    function tmpFile(name: string, content: string | Buffer): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-license-routes-"));
      createdDirs.push(dir);
      const file = path.join(dir, name);
      fs.writeFileSync(file, content);
      return file;
    }

    async function openViaApi(file: string): Promise<string> {
      const res = await postApi("/api/open", { filePath: file });
      expect(res.status).toBe(200);
      return (res.json as { data: { documentId: string } }).data.documentId;
    }

    /** A pending Claude comment over "Hello" in an open "Hello world" doc. */
    async function openWithClaudeComment(): Promise<{ docId: string; annId: string }> {
      const docId = await openViaApi(tmpFile("annotated.md", "Hello world\n"));
      const doc = getOrCreateDocument(docId);
      const created = createAnnotationLifecycle(doc).create({
        anchored: rangeOf(0, 5, doc),
        content: "Swap the greeting",
      });
      return { docId, annId: created.annotation.id };
    }

    it("POST /api/document/reload succeeds armed and replaces the body", async () => {
      await expectAiRefusedNow();
      const docId = await openViaApi(tmpFile("reload.md", "Before reload.\n"));
      const res = await postApi("/api/document/reload", {
        documentId: docId,
        markdown: "After reload.\n",
      });
      expect(res).toEqual({ status: 200, json: { success: true } });
      expect(extractText(getOrCreateDocument(docId))).toBe("After reload.");
    });

    it("POST /api/external-conflict/resolve succeeds armed and clears the conflict", async () => {
      await expectAiRefusedNow();
      const docId = await openViaApi(tmpFile("conflict.md", "Mine.\n"));
      const doc = getOrCreateDocument(docId);
      const meta = doc.getMap(Y_MAP_DOCUMENT_META);
      // Seeded, because with nothing pending the handler answers success
      // without doing anything — a vacuous pass.
      withInternal(doc, () =>
        meta.set(Y_MAP_EXTERNAL_CONFLICT, {
          kind: "external-edit",
          diskChanged: true,
          detectedAt: Date.now(),
        } satisfies ExternalConflictState),
      );
      const res = await postApi("/api/external-conflict/resolve", {
        documentId: docId,
        choice: "keep",
      });
      expect(res).toEqual({ status: 200, json: { success: true } });
      expect(meta.has(Y_MAP_EXTERNAL_CONFLICT)).toBe(false);
    });

    it("POST /api/backups/restore succeeds armed and restores the snapshot", async () => {
      await expectAiRefusedNow();
      // Snapshot and restore must see ONE app-data dir: no useTrial() between.
      _resetDocBackupGateForTests();
      const file = tmpFile("restore.md", "Version one.\n");
      expect(await snapshotBeforeFirstWrite(file, { appDataDir: resolveAppDataDir() })).toBe(
        "written",
      );
      const [snapshot] = await listDocBackups(file, resolveAppDataDir());
      expect(snapshot).toBeDefined();
      fs.writeFileSync(file, "Version two.\n");
      const docId = await openViaApi(file);
      expect(extractText(getOrCreateDocument(docId))).toBe("Version two.");

      const res = await postApi("/api/backups/restore", {
        backup: snapshot.name,
        documentId: docId,
      });
      expect(res.status).toBe(200);
      expect(res.json.data.restoredFrom).toContain(snapshot.name);
      expect(extractText(getOrCreateDocument(docId))).toBe("Version one.");
      expect(fs.readFileSync(file, "utf8")).toBe("Version one.\n");
    });

    it("POST /api/annotation-reply succeeds armed and writes the reply", async () => {
      await expectAiRefusedNow();
      const { docId, annId } = await openWithClaudeComment();
      const res = await postApi("/api/annotation-reply", {
        documentId: docId,
        annotationId: annId,
        text: "Agreed, thanks.",
      });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({
        data: { replyId: expect.stringMatching(/^rpl_/), annotationId: annId },
      });
      const replies = getOrCreateDocument(docId).getMap(Y_MAP_ANNOTATION_REPLIES);
      expect(replies.get(res.json.data.replyId)).toMatchObject({
        annotationId: annId,
        author: "user",
        text: "Agreed, thanks.",
      });
    });

    it("POST /api/remove-annotation succeeds armed and removes the record", async () => {
      await expectAiRefusedNow();
      const { docId, annId } = await openWithClaudeComment();
      const annotations = getOrCreateDocument(docId).getMap(Y_MAP_ANNOTATIONS);
      expect(annotations.has(annId)).toBe(true);
      const res = await postApi("/api/remove-annotation", {
        documentId: docId,
        annotationId: annId,
      });
      expect(res).toEqual({ status: 200, json: { data: { removed: true, annotationId: annId } } });
      expect(annotations.has(annId)).toBe(false);
    });

    it(
      "POST /api/apply-changes succeeds armed and writes the accepted change",
      async () => {
        await expectAiRefusedNow();
        // The wire-codes fixture (#1823): a minimal .docx on disk and an
        // ACCEPTED suggestion over "Hello", registered directly — `.docx` opens
        // are dark in a release, and vitest's TANDEM_DOCX=1 keeps this path live.
        const file = tmpFile("apply.docx", await createMinimalDocx("Hello world"));
        const docId = "license-armed-apply";
        seedAcceptedSuggestion(getOrCreateDocument(docId));
        addDoc(docId, {
          id: docId,
          filePath: file,
          format: "docx",
          readOnly: false,
          source: "file",
        });
        setActiveDocId(docId);
        const before = fs.readFileSync(file);

        const res = await postApi("/api/apply-changes", { documentId: docId });
        expect(res.status).toBe(200);
        expect(res.json.data).toMatchObject({ applied: 1, rejected: 0 });
        expect(fs.readFileSync(file).equals(before)).toBe(false);
      },
      timeoutMs(60_000, 300_000),
    );
  });
});
