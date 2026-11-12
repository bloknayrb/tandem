/**
 * Ownership enforcement through the registered MCP tools (#2358, ADR-054;
 * ownership design §4.2, §5.1–§5.6; requirements R1.3, R1.5, R3.6, R4.1, R4.2).
 *
 * Every call here goes through the real handlers over the in-memory MCP
 * transport, and every caller is a **real owner record** (registered the way
 * `server.ts` registers a transport), because the decisions key on records: a
 * caller with no record may write but never holds a document.
 *
 * Flag on for the whole file. What ownership must NOT do while it is off is in
 * `ownership-dark-enforcement.test.ts`.
 *
 * Reached through 1a's presence seam, not reachable in a running server until
 * PR 3b makes Tandem's Claude present: `default`, `not-present`, and the
 * `taken back` cause of `lost`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { addUserReply } from "../../src/server/annotations/lifecycle.js";
import { openFromDisk } from "../../src/server/documents/open.js";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { unwatchFile } from "../../src/server/file-watcher.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import {
  closeDocumentById,
  getActiveDocId,
  getOpenDocs,
} from "../../src/server/mcp/document-service.js";
import { registerApplyTools } from "../../src/server/mcp/docx-apply.js";
import { ownedOpen, ownedWrite } from "../../src/server/mcp/owned-op.js";
import { TOOL_MODES } from "../../src/server/mcp/tool-modes.js";
import { runDocOp } from "../../src/server/sessions/doc-op-queue.js";
import {
  getDocOwner,
  getOwnerRecord,
  noteTransportChanged,
  noteTransportRegistered,
  type OwnerRecord,
  ownershipSnapshotForTests,
  resetOwnershipForTests,
  setDocOwner,
  setGraceMsForTests,
  setTandemPresenceSource,
  setTransportView,
  TANDEM_OWNER_ID,
  type TransportViewEntry,
} from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
  Y_MAP_AWARENESS,
  Y_MAP_CLAUDE,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../src/shared/constants.js";
import { withInternal } from "../../src/shared/origins.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";
import { asTestCaller } from "../helpers/ownership-caller.js";

const A = "claude:session-a";
const B = "claude:session-b";

let client: Client;
let close: (() => Promise<void>) | undefined;
let view: TransportViewEntry[];
/** Which record the next tool call is dispatched as. */
let callingAs = A;
let run = 0;
let prefix = "";
let tmpDir = "";

const docId = (name: string) => `${prefix}-${name}`;

function register(
  ownerId: string,
  kind: OwnerRecord["recordKind"] = "claude",
  clientName?: string,
) {
  const entry: TransportViewEntry = { ownerId, openStreams: 0 };
  view.push(entry);
  noteTransportRegistered(ownerId, { recordKind: kind, clientName });
  return entry;
}

function setupDoc(name: string, text = "Hello world, this is a test document."): Y.Doc {
  const id = docId(name);
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, text);
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  return ydoc;
}

/** A pending, Claude-facing comment Claude authored. */
function seed(ydoc: Y.Doc, id: string, extra: Record<string, unknown> = {}): void {
  withInternal(ydoc, () =>
    ydoc.getMap(Y_MAP_ANNOTATIONS).set(id, {
      id,
      author: "claude",
      type: "comment",
      audience: "outbound",
      range: { from: 0, to: 5 },
      content: "original",
      status: "pending",
      timestamp: 1000,
      rev: 1,
      ...extra,
    }),
  );
}

function setMode(mode: "solo" | "tandem"): void {
  const ctrl = getOrCreateDocument(CTRL_ROOM);
  withInternal(ctrl, () => ctrl.getMap(Y_MAP_USER_AWARENESS).set(Y_MAP_MODE, mode));
}

/** Everything a tool could have written to a document. */
function snapshot(ydoc: Y.Doc): string {
  return JSON.stringify({
    text: ydoc.getXmlFragment("default").toString(),
    annotations: ydoc.getMap(Y_MAP_ANNOTATIONS).toJSON(),
    replies: ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).toJSON(),
    awareness: ydoc.getMap(Y_MAP_AWARENESS).toJSON(),
  });
}

function countTransactions(ydoc: Y.Doc): () => number {
  let n = 0;
  const onTx = () => {
    n++;
  };
  ydoc.on("afterTransaction", onTx);
  return () => {
    ydoc.off("afterTransaction", onTx);
    return n;
  };
}

type Body = {
  error: boolean;
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
  data?: Record<string, unknown>;
};

/** Every envelope this file received, for the "no identity leaks" sweep at the end of each test. */
let envelopes: string[] = [];

