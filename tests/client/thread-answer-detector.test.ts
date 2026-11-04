import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  createThreadAnswerDetector,
  isThreadAnswer,
  type ReplyBaseline,
} from "../../src/client/notifications/thread-answer-detector";
import { Y_MAP_ANNOTATION_REPLIES } from "../../src/shared/constants";
import type { AnnotationReply } from "../../src/shared/types";

const SYNCED_AT = 1_000_000;
const DOC_ID = "doc-1";

type Parent = { author: "user" | "claude" | "import"; type: string; audience?: string };

function reply(id: string, extra: Partial<AnnotationReply> = {}): AnnotationReply {
  return {
    id,
    annotationId: "user-card",
    author: "claude",
    text: `text of ${id}`,
    timestamp: SYNCED_AT + 10,
    ...extra,
  };
}

const PARENTS = new Map<string, Parent>([
  ["user-card", { author: "user", type: "comment", audience: "outbound" }],
  ["claude-card", { author: "claude", type: "comment", audience: "outbound" }],
  ["private-card", { author: "user", type: "comment", audience: "private" }],
  ["legacy-card", { author: "user", type: "comment" }],
  ["user-note", { author: "user", type: "note", audience: "private" }],
  ["user-highlight", { author: "user", type: "highlight" }],
]);

function baseline(ids: readonly string[] = []): ReplyBaseline {
  return { ids, capturedAt: SYNCED_AT };
}

function observeIds(
  detector: ReturnType<typeof createThreadAnswerDetector>,
  input: {
    doc: object;
    baseline?: ReplyBaseline | null;
    replies: AnnotationReply[];
    parents?: ReadonlyMap<string, Parent>;
  },
): string[] {
  return detector
    .observe({
      doc: input.doc,
      documentId: DOC_ID,
      baseline: input.baseline === undefined ? baseline() : input.baseline,
      replies: input.replies,
      parents: input.parents ?? PARENTS,
    })
    .map((answer) => answer.replyId);
}

describe("isThreadAnswer (#2360)", () => {
  it("is a Claude reply on a user's Claude-facing comment, and nothing else", () => {
    expect(isThreadAnswer(reply("a"), PARENTS.get("user-card"))).toBe(true);
    expect(isThreadAnswer(reply("a", { author: "user" }), PARENTS.get("user-card"))).toBe(false);
    expect(isThreadAnswer(reply("a", { author: "import" }), PARENTS.get("user-card"))).toBe(false);
    expect(isThreadAnswer(reply("a"), PARENTS.get("claude-card"))).toBe(false);
    expect(isThreadAnswer(reply("a"), PARENTS.get("user-note"))).toBe(false);
    expect(isThreadAnswer(reply("a"), PARENTS.get("user-highlight"))).toBe(false);
    expect(isThreadAnswer(reply("a"), undefined)).toBe(false);
    // ADR-027: a private thread, or one with no audience (absent is not
    // consent), is never Claude's to answer.
    expect(isThreadAnswer(reply("a"), PARENTS.get("private-card"))).toBe(false);
    expect(isThreadAnswer(reply("a"), PARENTS.get("legacy-card"))).toBe(false);
    // A private reply is the user's own (#1000); it is never Claude's answer.
    expect(isThreadAnswer(reply("a", { private: true }), PARENTS.get("user-card"))).toBe(false);
  });
});

