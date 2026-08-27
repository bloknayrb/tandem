/**
 * Claude's presence must expire.
 *
 * #1243 deleted the channel-awareness write that stamped `ClaudeAwareness` on
 * every SSE event the shim received — it was reporting a dead process as a live
 * model. But that write was also the only one that ever set `active: false`:
 * `tandem_status` hardcodes `active: true` and typing-presence's `withWorking`
 * spreads `prev` untouched. Without a sweep, one status call latches the pill and
 * the chat panel's "thinking" line for the life of the document's Y.Doc.
 *
 * The tests that matter most here are the two that pin the failure modes of the
 * sweep itself: it must not rewrite forever (a value-blind predicate stays true
 * after the clear, and `Y.Map.set` does not diff), and it must not fire while a
 * tool call is in flight.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addDoc, removeDoc } from "../../src/server/documents/registry-testing.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import {
  clearAllClaudePresence,
  isPresenceSweepArmed,
  noteClaudeActivity,
  PRESENCE_TTL_MS,
  resetPresenceExpiryForTests,
  sweepExpiredPresence,
} from "../../src/server/mcp/presence-expiry.js";
import { getOrCreateDocument, removeDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_AWARENESS, Y_MAP_CLAUDE } from "../../src/shared/constants.js";
import type { ClaudeAwareness } from "../../src/shared/types.js";

const DOC = "presence-expiry-doc";

function openDoc(id: string): Y.Doc {
  const ydoc = getOrCreateDocument(id);
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  return ydoc;
}

function setAwareness(doc: Y.Doc, value: ClaudeAwareness): void {
  doc.getMap(Y_MAP_AWARENESS).set(Y_MAP_CLAUDE, value);
}

function getAwareness(doc: Y.Doc): ClaudeAwareness | undefined {
  return doc.getMap(Y_MAP_AWARENESS).get(Y_MAP_CLAUDE) as ClaudeAwareness | undefined;
}

/** What `tandem_status` writes. */
function statusValue(over: Partial<ClaudeAwareness> = {}): ClaudeAwareness {
  return {
    status: "reviewing the intro",
    timestamp: Date.now(),
    active: true,
    focusParagraph: 3,
    focusOffset: 42,
    ...over,
  };
}

beforeEach(() => {
  resetPresenceExpiryForTests();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  removeDocument(DOC);
});

afterEach(() => {
  resetPresenceExpiryForTests();
});

