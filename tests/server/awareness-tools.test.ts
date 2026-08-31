import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { z } from "zod";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import {
  attachObservers,
  detachObservers,
  getAnnotationEditedChannelKey,
  resetForTesting as resetEventQueue,
  subscribe,
  unsubscribe,
  wasEmittedViaChannel,
} from "../../src/server/events/queue.js";
import { collectAnnotations } from "../../src/server/mcp/annotations.js";
import {
  collectInboxUserReplies,
  isUserActive,
  processInboxAnnotations,
  resetInbox,
  safeSlice,
} from "../../src/server/mcp/awareness.js";
import { extractText, populateYDoc } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { checkInboxOutputShape } from "../../src/server/mcp/output-schemas.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";
import {
  CTRL_ROOM,
  TANDEM_MODE_DEFAULT,
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
  Y_MAP_AWARENESS,
  Y_MAP_CHAT,
  Y_MAP_MODE,
  Y_MAP_USER_AWARENESS,
} from "../../src/shared/constants.js";
import { withBrowser } from "../../src/shared/origins.js";
import type { Annotation, AnnotationReply, ChatMessage } from "../../src/shared/types.js";
import { TandemModeSchema } from "../../src/shared/types.js";
import { generateMessageId } from "../../src/shared/utils.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";
import { range, unanchored } from "../helpers/positions.js";
import { createAnnotation } from "../helpers/ydoc-factory.js";

const DOC_HASH = "sha256:awareness-tools";
// Ledger keys are document-scoped (see `surfacedIds`); tests share one id
// unless they are specifically exercising the cross-document collision.
const DOC_KEY = "doc-awareness-tests";

function setupDoc(id: string, text: string) {
  const ydoc = getOrCreateDocument(id);
  populateYDoc(ydoc, text);
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  setActiveDocId(id);
  return ydoc;
}

beforeEach(() => {
  resetInbox();
  resetEventQueue();
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  setActiveDocId(null);
  // Mode lives in CTRL_ROOM, is module-global, and survives every reset above.
  // Tests further down this file write "solo" and "garbage-value" to it (see the
  // `tandemMode via Y.Map` / `/api/mode` describes). Without this reset, a leak
  // into the zero-subscriber regression test would make it pass VACUOUSLY rather
  // than fail: `pushEvent` early-returns on the Solo privacy hold, so the event is
  // never buffered and `wasEmittedViaChannel` is false for the wrong reason, while
  // `processInboxAnnotations` is handed "tandem" explicitly so the length
  // assertion still holds. Delete rather than set a default — present-vs-absent is
  // what `readModeState` uses to discriminate "indeterminate", and indeterminate
  // now fails CLOSED on the push path too, so a test that needs the queue to
  // actually emit must set "tandem" for itself (two below do).
  getOrCreateDocument(CTRL_ROOM).getMap(Y_MAP_USER_AWARENESS).delete(Y_MAP_MODE);
});

describe("safeSlice", () => {
  it("extracts snippet from text range", () => {
    expect(safeSlice("Hello world", 0, 5)).toBe("Hello");
  });

  it("truncates long snippets to 100 chars", () => {
    const text = "a".repeat(200);
    const result = safeSlice(text, 0, 150);
    expect(result).toHaveLength(100);
    expect(result.endsWith("...")).toBe(true);
  });

  it("clamps out-of-bounds from/to", () => {
    expect(safeSlice("Hello", -5, 100)).toBe("Hello");
  });

  it("returns empty string when from >= text length", () => {
    expect(safeSlice("Hello", 100, 200)).toBe("");
  });

  it("handles from > to by returning empty string", () => {
    expect(safeSlice("Hello", 5, 3)).toBe("");
  });
});

describe("isUserActive", () => {
  it("returns false when no activity", () => {
    expect(isUserActive(undefined)).toBe(false);
  });

  it("returns true when user is typing", () => {
    expect(isUserActive({ isTyping: true, lastEdit: 0 })).toBe(true);
  });

  it("returns true when lastEdit is recent (<10s)", () => {
    expect(isUserActive({ isTyping: false, lastEdit: Date.now() - 5000 })).toBe(true);
  });

  it("returns false when lastEdit is old (>10s) and not typing", () => {
    expect(isUserActive({ isTyping: false, lastEdit: Date.now() - 30000 })).toBe(false);
  });
});

