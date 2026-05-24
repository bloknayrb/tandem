/**
 * Unit tests for the typing-presence middleware (#651).
 *
 * Covers:
 *   - set-on-enter / clear-on-exit lifecycle
 *   - ADR-027 note-id sanitization (notes never broadcast)
 *   - exception path still clears presence
 *   - `resetTypingPresenceForTesting` stops the sweep timer
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry.js";
import { resetForTesting as resetEventQueue } from "../../src/server/events/queue.js";
import {
  resetTypingPresenceForTesting,
  sanitizeAnnotationIdForPresence,
  withTypingPresence,
} from "../../src/server/mcp/typing-presence.js";
import { getOrCreateDocument, removeDocument } from "../../src/server/yjs/provider.js";
import { Y_MAP_ANNOTATIONS, Y_MAP_AWARENESS, Y_MAP_CLAUDE } from "../../src/shared/constants.js";
import { withMcp } from "../../src/shared/origins.js";
import type { Annotation, ClaudeAwareness } from "../../src/shared/types.js";

const TEST_DOC = "test-doc-651";

function seedAnnotation(doc: Y.Doc, id: string, type: Annotation["type"]): void {
  const map = doc.getMap(Y_MAP_ANNOTATIONS);
  withMcp(doc, () => {
    map.set(id, {
      id,
      author: "user",
      type,
      status: "pending",
      content: "test",
      range: { from: 0, to: 5 },
      timestamp: Date.now(),
      rev: 1,
    } as Annotation);
  });
}

function readWorking(doc: Y.Doc): NonNullable<ClaudeAwareness["working"]> | null {
  const a = doc.getMap(Y_MAP_AWARENESS).get(Y_MAP_CLAUDE) as ClaudeAwareness | undefined;
  return a?.working ?? null;
}

describe("withTypingPresence", () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = getOrCreateDocument(TEST_DOC);
    addDoc(TEST_DOC, {
      id: TEST_DOC,
      filePath: "/tmp/test.md",
      format: "md",
      readOnly: false,
      source: "file",
    });
    setActiveDocId(TEST_DOC);
  });

  afterEach(() => {
    setActiveDocId(null);
    removeDoc(TEST_DOC);
    resetTypingPresenceForTesting();
    resetEventQueue();
    removeDocument(TEST_DOC);
  });

  it("sets presence on enter and clears on success", async () => {
    let observedWhileRunning: NonNullable<ClaudeAwareness["working"]> | null = null;
    const result = await withTypingPresence(
      { tool: "tandem_comment", documentId: TEST_DOC },
      async () => {
        observedWhileRunning = readWorking(doc);
        return "ok";
      },
    );
    expect(result).toBe("ok");
    expect(observedWhileRunning).not.toBeNull();
    expect(observedWhileRunning!.tool).toBe("tandem_comment");
    expect(readWorking(doc)).toBeNull();
  });

  it("clears presence even when the handler throws", async () => {
    await expect(
      withTypingPresence({ tool: "tandem_edit", documentId: TEST_DOC }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(readWorking(doc)).toBeNull();
  });

  it("broadcasts annotationId for non-note annotations", async () => {
    seedAnnotation(doc, "ann_comment", "comment");
    const safeId = sanitizeAnnotationIdForPresence(TEST_DOC, "ann_comment", Y_MAP_ANNOTATIONS);
    expect(safeId).toBe("ann_comment");

    let observed: NonNullable<ClaudeAwareness["working"]> | null = null;
    await withTypingPresence(
      { tool: "tandem_annotationReply", documentId: TEST_DOC, annotationId: safeId },
      async () => {
        observed = readWorking(doc);
      },
    );
    expect(observed?.annotationId).toBe("ann_comment");
  });

  it("ADR-027: never broadcasts annotationId for a note", () => {
    seedAnnotation(doc, "ann_note", "note");
    const safeId = sanitizeAnnotationIdForPresence(TEST_DOC, "ann_note", Y_MAP_ANNOTATIONS);
    expect(safeId).toBeUndefined();
  });

  it("returns undefined for a missing annotation lookup", () => {
    const safeId = sanitizeAnnotationIdForPresence(TEST_DOC, "ann_missing", Y_MAP_ANNOTATIONS);
    expect(safeId).toBeUndefined();
  });

  it("no-op when no document is open (no throw, handler still runs)", async () => {
    setActiveDocId(null);
    removeDoc(TEST_DOC);
    const result = await withTypingPresence(
      { tool: "tandem_comment", documentId: undefined },
      async () => 42,
    );
    expect(result).toBe(42);
  });

  it("resetTypingPresenceForTesting clears the active map and timer", async () => {
    // Kick off a long-running handler then immediately reset; the reset must
    // not throw and the eventual completion still leaves a clean state.
    const p = withTypingPresence(
      { tool: "tandem_reply", documentId: TEST_DOC },
      () => new Promise<void>((resolve) => setTimeout(resolve, 10)),
    );
    resetTypingPresenceForTesting();
    await p;
    expect(readWorking(doc)).toBeNull();
  });

  it("overlapping handlers on the same doc: completion of one does not stomp the other's marker", async () => {
    // Outer handler holds the marker for the full window; inner handler runs
    // and completes inside. After inner's finally{}, the awareness map must
    // reflect the documented single-slot behavior — the inner's clear matched
    // its OWN token, so a later outer (different token) would not be stomped.
    // NOTE: this protects against the regression where clearPresenceOn
    // unconditionally cleared whatever working entry it found. No timer needed:
    // ownership is keyed on a monotonic token (#823), not wall-clock time.
    let observedMidOuterPostInner: NonNullable<ClaudeAwareness["working"]> | null = null;
    await withTypingPresence({ tool: "tandem_comment", documentId: TEST_DOC }, async () => {
      const outerToken = readWorking(doc)?.token;
      await withTypingPresence({ tool: "tandem_edit", documentId: TEST_DOC }, async () => {
        const inner = readWorking(doc);
        expect(inner?.tool).toBe("tandem_edit");
        // Distinct ownership token even without any time gap.
        expect(inner?.token).not.toBe(outerToken);
      });
      observedMidOuterPostInner = readWorking(doc);
    });
    // Observable behavior: after the nested overlap, mid-outer post-inner is
    // null (inner cleared the slot it had taken). The match-by-token guard
    // prevents inner-after-outer-finished from clearing a *later* outer.
    expect(observedMidOuterPostInner).toBeNull();
    // After outermost finishes, awareness is fully clear.
    expect(readWorking(doc)).toBeNull();
  });

  it("#823: same-millisecond starts get distinct ownership tokens; clearing one leaves the other", async () => {
    // Two overlapping handlers whose `setPresenceOn` calls happen in the same
    // event-loop tick (so `Date.now()` collides) must NOT collide on ownership.
    // Earlier the marker was keyed on `startedAt` (ms resolution): clearing the
    // first wiped the second's still-active marker. With the monotonic token,
    // clearing the first is a no-op because the live marker carries the
    // second's token.
    //
    // We freeze Date.now() so both starts share an identical `startedAt`, then
    // drive the lifecycle with hand-controlled promise latches (no real timers,
    // so the same-ms collision is guaranteed, not racy).
    const realNow = Date.now;
    const FROZEN = 1_700_000_000_000;
    Date.now = () => FROZEN;
    try {
      let releaseFirst!: () => void;
      let releaseSecond!: () => void;
      const firstGate = new Promise<void>((r) => {
        releaseFirst = r;
      });
      const secondGate = new Promise<void>((r) => {
        releaseSecond = r;
      });

      // Start both handlers. setPresenceOn runs synchronously on entry, so by
      // the time withTypingPresence yields at the first await, the marker is
      // already written. Both share FROZEN as startedAt.
      const first = withTypingPresence({ tool: "tandem_comment", documentId: TEST_DOC }, () =>
        firstGate.then(() => "first"),
      );
      const second = withTypingPresence({ tool: "tandem_edit", documentId: TEST_DOC }, () =>
        secondGate.then(() => "second"),
      );

      // Yield so both synchronous setPresenceOn writes have landed.
      await Promise.resolve();

      const live = readWorking(doc);
      // The last set wins the single slot — that's the second handler.
      expect(live?.startedAt).toBe(FROZEN);
      expect(live?.tool).toBe("tandem_edit");
      const secondToken = live?.token;

      // Finish the FIRST handler. Its clear is keyed on the first token, which
      // does NOT match the live (second) marker — so it must be a no-op. Before
      // #823 this cleared the second's marker (same startedAt collision).
      releaseFirst();
      await first;

      const afterFirstCleared = readWorking(doc);
      expect(afterFirstCleared).not.toBeNull();
      expect(afterFirstCleared?.tool).toBe("tandem_edit");
      expect(afterFirstCleared?.token).toBe(secondToken);

      // Finish the SECOND handler — now the slot clears (token matches).
      releaseSecond();
      await second;
      expect(readWorking(doc)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  it("tandem_status-style awareness write preserves the in-flight working marker", async () => {
    // Simulate tandem_status firing during a wrapped tool call: it rewrites
    // the ClaudeAwareness object but must preserve `working` (#651 fix in
    // document.ts). Here we assert the middleware's clear-by-startedAt guard
    // cooperates: an external write that keeps `working` intact is not
    // disturbed, and the handler's own clear still removes it on exit.
    let workingDuringStatus: NonNullable<ClaudeAwareness["working"]> | null = null;
    await withTypingPresence({ tool: "tandem_comment", documentId: TEST_DOC }, async () => {
      const working = readWorking(doc);
      expect(working).not.toBeNull();
      // Emulate document.ts tandem_status preserving `working`.
      const awarenessMap = doc.getMap(Y_MAP_AWARENESS);
      withMcp(doc, () => {
        const prev = awarenessMap.get(Y_MAP_CLAUDE) as ClaudeAwareness | undefined;
        awarenessMap.set(Y_MAP_CLAUDE, {
          status: "thinking",
          timestamp: Date.now(),
          active: true,
          focusParagraph: null,
          focusOffset: null,
          ...(prev?.working ? { working: prev.working } : {}),
        });
      });
      workingDuringStatus = readWorking(doc);
    });
    // Marker survived the status write...
    expect(workingDuringStatus?.tool).toBe("tandem_comment");
    // ...and was cleared on handler exit (startedAt matched).
    expect(readWorking(doc)).toBeNull();
  });
});
