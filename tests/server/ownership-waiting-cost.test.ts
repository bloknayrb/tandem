/**
 * The cost of the waiting decision (#2358 PR 3b-2b4c, ADR-054's 3b-2b4c
 * amendment; the two flip-blocker rows "Waiting's cost is unmeasured
 * (3b-2b1b)" and "The waiting decision's cost is unmeasured
 * (3b-2b1b-chat)"). A measurement, not a speed gate: it records the numbers
 * and asserts only call counts and the answers, plus one bound loose enough
 * that a loaded Windows CI runner cannot reach it (`vitest-windows` runs the
 * suite). Set `TANDEM_MEASURE_WAITING=1` to print the numbers to stderr.
 *
 * The world is large and realistic: 50 open documents Tandem's Claude holds,
 * each with 100 user comments and 100 Claude comments carrying one user
 * reply (200 annotations, 100 replies), and 500 user chat rows. Both
 * questions are measured at their worst case, where nothing is waiting so
 * no scan stops early:
 *
 * - every comment and reply was handed to Tandem's Claude and acknowledged
 *   (real cursor-less `tandem_checkInbox` polls), so `documentWaiting` reads
 *   every annotation, every reply list and the registry for each item;
 * - every chat row is unread and on a document a terminal holds, so the chat
 *   side's `owedToFreshReader` clones and schema-parses all 500, and the
 *   waiting decision reads each one's standing before finding none is
 *   Tandem's Claude's.
 *
 * Platform: no files; synthetic paths only.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { addUserReply } from "../../src/server/annotations/lifecycle.js";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import {
  documentWaiting,
  handOverDocumentInbox,
  ownershipChatSide,
  registerAwarenessTools,
  resetInbox,
  setWaitingWrittenSinceForTests,
} from "../../src/server/mcp/awareness.js";
import { populateYDoc, registerDocumentTools } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { deliveryRegistry } from "../../src/server/mcp/inbox-cursor.js";
import {
  noteTransportRegistered,
  resetOwnershipForTests,
  setDocOwner,
  setOpenDocumentIdsSource,
  setOwnershipChatSide,
  setOwnershipInboxHandover,
  setOwnershipSeqSource,
  setTandemPresenceSource,
  setTransportView,
  setWaitingProbe,
  TANDEM_OWNER_ID,
  type TransportViewEntry,
  tandemWorkWaiting,
} from "../../src/server/sessions/ownership.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import { CTRL_ROOM, Y_MAP_ANNOTATIONS, Y_MAP_CHAT } from "../../src/shared/constants.js";
import { withBrowser, withInternal } from "../../src/shared/origins.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { parseResult, setupMcpServer } from "../helpers/mcp-harness.js";
import { asTestCaller } from "../helpers/ownership-caller.js";

const A = "claude:waiting-cost-a";
const TANDEM = TANDEM_OWNER_ID;
const DOCUMENTS = 50;
const USER_COMMENTS = 100;
const CLAUDE_COMMENTS = 100;
const CHAT_ROWS = 500;
const RUNS = 20;
/** Far above anything measured (see the ADR); only a hang or a blow-up reaches it. */
const LOOSE_BOUND_MS = 5_000;

let client: Client;
let close: (() => Promise<void>) | undefined;
let view: TransportViewEntry[];
let callingAs = TANDEM;
let clock = 1_000;
let probeCalls = 0;
const docIds: string[] = [];

const ctrl = () => getOrCreateDocument(CTRL_ROOM);
const chatMap = () => ctrl().getMap(Y_MAP_CHAT);

function mkDoc(id: string): Y.Doc {
  const ydoc = getOrCreateDocument(id);
  if (ydoc.getXmlFragment("default").length === 0) {
    populateYDoc(ydoc, "Hello world, this is a test document for the waiting cost.");
  }
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  return ydoc;
}

function comment(ydoc: Y.Doc, id: string, author: "user" | "claude"): void {
  withBrowser(ydoc, () =>
    ydoc.getMap(Y_MAP_ANNOTATIONS).set(id, {
      id,
      author,
      type: "comment",
      audience: "outbound",
      range: { from: 0, to: 5 },
      content: `text of ${id}`,
      status: "pending",
      timestamp: clock++,
      rev: 1,
    }),
  );
}

async function pollAs(owner: string, args: Record<string, unknown>): Promise<void> {
  callingAs = owner;
  const result = await client.callTool({ name: "tandem_checkInbox", arguments: args });
  expect(parseResult(result).error, JSON.stringify(result).slice(0, 500)).toBe(false);
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
}

function stats(samples: number[]): { median: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)] ?? 0, max: sorted.at(-1) ?? 0 };
}

const fmt = (n: number) => n.toFixed(2);

function record(line: string): void {
  if (process.env.TANDEM_MEASURE_WAITING === "1") process.stderr.write(`[waiting-cost] ${line}\n`);
}