describe("processInboxAnnotations", () => {
  it("buckets user comment annotations into userActions (not highlights/notes)", () => {
    const ydoc = setupDoc("inbox-1", "Hello world test");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "highlight", unanchored(0, 5), "", {
      author: "user",
      color: "yellow",
    });
    createAnnotation(map, ydoc, "comment", unanchored(6, 11), "Nice", { author: "user" });
    createAnnotation(map, ydoc, "note", unanchored(0, 3), "private", { author: "user" });

    const allAnns = collectAnnotations(map, DOC_HASH);
    const fullText = extractText(ydoc);
    const surfaced = new Map<string, number>();

    const result = processInboxAnnotations(allAnns, fullText, surfaced, (anns) => anns, DOC_KEY);
    // Only comments are surfaced; highlights and notes are excluded
    expect(result.userActions).toHaveLength(1);
    expect(result.userActions.find((a) => a.type === "comment")).toBeTruthy();
    expect(result.userActions.find((a) => a.type === "highlight")).toBeUndefined();
    expect(result.userActions.find((a) => a.type === "note")).toBeUndefined();
  });

  it("buckets resolved Claude annotations into userResponses", () => {
    const ydoc = setupDoc("inbox-2", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", unanchored(0, 5), "", {
      suggestedText: "Hi",
    });
    const ann = map.get(id) as Annotation;
    map.set(id, { ...ann, status: "accepted" as const });

    const allAnns = collectAnnotations(map, DOC_HASH);
    const fullText = extractText(ydoc);
    const surfaced = new Map<string, number>();

    const result = processInboxAnnotations(allAnns, fullText, surfaced, (anns) => anns, DOC_KEY);
    expect(result.userResponses).toHaveLength(1);
    expect(result.userResponses[0].status).toBe("accepted");
  });

  it("ignores pending Claude annotations", () => {
    const ydoc = setupDoc("inbox-3", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "comment", unanchored(0, 5), "A comment"); // author=claude, status=pending

    const allAnns = collectAnnotations(map, DOC_HASH);
    const fullText = extractText(ydoc);
    const surfaced = new Map<string, number>();

    const result = processInboxAnnotations(allAnns, fullText, surfaced, (anns) => anns, DOC_KEY);
    expect(result.userActions).toHaveLength(0);
    expect(result.userResponses).toHaveLength(0);
  });

  it("deduplicates via surfacedIds — second call returns empty", () => {
    const ydoc = setupDoc("inbox-4", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "comment", unanchored(0, 5), "test", { author: "user" });

    const allAnns = collectAnnotations(map, DOC_HASH);
    const fullText = extractText(ydoc);
    const surfaced = new Map<string, number>();

    const first = processInboxAnnotations(allAnns, fullText, surfaced, (anns) => anns, DOC_KEY);
    expect(first.userActions).toHaveLength(1);

    const second = processInboxAnnotations(allAnns, fullText, surfaced, (anns) => anns, DOC_KEY);
    expect(second.userActions).toHaveLength(0);
  });

  // Contract flipped deliberately: being handed to a consumer was never evidence
  // that a model received it — an attached channel shim whose host never
  // negotiated the channel accepts the frame and discards it, and the server
  // cannot tell that apart from a live one. Suppressing on it dropped the
  // comment for the whole server run. The item now surfaces with an advisory
  // `alreadyPushed` hint instead. See the two queue-driven tests below.
  it("discloses rather than suppresses a channel-pushed edit", () => {
    const ydoc = setupDoc("inbox-edit-channel", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", unanchored(0, 5), "before", {
      author: "user",
    });

    const surfaced = new Map<string, number>();
    const first = processInboxAnnotations(
      collectAnnotations(map, DOC_HASH),
      extractText(ydoc),
      surfaced,
      (anns) => anns,
      DOC_KEY,
    );
    expect(first.userActions).toHaveLength(1);

    const ann = map.get(id) as Annotation;
    map.set(id, { ...ann, content: "after", editedAt: 2000 });

    const second = processInboxAnnotations(
      collectAnnotations(map, DOC_HASH),
      extractText(ydoc),
      surfaced,
      (anns) => anns,
      DOC_KEY,
      "tandem",
      (payloadId) => payloadId === getAnnotationEditedChannelKey(id, 2000),
    );

    expect(second.userActions).toHaveLength(1);
    expect(second.userActions[0].alreadyPushed).toBe(true);
    expect(second.userActions[0].edited).toBe(true);
    expect(surfaced.get(`${DOC_KEY}:${id}`)).toBe(2000);
  });

  // Both regressions below drive the REAL queue rather than a stubbed
  // predicate. A stub would have kept passing throughout the original bug,
  // which is precisely how it survived: the one test that claimed to cover
  // "no channel attached" only ever exercised a detached-observer environment.
  function writeUserComment(map: Y.Map<unknown>, ydoc: Y.Doc, id: string) {
    withBrowser(ydoc, () =>
      map.set(id, {
        id,
        type: "comment",
        author: "user",
        audience: "outbound",
        content: "please look at this",
        status: "pending",
        textSnapshot: "Hello",
        range: unanchored(0, 5).range,
        timestamp: 1000,
        rev: 1,
      }),
    );
  }

  // The default install: no channel shim, no monitor, nothing on /api/events.
  // Nothing was handed to anyone, so the hint must NOT claim otherwise — and
  // the comment must reach the inbox. This is the configuration where the old
  // suppression lost the comment for the rest of the server run.
  it("surfaces a user comment unflagged when nothing is subscribed", () => {
    const docId = "inbox-no-subscribers";
    const ydoc = setupDoc(docId, "Hello world");
    attachObservers(docId, ydoc);
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);

    writeUserComment(map, ydoc, "ann_nosub");

    expect(wasEmittedViaChannel("ann_nosub")).toBe(false);

    const out = processInboxAnnotations(
      collectAnnotations(map, DOC_HASH),
      extractText(ydoc),
      new Map<string, number>(),
      (anns) => anns,
      DOC_KEY,
      "tandem",
      wasEmittedViaChannel,
    );

    expect(out.userActions).toHaveLength(1);
    expect(out.userActions[0].id).toBe("ann_nosub");
    expect(out.userActions[0].alreadyPushed).toBeUndefined();

    detachObservers(docId);
  });

  // The residual unknowable case: a consumer IS attached but may be inert — a
  // channel shim whose host never negotiated the channel accepts the frame and
  // discards it, exactly like this no-op subscriber. The server cannot tell the
  // difference, so the item is flagged AND still surfaced. The `toHaveLength(1)`
  // is the load-bearing assertion: it is what stops the flag ever becoming a
  // suppression again.
  it("surfaces a user comment WITH the hint when an attached consumer may be inert", () => {
    const docId = "inbox-inert-subscriber";
    const ydoc = setupDoc(docId, "Hello world");
    attachObservers(docId, ydoc);
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);

    const inertConsumer = () => {}; // accepts every event, delivers to nobody
    subscribe(inertConsumer, "external");

    // Explicit Tandem: the beforeEach clears the mode key, and the push hold
    // fails closed on that ("indeterminate"), which would make the tracking
    // assertion below fail for a reason this test isn't about.
    setCtrlMode("tandem");
    writeUserComment(map, ydoc, "ann_inert");

    expect(wasEmittedViaChannel("ann_inert")).toBe(true);

    const out = processInboxAnnotations(
      collectAnnotations(map, DOC_HASH),
      extractText(ydoc),
      new Map<string, number>(),
      (anns) => anns,
      DOC_KEY,
      "tandem",
      wasEmittedViaChannel,
    );

    expect(out.userActions).toHaveLength(1);
    expect(out.userActions[0].id).toBe("ann_inert");
    expect(out.userActions[0].alreadyPushed).toBe(true);

    // Pin the flag against the DECLARED schema, not just the runtime shape.
    // tests/server/mcp-output-schemas.test.ts cannot do this: it proves "no
    // undeclared keys" by parsing in strip mode and deep-equalling, which only
    // catches a key that is actually PRESENT — and that suite never attaches
    // observers, so `wasEmittedViaChannel` is always false there and the field is
    // never emitted. Without this, deleting `alreadyPushed` from userActionSchema
    // leaves the whole suite green, and the `.describe()` on that field is the
    // model-facing product of this change.
    const parsedAction = z.object(checkInboxOutputShape).shape.userActions.parse(out.userActions);
    expect(parsedAction[0].alreadyPushed).toBe(true);

    unsubscribe(inertConsumer);
    detachObservers(docId);
  });

  it("marks polling-discovered edits when no channel event has delivered them", () => {
    const ydoc = setupDoc("inbox-edit-poll", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", unanchored(0, 5), "before", {
      author: "user",
    });

    const surfaced = new Map<string, number>();
    processInboxAnnotations(
      collectAnnotations(map, DOC_HASH),
      extractText(ydoc),
      surfaced,
      (anns) => anns,
      DOC_KEY,
    );

    const ann = map.get(id) as Annotation;
    map.set(id, { ...ann, content: "after", editedAt: 3000 });

    const second = processInboxAnnotations(
      collectAnnotations(map, DOC_HASH),
      extractText(ydoc),
      surfaced,
      (anns) => anns,
      DOC_KEY,
    );

    expect(second.userActions).toHaveLength(1);
    expect(second.userActions[0].edited).toBe(true);
    expect(surfaced.get(`${DOC_KEY}:${id}`)).toBe(3000);
  });

  it("refreshes the unsurfaced candidates in ONE batch call, not one call each", () => {
    // **Rewritten, not migrated (ADR-035 Unit 8j-2).** This was "calls refreshFn
    // on each unsurfaced annotation", counting invocations and asserting `1`
    // against a single seeded annotation — so a per-item → batch signature
    // change would have left the count at 1 and the spec green while its own
    // NAME became false. Two annotations, and both halves of the new claim are
    // asserted: the batch fires exactly once, and it receives every candidate.
    //
    // The one-call half is the part that matters. `refreshAll` owns a single
    // `withMcp` transaction in production (`YDocStore.refreshAnnotations`), so a
    // caller that reverted to per-item refreshing would either open N
    // transactions or, one step further, none at all — an untagged `map.set`
    // that `audit:origins` cannot see because it is reached through a helper.
    const ydoc = setupDoc("inbox-5", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const first = createAnnotation(map, ydoc, "comment", unanchored(0, 5), "one", {
      author: "user",
    });
    const second = createAnnotation(map, ydoc, "comment", unanchored(6, 11), "two", {
      author: "user",
    });

    const allAnns = collectAnnotations(map, DOC_HASH);
    const fullText = extractText(ydoc);
    const surfaced = new Map<string, number>();

    const batches: string[][] = [];
    processInboxAnnotations(
      allAnns,
      fullText,
      surfaced,
      (anns) => {
        batches.push(anns.map((a) => a.id));
        return anns;
      },
      DOC_KEY,
      "tandem",
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]).toStrictEqual([first, second]);
  });

  it("includes text snippets from annotation ranges", () => {
    const ydoc = setupDoc("inbox-6", "The quick brown fox");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    createAnnotation(map, ydoc, "comment", unanchored(4, 9), "Note", { author: "user" });

    const allAnns = collectAnnotations(map, DOC_HASH);
    const fullText = extractText(ydoc);
    const surfaced = new Map<string, number>();

    const result = processInboxAnnotations(allAnns, fullText, surfaced, (anns) => anns, DOC_KEY);
    expect(result.userActions[0].textSnippet).toBe("quick");
  });
});

