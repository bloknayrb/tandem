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
import { closeStore, resetForTesting as storeReset } from "../../src/server/annotations/store.js";
import { openFromDisk } from "../../src/server/documents/open.js";
import { removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { resetForTesting as resetEventQueue } from "../../src/server/events/queue.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { registerAwarenessTools, resetInbox } from "../../src/server/mcp/awareness.js";
import { extractText } from "../../src/server/mcp/document.js";
import { closeDocumentById, getOpenDocs } from "../../src/server/mcp/document-service.js";
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
import { withBrowser, withInternal } from "../../src/shared/origins.js";
import { teardownFileAppDataDir } from "../helpers/app-data-teardown.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { setupMcpServer } from "../helpers/mcp-harness.js";
import { ownershipTestDispatch, registerTestCallerRecord } from "../helpers/ownership-caller.js";

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
  await fs.writeFile(filePath, DOC_TEXT);
  return { filePath, resolved: await fs.realpath(filePath) };
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
  const anchored = anchoredRange(doc, from, to, TARGET);
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
