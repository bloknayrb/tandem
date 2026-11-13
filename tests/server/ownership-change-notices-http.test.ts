/**
 * Change notices through the real HTTP server (#2358, the change-notice PR,
 * R4.1): one record's queue is shared by every transport of it. Two
 * `initialize`s carrying the same `X-Claude-Session-Id` are two transports of
 * one `claude:` record, so whichever polls first is reported a notice, and
 * the other, with a fresh cursor, `"start"` or none, is not reported it again.
 * (In the in-process harness a caller is chosen by owner id, so "another
 * transport" there is only another cursor.)
 *
 * Platform: an in-memory fixture document with a synthetic path; loopback
 * HTTP on an allocated port. Nothing is gated.
 */

import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDoc, removeDoc } from "../../src/server/documents/registry-testing.js";
import { populateYDoc } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { closeMcpSession, startMcpServerHttp } from "../../src/server/mcp/server.js";
import { getDocOwner, resetOwnershipForTests } from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { allocPort } from "../helpers/alloc-port.js";

const MCP_ACCEPT = "application/json, text/event-stream";
const CLAUDE = "5d8b0a3f-2c4e-4f60-9b7c-1d2e3f4a5b6c";
const OWNER = `claude:${CLAUDE}`;
let httpServer: Server;
let baseUrl: string;
let nextId = 10;

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("TANDEM_OWNERSHIP", "1");
  const port = await allocPort();
  baseUrl = `http://127.0.0.1:${port}`;
  httpServer = await startMcpServerHttp(port, "127.0.0.1");
});

afterEach(async () => {
  await closeMcpSession();
  if (httpServer) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  resetOwnershipForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function initialize(): Promise<string> {
  const base = {
    "Content-Type": "application/json",
    Accept: MCP_ACCEPT,
    "X-Claude-Session-Id": CLAUDE,
  };
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: base,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "probe", version: "1.0.0" },
      },
    }),
  });
  const id = res.headers.get("mcp-session-id") ?? "";
  await res.text();
  await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { ...base, "mcp-session-id": id },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).then((r) => r.text());
  return id;
}

/** A tool call on one transport; its `structuredContent`. */
async function callTool(
  sessionId: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: MCP_ACCEPT,
      "mcp-session-id": sessionId,
      "X-Claude-Session-Id": CLAUDE,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = await res.text();
  expect(res.status, body).toBe(200);
  const line = body.split("\n").find((l) => l.startsWith("data: "));
  const message = JSON.parse(line ? line.slice("data: ".length) : body) as {
    result: { isError?: boolean; structuredContent?: Record<string, unknown> };
  };
  expect(message.result.isError, body).not.toBe(true);
  return message.result.structuredContent ?? {};
}

type Changed = Array<{ documentId: string; change: string; cause: string }>;
const changedOf = (inbox: Record<string, unknown>): Changed =>
  ((inbox.ownership as { changed?: Changed } | undefined)?.changed ?? []) as Changed;

describe("one record, two transports: one queue", () => {
  it('the transport that polls first is reported the notice; the other transport is not, with a fresh cursor, "start" or none', async () => {
    const first = await initialize();
    const second = await initialize();
    expect(first).not.toBe(second);

    const id = "change-http-d";
    const ydoc = getOrCreateDocument(id);
    populateYDoc(ydoc, "Hello world, this is a test document.");
    addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });

    await callTool(first, "tandem_comment", { from: 0, to: 5, text: "a claim", documentId: id });
    expect(getDocOwner(id)?.ownerId).toBe(OWNER);

    const reported = await callTool(second, "tandem_checkInbox", { cursor: "start" });
    expect(changedOf(reported)).toEqual([
      { documentId: id, change: "gained", cause: "your write claimed it" },
    ]);
    expect((reported.ownership as { holding: string[] }).holding).toEqual([id]);

    for (const args of [{ cursor: reported.cursor }, { cursor: "start" }, {}]) {
      for (const transport of [first, second]) {
        expect(changedOf(await callTool(transport, "tandem_checkInbox", args))).toEqual([]);
      }
    }
  });
});