describe("processInboxAnnotations — WS-A2 Solo hold (kill-experiment A)", () => {
  // The load-bearing invariant: in Solo, a user comment must NOT surface AND
  // must NOT poison the dedup ledger. On the Solo→Tandem flip, the same
  // annotation surfaces on the next poll (pull-driven release). A ledger poison
  // would silently strand it forever — the failure this whole workstream fixes.

  it("holds a user comment in Solo — no surface, no ledger write", () => {
    const ydoc = setupDoc("inbox-solo-hold", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", unanchored(0, 5), "held", {
      author: "user",
    });

    const allAnns = collectAnnotations(map, DOC_HASH);
    const fullText = extractText(ydoc);
    const surfaced = new Map<string, number>();

    const result = processInboxAnnotations(
      allAnns,
      fullText,
      surfaced,
      (anns) => anns,
      DOC_KEY,
      "solo",
    );
    expect(result.userActions).toHaveLength(0);
    // Ledger must be untouched — the item stays "unsurfaced" for release.
    expect(surfaced.has(`${DOC_KEY}:${id}`)).toBe(false);
  });

  it("releases the held comment on the Solo→Tandem flip (surfaces on next poll)", () => {
    const ydoc = setupDoc("inbox-solo-release", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", unanchored(0, 5), "held", {
      author: "user",
    });

    const allAnns = collectAnnotations(map, DOC_HASH);
    const fullText = extractText(ydoc);
    const surfaced = new Map<string, number>();

    // Solo poll: held.
    const solo = processInboxAnnotations(
      allAnns,
      fullText,
      surfaced,
      (anns) => anns,
      DOC_KEY,
      "solo",
    );
    expect(solo.userActions).toHaveLength(0);

    // Flip to Tandem: same annotation, same ledger — must now surface exactly once.
    const released = processInboxAnnotations(
      allAnns,
      fullText,
      surfaced,
      (anns) => anns,
      DOC_KEY,
      "tandem",
    );
    expect(released.userActions).toHaveLength(1);
    expect(released.userActions[0].id).toBe(id);
    expect(surfaced.get(`${DOC_KEY}:${id}`)).toBe(0);

    // A subsequent Tandem poll dedups normally (proves the release wrote the ledger).
    const again = processInboxAnnotations(
      allAnns,
      fullText,
      surfaced,
      (anns) => anns,
      DOC_KEY,
      "tandem",
    );
    expect(again.userActions).toHaveLength(0);
  });

  it("does not hold Claude responses in Solo (only user-authored records are held)", () => {
    const ydoc = setupDoc("inbox-solo-claude", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const id = createAnnotation(map, ydoc, "comment", unanchored(0, 5), "claude note", {
      author: "claude",
    });
    const ann = map.get(id) as Annotation;
    map.set(id, { ...ann, status: "accepted" });

    const allAnns = collectAnnotations(map, DOC_HASH);
    const fullText = extractText(ydoc);
    const surfaced = new Map<string, number>();

    const result = processInboxAnnotations(
      allAnns,
      fullText,
      surfaced,
      (anns) => anns,
      DOC_KEY,
      "solo",
    );
    expect(result.userResponses).toHaveLength(1);
  });

  it("indeterminate mode holds ONLY the persisted heldInSolo marker (fail-closed restart)", () => {
    const ydoc = setupDoc("inbox-indeterminate", "Hello world again");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const heldId = createAnnotation(map, ydoc, "comment", unanchored(0, 5), "was held", {
      author: "user",
      heldInSolo: true,
    });
    const freshId = createAnnotation(map, ydoc, "comment", unanchored(6, 11), "not held", {
      author: "user",
    });

    const allAnns = collectAnnotations(map, DOC_HASH);
    const fullText = extractText(ydoc);
    const surfaced = new Map<string, number>();

    const result = processInboxAnnotations(
      allAnns,
      fullText,
      surfaced,
      (anns) => anns,
      DOC_KEY,
      "indeterminate",
    );
    // Marked-held stays held; the unmarked user comment surfaces normally.
    const surfacedIds = result.userActions.map((a) => a.id);
    expect(surfacedIds).toContain(freshId);
    expect(surfacedIds).not.toContain(heldId);
    expect(surfaced.has(`${DOC_KEY}:${heldId}`)).toBe(false);
  });
});

