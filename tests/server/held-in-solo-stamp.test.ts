/**
 * #1769 hole 2 — the `heldInSolo` marker used to be stamped from the CREATING
 * WINDOW's local mode rune, not from the room.
 *
 * Two windows on one machine hold separate localStorage, so a comment written
 * from a window that believes it is in Tandem into a room that reads Solo is
 * hidden LIVE (`hideFromAI` reads the room) but carries no marker. After a
 * restart that loses the ctrl session the room reads `indeterminate`, where
 * `hideFromAI` withholds only MARKED records — and the comment is delivered.
 * Replies were already stamped server-side; annotations now are too.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { addDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import {
  attachObservers,
  detachObservers,
  resetForTesting,
} from "../../src/server/events/queue.js";
import { registerAnnotationTools } from "../../src/server/mcp/annotations.js";
import { registerAwarenessTools, resetInbox } from "../../src/server/mcp/awareness.js";
import { getDocument, getOrCreateDocument, removeDocument } from "../../src/server/yjs/provider.js";
import { CTRL_ROOM, Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import { MODE_RELEASE_ORIGIN, transactForTest, withMcp } from "../../src/shared/origins.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { clearOpenDocs } from "../helpers/doc-service.js";

const DOC_ID = "held-in-solo-stamp-doc";

let doc: Y.Doc;

function annMap(): Y.Map<unknown> {
  return doc.getMap(Y_MAP_ANNOTATIONS);
}

function userComment(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    author: "user",
    type: "comment",
    audience: "outbound",
    range: { from: 0, to: 5 },
    content: "hello",
    status: "pending",
    timestamp: 1,
    rev: 1,
    ...extra,
  };
}

function rec(id: string): Record<string, unknown> {
  return annMap().get(id) as Record<string, unknown>;
}

/**
 * A browser write as it reaches the server: a non-null origin that is NOT in the
 * channel-skip set. `TEST_ORIGIN` has exactly that profile, which is why the
 * fixture sweep in the spec named the suites that seed under it.
 */
function browserWrite(fn: () => void): void {
  transactForTest(doc, fn);
}

beforeEach(() => {
  resetForTesting();
  clearOpenDocs();
  removeDocument(DOC_ID);
  doc = getOrCreateDocument(DOC_ID);
  addDoc(DOC_ID, {
    id: DOC_ID,
    filePath: `/tmp/${DOC_ID}.md`,
    format: "md",
    readOnly: false,
    source: "file",
  });
  setActiveDocId(DOC_ID);
  attachObservers(DOC_ID, doc);
  setCtrlMode("solo");
});

afterEach(() => {
  detachObservers(DOC_ID);
  resetForTesting();
  clearOpenDocs();
  removeDocument(DOC_ID);
  setCtrlMode(null);
  vi.restoreAllMocks();
});

