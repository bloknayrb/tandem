/**
 * Before/after record of what reaches the channel, spanning ADR-035's
 * `ChannelEligible` brand (Unit 8a).
 *
 * Written before the brand landed, when every assertion passed against
 * unmodified production code. When the brand landed, **exactly three failed**
 * — and the other fourteen did not move. That is the whole value of the file:
 * without it, "the brand changes only what we meant it to" is a claim nobody
 * can check, and three intended changes are indistinguishable from three
 * accidents.
 *
 * **Adversarial review then found three MORE deltas this file had not been
 * written to catch, and REMOVED one of the three it had. That is the honest
 * headline.** A characterization suite proves the deltas it thought to look
 * for; it cannot prove there are no others, and claiming otherwise is the
 * failure mode. The three it missed: the unrecognized-type refusal; a reply on
 * a legacy `suggestion`/`question` parent, which now emits where master
 * dropped it — the only delta in the EMITTING direction, and the one nobody
 * predicted in either; and a legacy `flag` promotion, which emitted nothing on
 * master and now works.
 *
 * The one it removed was the Claude-authored tutorial highlight. That had been
 * measured, accepted and written up as a cost worth paying — until review
 * observed that the seed is a REVIEW TARGET (`isReviewTarget` is
 * `author !== "user"`), so what the delta actually did was silently drop a
 * first-run user's Dismiss. Stating `audience: "outbound"` at the seed, which
 * is what `createAnnotation` always did, removes the delta instead of
 * accepting it. Measuring a delta correctly is not the same as understanding
 * what it costs.
 *
 * The five that remain assert the NEW behaviour, and each keeps the record of
 * what it asserted before, because a delta with no before is just an
 * assertion.
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
 * the reason these are deltas rather than regressions. Several fell out of one
 * change: sanitizing `replies.ts`'s parent read, which nothing had sanitized,
 * both withholds replies on an untriaged imported comment AND admits replies
 * on a legacy `suggestion` parent — the same fix moving the line in both
 * directions, which is what made it worth measuring rather than reasoning.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { sendNoteToClaude } from "../../../src/client/panels/annotation-actions.js";
import { makeAnnotationsObserver } from "../../../src/server/events/observers/annotations.js";
import { makeRepliesObserver } from "../../../src/server/events/observers/replies.js";
import type { TandemEvent } from "../../../src/server/events/types.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../../src/shared/constants.js";
import { toFlatOffset } from "../../../src/shared/positions/types.js";
import type { Annotation, AnnotationReply } from "../../../src/shared/types.js";

type AnnotationSeed = Partial<Annotation> & Pick<Annotation, "author" | "type">;

const SECRET = "PRIVATE PARENT TEXT — must not leak";
/** Distinct from SECRET: the parent's snapshot legitimately ships in the
 * parent's own `created` event, so asserting on SECRET here would fail for a
 * reason that has nothing to do with the reply. */