describe("collectInboxUserReplies — WS-A2 reply bucket + Solo hold", () => {
  const commentParent: Annotation = {
    id: "parent-comment",
    author: "user",
    type: "comment",
    range: range(0, 5),
    content: "parent",
    status: "pending",
    timestamp: 1000,
  };
  // `commentParent`'s declared type is the full `Annotation` union (not narrowed
  // to the "comment" member), so spreading it into a "note" override picks up
  // the other members' `color`/`suggestedText` shapes too. The `as Annotation`
  // reflects that the actual runtime object — no `color`, no `suggestedText` —
  // already matches the "note" member exactly.
  const noteParent: Annotation = {
    ...commentParent,
    id: "parent-note",
    type: "note",
  } as Annotation;
  const fullText = "Hello world";

  function reply(over: Partial<AnnotationReply>): AnnotationReply {
    return {
      id: "r1",
      annotationId: "parent-comment",
      author: "user",
      text: "a reply",
      timestamp: 2000,
      ...over,
    };
  }

  it("surfaces a user reply once in Tandem, then dedups", () => {
    const replies = [reply({})];
    const ledger = new Set<string>();
    const first = collectInboxUserReplies(
      [commentParent],
      fullText,
      () => replies,
      ledger,
      "tandem",
      DOC_KEY,
    );
    expect(first).toHaveLength(1);
    expect(first[0].id).toBe("r1");
    expect(first[0].textSnippet).toBe("Hello");

    const second = collectInboxUserReplies(
      [commentParent],
      fullText,
      () => replies,
      ledger,
      "tandem",
      DOC_KEY,
    );
    expect(second).toHaveLength(0);
  });

  it("holds a user reply in Solo (no surface, no ledger write) and releases on flip", () => {
    const replies = [reply({})];
    const ledger = new Set<string>();
    const solo = collectInboxUserReplies(
      [commentParent],
      fullText,
      () => replies,
      ledger,
      "solo",
      DOC_KEY,
    );
    expect(solo).toHaveLength(0);
    expect(ledger.has(`${DOC_KEY}:r1`)).toBe(false);

    const released = collectInboxUserReplies(
      [commentParent],
      fullText,
      () => replies,
      ledger,
      "tandem",
      DOC_KEY,
    );
    expect(released).toHaveLength(1);
  });

  it("never surfaces a Claude reply (Claude doesn't need its own replies echoed)", () => {
    const replies = [reply({ id: "rc", author: "claude" })];
    const out = collectInboxUserReplies(
      [commentParent],
      fullText,
      () => replies,
      new Set(),
      "tandem",
      DOC_KEY,
    );
    expect(out).toHaveLength(0);
  });

  it("never surfaces a private reply or a note-thread reply (ADR-027)", () => {
    const privateOnComment = [reply({ id: "rp", private: true })];
    expect(
      collectInboxUserReplies(
        [commentParent],
        fullText,
        () => privateOnComment,
        new Set(),
        "tandem",
        DOC_KEY,
      ),
    ).toHaveLength(0);

    // A reply on a note parent must never surface even without the private flag.
    const noteReply = [reply({ id: "rn", annotationId: "parent-note" })];
    expect(
      collectInboxUserReplies(
        [noteParent],
        fullText,
        () => noteReply,
        new Set(),
        "tandem",
        DOC_KEY,
      ),
    ).toHaveLength(0);
  });

  // Contract flipped deliberately — same reasoning as the annotation surfacer.
  // This branch was the more dangerous of the two: `replySurfaced` is a plain
  // Set with no edit dimension, so a poisoned entry had no `editedAt` escape
  // hatch and the reply was unrecoverable for the whole server run.
  it("discloses rather than suppresses a reply already pushed via the channel", () => {
    const replies = [reply({})];
    const ledger = new Set<string>();
    const out = collectInboxUserReplies(
      [commentParent],
      fullText,
      () => replies,
      ledger,
      "tandem",
      DOC_KEY,
      (id) => id === "r1",
    );
    expect(out).toHaveLength(1);
    expect(out[0].alreadyPushed).toBe(true);
    expect(ledger.has(`${DOC_KEY}:r1`)).toBe(true); // still deduped against future polls

    // Pin the reply flag against the declared schema too — same gap as the
    // annotation surfacer: the schema suite never emits this field.
    const parsed = z.object(checkInboxOutputShape).shape.userReplies.parse(out);
    expect(parsed[0].alreadyPushed).toBe(true);
  });

  // The test above passes a hand-written predicate, so `getTrackableId`'s
  // `case "annotation:reply": return event.payload.replyId` is never exercised for
  // tracking anywhere in the suite — the comment path got two queue-driven tests
  // and this path got a stub. Drive the real queue so a regression in that case
  // arm is visible here.
  //
  // Worth recording why this branch is structurally safer than the comment one:
  // it is the arm the cross-document id collision CANNOT reach. User reply ids come
  // from `generateReplyId()` (random), and imported Word reply ids carry
  // `author: "import"`, which is filtered before it ever reaches the surfacer.
  it("flags a reply that the real event queue tracked", () => {
    const docId = "inbox-reply-queue";
    const ydoc = setupDoc(docId, "Hello world");
    attachObservers(docId, ydoc);
    const annMap = ydoc.getMap(Y_MAP_ANNOTATIONS);

    const inertConsumer = () => {};
    subscribe(inertConsumer, "external");

    // Explicit Tandem — see the sibling test above: the cleared mode key is
    // "indeterminate", which the push hold fails closed on.
    setCtrlMode("tandem");
    // Parent must be a user comment: the replies observer drops note-threaded and
    // non-comment parents before emitting.
    withBrowser(ydoc, () => {
      annMap.set(commentParent.id, { ...commentParent });
      ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).set("r_queue", { ...reply({ id: "r_queue" }) });
    });

    expect(wasEmittedViaChannel("r_queue")).toBe(true);

    const out = collectInboxUserReplies(
      [commentParent],
      extractText(ydoc),
      () => [reply({ id: "r_queue" })],
      new Set<string>(),
      "tandem",
      DOC_KEY,
      wasEmittedViaChannel,
    );

    expect(out).toHaveLength(1);
    expect(out[0].alreadyPushed).toBe(true);

    unsubscribe(inertConsumer);
    detachObservers(docId);
  });

  it("indeterminate mode holds only replies carrying the persisted marker", () => {
    const replies = [reply({ id: "held", heldInSolo: true }), reply({ id: "fresh" })];
    const out = collectInboxUserReplies(
      [commentParent],
      fullText,
      () => replies,
      new Set(),
      "indeterminate",
      DOC_KEY,
    );
    const ids = out.map((r) => r.id);
    expect(ids).toContain("fresh");
    expect(ids).not.toContain("held");
  });
});

