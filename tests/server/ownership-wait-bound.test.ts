/**
 * The wait bound on the per-document operation queue, through the registered
 * MCP tools (#2358, ADR-054 as amended 2026-11-11: Bryan's "Time limit, then
 * 'try again'").
 *
 * Flag on for the whole file; every caller is a real owner record. Fake
 * timers throughout: nothing here sleeps. The queue's own mechanics are
 * `doc-op-queue.test.ts`; that a dark write never waits at all is
 * `ownership-dark-enforcement.test.ts`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { openFromDisk } from "../../src/server/documents/open.js";
import { addDoc, removeDoc } from "../../src/server/documents/registry-testing.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import { getActiveDocId, getOpenDocs } from "../../src/server/mcp/document-service.js";
import { ownedOpen, takeFreshDocument } from "../../src/server/mcp/owned-op.js";
import {
  type McpToolResult,
  mcpSuccess,
  withErrorBoundary,
  withStructuredErrors,
} from "../../src/server/mcp/response.js";
import type { ToolCaller } from "../../src/server/sessions/caller.js";
import {
  DOC_OP_WAIT_MS,
  isDocOpQueueBusy,
  runDocOp,
} from "../../src/server/sessions/doc-op-queue.js";
import {
  getDocOwner,
  getOwnerRecord,
  noteTransportChanged,
  noteTransportRegistered,
  ownershipSnapshotForTests,
  resetOwnershipForTests,
  setDocOwner,
  setGraceMsForTests,
  setTransportView,
  type TransportViewEntry,
} from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";
import { asTestCaller } from "../helpers/ownership-caller.js";

const A = "claude:wait-a";
const B = "claude:wait-b";

let client: Client;
let close: (() => Promise<void>) | undefined;
let view: TransportViewEntry[];
let callingAs = A;
let run = 0;
let prefix = "";
let tmpDir = "";

const docId = (name: string) => `${prefix}-${name}`;

type Body = {
  error: boolean;
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
  data?: Record<string, unknown>;
};

function setupDoc(name: string): { id: string; ydoc: Y.Doc } {
  const id = docId(name);
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, "Hello world, this is a test document.");
  addDoc(id, {
    id,
    filePath: path.join(tmpDir, `${id}.md`),
    format: "md",
    readOnly: false,
    source: "file",
  });
  return { id, ydoc };
}

const text = (ydoc: Y.Doc) => ydoc.getXmlFragment("default").toString();

/** An operation that holds `id`'s queue until `release()`. */
function hold(id: string): { release: () => void; done: Promise<void> } {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return { release, done: runDocOp(id, () => gate) };
}

