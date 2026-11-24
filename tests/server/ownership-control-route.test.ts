/**
 * The ownership routes (#2358 PR 5a, ADR-054; ownership design §10.1):
 * `POST /api/ownership` (Release and Assign of a document) and
 * `GET /api/ownership/owners`, through the real HTTP server.
 *
 * Flag off, both paths answer exactly as an unknown `/api` path does. Flag
 * on: Release applies the default rule and records a blocking `released`
 * loss; Assign gives the document as `assigned` and records `assigned`
 * (Assign to the holder is a no-op; a Release that leaves Tandem's Claude the
 * holder wakes nothing); the
 * no-op, `unknown-owner`, `owner-detached` and `busy` answers; the change
 * notices, read through the real `tandem_checkInbox`; the refusal copy a
 * released session gets on its next write; step 5's forward and frame; the
 * gates (origin, loopback, JSON body). The owners list names records by label
 * and display kind and documents by file name, never by owner id or path.
 *
 * Platform: in-memory fixture documents with synthetic paths; loopback HTTP
 * on an allocated port. Nothing is gated.
 */

import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addDoc, removeDoc } from "../../src/server/documents/registry-testing.js";
import { populateYDoc } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { handleOwnersList } from "../../src/server/mcp/routes/ownership.js";
import { closeMcpSession, startMcpServerHttp } from "../../src/server/mcp/server.js";
import {
  resetDocOpQueuesForTests,
  runDocOp,
  setDocOpWaitMsForTests,
} from "../../src/server/sessions/doc-op-queue.js";
import {
  getDocOwner,
  getOwnerRecord,
  noteTransportRegistered,
  ownershipSnapshotForTests,
  resetOwnershipForTests,
  setDocOwner,
  setOwnershipFrameSink,
  setOwnershipTransportMode,
  setStartOrWakeSink,
  setTandemPresenceSource,
  setTransportView,
  setWaitingProbe,
  setWakeObserverForTests,
  TANDEM_OWNER_ID,
  type TransportViewEntry,
} from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { API_OWNERSHIP, API_OWNERSHIP_OWNERS } from "../../src/shared/api-paths.js";
import { allocPort } from "../helpers/alloc-port.js";

const MCP_ACCEPT = "application/json, text/event-stream";
const CLAUDE = "7a1c2e3f-4b5d-4e6f-8a9b-0c1d2e3f4a5b";
const CLAUDE_OWNER = `claude:${CLAUDE}`;
const A = "bridge:term-a";
const B = "bridge:term-b";

let httpServer: Server | undefined;
let baseUrl = "";
let origin = "";
let nextId = 10;
/** Extra transports a test adds on top of the real registry's. */
let extraView: TransportViewEntry[] = [];