describe("checkInbox — chat messages (real Y.Map operations)", () => {
  it("reads unread chat messages from CTRL_ROOM", () => {
    const ctrlDoc = getOrCreateDocument("__tandem_ctrl_inbox_chat_1__");
    const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);

    const msg: ChatMessage = {
      id: generateMessageId(),
      author: "user",
      text: "Can you review paragraph 3?",
      timestamp: Date.now(),
      read: false,
    };
    chatMap.set(msg.id, msg);

    // Simulate checkInbox chat processing
    const chatMessages: Array<{ id: string; text: string }> = [];
    chatMap.forEach((value) => {
      const m = value as ChatMessage;
      if (m.author === "user" && !m.read) {
        chatMessages.push({ id: m.id, text: m.text });
        chatMap.set(m.id, { ...m, read: true });
      }
    });

    expect(chatMessages).toHaveLength(1);
    expect(chatMessages[0].text).toBe("Can you review paragraph 3?");

    // Verify marked as read
    const updated = chatMap.get(msg.id) as ChatMessage;
    expect(updated.read).toBe(true);
  });

  it("ignores Claude messages in inbox", () => {
    const ctrlDoc = getOrCreateDocument("__tandem_ctrl_inbox_chat_2__");
    const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);

    chatMap.set("msg_claude_only", {
      id: "msg_claude_only",
      author: "claude",
      text: "I see the issue",
      timestamp: Date.now(),
      read: true,
    } as ChatMessage);

    const unread: ChatMessage[] = [];
    chatMap.forEach((value) => {
      const m = value as ChatMessage;
      if (m.author === "user" && !m.read) unread.push(m);
    });
    expect(unread).toHaveLength(0);
  });
});