/** Let in-flight messages and promise callbacks run without moving the clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
}

/** Start a call as `owner` and return once the server has it. */
async function start(
  owner: string,
  tool: string,
  args: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<{ answer: Promise<Body> }> {
  callingAs = owner;
  const pending = client
    .callTool({ name: tool, arguments: args }, undefined, options)
    .then((r) => parseResult(r) as Body);
  // Observed below, so a rejection (an aborted call) is never unhandled.
  pending.catch(() => undefined);
  await settle();
  // Wrapped: an async function that returned the promise itself would wait for it.
  return { answer: pending };
}

beforeEach(async () => {
  vi.stubEnv("TANDEM_OWNERSHIP", "1");
  run++;
  prefix = `wait${run}`;
  callingAs = A;
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  view = [
    { ownerId: A, openStreams: 1 },
    { ownerId: B, openStreams: 1 },
  ];
  setTransportView(() => view);
  noteTransportRegistered(A, { recordKind: "claude" });
  noteTransportRegistered(B, { recordKind: "claude" });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-wait-"));
  ({ client, close } = await setupMcpServer([registerDocumentTools, registerAnnotationTools], {
    dispatch: (fn) => asTestCaller(fn, { ownerId: callingAs }),
  }));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(async () => {
  vi.useRealTimers();
  await close?.();
  close = undefined;
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  resetOwnershipForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("a write that waits past the limit", () => {
  it("is refused DOCUMENT_BUSY, claims nothing, writes nothing, and the retry runs once the document is free", async () => {
    const { id, ydoc } = setupDoc("d");
    const before = text(ydoc);
    const head = hold(id);

    const waiting = await start(A, "tandem_edit", {
      from: 0,
      to: 5,
      newText: "Howdy",
      documentId: id,
    });
    await vi.advanceTimersByTimeAsync(DOC_OP_WAIT_MS - 1);
    // Still waiting: no answer yet, nothing claimed.
    expect(getDocOwner(id)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    const body = await waiting.answer;

    expect(body.code).toBe("DOCUMENT_BUSY");
    expect(body.details).toEqual({
      reason: "wait-expired",
      documentId: id,
      waitedMs: DOC_OP_WAIT_MS,
    });
    expect(body.message).toContain("nothing was changed");
    expect(body.message).toContain("Retry once");
    expect(getDocOwner(id)).toBeUndefined();
    expect(text(ydoc)).toBe(before);

    // The head finishes. The refused call's turn comes and it is skipped:
    // nothing lands late, and no queue entry is left.
    head.release();
    await head.done;
    await settle();
    expect(text(ydoc)).toBe(before);
    expect(getDocOwner(id)).toBeUndefined();
    expect(isDocOpQueueBusy(id)).toBe(false);
    expect(ownershipSnapshotForTests().queuedDocuments).toBe(0);

    // The retry is an ordinary call.
    const retried = await start(A, "tandem_edit", {
      from: 0,
      to: 5,
      newText: "Howdy",
      documentId: id,
    });
    const retry = await retried.answer;
    expect(retry.error).toBe(false);
    expect(text(ydoc)).toContain("Howdy world");
    expect(text(ydoc)).not.toContain("HowdyHowdy");
    expect(getDocOwner(id)).toMatchObject({ ownerId: A, kind: "claimed" });
  });

  it("the calls behind it still run in order", async () => {
    const { id, ydoc } = setupDoc("d");
    const head = hold(id);
    const first = await start(A, "tandem_comment", { from: 0, to: 5, text: "one", documentId: id });
    await vi.advanceTimersByTimeAsync(DOC_OP_WAIT_MS - 1000);
    // Queued 1 s before the first gives up, so it has most of its own wait left.
    const second = await start(A, "tandem_comment", {
      from: 0,
      to: 5,
      text: "two",
      documentId: id,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await first.answer).code).toBe("DOCUMENT_BUSY");
    head.release();
    await head.done;
    expect((await second.answer).error).toBe(false);
    const contents = Object.values(ydoc.getMap(Y_MAP_ANNOTATIONS).toJSON()).map(
      (a) => (a as { content: string }).content,
    );
    expect(contents).toEqual(["two"]);
  });

  it("names no holder, even when another record holds the document", async () => {
    const { id } = setupDoc("d");
    setDocOwner(id, { ownerId: B, kind: "opened" }, "take");
    const head = hold(id);
    const waiting = await start(A, "tandem_comment", { from: 0, to: 5, text: "x", documentId: id });
    await vi.advanceTimersByTimeAsync(DOC_OP_WAIT_MS);
    const body = await waiting.answer;
    // The ownership check is inside the operation, which never ran.
    expect(body.code).toBe("DOCUMENT_BUSY");
    expect(JSON.stringify(body)).not.toContain(getOwnerRecord(B)?.label as string);
    expect(body.details).not.toHaveProperty("holder");
    head.release();
    await head.done;
  });
});

describe("tandem_open that waits past the limit", () => {
  it("is refused DOCUMENT_BUSY before any reload, activation or take", async () => {
    const filePath = path.join(tmpDir, "open.md");
    fs.writeFileSync(filePath, "On disk.\n");
    const opened = await openFromDisk(filePath);
    const id = opened.documentId;
    setupDoc("other");
    const active = getActiveDocId();
    let transactions = 0;
    getOrCreateDocument(id).on("afterTransaction", () => {
      transactions++;
    });
    const head = hold(id);

    const waiting = await start(A, "tandem_open", { filePath, force: true });
    await vi.advanceTimersByTimeAsync(DOC_OP_WAIT_MS);
    const body = await waiting.answer;

    expect(body.code).toBe("DOCUMENT_BUSY");
    expect(body.details).toMatchObject({ reason: "wait-expired", documentId: id });
    expect(transactions).toBe(0);
    expect(getActiveDocId()).toBe(active);
    expect(getDocOwner(id)).toBeUndefined();
    head.release();
    await head.done;
    await settle();
    expect(transactions).toBe(0);
    expect(getDocOwner(id)).toBeUndefined();
  });

  const envelope = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

  it("has one wait for the whole call, however many times its target moves", async () => {
    // Three targets, every one busy: the three hops together may wait one
    // limit, not three.
    const heads = ["m0", "m1", "m2"].map((name) => hold(setupDoc(name).id));
    const ids = ["m0", "m1", "m2"].map(docId);
    let asked = 0;
    let settled: McpToolResult | undefined;
    const call = ownedOpen({ ownerId: A }, "tandem_open", {
      // Stable long enough to wait in a queue, then a new target.
      predict: () => ids[Math.min(Math.floor(asked++ / 2), 2)],
      open: async () => ({ envelope: envelope("{}") }),
    }).then((r) => {
      settled = r;
    });
    await vi.advanceTimersByTimeAsync(DOC_OP_WAIT_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await call;
    expect((JSON.parse(settled?.content[0].text as string) as Body).code).toBe("DOCUMENT_BUSY");
    for (const h of heads) h.release();
    await Promise.all(heads.map((h) => h.done));
  });

  it("a hop with nothing left of the wait still runs when its queue is idle: only waiting is refused", async () => {
    const { id: slow } = setupDoc("slow");
    const { id: next } = setupDoc("next");
    let target = slow;
    const opens: string[] = [];
    const call = ownedOpen({ ownerId: A }, "tandem_open", {
      predict: () => target,
      open: async (expectTargetId) => {
        opens.push(expectTargetId as string);
        if (expectTargetId === slow) {
          // The open itself runs longer than the whole wait limit, then
          // finds its target moved.
          await new Promise((r) => setTimeout(r, DOC_OP_WAIT_MS + 5000));
          target = next;
          return { envelope: envelope("{}"), targetChanged: true };
        }
        return { envelope: envelope('{"opened":true}'), openedId: next };
      },
    });
    await vi.advanceTimersByTimeAsync(DOC_OP_WAIT_MS + 5000);
    const result = await call;
    expect(result.content[0].text).toBe('{"opened":true}');
    expect(opens).toEqual([slow, next]);
    expect(getDocOwner(next)).toMatchObject({ ownerId: A, kind: "opened" });
  });
});

describe("a call whose request was cancelled before its turn", () => {
  it("is skipped at its turn: its body never runs, nothing is claimed, and the next call runs", async () => {
    const { id, ydoc } = setupDoc("d");
    const before = text(ydoc);
    const head = hold(id);
    const abort = new AbortController();

    const cancelled = await start(
      A,
      "tandem_edit",
      { from: 0, to: 5, newText: "Late!", documentId: id },
      { signal: abort.signal },
    );
    // What a client does when its own timeout fires or the user interrupts:
    // it sends `notifications/cancelled` for the request.
    abort.abort("client gave up");
    await expect(cancelled.answer).rejects.toBeDefined();
    await settle();
    const after = await start(A, "tandem_comment", { from: 0, to: 5, text: "c", documentId: id });

    head.release();
    await head.done;
    expect((await after.answer).error).toBe(false);
    await settle();
    // The cancelled edit's turn came and went without it.
    expect(text(ydoc)).toBe(before);
    expect(text(ydoc)).not.toContain("Late!");
    expect(ydoc.getMap(Y_MAP_ANNOTATIONS).size).toBe(1);
    expect(isDocOpQueueBusy(id)).toBe(false);
  });

  it("the signal reaches the caller through either wrapper, and only with ownership on", async () => {
    const signal = new AbortController().signal;
    const seen: ToolCaller[] = [];
    const handler = async (_args: Record<string, unknown>, caller: ToolCaller) => {
      seen.push(caller);
      return mcpSuccess({});
    };
    const plain = withErrorBoundary("tandem_test", handler);
    const structured = withStructuredErrors(withErrorBoundary("tandem_test", handler));

    await asTestCaller(() => plain({}, { signal }), { ownerId: A });
    await asTestCaller(() => structured({}, { signal }), { ownerId: A });
    expect(seen.map((c) => c.signal)).toEqual([signal, signal]);
    expect(seen[0].ownerId).toBe(A);
    // No `extra` (a handler called directly): no key at all.
    await asTestCaller(() => plain({}), { ownerId: A });
    expect("signal" in seen[2]).toBe(false);

    // Dark: the caller object is exactly what it was before this existed.
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    await asTestCaller(() => plain({}, { signal }), { ownerId: A });
    await structured({}, { signal });
    expect(seen[3]).toEqual({});
    expect(seen[4]).toEqual({});
  });
});

describe("a lapse behind an operation that never settles", () => {
  it("moves the dead owner's document at the limit, and the record goes", async () => {
    const { id } = setupDoc("stuck");
    setDocOwner(id, { ownerId: A, kind: "opened" }, "take");
    const head = hold(id);

    // A's transport goes away and its grace runs out while the queue is busy.
    view = view.filter((e) => e.ownerId !== A);
    setGraceMsForTests(10);
    noteTransportChanged(A);
    // The grace ends at exactly 10 ms, and the lapse is queued then.
    await vi.advanceTimersByTimeAsync(10);
    // Deferred behind the running operation, as before.
    expect(getDocOwner(id)).toMatchObject({ ownerId: A });

    await vi.advanceTimersByTimeAsync(DOC_OP_WAIT_MS - 1);
    expect(getDocOwner(id)).toMatchObject({ ownerId: A });
    await vi.advanceTimersByTimeAsync(1);
    // The operation still has not settled; the document is free anyway.
    expect(getDocOwner(id)).toBeUndefined();
    expect(getOwnerRecord(A)).toBeUndefined();
    expect(isDocOpQueueBusy(id)).toBe(true);

    // Later calls are refused at the limit for as long as it stays stuck.
    const waiting = await start(B, "tandem_comment", { from: 0, to: 5, text: "x", documentId: id });
    await vi.advanceTimersByTimeAsync(DOC_OP_WAIT_MS);
    expect((await waiting.answer).code).toBe("DOCUMENT_BUSY");

    // And if it ever does settle, the skipped lapse does not run a second time.
    setDocOwner(id, { ownerId: B, kind: "opened" }, "take");
    head.release();
    await head.done;
    await settle();
    expect(getDocOwner(id)).toMatchObject({ ownerId: B, kind: "opened" });
  });
});

describe("the take of a document a call just created", () => {
  it("waits only briefly for that document's queue, then leaves it untaken and does not fail the call", async () => {
    const { id } = setupDoc("fresh");
    const head = hold(id);
    let returned = false;
    const take = takeFreshDocument({ ownerId: A }, id).then(() => {
      returned = true;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await take;
    expect(returned).toBe(true);
    expect(getDocOwner(id)).toBeUndefined();
    head.release();
    await head.done;
    await settle();
    // Not taken late either.
    expect(getDocOwner(id)).toBeUndefined();
  });
});
