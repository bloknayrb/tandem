/**
 * The pull tools send only the shape they advertise (#2465).
 *
 * `tandem_checkInbox` and `tandem_getAnnotations` declare output schemas whose
 * objects all carry `additionalProperties: false` once the SDK turns them into
 * JSON Schema at `tools/list`. A client that validates (the SDK client after
 * `listTools()`, and Claude Code) rejects the WHOLE response when any object in
 * it carries a key the schema does not declare, while the server's own checks
 * are strip-mode zod and object to nothing. No test before this file put an
 * undeclared field on a record and read it through a validating client, which
 * is why the bug shipped.
 *
 * The harness, and why each part of it is there:
 * - Durable open (`openFromDisk`), so the close-and-reopen reproduction runs
 *   the real envelope. The platform mock repoints the app-data dir, so the
 *   file tears it down with `teardownFileAppDataDir()` (the wiring test
 *   enforces that).
 * - `client.listTools()` before any call: the SDK client only validates a tool
 *   whose schema it has cached.
 * - `registerTestCallerRecord()` + `ownershipTestDispatch`: with ownership on
 *   (CI's `ownership-flag-on` job), a poll by a caller with no record reads no
 *   document, and every case here would pass empty.
 * - The mode is written `"tandem"` before any fixture: with the key absent the
 *   state is indeterminate, `hideFromAI` holds marked records, and a case
 *   could pass for the wrong reason.
 * - Every poll passes `cursor: "start"` except the one cursor-less chat poll
 *   on fresh state: a cursor-less poll stamps its items before the client
 *   rejects, so a SECOND one succeeds empty and hides the bug.
 * - Fixture `relRange`s are minted live with `anchoredRange` and the `range`
 *   it returns is kept, so the read path's refresh takes its `ok` arm and
 *   writes nothing — the stored-record checks compare a `structuredClone`
 *   taken before the call, never the live object against itself.
 */

import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Request, Response } from "express";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";

vi.mock(import("../../src/server/platform"), async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/platform")>();
  const osMod = await import("os");
  const pathMod = await import("path");
  const cryptoMod = await import("crypto");
  const appDataDir = pathMod.join(
    osMod.tmpdir(),
    `tandem-declared-shape-${cryptoMod.randomUUID()}`,
  );
  process.env.TANDEM_APP_DATA_DIR = appDataDir;
  return { ...original, SESSION_DIR: pathMod.join(appDataDir, "sessions") };
});

// Real fs.watch leaks handles and races the tests' own writes.
vi.mock(import("../../src/server/file-watcher"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/file-watcher")>()),
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
}));

import { docHash } from "../../src/server/annotations/doc-hash.js";
import { addUserReply } from "../../src/server/annotations/lifecycle.js";
import { closeStore, resetForTesting as storeReset } from "../../src/server/annotations/store.js";
import { openFromDisk } from "../../src/server/documents/open.js";
import { removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import {
  attachObservers,
  detachObservers,
  resetForTesting as resetEventQueue,
} from "../../src/server/events/queue.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { registerAwarenessTools, resetInbox } from "../../src/server/mcp/awareness.js";
import { extractText } from "../../src/server/mcp/document.js";
import { closeDocumentById, getOpenDocs } from "../../src/server/mcp/document-service.js";
import { handleModeRelease } from "../../src/server/mcp/routes/mode-release.js";
import {
  __resetLocalPeriodForTests,
  __setHonourLocalPeriodRecordsForTests,
} from "../../src/server/models/local-period.js";
import { SESSION_DIR } from "../../src/server/platform.js";
import { anchoredRange } from "../../src/server/positions.js";
import { resetOwnershipForTests } from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument, removeDocument } from "../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
  Y_MAP_CHAT,
} from "../../src/shared/constants.js";
import { withBrowser, withInternal, withMcp } from "../../src/shared/origins.js";
import { sanitizeAnnotation } from "../../src/shared/sanitize.js";
import { teardownFileAppDataDir } from "../helpers/app-data-teardown.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { setupMcpServer } from "../helpers/mcp-harness.js";
import { ownershipTestDispatch, registerTestCallerRecord } from "../helpers/ownership-caller.js";
import { off } from "../helpers/positions.js";

// Flag on, a poll reads only what its caller's record holds or may claim.
registerTestCallerRecord();

const DOC_TEXT = "Alpha paragraph text for the inbox.\n\nBeta paragraph follows here.\n";
const TARGET = "paragraph text";

let tmpDir: string;
let client: Client;
let close: (() => Promise<void>) | undefined;
/** Every document a case opened, as `{ documentId, resolved }`, for teardown. */
let opened: Array<{ documentId: string; resolved: string }> = [];

function ctrl(): Y.Doc {
  return getOrCreateDocument(CTRL_ROOM);
}

function clearChat(): void {
  const chat = ctrl().getMap(Y_MAP_CHAT);
  withInternal(ctrl(), () => {
    for (const key of [...chat.keys()]) chat.delete(key);
  });
}

beforeEach(async () => {
  for (const id of [...getOpenDocs().keys()]) {
    removeDoc(id);
    removeDocument(id);
  }
  setActiveDocId(null);
  storeReset();
  resetInbox();
  resetEventQueue();
  __resetLocalPeriodForTests();
  clearChat();
  opened = [];
  // The native realpath, so the root is the long spelling on every host
  // (an 8.3 TEMP alias on Windows would otherwise key the store differently
  // from the open pipeline, #2400).
  tmpDir = fsSync.realpathSync.native(
    await fs.mkdtemp(path.join(os.tmpdir(), "tandem-declared-shape-")),
  );
  await fs.rm(SESSION_DIR, { recursive: true, force: true }).catch(() => {});
  // Mode first: see the header.
  setCtrlMode("tandem");
  ({ client, close } = await setupMcpServer([registerAwarenessTools, registerAnnotationTools], {
    dispatch: ownershipTestDispatch,
  }));
  // The SDK client validates a tool's structured output only once it has
  // cached the tool's schema from tools/list, as a real client does.
  await client.listTools();
});