describe("tandem_reply — real Y.Map operations", () => {
  it("stores a Claude reply in CTRL_ROOM", () => {
    const ctrlDoc = getOrCreateDocument("__tandem_ctrl_reply_1__");
    const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);

    const id = generateMessageId();
    const msg: ChatMessage = {
      id,
      author: "claude",
      text: "Here is my response",
      timestamp: Date.now(),
      read: true,
    };
    chatMap.set(id, msg);

    const stored = chatMap.get(id) as ChatMessage;
    expect(stored.author).toBe("claude");
    expect(stored.text).toBe("Here is my response");
  });

  it("supports replyTo for threading", () => {
    const ctrlDoc = getOrCreateDocument("__tandem_ctrl_reply_2__");
    const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);

    const replyId = generateMessageId();
    const reply: ChatMessage = {
      id: replyId,
      author: "claude",
      text: "Great question!",
      timestamp: Date.now(),
      replyTo: "msg_user_original",
      read: true,
    };
    chatMap.set(replyId, reply);

    const stored = chatMap.get(replyId) as ChatMessage;
    expect(stored.replyTo).toBe("msg_user_original");
  });
});

describe("tandem_status — real Y.Map operations", () => {
  it("writes Claude status to awareness map", () => {
    const ydoc = setupDoc("status-1", "Hello world");
    const awarenessMap = ydoc.getMap(Y_MAP_AWARENESS);

    awarenessMap.set("claude", {
      status: "Reviewing section 3...",
      timestamp: Date.now(),
      active: true,
      focusParagraph: 2,
      focusOffset: null,
    });

    const claude = awarenessMap.get("claude") as {
      status: string;
      active: boolean;
      focusParagraph: number | null;
      focusOffset: number | null;
    };
    expect(claude.status).toBe("Reviewing section 3...");
    expect(claude.active).toBe(true);
    expect(claude.focusParagraph).toBe(2);
    expect(claude.focusOffset).toBeNull();
  });

  it("writes focusOffset for character-level cursor positioning", () => {
    const ydoc = setupDoc("status-2", "Hello world, this is a test document.");
    const awarenessMap = ydoc.getMap(Y_MAP_AWARENESS);

    awarenessMap.set("claude", {
      status: "Editing at position 15...",
      timestamp: Date.now(),
      active: true,
      focusParagraph: 0,
      focusOffset: 15,
    });

    const claude = awarenessMap.get("claude") as {
      status: string;
      active: boolean;
      focusParagraph: number | null;
      focusOffset: number | null;
    };
    expect(claude.focusOffset).toBe(15);
    expect(claude.focusParagraph).toBe(0);
  });

  it("supports focusOffset without focusParagraph", () => {
    const ydoc = setupDoc("status-3", "Hello world");
    const awarenessMap = ydoc.getMap(Y_MAP_AWARENESS);

    awarenessMap.set("claude", {
      status: "Working...",
      timestamp: Date.now(),
      active: true,
      focusParagraph: null,
      focusOffset: 5,
    });

    const claude = awarenessMap.get("claude") as {
      focusParagraph: number | null;
      focusOffset: number | null;
    };
    expect(claude.focusParagraph).toBeNull();
    expect(claude.focusOffset).toBe(5);
  });
});