describe("presence expiry sweep", () => {
  it("clears a stale presence claim", () => {
    const doc = openDoc(DOC);
    setAwareness(doc, statusValue());
    noteClaudeActivity(DOC);

    // Not yet stale.
    expect(sweepExpiredPresence(Date.now())).toBe(0);
    expect(getAwareness(doc)?.active).toBe(true);

    expect(sweepExpiredPresence(Date.now() + PRESENCE_TTL_MS + 1)).toBe(1);
    const after = getAwareness(doc);
    expect(after?.active).toBe(false);
    expect(after?.status).toBe("");
  });

  // `tandem_status` writes FIVE fields. Clearing only `active`/`status` leaves the
  // editor rendering a highlighted paragraph and a floating "AI" cursor forever —
  // the gutter decoration keys on `focusParagraph` alone, and the cursor widget
  // renders regardless of `active`.
  it("clears the focus fields too, not just active/status", () => {
    const doc = openDoc(DOC);
    setAwareness(doc, statusValue());
    noteClaudeActivity(DOC);

    sweepExpiredPresence(Date.now() + PRESENCE_TTL_MS + 1);

    const after = getAwareness(doc);
    expect(after?.focusParagraph).toBeNull();
    expect(after?.focusOffset).toBeNull();
  });

  // THE regression test. A time-only predicate stays true after the clear, and
  // Y.Map.set does not diff on value — so the sweep would emit a CRDT update every
  // tick for the life of the process, re-syncing to every client and (since the
  // session file encodes the whole doc) growing on every autosave.
  it("writes exactly once for a stale document, then stops", () => {
    const doc = openDoc(DOC);
    setAwareness(doc, statusValue());
    noteClaudeActivity(DOC);

    const t = Date.now() + PRESENCE_TTL_MS + 1;
    expect(sweepExpiredPresence(t)).toBe(1);

    const afterFirst = Y.encodeStateAsUpdate(doc).length;
    expect(sweepExpiredPresence(t + 1000)).toBe(0);
    expect(sweepExpiredPresence(t + 2000)).toBe(0);
    expect(Y.encodeStateAsUpdate(doc).length).toBe(afterFirst);
  });

  // `setPresenceOn` spreads `prev` without bumping `timestamp`, so a long run of
  // tool calls between status updates looks stale. Expiring then would darken the
  // pill at the exact moment Claude is busiest, while the typing dots animate.
  it("never expires while a tool call is in flight", () => {
    const doc = openDoc(DOC);
    setAwareness(doc, statusValue({ working: { tool: "tandem_edit", startedAt: 1, token: 1 } }));
    noteClaudeActivity(DOC);

    expect(sweepExpiredPresence(Date.now() + PRESENCE_TTL_MS * 10)).toBe(0);
    expect(getAwareness(doc)?.active).toBe(true);
  });

  it("preserves the working marker when it does clear", () => {
    const doc = openDoc(DOC);
    setAwareness(doc, statusValue());
    noteClaudeActivity(DOC);
    // Marker arrives after the activity note, before the sweep decides.
    const before = getAwareness(doc);
    if (!before) throw new Error("seed failed");
    setAwareness(doc, { ...before, status: "", active: true });

    sweepExpiredPresence(Date.now() + PRESENCE_TTL_MS + 1);
    expect(getAwareness(doc)?.active).toBe(false);
  });

  // Session restore applies the whole encoded Y.Doc back, awareness included, so
  // `active: true` outlives the process that wrote it. In the new process Claude
  // never ran, so an activity-armed sweep alone would never reach this document.
  it("clears presence restored from a previous process with no activity entry", () => {
    const doc = openDoc(DOC);
    setAwareness(doc, statusValue({ timestamp: 1 }));
    // Deliberately NO noteClaudeActivity — nothing in this process touched it.

    expect(sweepExpiredPresence(Date.now())).toBe(1);
    expect(getAwareness(doc)?.active).toBe(false);
  });

  it("ignores documents with no presence claim", () => {
    const doc = openDoc(DOC);
    expect(sweepExpiredPresence(Date.now())).toBe(0);
    expect(getAwareness(doc)).toBeUndefined();
  });

  // getOrCreateDocument inserts on miss, and eviction needs a WebSocket
  // disconnect — so resolving a closed doc during a sweep would leave a phantom
  // Y.Doc that nothing reclaims, and a later reopen would hand it back with its
  // stale awareness live.
  it("does not materialize a document that no longer exists", () => {
    openDoc(DOC);
    noteClaudeActivity(DOC);
    removeDoc(DOC);
    removeDocument(DOC);

    expect(() => sweepExpiredPresence(Date.now() + PRESENCE_TTL_MS + 1)).not.toThrow();
    // The registry entry drains, so the sweep can eventually disarm.
    expect(sweepExpiredPresence(Date.now() + PRESENCE_TTL_MS + 2)).toBe(0);
  });

  it("arms on activity and disarms once the registry drains", () => {
    openDoc(DOC);
    expect(isPresenceSweepArmed()).toBe(false);
    noteClaudeActivity(DOC);
    expect(isPresenceSweepArmed()).toBe(true);
  });
});

describe("clearAllClaudePresence (MCP session close)", () => {
  it("clears every open document immediately, without waiting out the TTL", () => {
    const a = openDoc("presence-a");
    const b = openDoc("presence-b");
    setAwareness(a, statusValue());
    setAwareness(b, statusValue());
    noteClaudeActivity("presence-a");

    expect(clearAllClaudePresence()).toBe(2);
    expect(getAwareness(a)?.active).toBe(false);
    expect(getAwareness(b)?.active).toBe(false);

    removeDoc("presence-a");
    removeDoc("presence-b");
    removeDocument("presence-a");
    removeDocument("presence-b");
  });
});
