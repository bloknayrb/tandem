/**
 * Before/after record of what reaches the channel, spanning ADR-035's
 * `ChannelEligible` brand (Unit 8a).
 *
 * Written before the brand landed, when every assertion passed against
 * unmodified production code. When the brand landed, **exactly three failed**
 * — the three marked `DELTA:` — and the other fourteen did not move. That is
 * the whole value of the file: without it, "the brand changes only what we
 * meant it to" is a claim nobody can check, and three intended changes are
 * indistinguishable from three accidents.
 *
 * The three now assert the NEW behaviour. Each keeps the record of what it
 * asserted before, because a delta with no before is just an assertion.
 *
 * The gates as they stood BEFORE the brand (all four, plus the origin filter
 * upstream of them):
 *
 * | Site | Predicate before |
 * |---|---|
 * | `observers/annotations.ts:32,38` user add | `author === "user" && type === "comment"` |
 * | `observers/annotations.ts:54` user edit/promotion | `author === "user" && type === "comment"` |
 * | `observers/annotations.ts:89,94` claude accept/dismiss | `author === "claude" && type !== "note"` |
 * | `observers/replies.ts:21,32` | `reply.author === "user" && parent.type === "comment"` |
 * | `observers/factory.ts:69` | `!shouldSkipChannel(txn.origin)` — runs before all of the above |
 *
 * Note what NO gate consulted: `audience`. That is the hole Unit 8a closes, and
 * the reason three of these are deltas rather than regressions. The third fell
 * out of the second: sanitizing `replies.ts`'s parent read, which nothing had
 * sanitized, also withholds replies on an untriaged imported comment.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { makeAnnotationsObserver } from "../../../src/server/events/observers/annotations.js";
import { makeRepliesObserver } from "../../../src/server/events/observers/replies.js";
import type { TandemEvent } from "../../../src/server/events/types.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../../src/shared/constants.js";
import { toFlatOffset } from "../../../src/shared/positions/types.js";
import type { Annotation, AnnotationReply } from "../../../src/shared/types.js";

type AnnotationSeed = Partial<Annotation> & Pick<Annotation, "author" | "type">;

const SECRET = "PRIVATE PARENT TEXT — must not leak";

function annotation(id: string, seed: AnnotationSeed): Annotation {
  return {
    id,
    range: { from: toFlatOffset(0), to: toFlatOffset(5) },
    content: "body",
    status: "pending",
    timestamp: 1_000,
    textSnapshot: SECRET,
    ...seed,
  } as Annotation;
}

function harness() {
  const doc = new Y.Doc();
  const events: TandemEvent[] = [];
  const push = (e: TandemEvent) => events.push(e);
  const disposers = [
    makeAnnotationsObserver({ docName: "doc", doc, pushEvent: push }),
    makeRepliesObserver({ docName: "doc", doc, pushEvent: push }),
  ];
  return {
    annotations: doc.getMap(Y_MAP_ANNOTATIONS),
    replies: doc.getMap(Y_MAP_ANNOTATION_REPLIES),
    events,
    types: () => events.map((e) => e.type),
    dispose: () => disposers.forEach((d) => d()),
  };
}

/** No origin tag: mirrors a browser write, which is the only kind that projects. */
function add(h: ReturnType<typeof harness>, id: string, seed: AnnotationSeed): void {
  h.annotations.set(id, annotation(id, seed));
}

describe("channel projection — user add", () => {
  it("a user comment emits annotation:created", () => {
    const h = harness();
    add(h, "a1", { author: "user", type: "comment" });
    expect(h.types()).toEqual(["annotation:created"]);
    h.dispose();
  });

  it.each(["note", "highlight"] as const)("a user %s emits nothing", (type) => {
    const h = harness();
    add(h, "a1", { author: "user", type });
    expect(h.events).toEqual([]);
    h.dispose();
  });

  it("never puts a note's textSnapshot on the wire (ADR-027)", () => {
    const h = harness();
    add(h, "a1", { author: "user", type: "note" });
    expect(JSON.stringify(h.events)).not.toContain(SECRET);
    h.dispose();
  });
});

describe("channel projection — user edit and promotion", () => {
  it("an edited comment emits annotation:edited once editedAt advances", () => {
    const h = harness();
    add(h, "a1", { author: "user", type: "comment" });
    h.annotations.set("a1", annotation("a1", { author: "user", type: "comment", editedAt: 2_000 }));
    expect(h.types()).toEqual(["annotation:created", "annotation:edited"]);
    h.dispose();
  });

  it("an edit that does NOT advance editedAt emits nothing further", () => {
    const h = harness();
    add(h, "a1", { author: "user", type: "comment" });
    h.annotations.set("a1", annotation("a1", { author: "user", type: "comment", content: "x" }));
    expect(h.types()).toEqual(["annotation:created"]);
    h.dispose();
  });

  it("note -> comment promotion emits annotation:created", () => {
    const h = harness();
    add(h, "a1", { author: "user", type: "note" });
    h.annotations.set(
      "a1",
      annotation("a1", { author: "user", type: "comment", promotedFrom: "note" }),
    );
    expect(h.types()).toEqual(["annotation:created"]);
    h.dispose();
  });
});