describe("tandemMode via Y.Map('userAwareness')", () => {
  it("defaults to 'tandem' when no mode is set", () => {
    const ydoc = setupDoc("int-1", "Hello world");
    const userAwareness = ydoc.getMap(Y_MAP_USER_AWARENESS);
    const mode = (userAwareness.get(Y_MAP_MODE) as string) ?? TANDEM_MODE_DEFAULT;
    expect(mode).toBe("tandem");
  });

  it("reads mode written by client", () => {
    const ydoc = setupDoc("int-2", "Hello world");
    const userAwareness = ydoc.getMap(Y_MAP_USER_AWARENESS);
    userAwareness.set(Y_MAP_MODE, "solo");
    expect(userAwareness.get(Y_MAP_MODE)).toBe("solo");
  });

  it("reads 'solo' mode", () => {
    const ydoc = setupDoc("int-3", "Hello world");
    const userAwareness = ydoc.getMap(Y_MAP_USER_AWARENESS);
    userAwareness.set(Y_MAP_MODE, "solo");
    expect(userAwareness.get(Y_MAP_MODE)).toBe("solo");
  });
});

describe("/api/mode endpoint validation", () => {
  it("returns 'tandem' by default when no mode is set", () => {
    const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
    const awareness = ctrlDoc.getMap(Y_MAP_USER_AWARENESS);
    const mode = TandemModeSchema.catch(TANDEM_MODE_DEFAULT).parse(awareness.get(Y_MAP_MODE));
    expect(mode).toBe("tandem");
  });

  it("returns 'solo' when mode is set to solo", () => {
    const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
    const awareness = ctrlDoc.getMap(Y_MAP_USER_AWARENESS);
    awareness.set(Y_MAP_MODE, "solo");
    const mode = TandemModeSchema.catch(TANDEM_MODE_DEFAULT).parse(awareness.get(Y_MAP_MODE));
    expect(mode).toBe("solo");
  });

  it("falls back to default for invalid mode values", () => {
    const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
    const awareness = ctrlDoc.getMap(Y_MAP_USER_AWARENESS);
    awareness.set(Y_MAP_MODE, "garbage-value");
    const mode = TandemModeSchema.catch(TANDEM_MODE_DEFAULT).parse(awareness.get(Y_MAP_MODE));
    expect(mode).toBe("tandem");
  });
});