async function as(owner: string, tool: string, args: Record<string, unknown> = {}): Promise<Body> {
  callingAs = owner;
  const result = await client.callTool({ name: tool, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>)
    .map((c) => c.text ?? "")
    .join("\n");
  envelopes.push(text);
  return parseResult(result) as Body;
}

/**
 * Start a call and return once the server has received it (so it is in its
 * document's queue, dispatched as `owner`), without waiting for its answer.
 * `callTool` sends asynchronously, and the caller is read at dispatch.
 */
async function start(owner: string, tool: string, args: Record<string, unknown> = {}) {
  const pending = as(owner, tool, args);
  await new Promise((r) => setTimeout(r, 15));
  return { answer: pending };
}

const holds = (owner: string, name: string) => getDocOwner(docId(name))?.ownerId === owner;
const kindOf = (name: string) => getDocOwner(docId(name))?.kind;

beforeEach(async () => {
  vi.stubEnv("TANDEM_OWNERSHIP", "1");
  run++;
  prefix = `own${run}`;
  envelopes = [];
  callingAs = A;
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  view = [];
  setTransportView(() => view);
  register(A);
  register(B);
  setMode("tandem");
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-own-"));
  ({ client, close } = await setupMcpServer(
    [registerDocumentTools, registerAnnotationTools, registerApplyTools],
    { dispatch: (fn) => asTestCaller(fn, { ownerId: callingAs }) },
  ));
});

afterEach(async () => {
  // R3.6 / §11.1: nothing a tool returned may carry an owner id (an `http:`
  // one is a bearer session id) or the raw header value inside one.
  const all = envelopes.join("\n");
  // Every owner-id prefix, and the raw header value inside each id this file
  // registers. (Display kinds and labels are the only names a refusal may use.)
  for (const secret of [
    "claude:",
    "bridge:",
    "http:",
    "session-a",
    "session-b",
    "session-c",
    "session-gone",
    "forger",
    "legacy-transport",
    "no-record",
  ]) {
    expect(all, `an envelope leaked ${secret}`).not.toContain(secret);
  }
  await close?.();
  close = undefined;
  // Close the watches the real opens started before removing their files
  // (an open handle keeps the directory busy on Windows).
  for (const d of getOpenDocs().values()) if (d.source === "file") unwatchFile(d.filePath);
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  resetOwnershipForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/**
 * Every write tool, addressed to the held document. On a writable document
 * of the right format that holds the annotation, the ownership refusal comes
 * before any other argument is looked at, so these need not be calls the
 * holder would succeed with; the holder's own success through each tool is
 * `ownership-claims-table.test.ts`.
 */
const WRITE_CALLS: Array<{ tool: string; args: (id: string) => Record<string, unknown> }> = [
  { tool: "tandem_edit", args: (id) => ({ from: 0, to: 5, newText: "Howdy", documentId: id }) },
  { tool: "tandem_appendContent", args: (id) => ({ content: "More.", documentId: id }) },
  { tool: "tandem_editList", args: (id) => ({ at: 0, op: "remove", documentId: id }) },
  { tool: "tandem_save", args: (id) => ({ documentId: id }) },
  { tool: "tandem_rename", args: (id) => ({ newName: "renamed.md", documentId: id }) },
  { tool: "tandem_close", args: (id) => ({ documentId: id }) },
  { tool: "tandem_comment", args: (id) => ({ from: 0, to: 5, text: "c", documentId: id }) },
  {
    tool: "tandem_resolveAnnotation",
    args: (id) => ({ id: "ann", action: "dismiss", documentId: id }),
  },
  { tool: "tandem_removeAnnotation", args: (id) => ({ id: "ann", documentId: id }) },
  { tool: "tandem_editAnnotation", args: (id) => ({ id: "ann", content: "e", documentId: id }) },
  {
    tool: "tandem_annotationReply",
    args: (id) => ({ annotationId: "ann", text: "r", documentId: id }),
  },
  { tool: "tandem_restoreBackup", args: (id) => ({ backup: "snap.md", documentId: id }) },
  { tool: "tandem_applyChanges", args: (id) => ({ documentId: id }) },
  { tool: "tandem_convertToMarkdown", args: (id) => ({ documentId: id }) },
];

describe("a write by a record that does not hold the document (R1.3)", () => {
  it("the sweep covers exactly the tools the mode table calls writes", () => {
    const writes = Object.entries(TOOL_MODES)
      .filter(([, entry]) => entry.mode === "write")
      .map(([name]) => name)
      .sort();
    expect(WRITE_CALLS.map((c) => c.tool).sort()).toEqual(writes);
  });

  it.each(WRITE_CALLS)(
    "$tool is refused NOT_DOC_OWNER and writes nothing",
    async ({ tool, args }) => {
      const ydoc = setupDoc("held");
      seed(ydoc, "ann");
      setDocOwner(docId("held"), { ownerId: A, kind: "opened" }, "take");
      const before = snapshot(ydoc);
      const transactions = countTransactions(ydoc);

      const body = await as(B, tool, args(docId("held")));

      expect(body.code).toBe("NOT_DOC_OWNER");
      expect(body.details).toMatchObject({
        reason: "held",
        documentId: docId("held"),
        holder: { label: getOwnerRecord(A)?.label, displayKind: "terminal" },
      });
      expect(transactions(), "a refused non-owner opened a transaction").toBe(0);
      expect(snapshot(ydoc)).toBe(before);
      expect(getOpenDocs().has(docId("held"))).toBe(true);
      expect(holds(A, "held")).toBe(true);
    },
  );

  it("reads are open on a held document and never claim", async () => {
    const ydoc = setupDoc("held");
    seed(ydoc, "ann");
    setDocOwner(docId("held"), { ownerId: A, kind: "opened" }, "take");
    setupDoc("free");
    for (const [tool, args] of [
      ["tandem_getTextContent", { documentId: docId("held") }],
      ["tandem_getOutline", { documentId: docId("held") }],
      ["tandem_getAnnotations", { documentId: docId("held") }],
      ["tandem_listDocuments", {}],
      ["tandem_exportAnnotations", { documentId: docId("held") }],
      ["tandem_restoreBackup", { documentId: docId("held") }],
      ["tandem_getTextContent", { documentId: docId("free") }],
      ["tandem_status", {}],
    ] as const) {
      const body = await as(B, tool, args);
      expect(body.code, tool).not.toBe("NOT_DOC_OWNER");
    }
    expect(holds(A, "held")).toBe(true);
    expect(getDocOwner(docId("free"))).toBeUndefined();
  });
});

describe("claims (§4.2, §5.1)", () => {
  it("a write to an unowned document claims it, and the next record is refused `claimed`", async () => {
    const ydoc = setupDoc("d");
    const first = await as(A, "tandem_comment", {
      from: 0,
      to: 5,
      text: "mine",
      documentId: docId("d"),
    });
    expect(first.error).toBe(false);
    expect(kindOf("d")).toBe("claimed");
    expect(holds(A, "d")).toBe(true);

    const before = snapshot(ydoc);
    const second = await as(B, "tandem_comment", {
      from: 0,
      to: 5,
      text: "x",
      documentId: docId("d"),
    });
    expect(second.code).toBe("NOT_DOC_OWNER");
    expect(second.details?.reason).toBe("claimed");
    expect(second.message).toContain("Call tandem_open on it only if the user asked you");
    expect(snapshot(ydoc)).toBe(before);
  });

  it("a refusal decided before the queue claims nothing", async () => {
    const id = docId("ro");
    populateYDoc(getOrCreateDocument(id), "text");
    addDoc(id, { id, filePath: `/tmp/${id}.html`, format: "html", readOnly: true, source: "file" });
    expect(
      (await as(A, "tandem_edit", { from: 0, to: 2, newText: "x", documentId: id })).code,
    ).toBe("READ_ONLY");
    expect((await as(A, "tandem_appendContent", { content: "x", documentId: id })).code).toBe(
      "READ_ONLY",
    );
    expect((await as(A, "tandem_rename", { newName: "", documentId: id })).code).toBe(
      "INVALID_NAME",
    );
    expect(getDocOwner(id)).toBeUndefined();
  });

  it("a non-owner on a read-only document is told READ_ONLY first (§5.1: before the queue)", async () => {
    const id = docId("ro");
    populateYDoc(getOrCreateDocument(id), "text");
    addDoc(id, { id, filePath: `/tmp/${id}.html`, format: "html", readOnly: true, source: "file" });
    setDocOwner(id, { ownerId: A, kind: "opened" }, "take");
    const body = await as(B, "tandem_edit", { from: 0, to: 2, newText: "x", documentId: id });
    expect(body.code).toBe("READ_ONLY");
  });

  it("an argument refusal answered inside the operation leaves no claim", async () => {
    setupDoc("d");
    // Point insert carrying a textSnapshot: argument-decided, but answered
    // after the live EMPTY_DOCUMENT check, so it runs inside the operation.
    const body = await as(A, "tandem_edit", {
      from: 3,
      to: 3,
      newText: "x",
      textSnapshot: "Hel",
      documentId: docId("d"),
    });
    expect(body.code).toBe("INVALID_ARGUMENT");
    expect(getDocOwner(docId("d"))).toBeUndefined();
    expect(ownershipSnapshotForTests().ownerByDoc).toEqual([]);
  });

  it("a refusal decided by live content keeps the claim", async () => {
    setupDoc("d");
    const body = await as(A, "tandem_comment", {
      from: 0,
      to: 5,
      text: "c",
      textSnapshot: "nothing like this is in the document",
      documentId: docId("d"),
    });
    expect(body.code).toBe("RANGE_GONE");
    expect(holds(A, "d")).toBe(true);
  });

  it("a refused call never removes a claim the caller already held", async () => {
    setupDoc("d");
    await as(A, "tandem_comment", { from: 0, to: 5, text: "mine", documentId: docId("d") });
    const held = getDocOwner(docId("d"));
    const body = await as(A, "tandem_edit", {
      from: 3,
      to: 3,
      newText: "x",
      textSnapshot: "Hel",
      documentId: docId("d"),
    });
    expect(body.code).toBe("INVALID_ARGUMENT");
    expect(getDocOwner(docId("d"))).toBe(held);
  });

  it("an id-keyed call refused by the lifecycle leaves no claim", async () => {
    const ydoc = setupDoc("d");
    seed(ydoc, "user-comment", { author: "user" });
    seed(ydoc, "note", { type: "note", audience: "private", author: "user" });
    const notOwned = await as(A, "tandem_editAnnotation", {
      id: "user-comment",
      content: "x",
      documentId: docId("d"),
    });
    expect(notOwned.code).toBe("NOT_OWNED");
    const note = await as(A, "tandem_removeAnnotation", { id: "note", documentId: docId("d") });
    expect(note.code).toBe("INVALID_ARGUMENT");
    expect(getDocOwner(docId("d"))).toBeUndefined();
  });

  it("a caller with no record may write to an unowned document but never holds one", async () => {
    setupDoc("d");
    const body = await as("claude:no-record", "tandem_comment", {
      from: 0,
      to: 5,
      text: "c",
      documentId: docId("d"),
    });
    expect(body.error).toBe(false);
    expect(getDocOwner(docId("d"))).toBeUndefined();
  });

  it("an entry whose record is gone is treated as unowned, and cleared", async () => {
    setupDoc("d");
    // Fabricated: no path writes an entry for a record that does not exist.
    setDocOwner(docId("d"), { ownerId: "claude:ghost", kind: "opened" }, "take");
    const body = await as(B, "tandem_comment", {
      from: 0,
      to: 5,
      text: "c",
      documentId: docId("d"),
    });
    expect(body.error).toBe(false);
    expect(holds(B, "d")).toBe(true);
  });
});

describe("which document a call means (R4.1, §5.2)", () => {
  it("a write that names no document is refused on another record's active document, never retargeted", async () => {
    const theirs = setupDoc("theirs");
    const mine = setupDoc("mine");
    setDocOwner(docId("theirs"), { ownerId: A, kind: "opened" }, "take");
    setDocOwner(docId("mine"), { ownerId: B, kind: "opened" }, "take");
    setActiveDocId(docId("theirs"));
    const before = [snapshot(theirs), snapshot(mine)];

    const body = await as(B, "tandem_edit", { from: 0, to: 5, newText: "Howdy" });

    expect(body.code).toBe("NOT_DOC_OWNER");
    expect(body.details).toMatchObject({ reason: "held", documentId: docId("theirs") });
    expect(body.details?.heldDocumentIds).toEqual([docId("mine")]);
    expect(body.message).toContain(
      "This call named no documentId, so it targeted the active document.",
    );
    expect(body.message).toContain("offsets read from this document do not apply to another");
    expect([snapshot(theirs), snapshot(mine)]).toEqual(before);
  });

  it("a read that names no document reads the active one, whoever holds it", async () => {
    setupDoc("theirs", "Their text.");
    setDocOwner(docId("theirs"), { ownerId: A, kind: "opened" }, "take");
    setActiveDocId(docId("theirs"));
    const body = await as(B, "tandem_getTextContent", {});
    expect(body.data?.text).toBe("Their text.");
    expect(body.data?.documentId).toBe(docId("theirs"));
  });

  it("a named document carries no defaulted-target sentence", async () => {
    setupDoc("theirs");
    setDocOwner(docId("theirs"), { ownerId: A, kind: "opened" }, "take");
    const body = await as(B, "tandem_save", { documentId: docId("theirs") });
    expect(body.message).not.toContain("named no documentId");
    expect(body.details).not.toHaveProperty("heldDocumentIds");
  });

  it("an id with directory parts is checked as the id the body acts on", async () => {
    const ydoc = setupDoc("held");
    setDocOwner(docId("held"), { ownerId: A, kind: "opened" }, "take");
    const before = snapshot(ydoc);
    for (const tool of [
      "tandem_save",
      "tandem_close",
      "tandem_rename",
      "tandem_convertToMarkdown",
    ]) {
      for (const spelling of [`x/${docId("held")}`, `${docId("held")}/`]) {
        const body = await as(B, tool, { documentId: spelling, newName: "n.md" });
        expect(body.code, `${tool} ${spelling}`).toBe("NOT_DOC_OWNER");
      }
    }
    expect(snapshot(ydoc)).toBe(before);
    expect(getOpenDocs().has(docId("held"))).toBe(true);
  });
});

describe("the operation queue (ownership design §5.1)", () => {
  it("operations run in the order they were queued: a write queued before a take runs first, and the loser is refused afterwards", async () => {
    const ydoc = setupDoc("d");
    const before = snapshot(ydoc);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // Something in flight on the document: A's write waits behind it.
    const inFlight = runDocOp(docId("d"), () => gate);
    const { answer: waiting } = await start(A, "tandem_edit", {
      from: 0,
      to: 5,
      newText: "Howdy",
      documentId: docId("d"),
    });
    // B takes the document while A's write is still queued.
    const take = runDocOp(docId("d"), () => {
      setDocOwner(docId("d"), { ownerId: B, kind: "opened" }, "take");
    });
    release();
    await Promise.all([inFlight, take]);
    const body = await waiting;
    // A's edit was queued BEFORE the take, so it ran first and claimed.
    expect(body, JSON.stringify(body)).toMatchObject({ error: false });
    expect(snapshot(ydoc)).not.toBe(before);
    // The record that lost it is now refused, with the loss named first.
    const next = await as(A, "tandem_edit", {
      from: 0,
      to: 5,
      newText: "Again",
      documentId: docId("d"),
    });
    expect(next.code).toBe("NOT_DOC_OWNER");
    expect(next.details).toMatchObject({ reason: "lost", cause: "taken" });
  });

  it("two records' writes on one unowned document: the first to queue holds it, the second is refused", async () => {
    const ydoc = setupDoc("d");
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inFlight = runDocOp(docId("d"), () => gate);
    const { answer: first } = await start(A, "tandem_comment", {
      from: 0,
      to: 5,
      text: "a",
      documentId: docId("d"),
    });
    const { answer: second } = await start(B, "tandem_comment", {
      from: 0,
      to: 5,
      text: "b",
      documentId: docId("d"),
    });
    // Neither has run: nothing is claimed while both wait.
    expect(getDocOwner(docId("d"))).toBeUndefined();
    release();
    await inFlight;
    expect((await first).error).toBe(false);
    const refused = await second;
    expect(refused.code).toBe("NOT_DOC_OWNER");
    expect(refused.details?.reason).toBe("claimed");
    expect(Object.keys(ydoc.getMap(Y_MAP_ANNOTATIONS).toJSON())).toHaveLength(1);
  });

  it("a write that named no document lands on the document that was checked, not on a tab that became active while it waited", async () => {
    const checked = setupDoc("checked");
    const later = setupDoc("later");
    setActiveDocId(docId("checked"));
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inFlight = runDocOp(docId("checked"), () => gate);
    const { answer: waiting } = await start(A, "tandem_comment", {
      from: 0,
      to: 5,
      text: "pinned",
    });
    setActiveDocId(docId("later"));
    const laterBefore = snapshot(later);
    release();
    await inFlight;
    const landed = await waiting;
    expect(landed, JSON.stringify(landed)).toMatchObject({ error: false });
    expect(Object.keys(checked.getMap(Y_MAP_ANNOTATIONS).toJSON())).toHaveLength(1);
    expect(snapshot(later)).toBe(laterBefore);
    expect(holds(A, "checked")).toBe(true);
    expect(getDocOwner(docId("later"))).toBeUndefined();
  });

  it("a document closed while a write waited is answered NO_DOCUMENT and leaves no entry", async () => {
    setupDoc("d");
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inFlight = runDocOp(docId("d"), () => gate);
    const { answer: waiting } = await start(A, "tandem_comment", {
      from: 0,
      to: 5,
      text: "c",
      documentId: docId("d"),
    });
    await closeDocumentById(docId("d"));
    release();
    await inFlight;
    expect((await waiting).code).toBe("NO_DOCUMENT");
    expect(getDocOwner(docId("d"))).toBeUndefined();
    expect(ownershipSnapshotForTests().ownerByDoc).toEqual([]);
  });
});

describe("a lapse while the document is busy (ownership design §3.4, §4.3)", () => {
  /** Detach `owner` and let its grace expire. */
  function lapseNow(owner: string) {
    view = view.filter((e) => e.ownerId !== owner);
    vi.useFakeTimers();
    setGraceMsForTests(10);
    noteTransportChanged(owner);
    vi.advanceTimersByTime(20);
    vi.useRealTimers();
  }

  it("moves each document at its own turn, and the record goes only when it holds nothing", async () => {
    setupDoc("busy");
    setupDoc("idle");
    setDocOwner(docId("busy"), { ownerId: A, kind: "opened" }, "take");
    setDocOwner(docId("idle"), { ownerId: A, kind: "opened" }, "take");
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inFlight = runDocOp(docId("busy"), () => gate);

    lapseNow(A);
    // The idle document moved at once; the busy one waits for its operation.
    expect(getDocOwner(docId("idle"))).toBeUndefined();
    expect(holds(A, "busy")).toBe(true);
    expect(getOwnerRecord(A)).toBeDefined();

    release();
    await inFlight;
    await runDocOp(docId("busy"), () => undefined);
    expect(getDocOwner(docId("busy"))).toBeUndefined();
    expect(getOwnerRecord(A)).toBeUndefined();
  });

  it("a deferred move that is no longer needed still lets the record go", async () => {
    setupDoc("busy");
    setDocOwner(docId("busy"), { ownerId: A, kind: "opened" }, "take");
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inFlight = runDocOp(docId("busy"), () => gate);
    lapseNow(A);
    expect(getOwnerRecord(A)).toBeDefined();
    // The tab closes before the deferred move gets its turn.
    await closeDocumentById(docId("busy"));
    release();
    await inFlight;
    await runDocOp(docId("busy"), () => undefined);
    expect(getOwnerRecord(A)).toBeUndefined();
  });

  it("a record that is attached again before its turn keeps the document", async () => {
    setupDoc("busy");
    setDocOwner(docId("busy"), { ownerId: A, kind: "opened" }, "take");
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inFlight = runDocOp(docId("busy"), () => gate);
    lapseNow(A);
    expect(holds(A, "busy")).toBe(true);
    register(A);
    release();
    await inFlight;
    await runDocOp(docId("busy"), () => undefined);
    expect(holds(A, "busy")).toBe(true);
  });
});

describe("tandem_open: the take rule (§4.2, §5.4)", () => {
  function file(name: string, text = "# Title\n\nBody text.\n"): string {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, text);
    return filePath;
  }

  it("opening a closed file makes the caller its owner, as `opened`", async () => {
    const body = await as(A, "tandem_open", { filePath: file("a.md") });
    expect(body.error).toBe(false);
    const id = body.data?.documentId as string;
    expect(getDocOwner(id)).toMatchObject({ ownerId: A, kind: "opened" });
  });

  it("a file that fails to open leaves no entry", async () => {
    const body = await as(A, "tandem_open", { filePath: path.join(tmpDir, "missing.md") });
    expect(body.code).toBe("FILE_NOT_FOUND");
    expect(ownershipSnapshotForTests().ownerByDoc).toEqual([]);
    expect(ownershipSnapshotForTests().queuedDocuments).toBe(0);
  });

  it("another record's open of an `opened` document is refused before any reload or activation", async () => {
    const filePath = file("a.md", "Original.\n");
    const opened = await as(A, "tandem_open", { filePath });
    const id = opened.data?.documentId as string;
    setupDoc("other");
    setActiveDocId(docId("other"));
    fs.writeFileSync(filePath, "Changed on disk.\n");
    const ydoc = getOrCreateDocument(id);
    const before = snapshot(ydoc);

    const refused = await as(B, "tandem_open", { filePath, force: true, authoredBy: "claude" });

    expect(refused.code).toBe("NOT_DOC_OWNER");
    expect(refused.details).toMatchObject({ reason: "held", documentId: id });
    expect(refused.message).toContain("You can still read it.");
    expect(snapshot(ydoc)).toBe(before);
    expect(getActiveDocId()).toBe(docId("other"));
    expect(getDocOwner(id)?.ownerId).toBe(A);
  });

  it("a `claimed` document is taken by another record's open, and its old holder is told it lost it", async () => {
    const filePath = file("a.md");
    const opened = await as(A, "tandem_open", { filePath });
    const id = opened.data?.documentId as string;
    // Make A's hold a claim (as a write on an unowned document would).
    setDocOwner(id, null, "lapse");
    await as(A, "tandem_comment", { from: 0, to: 3, text: "c", documentId: id });
    expect(getDocOwner(id)?.kind).toBe("claimed");

    expect((await as(B, "tandem_open", { filePath })).error).toBe(false);
    expect(getDocOwner(id)).toMatchObject({ ownerId: B, kind: "opened" });

    const lost = await as(A, "tandem_comment", { from: 0, to: 3, text: "c", documentId: id });
    expect(lost.code).toBe("NOT_DOC_OWNER");
    expect(lost.details).toMatchObject({
      reason: "lost",
      cause: "taken",
      holder: { label: getOwnerRecord(B)?.label, displayKind: "terminal" },
    });
    // `lost` wins over `held` for the open too (§5.3: the first row wins).
    const reopen = await as(A, "tandem_open", { filePath });
    expect(reopen.details).toMatchObject({ reason: "lost", cause: "taken" });
  });

  it("the holder's own claim becomes `opened` when it opens the document", async () => {
    const filePath = file("a.md");
    const id = (await as(A, "tandem_open", { filePath })).data?.documentId as string;
    setDocOwner(id, { ownerId: A, kind: "claimed" }, "claim");
    await as(A, "tandem_open", { filePath });
    expect(getDocOwner(id)).toMatchObject({ ownerId: A, kind: "opened" });
  });

  it("the loss is forgotten when the document changes owner again, and at close", async () => {
    setupDoc("d");
    setDocOwner(docId("d"), { ownerId: A, kind: "claimed" }, "claim");
    setDocOwner(docId("d"), { ownerId: B, kind: "opened" }, "take");
    expect(ownershipSnapshotForTests().losses).toEqual([
      [docId("d"), { ownerId: A, cause: "taken" }],
    ]);
    setDocOwner(docId("d"), null, "lapse");
    expect(ownershipSnapshotForTests().losses).toEqual([]);
    // Unowned again, so the record that lost it may claim it.
    expect(
      (await as(A, "tandem_comment", { from: 0, to: 5, text: "c", documentId: docId("d") })).error,
    ).toBe(false);
    setDocOwner(docId("d"), { ownerId: B, kind: "opened" }, "take");
    await closeDocumentById(docId("d"));
    expect(ownershipSnapshotForTests().losses).toEqual([]);
  });

  it("a path the open path refuses is refused before any filesystem call", async () => {
    const realpath = vi.spyOn(fs, "realpathSync");
    for (const filePath of [
      "\\\\host\\share\\x.md",
      "//host/share/x.md",
      "\\\\?\\UNC\\host\\share\\x.md",
    ]) {
      const body = await as(A, "tandem_open", { filePath });
      expect(body.code, filePath).toBe("INVALID_PATH");
    }
    expect(realpath).not.toHaveBeenCalled();
    realpath.mockRestore();
  });

  it("openFromDisk acts only on the target it was told to expect", async () => {
    const filePath = file("a.md", "Original.\n");
    const id = (await as(A, "tandem_open", { filePath })).data?.documentId as string;
    fs.writeFileSync(filePath, "Changed on disk.\n");
    const ydoc = getOrCreateDocument(id);
    const before = snapshot(ydoc);
    setupDoc("other");
    setActiveDocId(docId("other"));
    // The file's open document is `id`; a caller that checked another target
    // is refused before the force reload or the activation.
    await expect(
      openFromDisk(filePath, { force: true, expectTargetId: "some-other-document" }),
    ).rejects.toMatchObject({ code: "OPEN_TARGET_CHANGED" });
    expect(snapshot(ydoc)).toBe(before);
    expect(getActiveDocId()).toBe(docId("other"));
    // And a fresh open that expected an already-open target is refused too.
    await expect(openFromDisk(file("fresh.md"), { expectTargetId: id })).rejects.toMatchObject({
      code: "OPEN_TARGET_CHANGED",
    });
    expect([...getOpenDocs().values()].some((d) => d.filePath.endsWith("fresh.md"))).toBe(false);
  });

  it("an open whose target keeps moving starts again, at most three times, and opens nothing", async () => {
    let predictions = 0;
    const opens: Array<string | undefined> = [];
    const result = await asTestCaller(
      () =>
        ownedOpen({ ownerId: A }, "tandem_open", {
          // A different target every time it is asked.
          predict: () => `moving-${predictions++}`,
          open: async (expectTargetId) => {
            opens.push(expectTargetId);
            return { envelope: { content: [{ type: "text", text: "{}" }] } };
          },
        }),
      { ownerId: A },
    );
    const body = JSON.parse(result.content[0].text) as Body;
    expect(body.code).toBe("RELOAD_IN_PROGRESS");
    expect(body.message).toContain("Retry tandem_open");
    expect(opens).toEqual([]);
    expect(predictions).toBe(6);

    // The core reporting a changed target is the same signal.
    let calls = 0;
    const second = await ownedOpen({ ownerId: A }, "tandem_open", {
      predict: () => "steady",
      open: async () => {
        calls++;
        return { envelope: { content: [{ type: "text", text: "{}" }] }, targetChanged: true };
      },
    });
    expect((JSON.parse(second.content[0].text) as Body).code).toBe("RELOAD_IN_PROGRESS");
    expect(calls).toBe(3);
  });

  it("a take that lands while the open was reading the disk: the caller is told it was opened but is not held", async () => {
    setupDoc("d");
    const result = await ownedOpen({ ownerId: A }, "tandem_open", {
      predict: () => docId("d"),
      open: async () => {
        // Another record's take lands during the open's awaits.
        setDocOwner(docId("d"), { ownerId: B, kind: "opened" }, "take");
        return { envelope: { content: [{ type: "text", text: "{}" }] }, openedId: docId("d") };
      },
    });
    const body = JSON.parse(result.content[0].text) as Body;
    expect(body.code).toBe("NOT_DOC_OWNER");
    expect(body.message).toMatch(/^The document was opened/);
    expect(holds(B, "d")).toBe(true);
  });

  it("a body that throws leaves no claim behind", async () => {
    setupDoc("d");
    await expect(
      ownedWrite(
        { ownerId: A },
        "tandem_comment",
        {
          given: docId("d"),
          resolve: () => ({ open: true, documentId: docId("d"), defaulted: false }),
        },
        async () => {
          // Until PR 2a this pinned the opposite: 1c claimed at the check and
          // reversed afterwards. The claim now takes effect only at a kept
          // outcome, so the document is unowned while the body runs.
          expect(getDocOwner(docId("d"))).toBeUndefined();
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
    expect(getDocOwner(docId("d"))).toBeUndefined();
    expect(ownershipSnapshotForTests().pendingClaims).toBe(0);
  });

  it("tandem_scratchpad makes the caller the new document's owner", async () => {
    const body = await as(A, "tandem_scratchpad", { content: "Draft." });
    expect(getDocOwner(body.data?.documentId as string)).toMatchObject({
      ownerId: A,
      kind: "opened",
    });
    const refused = await as(B, "tandem_appendContent", {
      content: "x",
      documentId: body.data?.documentId,
    });
    expect(refused.details?.reason).toBe("held");
  });
});

describe("Tandem's Claude, through the presence seam (reachable in a server from PR 3b)", () => {
  beforeEach(() => {
    register(TANDEM_OWNER_ID, "tandem");
  });

  it("holds a document by default: a terminal's write gets the write sentence, its reply the answer sentence", async () => {
    setTandemPresenceSource(() => true);
    const ydoc = setupDoc("d");
    seed(ydoc, "ann");
    setDocOwner(docId("d"), { ownerId: TANDEM_OWNER_ID, kind: "default" }, "user-open");

    const write = await as(A, "tandem_edit", {
      from: 0,
      to: 5,
      newText: "x",
      documentId: docId("d"),
    });
    expect(write.details).toMatchObject({
      reason: "default",
      holder: { displayKind: "Tandem's Claude" },
    });
    expect(write.message).toContain("Tandem's Claude is answering this document.");

    const answer = await as(A, "tandem_annotationReply", {
      annotationId: "ann",
      text: "r",
      documentId: docId("d"),
    });
    expect(answer.details?.reason).toBe("default");
    expect(answer.message).toContain("do not take the document because of it");
  });

  it("while present it claims as `default`; a terminal's open then takes the document and it is told so", async () => {
    setTandemPresenceSource(() => true);
    setupDoc("d");
    expect(
      (
        await as(TANDEM_OWNER_ID, "tandem_comment", {
          from: 0,
          to: 5,
          text: "c",
          documentId: docId("d"),
        })
      ).error,
    ).toBe(false);
    expect(kindOf("d")).toBe("default");

    setDocOwner(docId("d"), { ownerId: A, kind: "opened" }, "take");
    const lost = await as(TANDEM_OWNER_ID, "tandem_comment", {
      from: 0,
      to: 5,
      text: "c",
      documentId: docId("d"),
    });
    expect(lost.details).toMatchObject({ reason: "lost", cause: "taken" });
    expect(lost.message).toBe(
      "A session the user is working with has this document now; leave it.",
    );
  });

  it("taking a terminal's claim back records `taken back`", async () => {
    setTandemPresenceSource(() => true);
    setupDoc("d");
    await as(A, "tandem_comment", { from: 0, to: 5, text: "c", documentId: docId("d") });
    setDocOwner(docId("d"), { ownerId: TANDEM_OWNER_ID, kind: "default" }, "take-back");
    const lost = await as(A, "tandem_comment", {
      from: 0,
      to: 5,
      text: "c",
      documentId: docId("d"),
    });
    expect(lost.details).toMatchObject({ reason: "lost", cause: "taken back" });
    expect(lost.message).toContain("Tandem's Claude took this document back.");
  });

  it("its tandem_open takes a terminal's claim back while present, takes nothing while not, and is refused on an `opened` document", async () => {
    const filePath = path.join(tmpDir, "t.md");
    fs.writeFileSync(filePath, "# T\n\nBody.\n");
    const id = (await as(A, "tandem_open", { filePath })).data?.documentId as string;

    // A holds it `opened`: refused, present or not.
    const refused = await as(TANDEM_OWNER_ID, "tandem_open", { filePath, force: true });
    expect(refused.details).toMatchObject({ reason: "held" });

    // A holds it only as a claim.
    setDocOwner(id, { ownerId: A, kind: "claimed" }, "claim");
    expect((await as(TANDEM_OWNER_ID, "tandem_open", { filePath })).error).toBe(false);
    // Not present: nothing moves.
    expect(getDocOwner(id)).toMatchObject({ ownerId: A, kind: "claimed" });

    setTandemPresenceSource(() => true);
    expect((await as(TANDEM_OWNER_ID, "tandem_open", { filePath })).error).toBe(false);
    expect(getDocOwner(id)).toMatchObject({ ownerId: TANDEM_OWNER_ID, kind: "default" });
    expect(ownershipSnapshotForTests().losses).toEqual([[id, { ownerId: A, cause: "taken back" }]]);
  });

  it("while not present it never claims: `not-present`, and nothing is written", async () => {
    const ydoc = setupDoc("d");
    const before = snapshot(ydoc);
    const body = await as(TANDEM_OWNER_ID, "tandem_comment", {
      from: 0,
      to: 5,
      text: "c",
      documentId: docId("d"),
    });
    expect(body.code).toBe("NOT_DOC_OWNER");
    expect(body.details).toMatchObject({ reason: "not-present", holder: null });
    expect(snapshot(ydoc)).toBe(before);
    expect(getDocOwner(docId("d"))).toBeUndefined();
  });
});

describe("tandem_switchDocument and write-mode tandem_status (§5.2, §5.6)", () => {
  it("switch is refused on a document another record holds, and never claims", async () => {
    setupDoc("theirs");
    setupDoc("free");
    setupDoc("start");
    setDocOwner(docId("theirs"), { ownerId: A, kind: "opened" }, "take");
    setActiveDocId(docId("start"));

    const refused = await as(B, "tandem_switchDocument", { documentId: docId("theirs") });
    expect(refused.code).toBe("NOT_DOC_OWNER");
    expect(refused.details?.reason).toBe("switch");
    expect(refused.message).toContain("Ask the user to click its tab");
    expect(getActiveDocId()).toBe(docId("start"));

    expect((await as(B, "tandem_switchDocument", { documentId: docId("free") })).error).toBe(false);
    expect(getDocOwner(docId("free"))).toBeUndefined();
    expect((await as(A, "tandem_switchDocument", { documentId: docId("theirs") })).error).toBe(
      false,
    );
  });

  it("a focus on another record's document is ignored: the holder's marker stays, the text is set, and the caller is told", async () => {
    const ydoc = setupDoc("theirs");
    setDocOwner(docId("theirs"), { ownerId: A, kind: "opened" }, "take");
    await as(A, "tandem_status", {
      text: "holder",
      focusParagraph: 3,
      documentId: docId("theirs"),
    });

    const body = await as(B, "tandem_status", {
      text: "visitor",
      focusParagraph: 9,
      documentId: docId("theirs"),
    });
    expect(body.error).toBe(false);
    expect(body.data?.warning).toContain("Your position marker was not moved");
    const stored = ydoc.getMap(Y_MAP_AWARENESS).get(Y_MAP_CLAUDE) as Record<string, unknown>;
    expect(stored.status).toBe("visitor");
    expect(stored.focusParagraph).toBe(3);
    expect(holds(A, "theirs")).toBe(true);

    // No focus asked for: nothing to warn about.
    const textOnly = await as(B, "tandem_status", { text: "again", documentId: docId("theirs") });
    expect(textOnly.data).not.toHaveProperty("warning");
  });

  it("a focus on an unowned document works as it always has, and does not claim", async () => {
    const ydoc = setupDoc("free");
    const body = await as(B, "tandem_status", {
      text: "s",
      focusParagraph: 2,
      documentId: docId("free"),
    });
    expect(body.data).not.toHaveProperty("warning");
    expect(
      (ydoc.getMap(Y_MAP_AWARENESS).get(Y_MAP_CLAUDE) as Record<string, unknown>).focusParagraph,
    ).toBe(2);
    expect(getDocOwner(docId("free"))).toBeUndefined();
  });

  it("read-mode status tells a session which one it is and what it holds", async () => {
    setupDoc("mine");
    setDocOwner(docId("mine"), { ownerId: B, kind: "opened" }, "take");
    const body = await as(B, "tandem_status", {});
    expect(body.data?.owner).toEqual({
      label: getOwnerRecord(B)?.label,
      displayKind: "terminal",
      holding: [docId("mine")],
    });
  });
});

describe("the four id-keyed tools (§5.2, R2.2)", () => {
  const ID_TOOLS: Array<{ tool: string; args: (id: string) => Record<string, unknown> }> = [
    { tool: "tandem_resolveAnnotation", args: (id) => ({ id, action: "dismiss" }) },
    { tool: "tandem_removeAnnotation", args: (id) => ({ id }) },
    { tool: "tandem_editAnnotation", args: (id) => ({ id, content: "edited" }) },
    { tool: "tandem_annotationReply", args: (id) => ({ annotationId: id, text: "a reply" }) },
  ];

  it("resolve the document by annotation id first, then check it: a background document the caller holds", async () => {
    const background = setupDoc("background");
    setupDoc("active");
    seed(background, "ann");
    setDocOwner(docId("background"), { ownerId: A, kind: "opened" }, "take");
    setDocOwner(docId("active"), { ownerId: B, kind: "opened" }, "take");
    setActiveDocId(docId("active"));
    const body = await as(A, "tandem_editAnnotation", { id: "ann", content: "edited" });
    expect(body.error).toBe(false);
    expect(body.data?.documentId).toBe(docId("background"));
  });

  it("an id matched in a background document is not called a defaulted target", async () => {
    const background = setupDoc("background");
    setupDoc("active");
    seed(background, "ann");
    setDocOwner(docId("background"), { ownerId: A, kind: "opened" }, "take");
    setActiveDocId(docId("active"));
    const body = await as(B, "tandem_editAnnotation", { id: "ann", content: "x" });
    expect(body.details).toMatchObject({ reason: "held", documentId: docId("background") });
    expect(body.message).not.toContain("named no documentId");
  });

  /** Records the pinned document holds for the id, and what each tool must say about them. */
  const PRESENT: Array<{ name: string; record: Record<string, unknown> | "raw-malformed" }> = [
    { name: "a Claude comment", record: {} },
    { name: "a user comment", record: { author: "user" } },
    { name: "a note", record: { type: "note", audience: "private", author: "user" } },
    { name: "a legacy flag", record: { type: "flag", author: "user" } },
    { name: "a private comment", record: { audience: "private", author: "user" } },
    {
      name: "a user highlight",
      record: { type: "highlight", author: "user", audience: "private" },
    },
    {
      name: "a Claude highlight with no audience",
      record: { type: "highlight", audience: undefined },
    },
    { name: "an unknown type", record: { type: "mystery" } },
    { name: "a record with no range", record: "raw-malformed" },
  ];

  it.each(PRESENT.flatMap((row) => ID_TOOLS.map((t) => ({ ...row, ...t }))))(
    "$tool on $name in a document another record holds is NOT_DOC_OWNER, with or without documentId",
    async ({ record, tool, args }) => {
      const ydoc = setupDoc("held");
      if (record === "raw-malformed") {
        withInternal(ydoc, () =>
          ydoc
            .getMap(Y_MAP_ANNOTATIONS)
            .set("ann", { id: "ann", type: "comment", status: "pending" }),
        );
      } else {
        seed(ydoc, "ann", record);
      }
      setDocOwner(docId("held"), { ownerId: A, kind: "opened" }, "take");
      setActiveDocId(docId("held"));
      const before = snapshot(ydoc);
      const transactions = countTransactions(ydoc);

      for (const withId of [true, false]) {
        const body = await as(B, tool, {
          ...args("ann"),
          ...(withId ? { documentId: docId("held") } : {}),
        });
        expect(body.code, withId ? "explicit" : "omitted").toBe("NOT_DOC_OWNER");
        // The refusal is about the document: nothing in it describes the record.
        const allowed = ["documentId", "heldDocumentIds", "holder", "reason"];
        expect(Object.keys(body.details ?? {}).filter((k) => !allowed.includes(k))).toEqual([]);
        expect(body.details).toMatchObject({ reason: "held", documentId: docId("held") });
      }
      expect(transactions()).toBe(0);
      expect(snapshot(ydoc)).toBe(before);
    },
  );

  it.each(ID_TOOLS)(
    "$tool on an id the document does not hold answers NOT_FOUND, unchecked, unclaimed and with no marker",
    async ({ tool, args }) => {
      const held = setupDoc("held");
      const free = setupDoc("free");
      setDocOwner(docId("held"), { ownerId: A, kind: "opened" }, "take");
      const transactions = [countTransactions(held), countTransactions(free)];

      const onHeld = await as(B, tool, { ...args("no-such-id"), documentId: docId("held") });
      expect(onHeld.code).toBe("NOT_FOUND");
      expect(onHeld.details).toBeUndefined();
      const onFree = await as(B, tool, { ...args("no-such-id"), documentId: docId("free") });
      expect(onFree.code).toBe("NOT_FOUND");

      expect(transactions.map((t) => t())).toEqual([0, 0]);
      expect(getDocOwner(docId("free"))).toBeUndefined();
      expect(holds(A, "held")).toBe(true);
    },
  );

  it("a record that appears while the call waits is checked, and one that vanishes is not", async () => {
    const ydoc = setupDoc("held");
    setDocOwner(docId("held"), { ownerId: A, kind: "opened" }, "take");
    let release!: () => void;
    let gate = new Promise<void>((r) => {
      release = r;
    });
    let inFlight = runDocOp(docId("held"), () => gate);
    const { answer: appears } = await start(B, "tandem_removeAnnotation", {
      id: "late",
      documentId: docId("held"),
    });
    seed(ydoc, "late");
    release();
    await inFlight;
    expect((await appears).code).toBe("NOT_DOC_OWNER");
    expect(ydoc.getMap(Y_MAP_ANNOTATIONS).has("late")).toBe(true);

    gate = new Promise<void>((r) => {
      release = r;
    });
    inFlight = runDocOp(docId("held"), () => gate);
    const { answer: vanishes } = await start(B, "tandem_removeAnnotation", {
      id: "late",
      documentId: docId("held"),
    });
    withInternal(ydoc, () => ydoc.getMap(Y_MAP_ANNOTATIONS).delete("late"));
    release();
    await inFlight;
    const body = await vanishes;
    expect(body.code).toBe("NOT_FOUND");
    expect(body.details).toBeUndefined();
  });

  it("an id in more than one document: today's refusal, plus which candidates the caller holds", async () => {
    const one = setupDoc("one");
    const two = setupDoc("two");
    const private_ = setupDoc("private");
    seed(one, "dup");
    seed(two, "dup");
    seed(private_, "dup", { type: "note", audience: "private", author: "user" });
    setDocOwner(docId("two"), { ownerId: B, kind: "opened" }, "take");
    setDocOwner(docId("private"), { ownerId: B, kind: "opened" }, "take");

    const body = await as(B, "tandem_editAnnotation", { id: "dup", content: "x" });
    expect(body.code).toBe("INVALID_ARGUMENT");
    expect(body.details).toEqual({
      reason: "ambiguous-document",
      documentIds: [docId("one"), docId("two")],
      heldDocumentIds: [docId("two")],
    });
  });
});

describe("NOT_DOC_OWNER is answered before every lifecycle refusal (ownership design §5.1)", () => {
  it.each([
    {
      name: "NOT_OWNED",
      record: { author: "user" },
      tool: "tandem_editAnnotation",
      args: { content: "x" },
      alone: "NOT_OWNED",
    },
    {
      name: "ANNOTATION_RESOLVED",
      record: { status: "accepted" },
      tool: "tandem_editAnnotation",
      args: { content: "x" },
      alone: "ANNOTATION_RESOLVED",
    },
    {
      name: "ACCEPT_REFUSED",
      record: {},
      tool: "tandem_resolveAnnotation",
      args: { action: "accept" },
      alone: "ACCEPT_REFUSED",
    },
    {
      name: "the private-note refusal",
      record: { type: "note", audience: "private", author: "user" },
      tool: "tandem_removeAnnotation",
      args: {},
      alone: "INVALID_ARGUMENT",
    },
    {
      name: "an empty patch",
      record: {},
      tool: "tandem_editAnnotation",
      args: {},
      alone: "INVALID_ARGUMENT",
    },
  ])("before $name", async ({ record, tool, args, alone }) => {
    const ydoc = setupDoc("d");
    seed(ydoc, "ann", record);
    const idArg = tool === "tandem_annotationReply" ? { annotationId: "ann" } : { id: "ann" };
    // The owner gets the lifecycle's own answer…
    setDocOwner(docId("d"), { ownerId: A, kind: "opened" }, "take");
    expect((await as(A, tool, { ...idArg, ...args, documentId: docId("d") })).code).toBe(alone);
    // …and a record that does not hold the document never reaches it.
    const refused = await as(B, tool, { ...idArg, ...args, documentId: docId("d") });
    expect(refused.code).toBe("NOT_DOC_OWNER");
    expect(JSON.stringify(refused)).not.toContain("note");
    expect(JSON.stringify(refused)).not.toContain("private");
  });
});

describe("one answer per thread item (R1.5, §5.5)", () => {
  function thread(name = "d") {
    const ydoc = setupDoc(name);
    seed(ydoc, "ann");
    const reply = addUserReply(ydoc, "ann", "what about this?", () => {});
    expect(reply.kind).toBe("ok");
    return ydoc;
  }
  const answer = (owner: string, name = "d") =>
    as(owner, "tandem_annotationReply", {
      annotationId: "ann",
      text: "answer",
      documentId: docId(name),
    });

  it("R1.5: a second record that takes the document is still refused on an answered item", async () => {
    const ydoc = thread();
    expect((await answer(A)).error).toBe(false);

    // Not the holder: told the item is answered, not to take the document.
    const before = await answer(B);
    expect(before.code).toBe("NOT_DOC_OWNER");
    expect(before.details).toMatchObject({
      reason: "answered",
      holder: { label: getOwnerRecord(A)?.label, displayKind: "terminal" },
    });

    // B takes the document (decision 3) and is now its owner — still refused.
    setDocOwner(docId("d"), { ownerId: B, kind: "opened" }, "take");
    const after = await answer(B);
    expect(after.details?.reason).toBe("answered");
    expect(Object.keys(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).toJSON())).toHaveLength(2);
  });

  it("`answered` is said before `lost` and before `held`", async () => {
    thread();
    await answer(A);
    setDocOwner(docId("d"), { ownerId: B, kind: "opened" }, "take");
    // A lost the document AND B is the holder; B answered nothing. A's item
    // is its own, so A falls to `lost`; a third record gets `answered`.
    register("claude:session-c");
    const third = await answer("claude:session-c");
    expect(third.details?.reason).toBe("answered");
    expect((await answer(A)).details?.reason).toBe("lost");
    expect(envelopes.join("\n")).not.toContain("session-c");
  });

  it("the answerer may reply again; a new user reply is a new item the new owner may answer", async () => {
    const ydoc = thread();
    await answer(A);
    expect((await answer(A)).error).toBe(false);

    setDocOwner(docId("d"), { ownerId: B, kind: "opened" }, "take");
    expect((await answer(B)).details?.reason).toBe("answered");
    addUserReply(ydoc, "ann", "and this?", () => {});
    expect((await answer(B)).error).toBe(false);
    // B is that item's answerer now; A, were it to hold the document again, is not.
    setDocOwner(docId("d"), { ownerId: A, kind: "opened" }, "take");
    expect((await answer(A)).details?.reason).toBe("answered");
  });

  it("a thread with no user reply has no item: nothing is recorded", async () => {
    const ydoc = setupDoc("d");
    seed(ydoc, "ann");
    expect((await answer(A)).error).toBe(false);
    expect(ownershipSnapshotForTests().answerers).toBe(0);
  });

  it("a reply the lifecycle refuses records no answerer", async () => {
    const ydoc = thread();
    const tooLong = await as(A, "tandem_annotationReply", {
      annotationId: "ann",
      text: "x".repeat(100_001),
      documentId: docId("d"),
    });
    expect(tooLong.code).toBe("INVALID_ARGUMENT");
    expect(ownershipSnapshotForTests().answerers).toBe(0);
    expect(getDocOwner(docId("d"))).toBeUndefined();
    expect(Object.keys(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).toJSON())).toHaveLength(1);
  });

  it("a record that stopped being Claude-facing after its answer has no item: the lifecycle's refusal, never `answered`", async () => {
    for (const patch of [
      { audience: "private" },
      { type: "note", audience: "private" },
      { type: "flag" },
    ]) {
      const name = `d-${JSON.stringify(patch).length}-${Object.keys(patch).length}-${patch.type ?? "c"}`;
      const ydoc = thread(name);
      await answer(A, name);
      setDocOwner(docId(name), { ownerId: B, kind: "opened" }, "take");
      withInternal(ydoc, () => {
        const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
        map.set("ann", { ...(map.get("ann") as object), ...patch });
      });
      const body = await answer(B, name);
      expect(body.code, JSON.stringify(patch)).toBe("INVALID_ARGUMENT");
      expect(body.details).toBeUndefined();
    }
  });

  it("a reply written during Solo is not the item until it is released, in any mode", async () => {
    const ydoc = thread();
    await answer(A);
    setDocOwner(docId("d"), { ownerId: B, kind: "opened" }, "take");

    setMode("solo");
    // Written in Solo: stamped held, so Claude cannot read it — and it must
    // neither change the item nor be revealed by an accepted reply.
    addUserReply(ydoc, "ann", "held question", () => {});
    expect((await answer(B)).details?.reason).toBe("answered");
    setMode("tandem");
    // Still held (nothing released it): the same answer after the mode flips.
    expect((await answer(B)).details?.reason).toBe("answered");

    // Released: the held reply becomes the latest visible item.
    withInternal(ydoc, () => {
      const replies = ydoc.getMap(Y_MAP_ANNOTATION_REPLIES);
      for (const [key, value] of replies.entries()) {
        const { heldInSolo: _held, ...rest } = value as Record<string, unknown>;
        replies.set(key, rest);
      }
    });
    expect((await answer(B)).error).toBe(false);
  });

  it("an answer given during Solo is recorded against the item Claude could see", async () => {
    thread();
    setMode("solo");
    expect((await answer(A)).error).toBe(false);
    setMode("tandem");
    setDocOwner(docId("d"), { ownerId: B, kind: "opened" }, "take");
    expect((await answer(B)).details?.reason).toBe("answered");
  });

  it("removing the annotation forgets its answerers; closing and reopening the document does not", async () => {
    thread();
    await answer(A);
    expect(ownershipSnapshotForTests().answerers).toBe(1);
    await closeDocumentById(docId("d"));
    expect(ownershipSnapshotForTests().answerers).toBe(1);

    thread("e");
    await answer(A, "e");
    await as(A, "tandem_removeAnnotation", { id: "ann", documentId: docId("e") });
    expect(ownershipSnapshotForTests().answerers).toBe(1);
  });

  it("an answerer whose record is gone still blocks the item, named only as another session", async () => {
    thread();
    const gone = register("claude:session-gone");
    await answer("claude:session-gone");
    setDocOwner(docId("d"), null, "lapse");
    view = view.filter((e) => e !== gone);
    vi.useFakeTimers();
    setGraceMsForTests(10);
    noteTransportChanged("claude:session-gone");
    vi.advanceTimersByTime(20);
    vi.useRealTimers();
    expect(getOwnerRecord("claude:session-gone")).toBeUndefined();

    const body = await answer(B);
    expect(body.details).toMatchObject({ reason: "answered", holder: null });
    expect(body.message).toBe("Another session already answered this. Do not answer it again.");
    expect(envelopes.join("\n")).not.toContain("session-gone");
  });
});

describe("what a refusal may say (R3.6)", () => {
  it("a client that names itself Tandem's Claude is shown as another app, and its name never appears", async () => {
    register("bridge:forger", "bridge", "Tandem's Claude");
    setupDoc("d");
    setDocOwner(docId("d"), { ownerId: "bridge:forger", kind: "opened" }, "take");
    const body = await as(B, "tandem_save", { documentId: docId("d") });
    expect(body.details?.holder).toEqual({
      label: getOwnerRecord("bridge:forger")?.label,
      displayKind: "other app",
    });
    expect(JSON.stringify(body)).not.toContain("Tandem's Claude");
    expect(JSON.stringify(body)).not.toContain("forger");
  });

  it("a direct-HTTP Claude Code terminal is told to restart", async () => {
    register("http:legacy-transport", "http", "claude-code");
    setupDoc("d");
    setDocOwner(docId("d"), { ownerId: A, kind: "opened" }, "take");
    const body = await as("http:legacy-transport", "tandem_save", { documentId: docId("d") });
    expect(body.message).toContain("restart this terminal");
    expect(JSON.stringify(body)).not.toContain("legacy-transport");
  });
});