afterEach(async () => {
  await close?.();
  close = undefined;
  for (const { documentId, resolved } of opened) {
    await closeStore(docHash(resolved));
    if (getOpenDocs().has(documentId)) await closeDocumentById(documentId);
  }
  __setHonourLocalPeriodRecordsForTests(null);
  resetOwnershipForTests();
  setCtrlMode(null);
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

afterAll(async () => {
  // RESTORE, never `delete` — see the helper.
  await teardownFileAppDataDir();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function writeDoc(name = "doc.md"): Promise<{ filePath: string; resolved: string }> {
  const filePath = path.join(tmpDir, name);
  // Unique content per case: the store's rename recovery matches a new path
  // to an old envelope by content, and would carry earlier cases' records in.
  await fs.writeFile(filePath, `${DOC_TEXT}\nCase ${path.basename(tmpDir)}.\n`);
  // The JS realpath, the flavour the open pipeline hashes (#2400; never mix
  // it with the native one). `tmpDir` is already the long spelling.
  return { filePath, resolved: fsSync.realpathSync(filePath) };
}

interface Opened {
  documentId: string;
  resolved: string;
  filePath: string;
  doc: Y.Doc;
}

async function openDoc(name = "doc.md"): Promise<Opened> {
  const { filePath, resolved } = await writeDoc(name);
  return reopen(filePath, resolved);
}

async function reopen(filePath: string, resolved: string): Promise<Opened> {
  const result = await openFromDisk(filePath);
  opened.push({ documentId: result.documentId, resolved });
  return {
    documentId: result.documentId,
    resolved,
    filePath,
    doc: getOrCreateDocument(result.documentId),
  };
}

async function closeDoc(o: Opened): Promise<void> {
  await closeStore(docHash(o.resolved));
  expect((await closeDocumentById(o.documentId)).success).toBe(true);
}

/**
 * A live anchor over `TARGET`: the range the anchors resolve to, its relRange
 * and the text at it, so the read path's refresh takes its `ok` arm.
 */
function liveAnchor(doc: Y.Doc) {
  const text = extractText(doc);
  const from = text.indexOf(TARGET);
  expect(from, "the target text is in the document").toBeGreaterThanOrEqual(0);
  const to = from + TARGET.length;
  const anchored = anchoredRange(doc, off(from), off(to), TARGET);
  if (!anchored.ok || !anchored.relRange) throw new Error("could not anchor the fixture");
  return { range: anchored.range, relRange: anchored.relRange, textSnapshot: TARGET };
}

/** Write a record the way the browser does. */
function browserWrite(doc: Y.Doc, map: string, id: string, record: Record<string, unknown>): void {
  withBrowser(doc, () => doc.getMap(map).set(id, record));
}

function stored(doc: Y.Doc, id: string, map = Y_MAP_ANNOTATIONS): unknown {
  return structuredClone(doc.getMap(map).get(id));
}

/** `value` as it reads after the wire (JSON), for deep comparisons. */
function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

type Item = Record<string, unknown>;
interface InboxData {
  userActions: Item[];
  userResponses: Item[];
  userReplies: Item[];
  chatMessages: Item[];
  [key: string]: unknown;
}

/**
 * Call a tool through the validating client and return both parts of the
 * result: `structuredContent`, and the text envelope's `data`. Throws (as the
 * SDK client does) when the structured output fails the advertised schema.
 */
async function call(
  name: string,
  args: Record<string, unknown>,
): Promise<{ structured: Record<string, unknown>; text: Record<string, unknown> }> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content: Array<{ type: string; text?: string }>;
  };
  // The SDK skips its output check on an error result, so "did not throw" is
  // not success on its own.
  expect(result.isError ?? false, JSON.stringify(result)).toBe(false);
  const envelope = JSON.parse(result.content.find((c) => c.type === "text")?.text ?? "null") as {
    error: boolean;
    data: Record<string, unknown>;
  };
  expect(envelope.error).toBe(false);
  expect(result.structuredContent).toBeDefined();
  return { structured: result.structuredContent as Record<string, unknown>, text: envelope.data };
}

async function poll(args: Record<string, unknown> = { cursor: "start" }) {
  const { structured, text } = await call("tandem_checkInbox", args);
  return { inbox: structured as InboxData, text: text as InboxData };
}

/** Every key `carried` holds arrives on `item` with an equal (wire) value. */
function expectCarried(item: Item, carried: Record<string, unknown>, label: string): void {
  for (const [key, value] of Object.entries(wire(carried))) {
    expect(item[key], `${label}: ${key}`).toEqual(value);
  }
}

// ---------------------------------------------------------------------------
// Commit 1: characterization (green on master)
// ---------------------------------------------------------------------------

/**
 * One stray-free user comment carrying every declared field a client-written
 * record can carry. Declared fields left out: `color` (sanitize drops it from
 * comments), getAnnotations' `anchor` (needs a degraded refresh), and
 * `edited` / `alreadyPushed` (server-set).
 */
function fullUserComment(doc: Y.Doc, id: string): Record<string, unknown> {
  return {
    id,
    author: "user",
    type: "comment",
    audience: "outbound",
    ...liveAnchor(doc),
    content: "please tighten this",
    status: "pending",
    timestamp: 1_700_000_000_000,
    textSnapshotTruncated: false,
    textSnapshotBreaks: [{ at: 5, kind: "hard" }],
    editedAt: 1_700_000_000_500,
    rev: 3,
    resolvedBy: "user",
    acceptedReplyId: "reply-accepted",
    priorSuggestedText: null,
    promotedFrom: "note",
    importSource: { author: "Reviewer", file: "review.docx", commentId: "7" },
    suggestedText: "tighter text",
  };
}

describe("characterization: every declared field arrives with its value", () => {
  it("tandem_checkInbox hands the full user comment with every carried key equal", async () => {
    const o = await openDoc();
    const record = fullUserComment(o.doc, "full-comment");
    browserWrite(o.doc, Y_MAP_ANNOTATIONS, "full-comment", record);
    const before = stored(o.doc, "full-comment");

    const { inbox } = await poll();

    expect(inbox.userActions.map((a) => a.id)).toEqual(["full-comment"]);
    const item = inbox.userActions[0];
    expectCarried(item, record, "userActions");
    expect(item.documentId).toBe(o.documentId);
    expect(item.textSnippet).toBe(TARGET);
    expect(stored(o.doc, "full-comment"), "the read wrote nothing").toEqual(before);
  });

  it("tandem_getAnnotations returns the full user comment, a user reply and a Claude reply", async () => {
    const o = await openDoc();
    const record = fullUserComment(o.doc, "full-comment");
    browserWrite(o.doc, Y_MAP_ANNOTATIONS, "full-comment", record);
    const userReply = {
      id: "reply-user",
      annotationId: "full-comment",
      author: "user",
      text: "and this part",
      timestamp: 1_700_000_001_000,
      editedAt: 1_700_000_001_500,
      rev: 2,
    };
    const claudeReply = {
      id: "reply-claude",
      annotationId: "full-comment",
      author: "claude",
      text: "how about this",
      timestamp: 1_700_000_002_000,
      rev: 1,
      suggestedText: "a proposal",
    };
    browserWrite(o.doc, Y_MAP_ANNOTATION_REPLIES, "reply-user", userReply);
    withInternal(o.doc, () =>
      o.doc.getMap(Y_MAP_ANNOTATION_REPLIES).set("reply-claude", claudeReply),
    );
    const before = stored(o.doc, "full-comment");

    const { structured } = await call("tandem_getAnnotations", { documentId: o.documentId });
    const annotations = structured.annotations as Item[];

    expect(annotations.map((a) => a.id)).toEqual(["full-comment"]);
    const item = annotations[0];
    expectCarried(item, record, "getAnnotations");
    expect(item.anchor, "a healthy refresh carries no anchor verdict").toBeUndefined();
    const replies = item.replies as Item[];
    expect(replies.map((r) => r.id).sort()).toEqual(["reply-claude", "reply-user"]);
    expectCarried(replies.find((r) => r.id === "reply-user") as Item, userReply, "user reply");
    expectCarried(
      replies.find((r) => r.id === "reply-claude") as Item,
      claudeReply,
      "claude reply",
    );
    expect(stored(o.doc, "full-comment"), "the read wrote nothing").toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Commit 2: the reproduction (A1), agentIdentity (A2) and the walk (A3)
// ---------------------------------------------------------------------------

const AGENT_IDENTITY = { provider: "openai", displayName: "A local helper" };

/** A user comment as the browser writes it, over the live anchor. */
function userComment(doc: Y.Doc, id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    author: "user",
    type: "comment",
    audience: "outbound",
    ...liveAnchor(doc),
    content: `comment ${id}`,
    status: "pending",
    timestamp: 1_700_000_000_000,
    rev: 1,
    ...extra,
  };
}

/** `POST /api/mode/release` from the editor's own origin, as the client sends it. */
function release(): { status: number; body: unknown } {
  const captured = { status: 200, body: undefined as unknown };
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
  } as unknown as Response;
  handleModeRelease(
    {
      headers: { origin: "http://127.0.0.1:5173" },
      socket: { remoteAddress: "127.0.0.1" },
      body: {},
    } as unknown as Request,
    res,
  );
  return captured;
}

/**
 * A1's assertions: the poll succeeded through the validating client (`call`
 * checks that), `userActions` holds the comment without the marker, and the
 * text part carries no marker either (catches a build that strips only
 * `structuredContent`).
 */
async function expectHandedWithoutMarker(o: Opened, id: string): Promise<void> {
  const { inbox, text } = await poll();
  expect(inbox.userActions.map((a) => a.id)).toEqual([id]);
  const item = inbox.userActions[0];
  expect(item.content).toBe(`comment ${id}`);
  expect(item.textSnippet).toBe(TARGET);
  expect(item.documentId).toBe(o.documentId);
  expect("heldInSolo" in item, "structuredContent").toBe(false);
  expect(text.userActions.map((a) => a.id)).toEqual([id]);
  expect("heldInSolo" in text.userActions[0], "the text part").toBe(false);
  expect(text.userActions[0]).toEqual(item);
  const marker = (o.doc.getMap(Y_MAP_ANNOTATIONS).get(id) as { heldInSolo?: unknown }).heldInSolo;
  expect(marker, "the stored record still carries the marker").toBe(true);
}

describe("A1: a stale heldInSolo marker no longer fails the poll", () => {
  it("a Solo comment on a tab closed before the switch to Tandem, then reopened", async () => {
    setCtrlMode("solo");
    const first = await openDoc();
    // The client's own stamp is enough: the server stamp skips a record that
    // already carries it.
    browserWrite(
      first.doc,
      Y_MAP_ANNOTATIONS,
      "solo-closed",
      userComment(first.doc, "solo-closed", { heldInSolo: true }),
    );
    await closeDoc(first);

    setCtrlMode("tandem");
    // The release sweeps OPEN documents only, so it clears nothing here.
    const released = release();
    expect(released.status).toBe(200);
    expect(released.body).toEqual({ data: { released: 0 } });

    const second = await reopen(first.filePath, first.resolved);
    const raw = second.doc.getMap(Y_MAP_ANNOTATIONS).get("solo-closed") as Record<string, unknown>;
    expect(raw?.heldInSolo, "the envelope kept the marker through the reopen").toBe(true);

    await expectHandedWithoutMarker(second, "solo-closed");
  });

  it("the same, with the marker written by the server's stamp observer", async () => {
    setCtrlMode("solo");
    const first = await openDoc();
    // `openFromDisk` does not attach the event-queue observers (Hocuspocus's
    // doc swap does in production), so attach them as that would.
    attachObservers(first.documentId, first.doc);
    try {
      browserWrite(
        first.doc,
        Y_MAP_ANNOTATIONS,
        "solo-stamped",
        userComment(first.doc, "solo-stamped"),
      );
      const raw = first.doc.getMap(Y_MAP_ANNOTATIONS).get("solo-stamped") as Record<
        string,
        unknown
      >;
      expect(raw.heldInSolo, "the server stamped the Solo comment").toBe(true);
    } finally {
      detachObservers(first.documentId);
    }
    await closeDoc(first);

    setCtrlMode("tandem");
    const released = release();
    expect(released.status).toBe(200);
    expect(released.body).toEqual({ data: { released: 0 } });

    const second = await reopen(first.filePath, first.resolved);
    await expectHandedWithoutMarker(second, "solo-stamped");
  });

  it("a Solo comment on an open document polled after the switch, before any release", async () => {
    setCtrlMode("solo");
    const o = await openDoc();
    browserWrite(
      o.doc,
      Y_MAP_ANNOTATIONS,
      "solo-open",
      userComment(o.doc, "solo-open", { heldInSolo: true }),
    );
    // The client's mode write has landed; its release POST has not (or failed twice).
    setCtrlMode("tandem");
    await expectHandedWithoutMarker(o, "solo-open");
  });
});

describe("A2: agentIdentity is stripped from inbox items", () => {
  it("positive control: a user comment carrying agentIdentity is handed without it", async () => {
    const o = await openDoc();
    browserWrite(
      o.doc,
      Y_MAP_ANNOTATIONS,
      "with-agent",
      userComment(o.doc, "with-agent", { agentIdentity: AGENT_IDENTITY }),
    );
    const before = stored(o.doc, "with-agent");

    const { inbox, text } = await poll();
    expect(inbox.userActions.map((a) => a.id)).toEqual(["with-agent"]);
    expect("agentIdentity" in inbox.userActions[0]).toBe(false);
    expect("agentIdentity" in text.userActions[0]).toBe(false);
    expect(stored(o.doc, "with-agent")).toEqual(before);
  });

  it("with local-period records not honoured: a user comment and an accepted Claude annotation", async () => {
    // `isLocalModelRecord` then answers false, so neither record is withheld
    // as local-model activity and both reach their buckets.
    __setHonourLocalPeriodRecordsForTests(false);
    const o = await openDoc();
    browserWrite(
      o.doc,
      Y_MAP_ANNOTATIONS,
      "user-agent",
      userComment(o.doc, "user-agent", { agentIdentity: AGENT_IDENTITY }),
    );
    browserWrite(
      o.doc,
      Y_MAP_ANNOTATIONS,
      "claude-agent",
      userComment(o.doc, "claude-agent", {
        author: "claude",
        status: "accepted",
        resolvedBy: "user",
        agentIdentity: AGENT_IDENTITY,
      }),
    );
    const before = [stored(o.doc, "user-agent"), stored(o.doc, "claude-agent")];

    const { inbox, text } = await poll();
    expect(inbox.userActions.map((a) => a.id)).toEqual(["user-agent"]);
    expect(inbox.userResponses.map((a) => a.id)).toEqual(["claude-agent"]);
    expect(inbox.userResponses[0].status).toBe("accepted");
    for (const item of [...inbox.userActions, ...inbox.userResponses]) {
      expect("agentIdentity" in item, String(item.id)).toBe(false);
    }
    for (const item of [...text.userActions, ...text.userResponses]) {
      expect("agentIdentity" in item, `text ${String(item.id)}`).toBe(false);
    }
    expect([stored(o.doc, "user-agent"), stored(o.doc, "claude-agent")]).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// A3: the walk. Its key list comes from sanitize itself.
// ---------------------------------------------------------------------------

/**
 * Kept by `sanitizeAnnotation` on every read, and deliberately NOT declared in
 * the inbox's advertised schema, so the inbox strips them:
 * - `heldInSolo` is the Solo-hold marker. It gates the editor's badge and the
 *   restart hold; live hiding is mode-based (`hideFromAI`), so it means
 *   nothing to Claude, and a stale one is the ordinary closed-tab case above.
 * - `agentIdentity` is the local-model collaborator's byline, a client-side
 *   label; the local model's own records never reach the inbox.
 * Declaring either would change `tools/list` and hand Claude a field that
 * means nothing to it.
 */
const STRIPPED_ON_PURPOSE = ["heldInSolo", "agentIdentity"] as const;

/**
 * Keys sanitize reads only to choose a branch or derive another value, and
 * never emits under their own name for a comment. Measured by the walk, so a
 * change to sanitize that makes this list wrong turns the test red.
 */
const SANITIZE_BRANCH_ONLY: readonly string[] = [];

const STRAY = { strayKey: "not declared" };

/**
 * A value for every key sanitize may read, each passing sanitize's own type
 * guard (a wrong-typed value is silently not emitted, which would leave that
 * field unchecked). `clean` is what must arrive; `withStrays` is what is
 * stored, a stray key nested in each object the schema declares strict.
 */
function fixtureValues(doc: Y.Doc) {
  const anchor = liveAnchor(doc);
  const clean: Record<string, unknown> = {
    id: "walk",
    author: "user",
    type: "comment",
    audience: "outbound",
    range: anchor.range,
    relRange: anchor.relRange,
    content: "walk content",
    status: "pending",
    timestamp: 1_700_000_000_000,
    textSnapshot: anchor.textSnapshot,
    textSnapshotTruncated: false,
    textSnapshotBreaks: [{ at: 5, kind: "block" }],
    editedAt: 1_700_000_000_500,
    rev: 4,
    heldInSolo: false,
    resolvedBy: "user",
    acceptedReplyId: "reply-accepted",
    priorSuggestedText: "the earlier proposal",
    agentIdentity: AGENT_IDENTITY,
    promotedFrom: "note",
    importSource: { author: "Reviewer", file: "review.docx", commentId: "9" },
    suggestedText: "walk proposal",
  };
  const withStrays: Record<string, unknown> = {
    ...clean,
    range: { ...anchor.range, ...STRAY },
    // Beside fromRel/toRel: those two are `z.unknown()`, so a key inside them
    // is allowed by the advertised schema and would fail nothing.
    relRange: { ...anchor.relRange, ...STRAY },
    textSnapshotBreaks: [{ at: 5, kind: "block", ...STRAY }],
    importSource: { ...(clean.importSource as object), ...STRAY },
  };
  return { clean, withStrays };
}

/** Every key `sanitizeAnnotation` reads off `record`, through a Proxy. */
function keysSanitizeReads(record: Record<string, unknown>): Set<string> {
  const reads = new Set<string>();
  const proxy = new Proxy(record, {
    get(target, key, receiver) {
      if (typeof key === "string") reads.add(key);
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      if (typeof key === "string") reads.add(key);
      return Reflect.has(target, key);
    },
  });
  sanitizeAnnotation(proxy as never, () => {});
  return reads;
}

/** The item properties a bucket's advertised JSON schema declares. */
async function declaredKeys(bucket: "userActions" | "userResponses" | "userReplies") {
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "tandem_checkInbox");
  const schema = tool?.outputSchema as {
    properties: Record<string, { items: { properties: Record<string, unknown> } }>;
  };
  return new Set(Object.keys(schema.properties[bucket].items.properties));
}

describe("A3: inbox items carry only declared keys, at every depth", () => {
  it("userActions and userResponses: every key sanitize reads is declared or stripped on purpose", async () => {
    // The userResponses fixture carries agentIdentity: with local-period
    // records honoured it would be withheld as local-model activity.
    __setHonourLocalPeriodRecordsForTests(false);
    const o = await openDoc();
    const { clean, withStrays } = fixtureValues(o.doc);
    const buckets = {
      userActions: { id: "walk-action", overrides: {} },
      userResponses: {
        id: "walk-response",
        overrides: { author: "claude", status: "dismissed", resolvedBy: "user" },
      },
    } as const;

    for (const [bucket, { id, overrides }] of Object.entries(buckets)) {
      const raw = { ...withStrays, ...overrides, id };
      const reads = keysSanitizeReads(raw);
      const unknown = [...reads].filter((k) => !(k in clean));
      expect(unknown, `${bucket}: sanitize reads a key with no FIXTURE value`).toEqual([]);
      const sanitized = sanitizeAnnotation(raw as never, () => {});
      const branchOnly = [...reads].filter((k) => !(k in sanitized)).sort();
      expect(branchOnly, `${bucket}: keys sanitize reads but does not emit`).toEqual([
        ...SANITIZE_BRANCH_ONLY,
      ]);
      // Every value passed its guard: an emitted key with a dropped value
      // would leave that field unchecked.
      for (const k of reads) {
        if (SANITIZE_BRANCH_ONLY.includes(k)) continue;
        expect(sanitized[k as keyof typeof sanitized], `${bucket}: ${k} emitted`).not.toBe(
          undefined,
        );
      }
      browserWrite(o.doc, Y_MAP_ANNOTATIONS, id, raw);
    }
    const before = {
      action: stored(o.doc, "walk-action"),
      response: stored(o.doc, "walk-response"),
    };

    const { inbox, text } = await poll();

    for (const [bucket, { id, overrides }] of Object.entries(buckets)) {
      const items = inbox[bucket as keyof typeof buckets];
      expect(
        items.map((a) => a.id),
        `${bucket} holds its item`,
      ).toEqual([id]);
      const item = items[0];
      const expected: Record<string, unknown> = wire({ ...clean, ...overrides, id });
      const declared = await declaredKeys(bucket as keyof typeof buckets);
      const reads = keysSanitizeReads({ ...withStrays, ...overrides, id });
      for (const k of reads) {
        if (SANITIZE_BRANCH_ONLY.includes(k)) continue;
        if ((STRIPPED_ON_PURPOSE as readonly string[]).includes(k)) continue;
        expect(declared.has(k), `${bucket}: ${k} is declared`).toBe(true);
        expect(item[k], `${bucket}: ${k} arrives equal, strays removed`).toEqual(expected[k]);
      }
      for (const k of STRIPPED_ON_PURPOSE) {
        expect(declared.has(k), `${bucket}: ${k} is not declared`).toBe(false);
        expect(k in item, `${bucket}: ${k} is not sent`).toBe(false);
      }
      expect(text[bucket as keyof typeof buckets][0], `${bucket}: the text part matches`).toEqual(
        item,
      );
    }

    // Nothing was deleted in place: the stored records still hold their strays.
    const after = {
      action: stored(o.doc, "walk-action"),
      response: stored(o.doc, "walk-response"),
    };
    expect(after).toEqual(before);
    const action = after.action as Record<string, Record<string, unknown>>;
    expect(action.range.strayKey).toBe(STRAY.strayKey);
    expect(action.relRange.strayKey).toBe(STRAY.strayKey);
    expect(action.importSource.strayKey).toBe(STRAY.strayKey);
    expect((action.textSnapshotBreaks as unknown as Item[])[0].strayKey).toBe(STRAY.strayKey);
  });

  it("userReplies (a guard): a stored reply's undeclared keys never reach the item", async () => {
    __setHonourLocalPeriodRecordsForTests(false);
    const o = await openDoc();
    browserWrite(o.doc, Y_MAP_ANNOTATIONS, "parent", userComment(o.doc, "parent"));
    const reply = {
      id: "reply-extra",
      annotationId: "parent",
      author: "user",
      text: "a reply with extras",
      timestamp: 1_700_000_003_000,
      private: false,
      heldInSolo: false,
      agentIdentity: AGENT_IDENTITY,
      importAuthor: "Someone",
    };
    browserWrite(o.doc, Y_MAP_ANNOTATION_REPLIES, "reply-extra", reply);
    const declared = await declaredKeys("userReplies");

    const { inbox } = await poll();
    expect(inbox.userReplies.map((r) => r.id)).toEqual(["reply-extra"]);
    const item = inbox.userReplies[0];
    for (const k of Object.keys(item)) expect(declared.has(k), k).toBe(true);
    expect(item).toEqual({
      id: "reply-extra",
      annotationId: "parent",
      author: "user",
      text: "a reply with extras",
      timestamp: 1_700_000_003_000,
      textSnippet: TARGET,
      documentId: o.documentId,
    });
  });

  /** A user chat message on the open document with a stray key in its anchor. */
  function chatWithStrayAnchor(documentId: string) {
    const clean = {
      id: "chat-stray",
      text: "about this part",
      timestamp: 1_700_000_004_000,
      documentId,
      anchor: { from: 6, to: 20, textSnapshot: TARGET },
      replyTo: "chat-earlier",
    };
    const record = {
      ...clean,
      author: "user",
      read: false,
      anchor: { ...clean.anchor, ...STRAY },
    };
    withBrowser(ctrl(), () => ctrl().getMap(Y_MAP_CHAT).set(clean.id, record));
    return clean;
  }

  it("chat: a stray in anchor is removed (cursor poll, the cursor collector)", async () => {
    const o = await openDoc();
    const clean = chatWithStrayAnchor(o.documentId);
    const before = structuredClone(ctrl().getMap(Y_MAP_CHAT).get(clean.id)) as {
      anchor: Record<string, unknown>;
    };

    const { inbox, text } = await poll();
    expect(inbox.chatMessages).toEqual([clean]);
    expect(text.chatMessages).toEqual([clean]);
    const after = ctrl().getMap(Y_MAP_CHAT).get(clean.id) as { anchor: Record<string, unknown> };
    expect(after.anchor, "the stored anchor is untouched").toEqual(before.anchor);
  });

  it("chat: a stray in anchor is removed (one cursor-less poll on fresh state, the legacy collector)", async () => {
    // The FIRST cursor-less poll on fresh state: a second one would find the
    // message already stamped read and prove nothing (see the header).
    const o = await openDoc();
    const clean = chatWithStrayAnchor(o.documentId);
    const before = structuredClone(ctrl().getMap(Y_MAP_CHAT).get(clean.id)) as {
      anchor: Record<string, unknown>;
    };

    const { inbox, text } = await poll({});
    expect(inbox.chatMessages).toEqual([clean]);
    expect(text.chatMessages).toEqual([clean]);
    const after = ctrl().getMap(Y_MAP_CHAT).get(clean.id) as { anchor: Record<string, unknown> };
    expect(after.anchor, "the stored anchor is untouched").toEqual(before.anchor);
  });
});

// ---------------------------------------------------------------------------
// tandem_getAnnotations (#2465 part 2): the same, for the read tool
// ---------------------------------------------------------------------------

interface RawResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
}

/** The call as the validating client returns it, success or not. */
async function rawGetAnnotations(documentId: string): Promise<RawResult> {
  return (await client.callTool({
    name: "tandem_getAnnotations",
    arguments: { documentId },
  })) as RawResult;
}

/** A Claude comment, written as `tandem_comment` writes it. */
function claudeComment(doc: Y.Doc, id: string, extra: Record<string, unknown> = {}) {
  const record = { ...userComment(doc, id), author: "claude", ...extra };
  withMcp(doc, () => doc.getMap(Y_MAP_ANNOTATIONS).set(id, record));
  return record;
}

/**
 * G1's sequence: in Solo the user writes a comment (the client's stamp) and
 * replies on a Claude comment through the reply seam (the seam's stamp); the
 * tab is closed, the mode switched to Tandem and released (`released: 0`, the
 * release sweeps open documents only), and the document reopened. Returns the
 * reopened document with both markers still stored.
 */
async function closedTabWithMarkers(): Promise<{ o: Opened; replyId: string }> {
  const first = await openDoc();
  // Written with the mode at "tandem" (the header's rule); only the two user
  // writes below are deliberately Solo.
  claudeComment(first.doc, "claude-parent");
  setCtrlMode("solo");
  browserWrite(
    first.doc,
    Y_MAP_ANNOTATIONS,
    "solo-user",
    userComment(first.doc, "solo-user", { heldInSolo: true }),
  );
  const replied = addUserReply(first.doc, "claude-parent", "my Solo reply", () => {});
  if (replied.kind !== "ok") throw new Error(`reply refused: ${replied.kind}`);
  const storedReply = first.doc.getMap(Y_MAP_ANNOTATION_REPLIES).get(replied.replyId) as {
    heldInSolo?: unknown;
  };
  expect(storedReply.heldInSolo, "the reply seam stamped the Solo reply").toBe(true);
  await closeDoc(first);

  setCtrlMode("tandem");
  const released = release();
  expect(released.status).toBe(200);
  expect(released.body).toEqual({ data: { released: 0 } });

  const o = await reopen(first.filePath, first.resolved);
  const comment = o.doc.getMap(Y_MAP_ANNOTATIONS).get("solo-user") as { heldInSolo?: unknown };
  const reply = o.doc.getMap(Y_MAP_ANNOTATION_REPLIES).get(replied.replyId) as {
    heldInSolo?: unknown;
  };
  expect(comment?.heldInSolo, "the comment's marker survived the reopen").toBe(true);
  expect(reply?.heldInSolo, "the reply's marker survived the reopen").toBe(true);
  return { o, replyId: replied.replyId };
}

/**
 * A successful call through the validating client, with the text part read
 * from `content[0]` (a trailing wake-advisory block can follow it).
 */
async function getAnnotations(documentId: string) {
  const result = await rawGetAnnotations(documentId);
  expect(result.isError ?? false, JSON.stringify(result)).toBe(false);
  expect(result.structuredContent).toBeDefined();
  const envelope = JSON.parse(result.content[0]?.text ?? "null") as {
    error: boolean;
    data: Record<string, unknown>;
  };
  expect(envelope.error).toBe(false);
  const structured = result.structuredContent as { annotations: Item[]; count: number };
  expect(envelope.data, "the text part agrees with structuredContent").toEqual(structured);
  return structured;
}

/** The annotation-item and reply-item properties the advertised schema declares. */
async function getAnnotationsDeclared() {
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "tandem_getAnnotations");
  type Obj = { properties: Record<string, unknown> };
  const schema = tool?.outputSchema as unknown as {
    properties: { annotations: { items: Obj & { properties: { replies: { items: Obj } } } } };
  };
  const item = schema.properties.annotations.items;
  return {
    annotation: new Set(Object.keys(item.properties)),
    reply: new Set(Object.keys(item.properties.replies.items.properties)),
  };
}

const ANNOTATION_STRIPPED = ["heldInSolo", "agentIdentity"] as const;
const REPLY_STRIPPED = ["heldInSolo", "agentIdentity", "private", "importAuthor"] as const;

describe("G1: getAnnotations on a reopened tab with stale Solo markers", () => {
  it("succeeds, returning both comments and the reply, none carrying heldInSolo", async () => {
    const { o, replyId } = await closedTabWithMarkers();

    const { annotations } = await getAnnotations(o.documentId);

    expect(annotations.map((a) => a.id).sort()).toEqual(["claude-parent", "solo-user"]);
    const parent = annotations.find((a) => a.id === "claude-parent") as Item;
    const replies = parent.replies as Item[];
    expect(replies.map((r) => r.id)).toEqual([replyId]);
    expect(replies[0].text).toBe("my Solo reply");
    for (const item of [...annotations, ...replies]) {
      expect("heldInSolo" in item, String(item.id)).toBe(false);
    }
    // `getAnnotations` compared the text part with structuredContent whole,
    // so the text part carries no marker either.
  });
});

describe("G2: strays are removed at every depth, and nothing stored changes", () => {
  it("range, the live relRange, importSource, textSnapshotBreaks and a Claude reply's agentIdentity", async () => {
    const o = await openDoc();
    const { clean, withStrays } = fixtureValues(o.doc);
    browserWrite(o.doc, Y_MAP_ANNOTATIONS, "walk", withStrays);
    const claudeReply = {
      id: "reply-agent",
      annotationId: "walk",
      author: "claude",
      text: "from the helper",
      timestamp: 1_700_000_005_000,
      rev: 1,
      agentIdentity: AGENT_IDENTITY,
    };
    withMcp(o.doc, () => o.doc.getMap(Y_MAP_ANNOTATION_REPLIES).set("reply-agent", claudeReply));
    const before = {
      record: stored(o.doc, "walk"),
      reply: stored(o.doc, "reply-agent", Y_MAP_ANNOTATION_REPLIES),
    };
    const declared = await getAnnotationsDeclared();

    const { annotations } = await getAnnotations(o.documentId);

    expect(annotations.map((a) => a.id)).toEqual(["walk"]);
    const item = annotations[0];
    const expected = wire(clean);
    for (const [k, v] of Object.entries(expected)) {
      if ((ANNOTATION_STRIPPED as readonly string[]).includes(k)) {
        expect(k in item, `${k} is not sent`).toBe(false);
        continue;
      }
      expect(declared.annotation.has(k), `${k} is declared`).toBe(true);
      // Equal, not merely containing: a stray left in a nested object fails.
      expect(item[k], `${k} arrives equal, strays removed`).toEqual(v);
    }
    for (const k of Object.keys(item)) expect(declared.annotation.has(k), k).toBe(true);
    expect(item.replies).toEqual([
      {
        id: "reply-agent",
        annotationId: "walk",
        author: "claude",
        text: "from the helper",
        timestamp: 1_700_000_005_000,
        rev: 1,
      },
    ]);

    const after = {
      record: stored(o.doc, "walk"),
      reply: stored(o.doc, "reply-agent", Y_MAP_ANNOTATION_REPLIES),
    };
    expect(after, "the stored record and reply are unchanged").toEqual(before);
    const record = after.record as Record<string, Record<string, unknown>>;
    expect(record.range.strayKey).toBe(STRAY.strayKey);
    expect(record.relRange.strayKey).toBe(STRAY.strayKey);
    expect(record.importSource.strayKey).toBe(STRAY.strayKey);
    expect((record.textSnapshotBreaks as unknown as Item[])[0].strayKey).toBe(STRAY.strayKey);
    expect((after.reply as Item).agentIdentity).toEqual(AGENT_IDENTITY);
  });
});

describe("G3: a reply stored with private: false round-trips", () => {
  it("is returned, without the private key", async () => {
    const o = await openDoc();
    claudeComment(o.doc, "claude-parent");
    const reply = {
      id: "reply-public",
      annotationId: "claude-parent",
      author: "user",
      text: "shared on purpose",
      timestamp: 1_700_000_006_000,
      private: false,
    };
    browserWrite(o.doc, Y_MAP_ANNOTATION_REPLIES, "reply-public", reply);

    const { annotations } = await getAnnotations(o.documentId);

    const { private: _private, ...declaredOnly } = reply;
    expect(annotations.map((a) => a.id)).toEqual(["claude-parent"]);
    expect(annotations[0].replies).toEqual([declaredOnly]);
  });
});

describe("G4: an invalid declared value still fails as it does today", () => {
  it("content: 42 gives an error result with no structuredContent, naming the output check", async () => {
    const o = await openDoc();
    claudeComment(o.doc, "bad-content", { content: 42 });

    const result = await rawGetAnnotations(o.documentId);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0]?.text).toMatch(
      /^MCP error -32602: Output validation error: Invalid structured content for tool tandem_getAnnotations/,
    );
  });
});

describe("G5: the stripped keys stay undeclared and unsent", () => {
  it("neither the advertised schema nor the response carries them", async () => {
    const o = await openDoc();
    browserWrite(
      o.doc,
      Y_MAP_ANNOTATIONS,
      "carrier",
      userComment(o.doc, "carrier", { heldInSolo: false, agentIdentity: AGENT_IDENTITY }),
    );
    const reply = {
      id: "reply-carrier",
      annotationId: "carrier",
      author: "user",
      text: "a reply with extras",
      timestamp: 1_700_000_007_000,
      heldInSolo: false,
      agentIdentity: AGENT_IDENTITY,
      private: false,
      importAuthor: "Someone",
    };
    browserWrite(o.doc, Y_MAP_ANNOTATION_REPLIES, "reply-carrier", reply);
    const declared = await getAnnotationsDeclared();

    const { annotations } = await getAnnotations(o.documentId);

    for (const k of ANNOTATION_STRIPPED) {
      expect(declared.annotation.has(k), `annotation ${k} is not declared`).toBe(false);
    }
    for (const k of REPLY_STRIPPED) {
      expect(declared.reply.has(k), `reply ${k} is not declared`).toBe(false);
    }
    expect(annotations.map((a) => a.id)).toEqual(["carrier"]);
    const item = annotations[0];
    for (const k of ANNOTATION_STRIPPED) expect(k in item, `annotation ${k} sent`).toBe(false);
    const replies = item.replies as Item[];
    expect(replies.map((r) => r.id)).toEqual(["reply-carrier"]);
    for (const k of REPLY_STRIPPED) expect(k in replies[0], `reply ${k} sent`).toBe(false);
  });
});

describe("source pin: every document push site pushes what admit returned", () => {
  it("the three `ctx.admit` calls each push their returned value, never the original item", () => {
    // Behaviour cannot see the userReplies site pushing its original `item`
    // instead: that item is a literal of declared fields, so the output is
    // identical today (#2472 review round 1, R1.4). Pinned from source so a
    // later edit that goes back to `if (!ctx.admit(..)) continue; push(item)`
    // fails here rather than the next time a stray key appears.
    const source = fsSync.readFileSync(
      path.join(import.meta.dirname, "..", "..", "src", "server", "mcp", "awareness.ts"),
      "utf8",
    );
    expect(source.match(/ctx\.admit\(/g) ?? [], "admit call sites").toHaveLength(3);
    const pinned =
      source.match(
        /const sent = ctx\.admit\("(?:userActions|userResponses|userReplies)", item\);[^\n]*\n\s*if \(!sent\) continue;\n\s*\w+\.push\(sent\);/g,
      ) ?? [];
    expect(pinned, "each site pushes `sent`").toHaveLength(3);
  });
});
