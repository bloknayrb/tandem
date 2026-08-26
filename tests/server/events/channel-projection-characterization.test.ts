/**
 * Characterization of what reaches the channel TODAY, written before ADR-035's
 * `ChannelEligible` brand (Unit 8a) moves anything.
 *
 * Every assertion here passes against unmodified production code. Two of them
 * describe behaviour the brand deliberately CHANGES, and they are marked
 * `DELTA:` — when the brand lands, those two flip and the rest must not. That
 * is the whole point of writing this first: without it, "the brand preserves
 * behaviour" is a claim nobody can check, and the two intended changes are
 * indistinguishable from two accidents.
 *
 * The gates being characterized (all four, plus the origin filter upstream):
 *
 * | Site | Predicate today |
 * |---|---|
 * | `observers/annotations.ts:32,38` user add | `author === "user" && type === "comment"` |
 * | `observers/annotations.ts:54` user edit/promotion | `author === "user" && type === "comment"` |
 * | `observers/annotations.ts:89,94` claude accept/dismiss | `author === "claude" && type !== "note"` |
 * | `observers/replies.ts:21,32` | `reply.author === "user" && parent.type === "comment"` |
 * | `observers/factory.ts:69` | `!shouldSkipChannel(txn.origin)` — runs before all of the above |
 *
 * Note what NO gate consults today: `audience`. That is the hole Unit 8a closes
 * and the reason two of these characterizations are deltas rather than
 * regressions.
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

describe("channel projection today — user add", () => {
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

describe("channel projection today — user edit and promotion", () => {
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

describe("channel projection today — claude accept and dismiss", () => {
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

  it("DELTA: a claude HIGHLIGHT emits annotation:accepted today", () => {
    // The `type !== "note"` gate admits highlights, and the tutorial seeds a
    // Claude-authored highlight on sample/welcome.md
    // (`mcp/tutorial-annotations.ts` — `type: "highlight"`, author assigned
    // "claude" for everything that is not a note). So this fires on first run.
    //
    // Unit 8a's brand requires `audience === "outbound"`, and
    // `sanitize.ts:79-87` derives `"private"` for ANY highlight regardless of
    // author, so this becomes zero events. Decided deliberately: highlights are
    // user-only markup with nothing for Claude to act on.
    const h = harness();
    add(h, "a1", { author: "claude", type: "highlight" });
    h.annotations.set(
      "a1",
      annotation("a1", { author: "claude", type: "highlight", status: "accepted" }),
    );
    expect(h.types()).toEqual(["annotation:accepted"]);
    h.dispose();
  });
});

describe("channel projection today — replies", () => {
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

describe("channel projection today — the audience axis nothing consults", () => {
  it("DELTA: a comment stored with audience:'private' still emits today", () => {
    // No gate reads `audience`. The durable schema is `.passthrough()` and is
    // documented as not cross-validated against `type`
    // (`src/server/annotations/schema.ts`), and `sanitize.ts` only ever DEMOTES
    // to private for user-authored note/highlight/flag — it never demotes a
    // comment and never promotes. So a stored `{type:"comment",
    // audience:"private"}` reaches Claude, which `docs/security.md`'s docx
    // export path already treats as two separately-required gates.
    //
    // Unit 8a's brand closes this. That is the privacy fix in the unit, and
    // this test is what proves it was a real hole rather than ceremony.
    const h = harness();
    add(h, "a1", { author: "user", type: "comment", audience: "private" });
    expect(h.types()).toEqual(["annotation:created"]);
    h.dispose();
  });

  it("a user reply on an UNTRIAGED imported comment still emits today", () => {
    // Imports are private until the user triages them
    // (`sanitize.ts` derives "private" for `author === "import"`), but
    // `replies.ts` checks only `parent.type`, so the reply projects anyway.
    // Recorded as characterization; the brand changes this too.
    const h = harness();
    add(h, "a1", { author: "import", type: "comment" });
    h.replies.set("r1", { id: "r1", annotationId: "a1", author: "user", text: "t", timestamp: 1 });
    expect(h.types()).toEqual(["annotation:reply"]);
    h.dispose();
  });
});