afterEach(async () => {
  await closeMcpSession();
  if (httpServer) await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  httpServer = undefined;
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  extraView = [];
  setWakeObserverForTests(undefined);
  setDocOpWaitMsForTests();
  resetDocOpQueuesForTests();
  resetOwnershipForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Boot the real HTTP server with ownership on (`"1"`) or off (`""`). */
async function boot(flag: "1" | ""): Promise<void> {
  // Literal calls, so the reviewed lists in ownership-module-seam.test.ts see them.
  if (flag === "1") vi.stubEnv("TANDEM_OWNERSHIP", "1");
  else vi.stubEnv("TANDEM_OWNERSHIP", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const port = await allocPort();
  baseUrl = `http://127.0.0.1:${port}`;
  origin = baseUrl;
  httpServer = await startMcpServerHttp(port, "127.0.0.1");
  setOwnershipTransportMode("http");
}

/**
 * Attach two bridge records, A and B, beside whatever the real registry
 * holds (the server wired its own view at boot; this wraps it).
 */
function attachTerminals(): void {
  extraView = [
    { ownerId: A, openStreams: 0 },
    { ownerId: B, openStreams: 0 },
  ];
  setTransportView(() => extraView);
  noteTransportRegistered(A, { recordKind: "bridge" });
  noteTransportRegistered(B, { recordKind: "bridge" });
}

function labelOf(ownerId: string): string {
  const record = getOwnerRecord(ownerId);
  if (!record) throw new Error(`no record ${ownerId}`);
  return record.label;
}

function openDoc(id: string): void {
  populateYDoc(getOrCreateDocument(id), "Hello world, this is a test document.");
  addDoc(id, {
    id,
    filePath: `/tmp/own-route/${id}.md`,
    format: "md",
    readOnly: false,
    source: "file",
  });
}

async function post(
  body: unknown,
  init: { origin?: string | null; contentType?: string; raw?: string } = {},
): Promise<{ status: number; json: unknown; text: string }> {
  const headers: Record<string, string> = {
    "Content-Type": init.contentType ?? "application/json",
  };
  if (init.origin !== null) headers.Origin = init.origin ?? origin;
  const res = await fetch(`${baseUrl}${API_OWNERSHIP}`, {
    method: "POST",
    headers,
    body: init.raw ?? JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

const losses = () => ownershipSnapshotForTests().losses;
const noticesOf = (ownerId: string) =>
  ownershipSnapshotForTests().changeNotices.find(([id]) => id === ownerId)?.[1] ?? [];

describe("flag off: the routes do not exist", () => {
  it("POST, OPTIONS and the owners GET answer exactly as an unknown /api path does", async () => {
    await boot("");
    const same = async (method: string, path: string, twin: string) => {
      const init = (): RequestInit => ({
        method,
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          "Access-Control-Request-Method": "POST",
        },
        ...(method === "POST"
          ? { body: JSON.stringify({ documentId: "x", action: "release" }) }
          : {}),
      });
      const real = await fetch(`${baseUrl}${path}`, init());
      const unknown = await fetch(`${baseUrl}${twin}`, init());
      const realText = (await real.text()).split(path).join("<path>");
      const unknownText = (await unknown.text()).split(twin).join("<path>");
      expect(real.status).toBe(unknown.status);
      expect(realText).toBe(unknownText);
      const headersOf = (r: Response) =>
        [...r.headers]
          .filter(([k]) => !["date", "content-length", "etag"].includes(k))
          .map(([k, v]) => [k, v.split(path).join("<path>").split(twin).join("<path>")]);
      expect(headersOf(real)).toEqual(headersOf(unknown));
    };
    await same("POST", API_OWNERSHIP, "/api/ownershiq");
    await same("OPTIONS", API_OWNERSHIP, "/api/ownershiq");
    await same("GET", API_OWNERSHIP_OWNERS, "/api/ownership/ownerz");
  });

  it("nothing is recorded and no record is created", async () => {
    await boot("");
    openDoc("dark-d");
    await post({ documentId: "dark-d", action: "release" });
    const snap = ownershipSnapshotForTests();
    expect(snap.ownerByDoc).toEqual([]);
    expect(snap.losses).toEqual([]);
    expect(snap.records).toEqual([]);
  });
});

describe("flag on: Release", () => {
  it("a document a terminal holds goes unowned while Tandem's Claude is not present, with a blocking released loss and a notice", async () => {
    await boot("1");
    attachTerminals();
    openDoc("rel-1");
    setDocOwner("rel-1", { ownerId: A, kind: "opened" }, "take", A);
    const seenA = noticesOf(A).length;

    const res = await post({ documentId: "rel-1", action: "release" });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({ data: { changed: true } });
    expect(getDocOwner("rel-1")).toBeUndefined();
    expect(losses()).toEqual([["rel-1", { ownerId: A, cause: "released" }]]);
    expect(noticesOf(A).slice(seenA)).toEqual([
      { documentId: "rel-1", change: "lost", cause: "it was released" },
    ]);
  });

  it("while Tandem's Claude is present the document goes to it as default, and waiting work is forwarded", async () => {
    await boot("1");
    attachTerminals();
    setTandemPresenceSource(() => true);
    setWaitingProbe(() => true);
    const forwarded: string[] = [];
    setStartOrWakeSink((cause) => forwarded.push(cause));
    const causes: string[] = [];
    setWakeObserverForTests((cause) => causes.push(cause));
    openDoc("rel-2");
    setDocOwner("rel-2", { ownerId: A, kind: "claimed" }, "poll-claim", A);

    const res = await post({ documentId: "rel-2", action: "release" });
    expect(res.json).toEqual({ data: { changed: true } });
    expect(getDocOwner("rel-2")).toMatchObject({ ownerId: TANDEM_OWNER_ID, kind: "default" });
    expect(losses()).toEqual([["rel-2", { ownerId: A, cause: "released" }]]);
    expect(causes).toContain("release");
    expect(forwarded).toEqual(["document"]);
  });

  it("a release to unowned with work waiting sends the ownership frame", async () => {
    await boot("1");
    attachTerminals();
    setWaitingProbe(() => true);
    const frames = vi.fn();
    setOwnershipFrameSink(frames);
    openDoc("rel-3");
    setDocOwner("rel-3", { ownerId: A, kind: "opened" }, "take", A);
    await post({ documentId: "rel-3", action: "release" });
    expect(frames).toHaveBeenCalledTimes(1);
  });

  it("no-ops: an unowned document, and a default document while Tandem's Claude is present", async () => {
    await boot("1");
    openDoc("noop-1");
    const unowned = await post({ documentId: "noop-1", action: "release" });
    expect(unowned.json).toEqual({ data: { changed: false } });
    expect(losses()).toEqual([]);

    setTandemPresenceSource(() => true);
    setDocOwner("noop-1", { ownerId: TANDEM_OWNER_ID, kind: "default" }, "presence");
    const held = await post({ documentId: "noop-1", action: "release" });
    expect(held.json).toEqual({ data: { changed: false } });
    expect(getDocOwner("noop-1")).toMatchObject({ ownerId: TANDEM_OWNER_ID, kind: "default" });
  });

  it("a release of an entry whose record is gone clears it and applies the default rule: changed", async () => {
    await boot("1");
    setTandemPresenceSource(() => true);
    openDoc("rel-stale");
    // An entry for a record that does not exist (the stale backstop's case).
    setDocOwner("rel-stale", { ownerId: "bridge:gone", kind: "opened" }, "take", "bridge:gone");
    expect(getOwnerRecord("bridge:gone")).toBeUndefined();
    const res = await post({ documentId: "rel-stale", action: "release" });
    expect(res.json).toEqual({ data: { changed: true } });
    expect(getDocOwner("rel-stale")).toMatchObject({ ownerId: TANDEM_OWNER_ID, kind: "default" });
  });

  it("a release that leaves Tandem's Claude the holder (assigned to default) starts or wakes nothing and sends no frame", async () => {
    // Bryan's pick "Skip the wake (Recommended)" (2026-11-23): only a change
    // of holder forwards or frames.
    await boot("1");
    attachTerminals();
    setTandemPresenceSource(() => true);
    setWaitingProbe(() => true);
    const forwarded: string[] = [];
    setStartOrWakeSink((cause) => forwarded.push(cause));
    const causes: string[] = [];
    setWakeObserverForTests((cause) => causes.push(cause));
    const frames = vi.fn();
    setOwnershipFrameSink(frames);
    openDoc("rel-same");
    setDocOwner("rel-same", { ownerId: A, kind: "opened" }, "take", A);
    const assigned = await post({
      documentId: "rel-same",
      action: "assign",
      ownerLabel: labelOf(TANDEM_OWNER_ID),
    });
    expect(assigned.json).toEqual({ data: { changed: true } });
    expect(forwarded).toEqual(["document"]);
    forwarded.length = 0;
    causes.length = 0;
    frames.mockClear();
    const lossesBefore = losses();

    const res = await post({ documentId: "rel-same", action: "release" });
    expect(res.json).toEqual({ data: { changed: true } });
    expect(getDocOwner("rel-same")).toMatchObject({ ownerId: TANDEM_OWNER_ID, kind: "default" });
    expect(causes).toEqual([]);
    expect(forwarded).toEqual([]);
    expect(frames).not.toHaveBeenCalled();
    expect(losses()).toEqual(lossesBefore);
  });

  it("the released session's next write is refused with the released copy, which never says the user chose it", async () => {
    await boot("1");
    const session = await initialize();
    openDoc("rel-write");
    await callTool(session, "tandem_comment", {
      from: 0,
      to: 5,
      text: "claims it",
      documentId: "rel-write",
    });
    expect(getDocOwner("rel-write")?.ownerId).toBe(CLAUDE_OWNER);

    expect((await post({ documentId: "rel-write", action: "release" })).status).toBe(200);
    // Told through the real poll, as a past-tense fact.
    const inbox = await callTool(session, "tandem_checkInbox", { cursor: "start" });
    const changed = (inbox.ownership as { changed?: unknown[] } | undefined)?.changed ?? [];
    expect(changed).toContainEqual({
      documentId: "rel-write",
      change: "lost",
      cause: "it was released",
    });

    const refused = await callToolRaw(session, "tandem_comment", {
      from: 0,
      to: 5,
      text: "again",
      documentId: "rel-write",
    });
    const text = JSON.stringify(refused);
    expect(text).toContain("NOT_DOC_OWNER");
    expect(text).toContain("This document was released from you.");
    expect(text).not.toMatch(/the user (released|chose)/i);
    expect(getDocOwner("rel-write")).toBeUndefined();
  });

  it("the released session's polls say an earlier request no longer counts, as the released refusal does", async () => {
    await boot("1");
    const session = await initialize();
    openDoc("rel-poll");
    await callTool(session, "tandem_comment", {
      from: 0,
      to: 5,
      text: "claims it",
      documentId: "rel-poll",
    });
    expect((await post({ documentId: "rel-poll", action: "release" })).status).toBe(200);

    // A default poll leaves it out and names it as released.
    const all = await callTool(session, "tandem_checkInbox", { cursor: "start" });
    expect(String(all.summary)).toContain(
      "released from you, so an earlier request from the user does not count for it: call tandem_open on it only if the user asks you again after that.",
    );
    // A named poll says it of this document.
    const named = await callTool(session, "tandem_checkInbox", { documentId: "rel-poll" });
    expect(String(named.summary)).toContain(
      "This document was released from you, so an earlier request from the user does not count: call tandem_open on it only if the user asks you again after that.",
    );
    // Neither claims Tandem's Claude took it.
    expect(String(all.summary)).not.toContain("Tandem's Claude took");
    expect(String(named.summary)).not.toContain("Tandem's Claude took");
  });
});

describe("flag on: Assign", () => {
  it("gives the document to the named session as assigned, with notices both ways and a blocking loss", async () => {
    await boot("1");
    attachTerminals();
    setWaitingProbe(() => true);
    const frames = vi.fn();
    setOwnershipFrameSink(frames);
    openDoc("as-1");
    setDocOwner("as-1", { ownerId: A, kind: "opened" }, "take", A);
    const seenA = noticesOf(A).length;

    const res = await post({ documentId: "as-1", action: "assign", ownerLabel: labelOf(B) });
    expect(res.json).toEqual({ data: { changed: true } });
    expect(getDocOwner("as-1")).toMatchObject({ ownerId: B, kind: "assigned" });
    expect(losses()).toEqual([["as-1", { ownerId: A, cause: "assigned" }]]);
    expect(noticesOf(A).slice(seenA)).toEqual([
      { documentId: "as-1", change: "lost", cause: "it was assigned to another session" },
    ]);
    expect(noticesOf(B)).toEqual([
      { documentId: "as-1", change: "gained", cause: "it was assigned to this session" },
    ]);
    // Work waits and the new owner is not the caller: the frame (step 5).
    expect(frames).toHaveBeenCalledTimes(1);
  });

  it("to Tandem's Claude while present: forwarded to start-or-wake for waiting work", async () => {
    await boot("1");
    attachTerminals();
    setTandemPresenceSource(() => true);
    setWaitingProbe(() => true);
    const forwarded: string[] = [];
    setStartOrWakeSink((cause) => forwarded.push(cause));
    openDoc("as-t");
    setDocOwner("as-t", { ownerId: A, kind: "opened" }, "take", A);
    const res = await post({
      documentId: "as-t",
      action: "assign",
      ownerLabel: labelOf(TANDEM_OWNER_ID),
    });
    expect(res.json).toEqual({ data: { changed: true } });
    expect(getDocOwner("as-t")).toMatchObject({ ownerId: TANDEM_OWNER_ID, kind: "assigned" });
    expect(forwarded).toEqual(["document"]);
  });

  it("to Tandem's Claude while not present: owner-detached, nothing changes", async () => {
    await boot("1");
    openDoc("as-off");
    const res = await post({
      documentId: "as-off",
      action: "assign",
      ownerLabel: labelOf(TANDEM_OWNER_ID),
    });
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: "owner-detached" });
    expect(getDocOwner("as-off")).toBeUndefined();
  });

  it("Assign to the session that already holds it is a no-op whatever kind of hold it is", async () => {
    // Bryan's pick "Do nothing" (2026-11-23): never an upgrade to `assigned`.
    await boot("1");
    attachTerminals();
    setTandemPresenceSource(() => true);
    setWaitingProbe(() => true);
    const forwarded: string[] = [];
    setStartOrWakeSink((cause) => forwarded.push(cause));
    const frames = vi.fn();
    setOwnershipFrameSink(frames);
    const holds = [
      ["as-claimed", A, "claimed"],
      ["as-opened", A, "opened"],
      ["as-assigned", A, "assigned"],
      ["as-default", TANDEM_OWNER_ID, "default"],
    ] as const;
    for (const [id, ownerId, kind] of holds) {
      openDoc(id);
      setDocOwner(id, { ownerId, kind }, "presence");
    }
    // The setup's own step 5 (a `presence` change forwards) is not under test.
    forwarded.length = 0;
    frames.mockClear();
    const seenA = noticesOf(A).length;
    const before = holds.map(([id]) => getDocOwner(id));

    for (const [id, ownerId] of holds) {
      const res = await post({ documentId: id, action: "assign", ownerLabel: labelOf(ownerId) });
      expect(res.json, id).toEqual({ data: { changed: false } });
    }
    expect(holds.map(([id]) => getDocOwner(id))).toEqual(before);
    expect(noticesOf(A).slice(seenA)).toEqual([]);
    expect(losses()).toEqual([]);
    expect(forwarded).toEqual([]);
    expect(frames).not.toHaveBeenCalled();
  });

  it("an unknown label is 404 unknown-owner; a session in its grace is 409 owner-detached", async () => {
    await boot("1");
    attachTerminals();
    openDoc("as-3");
    const unknown = await post({ documentId: "as-3", action: "assign", ownerLabel: "owner-zzzz" });
    expect(unknown.status).toBe(404);
    expect(unknown.json).toEqual({ error: "unknown-owner" });

    // B held a stream once and has none open now: detached, in its grace.
    extraView = [
      { ownerId: A, openStreams: 0 },
      { ownerId: B, openStreams: 0, streamEver: true },
    ];
    noteTransportRegistered(B, { recordKind: "bridge" });
    const detached = await post({ documentId: "as-3", action: "assign", ownerLabel: labelOf(B) });
    expect(detached.status).toBe(409);
    expect(detached.json).toEqual({ error: "owner-detached" });
    expect(getDocOwner("as-3")).toBeUndefined();
  });
});

describe("flag on: the queue, the document and the gates", () => {
  it("409 busy when the document's operation does not settle within the wait, and the change is not queued", async () => {
    await boot("1");
    attachTerminals();
    openDoc("busy-1");
    setDocOwner("busy-1", { ownerId: A, kind: "opened" }, "take", A);
    setDocOpWaitMsForTests(50);
    let release!: () => void;
    const op = runDocOp("busy-1", () => new Promise<void>((r) => (release = r)));
    const res = await post({ documentId: "busy-1", action: "release" });
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: "busy" });
    release();
    await op;
    await new Promise((r) => setTimeout(r, 10));
    expect(getDocOwner("busy-1")?.ownerId).toBe(A);
    const retry = await post({ documentId: "busy-1", action: "release" });
    expect(retry.json).toEqual({ data: { changed: true } });
  });

  it("404 unknown-document for a document that is not open", async () => {
    await boot("1");
    const res = await post({ documentId: "not-open", action: "release" });
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: "unknown-document" });
  });

  it("400 for a malformed body, a message action, or a release naming an owner", async () => {
    await boot("1");
    openDoc("bad-1");
    for (const body of [
      {},
      { documentId: "bad-1" },
      { documentId: "bad-1", action: "take" },
      { documentId: "bad-1", action: "assign" },
      { documentId: "bad-1", action: "release", ownerLabel: "owner-abcd" },
      { messageId: "m1", action: "release" },
      ["bad-1"],
    ]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("a text/plain simple request never reaches the control (no parsed body)", async () => {
    await boot("1");
    attachTerminals();
    openDoc("plain-1");
    setDocOwner("plain-1", { ownerId: A, kind: "opened" }, "take", A);
    const res = await post(undefined, {
      contentType: "text/plain",
      raw: JSON.stringify({ documentId: "plain-1", action: "release" }),
    });
    expect(res.status).toBe(400);
    expect(getDocOwner("plain-1")?.ownerId).toBe(A);
  });

  it("an origin off the allowlist, or none, is refused before anything is read", async () => {
    await boot("1");
    attachTerminals();
    openDoc("origin-1");
    setDocOwner("origin-1", { ownerId: A, kind: "opened" }, "take", A);
    for (const o of ["http://evil.example", null]) {
      const res = await post({ documentId: "origin-1", action: "release" }, { origin: o });
      expect(res.status).toBe(403);
    }
    expect(getDocOwner("origin-1")?.ownerId).toBe(A);
  });
});

describe("flag on: GET /api/ownership/owners", () => {
  it("lists attached sessions and Tandem's Claude while present, by label and display kind, holds as file names", async () => {
    await boot("1");
    attachTerminals();
    setTandemPresenceSource(() => true);
    openDoc("list-1");
    setDocOwner("list-1", { ownerId: A, kind: "opened" }, "take", A);
    const res = await fetch(`${baseUrl}${API_OWNERSHIP_OWNERS}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const { data } = JSON.parse(text) as {
      data: Array<{ label: string; displayKind: string; holds: string[]; canTake: boolean }>;
    };
    const byLabel = new Map(data.map((o) => [o.label, o]));
    expect(byLabel.get(labelOf(A))).toEqual({
      label: labelOf(A),
      displayKind: "other app",
      holds: ["list-1.md"],
      canTake: true,
    });
    expect(byLabel.get(labelOf(B))?.holds).toEqual([]);
    expect(byLabel.get(labelOf(TANDEM_OWNER_ID))?.displayKind).toBe("Tandem's Claude");
    expect(data).toHaveLength(3);
    // Never an owner id, never a path.
    expect(text).not.toContain("bridge:");
    expect(text).not.toContain("/tmp/");
  });

  it("leaves out a session in its grace and Tandem's Claude while not present", async () => {
    await boot("1");
    attachTerminals();
    extraView = [
      { ownerId: A, openStreams: 0 },
      { ownerId: B, openStreams: 0, streamEver: true },
    ];
    noteTransportRegistered(B, { recordKind: "bridge" });
    const res = await fetch(`${baseUrl}${API_OWNERSHIP_OWNERS}`);
    const { data } = (await res.json()) as { data: Array<{ label: string }> };
    expect(data.map((o) => o.label)).toEqual([labelOf(A)]);
  });

  it("a non-loopback peer is refused 403 by the handler's own address check", () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "1");
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const req = { socket: { remoteAddress: "192.168.1.50" } } as never;
    handleOwnersList(req, { status, json } as never);
    expect(status).toHaveBeenCalledWith(403);
  });
});

// ---------------------------------------------------------------------------
// MCP helpers (as in ownership-change-notices-http.test.ts).

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

async function callToolRaw(
  sessionId: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError?: boolean; structuredContent?: Record<string, unknown>; content?: unknown }> {
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
  return (
    JSON.parse(line ? line.slice("data: ".length) : body) as {
      result: { isError?: boolean; structuredContent?: Record<string, unknown> };
    }
  ).result;
}

async function callTool(
  sessionId: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = await callToolRaw(sessionId, name, args);
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return result.structuredContent ?? {};
}