describe("the server-side heldInSolo stamp (#1769)", () => {
  it("marks a browser-written user comment, bumps rev, and writes under MODE_RELEASE_ORIGIN", () => {
    // The origin assertion is the ONLY pin of the helper choice — `audit:origins`
    // asserts floors, not which helper a site picked. A `withBrowser` stamp is
    // channel-eligible by construction and reds this row.
    const origins: unknown[] = [];
    doc.on("afterTransaction", (txn: Y.Transaction) => {
      origins.push(txn.origin);
    });

    browserWrite(() => annMap().set("a1", userComment("a1")));

    const after = rec("a1");
    expect(after.heldInSolo).toBe(true);
    expect(after.rev as number).toBeGreaterThan(1);
    expect(origins).toContain(MODE_RELEASE_ORIGIN);
    // The stamp is not an edit: `editedAt` is untouched, including its absence.
    expect(after.editedAt).toBeUndefined();
  });

  it("reads the SANITIZED type, so a stored legacy `question` is stamped", () => {
    browserWrite(() => annMap().set("q1", userComment("q1", { type: "question" })));
    expect(rec("q1").heldInSolo).toBe(true);
  });

  it("stamps an UPDATE of an unmarked comment made while the room reads Solo", () => {
    setCtrlMode("tandem");
    browserWrite(() => annMap().set("u1", userComment("u1", { editedAt: 7 })));
    expect(rec("u1").heldInSolo).toBeUndefined();

    setCtrlMode("solo");
    browserWrite(() => annMap().set("u1", { ...rec("u1"), content: "edited" }));

    const after = rec("u1");
    expect(after.heldInSolo).toBe(true);
    expect(after.editedAt).toBe(7);
  });

  it("does not stamp while the room reads Tandem", () => {
    setCtrlMode("tandem");
    browserWrite(() => annMap().set("t1", userComment("t1")));
    expect(rec("t1").heldInSolo).toBeUndefined();
    expect(rec("t1").rev).toBe(1);
  });

  it("STAMPS when the mode key is absent (indeterminate), matching the reply stamp", () => {
    // Kills a gate written as `=== "solo"`. A comment authored while the key is
    // absent is exactly the record a later `indeterminate` must keep withholding.
    setCtrlMode(null);
    browserWrite(() => annMap().set("i1", userComment("i1")));
    expect(rec("i1").heldInSolo).toBe(true);
  });

  it("skips a channel-skipped origin (an MCP write)", () => {
    withMcp(doc, () => annMap().set("m1", userComment("m1")));
    expect(rec("m1").heldInSolo).toBeUndefined();
  });

  it("skips a null-origin transaction (a restore or a doc swap)", () => {
    const scratch = new Y.Doc();
    scratch.getMap(Y_MAP_ANNOTATIONS).set("n1", userComment("n1"));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(scratch));
    expect(rec("n1").heldInSolo).toBeUndefined();
  });

  it("does not re-enter: exactly one write for an unmarked seed, none for a marked one", () => {
    let sets = 0;
    const map = annMap();
    const realSet = map.set.bind(map);
    const spy = vi.spyOn(map, "set");
    spy.mockImplementation(((key: string, value: unknown) => {
      sets += 1;
      return realSet(key, value as never);
    }) as typeof map.set);

    browserWrite(() => map.set("r1", userComment("r1")));
    // One seed + one stamp; the stamp's own transaction fires no third.
    expect(sets).toBe(2);

    sets = 0;
    browserWrite(() => map.set("r2", userComment("r2", { heldInSolo: true })));
    expect(sets).toBe(1);
  });

  it("leaves a Claude comment and a user note alone", () => {
    browserWrite(() => {
      annMap().set("c1", userComment("c1", { author: "claude" }));
      annMap().set("n2", userComment("n2", { type: "note", audience: "private" }));
    });
    expect(rec("c1").heldInSolo).toBeUndefined();
    expect(rec("n2").heldInSolo).toBeUndefined();
  });

  it("never resolves CTRL_ROOM when a transaction holds no candidate", () => {
    // `readModeState()` does a lookup-or-CREATE on CTRL_ROOM, so the early
    // return before it is what keeps the common transaction — the client's
    // accept/dismiss write of a Claude comment — free of that cost.
    removeDocument(CTRL_ROOM);
    browserWrite(() => annMap().set("c2", userComment("c2", { author: "claude" })));
    expect(getDocument(CTRL_ROOM)).toBeUndefined();
  });

  it("stamps the good record in a transaction that also carries a null value", () => {
    browserWrite(() => {
      annMap().set("bad", null);
      annMap().set("good", userComment("good"));
    });
    expect(rec("good").heldInSolo).toBe(true);
  });

  it("keeps the stamped comment out of tandem_checkInbox after a simulated restart", async () => {
    browserWrite(() => annMap().set("s1", userComment("s1")));
    expect(rec("s1").heldInSolo).toBe(true);

    // A CONTROL record, and the row is vacuous without it. Written while the
    // room reads Tandem, so the stamp declines and `hideFromAI` has nothing to
    // withhold under `indeterminate`. Asserting only "s1 is absent" passes on an
    // empty payload — which is exactly how this row shipped green while reading
    // the wrong nesting (`payload.userActions` rather than `payload.data.*`) and
    // the wrong key (`annotationId`; the bucket items are `Annotation &
    // { textSnippet }`, keyed `id`). Both lookups were `undefined`, `ids` was
    // always `[]`, and `not.toContain` could never fail.
    setCtrlMode("tandem");
    browserWrite(() => annMap().set("t1", userComment("t1")));
    expect(rec("t1").heldInSolo).toBeUndefined();

    // The restart: the ctrl session is lost, so the mode key is absent and
    // `readModeState()` reads `indeterminate` — where only MARKED records are
    // withheld. Driven through the REGISTERED handler, never a reimplemented
    // filter (the proxy trap `annotation-promote-pull-surface.test.ts` names).
    setCtrlMode(null);
    resetInbox();

    const server = new McpServer({ name: "tandem-test", version: "0.0.1" });
    registerAnnotationTools(server);
    registerAwarenessTools(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "0.0.1" });
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({ name: "tandem_checkInbox", arguments: {} });
    const content = result.content as Array<{ type: string; text?: string }>;
    const payload = JSON.parse(content.find((c) => c.type === "text")?.text ?? "{}");

    // `mcpSuccess` wraps as `{ error: false, data }`, so the buckets are one
    // level down — the sibling `mcp-tool-integration.test.ts` reads `parsed.data.*`.
    expect(payload.error).toBe(false);
    const ids = [
      ...(payload.data?.userActions ?? []).map((a: { id?: string }) => a.id),
      ...(payload.data?.userResponses ?? []).map((a: { id?: string }) => a.id),
    ];
    expect(ids).toContain("t1");
    expect(ids).not.toContain("s1");

    await mcpClient.close();
  });
});