describe("channel projection — claude accept and dismiss", () => {
  it.each([
    ["accepted", "annotation:accepted"],
    ["dismissed", "annotation:dismissed"],
  ] as const)("a claude comment marked %s emits %s", (status, expected) => {
    const h = harness();
    add(h, "a1", { author: "claude", type: "comment" });
    h.annotations.set("a1", annotation("a1", { author: "claude", type: "comment", status }));
    expect(h.types()).toEqual([expected]);
    h.dispose();
  });

  it("a claude NOTE emits nothing on accept (ADR-027 defence in depth)", () => {
    const h = harness();
    add(h, "a1", { author: "claude", type: "note" });
    h.annotations.set(
      "a1",
      annotation("a1", { author: "claude", type: "note", status: "accepted" }),
    );
    expect(h.events).toEqual([]);
    h.dispose();
  });

  it("DELTA (was: emitted): a claude HIGHLIGHT now emits nothing", () => {
    // The `type !== "note"` gate admits highlights, and the tutorial seeds a
    // Claude-authored highlight on sample/welcome.md
    // (`mcp/tutorial-annotations.ts` — `type: "highlight"`, author assigned
    // "claude" for everything that is not a note). So this fires on first run.
    //
    // The brand requires `audience === "outbound"`, and `sanitize.ts:79-87`
    // derives `"private"` for ANY highlight regardless of author, so this is
    // now zero events. Decided deliberately (2026-08-26): highlights are
    // user-only markup with nothing for Claude to act on, and the delta comes
    // from the audience axis rather than the type axis — widening the type
    // check to `!== "note"` does not bring it back.
    const h = harness();
    add(h, "a1", { author: "claude", type: "highlight" });
    h.annotations.set(
      "a1",
      annotation("a1", { author: "claude", type: "highlight", status: "accepted" }),
    );
    expect(h.events).toEqual([]);
    h.dispose();
  });
});

describe("channel projection — replies", () => {
  function reply(annotationId: string, author: AnnotationReply["author"]): AnnotationReply {
    return { id: "r1", annotationId, author, text: "reply body", timestamp: 1_000 };
  }

  it("a user reply on a comment emits annotation:reply", () => {
    const h = harness();
    add(h, "a1", { author: "user", type: "comment" });
    h.replies.set("r1", reply("a1", "user"));
    expect(h.types()).toEqual(["annotation:created", "annotation:reply"]);
    h.dispose();
  });

  it.each(["note", "highlight"] as const)("a user reply on a %s emits nothing", (type) => {
    const h = harness();
    add(h, "a1", { author: "user", type });
    h.replies.set("r1", reply("a1", "user"));
    expect(h.events).toEqual([]);
    h.dispose();
  });

  it("a reply whose parent is missing emits nothing", () => {
    const h = harness();
    h.replies.set("r1", reply("ghost", "user"));
    expect(h.events).toEqual([]);
    h.dispose();
  });
});

describe("channel projection — the audience axis nothing consults", () => {
  it("DELTA (was: emitted — the hole): a comment stored audience:'private' is now withheld", () => {
    // No gate reads `audience`. The durable schema is `.passthrough()` and is
    // documented as not cross-validated against `type`
    // (`src/server/annotations/schema.ts`), and `sanitize.ts` only ever DEMOTES
    // to private for user-authored note/highlight/flag — it never demotes a
    // comment and never promotes. So a stored `{type:"comment",
    // audience:"private"}` reaches Claude, which `docs/security.md`'s docx
    // export path already treats as two separately-required gates.
    //
    // The brand closes this, and this test is what proves it was a real hole
    // rather than ceremony: it passed against master, asserting the leak.
    const h = harness();
    add(h, "a1", { author: "user", type: "comment", audience: "private" });
    expect(h.events).toEqual([]);
    expect(JSON.stringify(h.events)).not.toContain(SECRET);
    h.dispose();
  });

  it("DELTA (was: emitted): a reply on an UNTRIAGED imported comment is now withheld", () => {
    // Imports are private until the user triages them (`sanitize.ts` derives
    // "private" for `author === "import"`), but `replies.ts` used to check
    // only `parent.type`, so the reply projected anyway — Word comment text
    // reaching Claude before the user had triaged it. Routing the parent read
    // through the narrow closes it. A third delta, and the one nobody
    // predicted: it fell out of sanitizing a read that was never sanitized.
    const h = harness();
    add(h, "a1", { author: "import", type: "comment" });
    h.replies.set("r1", { id: "r1", annotationId: "a1", author: "user", text: "t", timestamp: 1 });
    expect(h.events).toEqual([]);
    h.dispose();
  });
});