describe("createThreadAnswerDetector (#2360)", () => {
  it("announces nothing until the document's provider has synced", () => {
    const detector = createThreadAnswerDetector();
    const doc = {};
    expect(observeIds(detector, { doc, baseline: null, replies: [reply("a")] })).toEqual([]);
    // Sync lands; the baseline captured in the provider callback holds it.
    expect(observeIds(detector, { doc, baseline: baseline(["a"]), replies: [reply("a")] })).toEqual(
      [],
    );
  });

  it("ignores baseline replies and announces only what arrives after the baseline", () => {
    const detector = createThreadAnswerDetector();
    const doc = {};
    expect(
      observeIds(detector, {
        doc,
        baseline: baseline(["old"]),
        replies: [reply("old"), reply("late")],
      }),
    ).toEqual(["late"]);
  });

  it("treats a reply stamped before the baseline as history, even outside it", () => {
    // The overlapping-open race: the doc is broadcast before its stored
    // replies are merged, so history arrives as a delta after the baseline.
    const detector = createThreadAnswerDetector();
    const doc = {};
    expect(observeIds(detector, { doc, replies: [] })).toEqual([]);
    const stored = reply("stored", { timestamp: SYNCED_AT - 3_600_000 });
    expect(observeIds(detector, { doc, replies: [stored, reply("live")] })).toEqual(["live"]);
  });

  it("ignores user replies and Claude replies on Claude's own cards", () => {
    const detector = createThreadAnswerDetector();
    expect(
      observeIds(detector, {
        doc: {},
        replies: [
          reply("mine", { author: "user" }),
          reply("on-claude-card", { annotationId: "claude-card" }),
          reply("on-note", { annotationId: "user-note" }),
          reply("on-private", { annotationId: "private-card" }),
          reply("answer"),
        ],
      }),
    ).toEqual(["answer"]);
  });

  it("announces each answer once, however often the map is re-observed", () => {
    const detector = createThreadAnswerDetector();
    const doc = {};
    expect(observeIds(detector, { doc, replies: [reply("a")] })).toEqual(["a"]);
    expect(observeIds(detector, { doc, replies: [reply("a")] })).toEqual([]);
    // Deleted and re-inserted under the same id (a reload re-merge): still once.
    expect(observeIds(detector, { doc, replies: [] })).toEqual([]);
    expect(observeIds(detector, { doc, replies: [reply("a")] })).toEqual([]);
  });

  it("waits for a parent that has not arrived yet rather than dropping the answer", () => {
    const detector = createThreadAnswerDetector();
    const doc = {};
    const orphan = reply("a", { annotationId: "late-card" });
    expect(observeIds(detector, { doc, replies: [orphan] })).toEqual([]);
    const parents = new Map(PARENTS).set("late-card", {
      author: "user",
      type: "comment",
      audience: "outbound",
    });
    expect(observeIds(detector, { doc, replies: [orphan], parents })).toEqual(["a"]);
    expect(observeIds(detector, { doc, replies: [orphan], parents })).toEqual([]);
  });

  it("re-arms on a rebuilt doc from that doc's baseline, without re-announcing", () => {
    const detector = createThreadAnswerDetector();
    const first = new Y.Doc();
    const map = first.getMap(Y_MAP_ANNOTATION_REPLIES);
    map.set("a", reply("a"));
    expect(observeIds(detector, { doc: first, replies: [reply("a")] })).toEqual(["a"]);
    // Server restart: the tab is rebuilt on a new doc that syncs the history,
    // plus one answer written while the client was rebuilding. That one lands
    // in the new baseline: accepted, it is not announced (the seen map still
    // shows it as new on the card).
    const second = new Y.Doc();
    Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
    const during = reply("during-restart", { timestamp: SYNCED_AT + 20 });
    second.getMap(Y_MAP_ANNOTATION_REPLIES).set(during.id, during);
    const rebuilt = { ids: ["a", during.id], capturedAt: SYNCED_AT + 30 };
    expect(
      observeIds(detector, { doc: second, baseline: rebuilt, replies: [reply("a"), during] }),
    ).toEqual([]);
    const fresh = reply("b", { timestamp: SYNCED_AT + 40 });
    expect(
      observeIds(detector, {
        doc: second,
        baseline: rebuilt,
        replies: [reply("a"), during, fresh],
      }),
    ).toEqual(["b"]);
  });

  it("returns content-free routing data plus the text the dispatcher may preview", () => {
    const detector = createThreadAnswerDetector();
    const [answer] = detector.observe({
      doc: {},
      documentId: DOC_ID,
      baseline: baseline(),
      replies: [reply("a")],
      parents: PARENTS,
    });
    expect(answer).toEqual({
      documentId: DOC_ID,
      annotationId: "user-card",
      replyId: "a",
      text: "text of a",
      timestamp: SYNCED_AT + 10,
    });
  });
});