const REPLY_SECRET = "PRIVATE REPLY TEXT — must not leak";

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
    doc,
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

  it("DELTA (was: emitted nothing): promoting a legacy flag now emits annotation:created", () => {
    // A bug on master, fixed here because the branch was in this code anyway.
    // The client promoter sanitizes before deciding something is a note, and
    // sanitize maps `flag` to `note` — so the user CAN promote a stored flag.
    // The observer compared the RAW old type against "note", saw "flag", fell
    // through to the edit branch, found `editedAt` unmoved (promotion does not
    // touch it) and emitted nothing at all. A "Send to Claude" click that
    // reached Claude never.
    const h = harness();
    const old = annotation("a1", { author: "user", type: "note" });
    (old as { type?: unknown }).type = "flag";
    h.annotations.set("a1", old);
    h.annotations.set(
      "a1",
      annotation("a1", { author: "user", type: "comment", promotedFrom: "note" }),
    );
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

  it("a claude highlight with NO stored audience emits nothing", () => {
    // **No longer a delta, and the reason is the point.** This WAS one: the
    // tutorial seeded a Claude-authored highlight on sample/welcome.md with
    // no `audience` field, so it derived `private` and stopped emitting.
    // That looked like a cosmetic first-run difference until the silent-
    // failure review pointed out `isReviewTarget` is `author !== "user"` —
    // the seed is IN the review queue, so a new user's Dismiss was being
    // dropped with no signal. `mcp/tutorial-annotations.ts` now states
    // `audience: "outbound"` on its Claude seeds, matching what
    // `createAnnotation` always stamped, so the delta is gone rather than
    // accepted. This test stays because the derivation it exercises is real
    // and still governs any highlight that reaches here without the field.
    //
    // **The no-audience half of the title is load-bearing, and an earlier
    // version of this test got it wrong.** It claimed sanitize derives
    // "private" for ANY highlight regardless of author. It does not:
    // `sanitize.ts:79-87` short-circuits on a stored `audience` and only
    // derives when there is none. This fixture omits `audience`, so it
    // exercises the tutorial seed and nothing else — the classic
    // build-your-own-input blind spot, caught by two independent reviewers.
    // The companion test below pins the branch this one cannot see.
    const h = harness();
    add(h, "a1", { author: "claude", type: "highlight" });
    h.annotations.set(
      "a1",
      annotation("a1", { author: "claude", type: "highlight", status: "accepted" }),
    );
    expect(h.events).toEqual([]);
    h.dispose();
  });

  it("a claude highlight with a STORED outbound audience still emits", () => {
    // Not a delta — the behaviour master had, preserved. It is here because
    // the test above reads like it covers all Claude highlights and does not.
    //
    // No product path creates this record today: `createAnnotation` would
    // stamp `audience: "outbound"` on it (`mcp/annotations.ts:383`), but
    // `tandem_highlight` is a deprecated stub that errors before reaching it
    // and nothing else passes "highlight" to a creator. So the accepted delta
    // really is scoped to the tutorial seed. If a Claude-highlight creator is
    // ever reintroduced, this test is what says its events still flow, and the
    // decision to withhold highlights would then need making for real.
    const h = harness();
    add(h, "a1", { author: "claude", type: "highlight", audience: "outbound" });
    h.annotations.set(
      "a1",
      annotation("a1", {
        author: "claude",
        type: "highlight",
        audience: "outbound",
        status: "accepted",
      }),
    );
    expect(h.types()).toEqual(["annotation:accepted"]);
    h.dispose();
  });

  it("DELTA (was: emitted): a claude comment stored audience:'private' is withheld on accept", () => {
    // The audience hole had TWO sites and this file measured only the user-add
    // one. Master's claude branch gated on `type !== "note"` alone, so this
    // emitted `annotation:accepted`. Same class as the recorded delta, a
    // different site — found by review, not by the suite whose header
    // enumerates the gates.
    const h = harness();
    add(h, "a1", { author: "claude", type: "comment", audience: "private" });
    h.annotations.set(
      "a1",
      annotation("a1", {
        author: "claude",
        type: "comment",
        audience: "private",
        status: "accepted",
      }),
    );
    expect(h.events).toEqual([]);
    expect(JSON.stringify(h.events)).not.toContain(SECRET);
    h.dispose();
  });

  it("DELTA (was: emitted): an unrecognized type is dropped, not coerced to comment", () => {
    // Fourth delta. `sanitizeAnnotation` coerces an unknown type to `comment`
    // (`sanitize.ts:213`) and the coerced comment derives `audience:
    // "outbound"`, so master emitted a real `annotation:created` for a record
    // it could not identify. The narrow refuses on sanitize's own
    // `unknown-type` signal. Fires for corruption and for any future or legacy
    // type name sanitize does not enumerate.
    const h = harness();
    const ann = annotation("a1", { author: "user", type: "comment" });
    (ann as { type?: unknown }).type = "sticky-note";
    h.annotations.set("a1", ann);
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

  it("DELTA (was: dropped): a reply on a legacy suggestion parent now emits", () => {
    // The only delta in the EMITTING direction, and the one nobody predicted
    // in either direction — I had recorded three, all narrowing.
    //
    // Master read the parent raw and required `type === "comment"`, so a
    // parent stored as `suggestion` or `question` silently dropped its
    // replies. Sanitize maps both to `comment` (`sanitize.ts:164-181`), so the
    // narrow admits them. This is a fix, not a regression: the reply seam
    // sanitizes the parent before stamping `private`, so the MCP layer already
    // accepted these replies as non-private — master then swallowed the event
    // the user's reply should have produced. The two halves now agree.
    for (const legacy of ["suggestion", "question"]) {
      const h = harness();
      const parent = annotation("a1", { author: "user", type: "comment", content: "{}" });
      (parent as { type?: unknown }).type = legacy;
      h.annotations.set("a1", parent);
      h.replies.set("r1", reply("a1", "user"));
      expect(h.types(), `${legacy} parent`).toContain("annotation:reply");
      h.dispose();
    }
  });

  it("a reply naming a parent that does not exist emits nothing", () => {
    const h = harness();
    add(h, "a1", { author: "user", type: "comment" });
    // **This does NOT reach `narrowReplyForChannel`, and an earlier version of
    // this comment claimed it did.** `replies.ts` fetches the parent by
    // `reply.annotationId`, so `get("ghost")` returns undefined and the PARENT
    // narrow refuses first; delete the `annotationId !== parent.id` guard and
    // this test still passes. That guard exists for a future caller supplying
    // its own parent, so only a direct unit test reaches it — see
    // `channel-eligible-brand.test.ts`. A test that cannot fail for the reason
    // it names is worse than no test, because it reads as coverage.
    h.replies.set("r1", {
      id: "r1",
      annotationId: "ghost",
      author: "user",
      text: "t",
      timestamp: 1,
    });
    expect(h.types()).toEqual(["annotation:created"]);
    h.dispose();
  });

  it.each([
    "true",
    1,
    "yes",
  ])("a reply whose private flag is the non-boolean %p is withheld", (value) => {
    // `private === true` fails open on every one of these. The reply is the
    // one value on this path nothing sanitizes.
    const h = harness();
    add(h, "a1", { author: "user", type: "comment" });
    h.replies.set("r1", {
      id: "r1",
      annotationId: "a1",
      author: "user",
      text: "t",
      timestamp: 1,
      private: value as unknown as boolean,
    });
    expect(h.types()).toEqual(["annotation:created"]);
    h.dispose();
  });

  it.each(["import", "claude"] as const)("a reply authored by %s emits nothing", (author) => {
    // Imported Word reply threads are `author: "import"` (#1000), user-private
    // until triaged. This check moved from `replies.ts` into the narrow and had
    // no test on either side of the move — deleting it broke nothing.
    const h = harness();
    add(h, "a1", { author: "user", type: "comment" });
    h.replies.set("r1", { id: "r1", annotationId: "a1", author, text: REPLY_SECRET, timestamp: 1 });
    expect(h.types()).toEqual(["annotation:created"]);
    expect(JSON.stringify(h.events)).not.toContain(REPLY_SECRET);
    h.dispose();
  });

  it("a reply stamped private:true on a comment parent is withheld", () => {
    // The value production actually writes. The non-boolean cases cover the
    // fail-open bug; nothing covered the ordinary path. The note/highlight
    // cases look like reply-layer coverage but their fixtures omit `private`,
    // so what refuses them is the PARENT narrow. A reply written while its
    // parent was a note keeps `private: true` permanently, so a later
    // promotion must not back-publish it.
    const h = harness();
    add(h, "a1", { author: "user", type: "comment" });
    h.replies.set("r1", {
      id: "r1",
      annotationId: "a1",
      author: "user",
      text: REPLY_SECRET,
      timestamp: 1,
      private: true,
    });
    expect(h.types()).toEqual(["annotation:created"]);
    expect(JSON.stringify(h.events)).not.toContain(REPLY_SECRET);
    h.dispose();
  });

  it("keeps a note's reply private across a REAL promotion, and admits the next one", () => {
    // **The regression ADR-035 Unit 8a asked for, which did not exist.** The
    // spec above says "a later promotion must not back-publish it" while its
    // fixture seeds a comment parent and never promotes — the symptom asserted
    // without its discriminating precondition, so deleting promotion
    // permanence leaves it green. This drives the sequence.
    //
    // The promotion is `sendNoteToClaude`, the real user action, rather than a
    // hand-written `{type:"comment", audience:"outbound"}` literal: an input I
    // build myself can only confirm my own model of what promotion writes.
    // Measured honestly, that choice buys correctness by construction, not
    // detection — substituting the literal leaves this spec green.
    //
    // Note what is NOT asserted: "no textSnapshot on the wire". Promotion
    // legitimately emits `annotation:created`, and `createdPayload` puts the
    // parent's own snapshot on as `textSnippet`. The claim is about the REPLY.
    const h = harness();
    add(h, "a1", { author: "user", type: "note" });
    h.replies.set("r1", {
      id: "r1",
      annotationId: "a1",
      author: "user",
      text: REPLY_SECRET,
      timestamp: 1,
      // What production stamps for a note parent, permanently (#1000).
      private: true,
    });
    expect(h.types(), "a note and its private reply emit nothing").toEqual([]);

    sendNoteToClaude(h.doc, "a1");

    expect(h.types()).toEqual(["annotation:created"]);
    expect(JSON.stringify(h.events)).not.toContain(REPLY_SECRET);

    // The control, and it is what stops this passing for "replies never emit".
    // The parent IS eligible now — so a reply written after the promotion must
    // go through. What withholds the first one is its own `private` stamp, not
    // the parent's current state.
    h.replies.set("r2", {
      id: "r2",
      annotationId: "a1",
      author: "user",
      text: "written after the promotion",
      timestamp: 2,
    });
    expect(h.types()).toEqual(["annotation:created", "annotation:reply"]);
    expect(JSON.stringify(h.events), "and still not the old one").not.toContain(REPLY_SECRET);
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