beforeEach(async () => {
  vi.stubEnv("TANDEM_OWNERSHIP", "1");
  setWaitingWrittenSinceForTests(undefined);
  resetInbox();
  resetOwnershipForTests();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  withInternal(ctrl(), () => {
    for (const k of [...chatMap().keys()]) chatMap().delete(k);
  });
  probeCalls = 0;
  docIds.length = 0;
  view = [{ ownerId: A, openStreams: 1 }];
  setTransportView(() => view);
  noteTransportRegistered(A, { recordKind: "claude" });
  // The lines of `src/server/index.ts`, the probe counted.
  setOwnershipSeqSource(() => deliveryRegistry.counter);
  setOwnershipInboxHandover(handOverDocumentInbox);
  setOwnershipChatSide(ownershipChatSide);
  setWaitingProbe((documentId) => {
    probeCalls += 1;
    return documentWaiting(documentId);
  });
  setOpenDocumentIdsSource(() => getOpenDocs().keys());
  setTandemPresenceSource(() => true);
  setCtrlMode("tandem");
  ({ client, close } = await setupMcpServer(
    [registerAwarenessTools, registerDocumentTools, registerAnnotationTools],
    { dispatch: (fn) => asTestCaller(fn, { ownerId: callingAs }) },
  ));
  await client.listTools();

  // The terminal's document, which every chat row names.
  const theirs = "cost-theirs";
  mkDoc(theirs);
  setActiveDocId(theirs);
  setDocOwner(theirs, { ownerId: A, kind: "opened" }, "take", A);
  for (let d = 0; d < DOCUMENTS; d++) {
    const id = `cost-doc-${d}`;
    const ydoc = mkDoc(id);
    for (let i = 0; i < USER_COMMENTS; i++) comment(ydoc, `${id}-u${i}`, "user");
    for (let i = 0; i < CLAUDE_COMMENTS; i++) {
      const parent = `${id}-c${i}`;
      comment(ydoc, parent, "claude");
      const reply = addUserReply(ydoc, parent, `a reply on ${parent}`, () => {});
      expect(reply.kind).toBe("ok");
    }
    setDocOwner(id, { ownerId: TANDEM, kind: "default" }, "presence");
    docIds.push(id);
    expect(documentWaiting(id), "before the poll, its work is waiting").toBe(true);
    // Handed and acknowledged: a cursor-less poll acknowledges what it returns.
    await pollAs(TANDEM, { documentId: id });
  }
  withInternal(ctrl(), () => {
    for (let i = 0; i < CHAT_ROWS; i++) {
      const k = `cost-chat-${i}`;
      chatMap().set(k, {
        id: k,
        author: "user",
        text: `chat row ${i}`,
        timestamp: clock++,
        read: false,
        documentId: theirs,
      });
    }
  });
}, 120_000);

afterEach(async () => {
  await close?.();
  close = undefined;
  setWaitingProbe(() => false);
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  withInternal(ctrl(), () => {
    for (const k of [...chatMap().keys()]) chatMap().delete(k);
  });
  resetOwnershipForTests();
  resetInbox();
  setWaitingWrittenSinceForTests(undefined);
  vi.unstubAllEnvs();
});

describe("the waiting decision's cost (3b-2b4c's measurement)", () => {
  it(`records documentWaiting, owedToFreshReader and tandemWorkWaiting over ${DOCUMENTS} documents × ${USER_COMMENTS + CLAUDE_COMMENTS} annotations and ${CHAT_ROWS} chat rows`, () => {
    // documentWaiting, one document at a time (step 5's probe).
    const perDocument: number[] = [];
    for (let run = 0; run < 3; run++) {
      for (const id of docIds) {
        const { value, ms } = timed(() => documentWaiting(id));
        expect(value, id).toBe(false);
        perDocument.push(ms);
      }
    }
    // The chat side's scan (step 5's chat half, and each forward admit's scan).
    const owed: number[] = [];
    for (let run = 0; run < RUNS; run++) {
      const { value, ms } = timed(() => ownershipChatSide.owedToFreshReader());
      expect(value).toHaveLength(CHAT_ROWS);
      owed.push(ms);
    }
    // The whole decision (the supervisor's start-or-wake pass), another
    // session connected: every held document probed, the chat half read.
    const decision: number[] = [];
    probeCalls = 0;
    for (let run = 0; run < RUNS; run++) {
      const { value, ms } = timed(() => tandemWorkWaiting());
      expect(value).toBe(false);
      decision.push(ms);
    }
    expect(probeCalls, "one probe per held document per decision").toBe(DOCUMENTS * RUNS);

    // The chat half alone: the same scan step 5 makes when its probe answers
    // false (`tandemChatWaiting`, there filtered to the document), and the
    // scan each message forward's admit makes. Measured as the decision with
    // no held document: the documents go unowned (their handover re-owes
    // them, which does not matter here) and, the terminal connected, no
    // unheld document is probed.
    for (const id of docIds) setDocOwner(id, null, "presence");
    const chatHalf: number[] = [];
    probeCalls = 0;
    for (let run = 0; run < RUNS; run++) {
      const { value, ms } = timed(() => tandemWorkWaiting());
      expect(value).toBe(false);
      chatHalf.push(ms);
    }
    expect(probeCalls, "no document is probed").toBe(0);

    const doc = stats(perDocument);
    const half = stats(chatHalf);
    const chat = stats(owed);
    const whole = stats(decision);
    record(
      `documentWaiting per document: median ${fmt(doc.median)} ms, max ${fmt(doc.max)} ms (${perDocument.length} samples)`,
    );
    record(
      `owedToFreshReader over ${CHAT_ROWS} rows: median ${fmt(chat.median)} ms, max ${fmt(chat.max)} ms`,
    );
    record(
      `tandemWorkWaiting (${DOCUMENTS} held documents, ${CHAT_ROWS} rows): median ${fmt(whole.median)} ms, max ${fmt(whole.max)} ms`,
    );
    record(
      `the chat half alone (${CHAT_ROWS} rows, standing read for each): median ${fmt(half.median)} ms, max ${fmt(half.max)} ms`,
    );
    expect(whole.max).toBeLessThan(LOOSE_BOUND_MS);
    expect(half.max).toBeLessThan(LOOSE_BOUND_MS);
  }, 120_000);
});