// ── Cross-document ledger collision (the reason keys are document-scoped) ────
//
// `importAnnotationId` hashes only commentId + range + body text — no path, by
// design, so re-importing the same .docx dedupes instead of accumulating. The
// consequence is that the SAME Word comment living in two files carries ONE id.
// Under a bare-id ledger key, surfacing it from document A silently dropped it
// from document B: one client, no restart, no multi-session involved. Promotion
// bumps `rev`, not `editedAt`, so the re-surface hatch never fired either.
describe("inbox ledgers are document-scoped", () => {
  const SHARED_ID = "import-deadbeefcafe"; // same Word comment, two files

  it("surfaces the same imported annotation id in BOTH documents", () => {
    const docA = setupDoc("ledger-doc-a", "Hello world");
    const docB = setupDoc("ledger-doc-b", "Hello world");
    const surfaced = new Map<string, number>();

    for (const [docKey, ydoc] of [
      ["ledger-doc-a", docA],
      ["ledger-doc-b", docB],
    ] as const) {
      const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
      map.set(SHARED_ID, {
        id: SHARED_ID,
        type: "comment",
        author: "user",
        content: "Word comment",
        status: "pending",
        textSnapshot: "Hello",
        range: { from: 0, to: 5 },
      });

      const out = processInboxAnnotations(
        collectAnnotations(map, DOC_HASH),
        extractText(ydoc),
        surfaced,
        (anns) => anns,
        docKey,
        "tandem",
      );
      // Without document scoping the second document returns 0 here.
      expect(out.userActions.map((a) => a.id)).toContain(SHARED_ID);
    }

    // One entry per document, not one shared entry.
    expect(surfaced.has(`ledger-doc-a:${SHARED_ID}`)).toBe(true);
    expect(surfaced.has(`ledger-doc-b:${SHARED_ID}`)).toBe(true);
  });

  // The reply ledger is a plain Set with NO edit dimension, so its collision has
  // no escape hatch at all — strictly worse than the annotation one.
  it("surfaces the same imported reply id in BOTH documents", () => {
    const parent: Annotation = {
      id: "parent-comment",
      author: "user",
      type: "comment",
      range: range(0, 5),
      content: "parent",
      status: "pending",
      timestamp: 1000,
    };
    const sharedReply: AnnotationReply = {
      id: "import-reply-cafe",
      annotationId: "parent-comment",
      author: "user",
      text: "imported reply",
      timestamp: 2000,
    };
    const ledger = new Set<string>();

    for (const docKey of ["ledger-doc-a", "ledger-doc-b"]) {
      const out = collectInboxUserReplies(
        [parent],
        "Hello world",
        () => [sharedReply],
        ledger,
        "tandem",
        docKey,
      );
      expect(out.map((r) => r.id)).toContain(sharedReply.id);
    }
  });
});
