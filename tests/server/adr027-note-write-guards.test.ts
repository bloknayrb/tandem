/**
 * ADR-027 note guards on the two write paths that lacked them (#1680).
 *
 * `tandem_editAnnotation` has refused notes since Unit 8c. `resolve` and
 * `remove` did not — and the gap was reachable, not theoretical. Three paths
 * hand a Claude session a note's id without any disclosure step:
 *
 *  1. `tutorial-note-1` is a **compile-time constant**
 *     (`TUTORIAL_ANNOTATION_PREFIX` + `note-1`), seeded on the welcome document
 *     that auto-opens on first run. Nothing has to leak it.
 *  2. `file-io/docx-comments.ts` migrates a legacy imported `comment` to a
 *     `note` **in place, under the same id**, and `importAnnotationId` is a
 *     content hash with no timestamp — so an id Claude legitimately read
 *     becomes a private note's id on the next `.docx` open.
 *  3. `awareness.ts`'s `userResponses` bucket had no type gate at all.
 *
 * Each spec below carries the discriminating precondition its title claims,
 * because a note guard has four distinct ways to be wrong and only one of them
 * is visible from the returned arm alone.
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  acceptPending,
  createAnnotationLifecycle,
  dismissPending,
  removeAnnotationRecord,
} from "../../src/server/annotations/lifecycle.js";
import { processInboxAnnotations } from "../../src/server/mcp/awareness.js";
import { YDocStore } from "../../src/server/mcp/document-store.js";
import { TUTORIAL_ANNOTATIONS } from "../../src/server/mcp/tutorial-annotations.js";
import { Y_MAP_ANNOTATION_REPLIES } from "../../src/shared/constants.js";
import type { Annotation } from "../../src/shared/types.js";
import { getAnnotationsMap, makeDoc, noRelay, seedRawAnnotation } from "../helpers/ydoc-factory.js";

let doc: Y.Doc;
let map: Y.Map<unknown>;
/** The MCP-only seam. The browser reaches `removeAnnotationRecord` directly, so
 *  the guard is here and every remove spec must drive THIS, not the helper. */
let store: YDocStore;

beforeEach(() => {
  doc = makeDoc("Hello world");
  map = getAnnotationsMap(doc);
  store = new YDocStore(doc, "C:/tmp/guards.md", "doc-guards");
});

/** Shorthand for the shared raw-record seeder, bound to this file's doc. */
function seed(id: string, extra: Record<string, unknown>): void {
  seedRawAnnotation(map, doc, id, extra);
}

describe("resolve refuses notes (ADR-027)", () => {
  it("returns invalid-note for a pending note, and writes nothing", () => {
    // Two assertions, because the arm alone is not enough. A guard placed AFTER
    // the `map.set` returns the right arm and still performs the write, so the
    // stored record is compared whole rather than checked for `status`.
    seed("n1", { type: "note" });
    const before = { ...(map.get("n1") as Annotation) };

    const result = acceptPending("n1", doc, map, noRelay);

    expect(result).toStrictEqual({ kind: "invalid-note" });
    expect(map.get("n1"), "a guard that returns after the write passes an arm check").toStrictEqual(
      before,
    );
  });

  it("control: a pending COMMENT still resolves, so the guard is not refusing everything", () => {
    // Without this, `if (true) return { kind: "invalid-note" }` passes the spec
    // above. This is the positive control for the guard, not for the harness.
    //
    // USER-authored since #1770: accept is the user's decision. The sibling row
    // below is the other half of that split, and C-1803's control set relies on
    // the two existing separately.
    seed("c1", { type: "comment", author: "user", audience: "outbound" });

    const result = acceptPending("c1", doc, map, noRelay);

    expect(result.kind).toBe("ok");
    expect((map.get("c1") as Annotation).status).toBe("accepted");
  });

  it("refuses an accept of CLAUDE's own annotation (#1770)", () => {
    // The other half of the split above. Behind the pending check, so
    // `not-pending` keeps precedence — pinned by the resolved-comment row below.
    seed("c1b", { type: "comment", author: "claude", audience: "outbound" });

    expect(acceptPending("c1b", doc, map, noRelay)).toStrictEqual({
      kind: "accept-refused",
      reason: "own-annotation",
    });
    expect((map.get("c1b") as Annotation).status, "and nothing was written").toBe("pending");

    // Dismiss on Claude's own record is still permitted, and stamps who did it.
    expect(dismissPending("c1b", doc, map, noRelay).kind).toBe("ok");
    expect((map.get("c1b") as Annotation).resolvedBy).toBe("claude");
  });

  it("reports a RESOLVED note as invalid-note, not as not-pending", () => {
    // **The only assertion that distinguishes the guard's position.** A note
    // check written after the pending check passes every other spec in this
    // file and fails only here. `not-pending` would tell a caller that the note
    // exists and is merely resolved — a disclosure ADR-027 does not make.
    seed("n2", { type: "note", status: "dismissed" });

    expect(acceptPending("n2", doc, map, noRelay)).toStrictEqual({ kind: "invalid-note" });
    expect(dismissPending("n2", doc, map, noRelay)).toStrictEqual({ kind: "invalid-note" });
  });

  it("refuses a stored `flag`, which is a note only after sanitize", () => {
    // The kill for a guard keyed on the RAW type. `sanitizeAnnotation` maps a
    // legacy `flag` to `note`; a `raw.type === "note"` check passes every spec
    // above and lets this one through. This fixture is the whole reason the
    // guard sits after sanitize rather than before it.
    seed("f1", { type: "flag" });

    expect(acceptPending("f1", doc, map, noRelay)).toStrictEqual({ kind: "invalid-note" });
    expect((map.get("f1") as Annotation).status, "and it is not resolved").toBe("pending");
  });

  it("still reports not-pending for a resolved COMMENT", () => {
    // Guard the guard from the other side: the note check must not have
    // swallowed the pending arm for non-notes.
    seed("c2", { type: "comment", author: "claude", audience: "outbound", status: "accepted" });

    expect(acceptPending("c2", doc, map, noRelay)).toStrictEqual({
      kind: "not-pending",
      id: "c2",
      currentStatus: "accepted",
    });
  });
});

describe("remove refuses notes (ADR-027)", () => {
  it("refuses a note and leaves the record AND its replies in place", () => {
    // This path is the destructive one — it deletes the annotation and sweeps
    // every reply keyed to it, which for a note is a private thread. The reply
    // assertion is the half an arm-only check would miss.
    seed("n3", { type: "note" });
    const replies = doc.getMap(Y_MAP_ANNOTATION_REPLIES);
    replies.set("r1", { id: "r1", annotationId: "n3", content: "private", private: true });

    const result = store.removeAnnotation("n3");

    // The ARM, not a boolean. `invalid-note` is what the handler translates
    // into the INVALID_ARGUMENT envelope; asserting only "not ok" would pass
    // for `not-found`, which tells a caller the opposite thing about whether
    // the note exists.
    expect(result).toStrictEqual({ kind: "invalid-note" });
    expect(map.has("n3"), "the note survives").toBe(true);
    expect(replies.has("r1"), "and so does its private thread").toBe(true);
  });

  it("refuses a stored `flag` here too, for the same post-sanitize reason", () => {
    seed("f2", { type: "flag" });

    expect(store.removeAnnotation("f2")).toStrictEqual({ kind: "invalid-note" });
    expect(map.has("f2")).toBe(true);
  });

  it("control: a comment is still removed, along with its replies", () => {
    // The positive control. Without it, a guard that refuses everything passes
    // both specs above — and remove is the path where that failure mode is
    // silent rather than loud, since nothing downstream expects a deletion.
    seed("c3", { type: "comment", author: "claude", audience: "outbound" });
    const replies = doc.getMap(Y_MAP_ANNOTATION_REPLIES);
    replies.set("r2", { id: "r2", annotationId: "c3", content: "ok" });

    const result = store.removeAnnotation("c3");

    expect(result).toStrictEqual({ kind: "ok", id: "c3" });
    expect(map.has("c3")).toBe(false);
    expect(replies.has("r2"), "the reply sweep still runs for a comment").toBe(false);
  });
});

describe("the BROWSER may still archive its own note", () => {
  it("removeAnnotationRecord itself does not refuse a note", () => {
    // **The guard must NOT be here.** `mcp/routes/remove-annotation.ts` calls
    // this helper for `POST /api/remove-annotation`, which is what the Archive
    // button on every note card posts to. The first draft of this fix put the
    // guard in the helper: the user's own Archive returned 400, the client only
    // logged it, and a toast told the user their note "cannot be removed by
    // Claude". ADR-027 governs what CLAUDE may do.
    //
    // Every remove spec above drives `YDocStore` for the same reason — a suite
    // that only calls the helper cannot see which of the two layers holds the
    // guard, which is exactly why the regression was invisible to it.
    seed("b1", { type: "note" });

    const result = removeAnnotationRecord(doc, "b1");

    expect(result.kind, "the user's own Archive still works").toBe("ok");
    expect(map.has("b1")).toBe(false);
  });
});

describe("checkInbox does not choke on a legacy note", () => {
  it("drops a claude-authored record that sanitizes to a note", () => {
    // Not disclosure — the output schema's `type` is `["highlight","comment"]`
    // and the SDK hard-validates before transmit, so a note here could never
    // reach the wire. It is AVAILABILITY: one such record failed the entire
    // `tandem_checkInbox` call rather than being filtered, and the error named
    // a schema rather than the annotation. The discriminating fixture is a
    // legacy `flag`, because that is the only way the record arises.
    // BOTH seeds are outbound, not only `real`. `seedRawAnnotation` defaults to
    // `audience: "private"`, and after #1619 the audience half alone would
    // exclude `legacy` — which would leave this row green even if the
    // `type !== "note"` half were dropped, re-opening the availability bug this
    // spec exists for. With both outbound, the type half is the only thing
    // excluding `legacy`. It is Claude-authored, so sanitize's user-scoped
    // demotion cannot apply.
    seed("legacy", { type: "flag", author: "claude", audience: "outbound", status: "accepted" });
    seed("real", {
      type: "comment",
      author: "claude",
      audience: "outbound",
      status: "accepted",
    });

    const inbox = [
      { ...(map.get("legacy") as Annotation), type: "note" },
      map.get("real") as Annotation,
    ] as Annotation[];

    const { userResponses } = processInboxAnnotations(
      inbox,
      "Hello world",
      new Map(),
      (anns) => anns,
      "doc-guards",
      "tandem",
      () => false,
    );

    expect(
      userResponses.map((r) => r.id),
      "the note is gone, the comment is not",
    ).toEqual(["real"]);
  });
});

/**
 * #1803 — the same four Claude-facing write families, on the OTHER half of
 * ADR-027's privacy field.
 *
 * A stored `{type: "comment", audience: "private"}` record is reachable by a
 * legacy envelope or a stale-tab merge, and `sanitizeAnnotation` does not heal
 * one (it derives an audience only when none is stored). Until #1803 Claude
 * could not REPLY to such a record but could edit, resolve and remove it.
 *
 * `seedRawAnnotation`'s defaults are `{type: "comment", author: "user",
 * audience: "private"}`, so every CONTROL below passes both `author` and
 * `audience: "outbound"` explicitly.
 */
describe("the four write guards agree on audience (#1803)", () => {
  function lifecycle() {
    return createAnnotationLifecycle(doc);
  }

  it("refuses a private COMMENT on resolve, edit and remove, writing nothing", () => {
    seed("p1", { type: "comment", author: "claude", audience: "private" });
    const replies = doc.getMap(Y_MAP_ANNOTATION_REPLIES);
    replies.set("pr1", { id: "pr1", annotationId: "p1", content: "private thread" });
    const before = { ...(map.get("p1") as Annotation) };

    expect(acceptPending("p1", doc, map, noRelay)).toStrictEqual({ kind: "invalid-note" });
    expect(dismissPending("p1", doc, map, noRelay)).toStrictEqual({ kind: "invalid-note" });
    expect(lifecycle().editPending("p1", { content: "rewritten" }, noRelay)).toStrictEqual({
      kind: "invalid-note",
    });
    expect(store.removeAnnotation("p1")).toStrictEqual({ kind: "invalid-note" });

    expect(map.get("p1")).toStrictEqual(before);
    expect(replies.has("pr1"), "and its thread survives the remove refusal").toBe(true);
  });

  it("control: each family still writes on an OUTBOUND record", () => {
    // Split by verb on purpose: accept is the user's decision, so the accept
    // control is a USER-authored comment (sanitize leaves a user comment
    // outbound) while dismiss/edit/remove use Claude's own.
    seed("o1", { type: "comment", author: "claude", audience: "outbound" });
    expect(dismissPending("o1", doc, map, noRelay).kind).toBe("ok");

    seed("o2", { type: "comment", author: "user", audience: "outbound" });
    expect(acceptPending("o2", doc, map, noRelay).kind).toBe("ok");

    seed("o3", { type: "comment", author: "claude", audience: "outbound" });
    expect(lifecycle().editPending("o3", { content: "rewritten" }, noRelay).kind).toBe("ok");

    seed("o4", { type: "comment", author: "claude", audience: "outbound" });
    expect(store.removeAnnotation("o4")).toStrictEqual({ kind: "ok", id: "o4" });
  });

  it("leaves a HIGHLIGHT to its own arms, never invalid-note", () => {
    // Kills a predicate written as `audience !== "outbound"` over every type.
    // Claude-authored so the user-scoped demotion in sanitize cannot apply;
    // sanitize derives `private` from the absent stored audience.
    seed("h1", { type: "highlight", author: "claude", audience: undefined });

    expect(lifecycle().editPending("h1", { suggestedText: "x" }, noRelay)).toStrictEqual({
      kind: "invalid-suggestion-target",
      annotationType: "highlight",
    });
    expect(lifecycle().reply("h1", "hello", noRelay).kind).toBe("not-repliable");
  });

  it("refuses a stored `flag` at audience OUTBOUND on all four, by both halves", () => {
    // (i) user-authored: `sanitize` demotes a user outbound flag to `private`
    // AND makes it a note, so both halves of the predicate refuse it.
    seed("fu", { type: "flag", author: "user", audience: "outbound" });
    expect(acceptPending("fu", doc, map, noRelay)).toStrictEqual({ kind: "invalid-note" });
    expect(lifecycle().editPending("fu", { content: "x" }, noRelay)).toStrictEqual({
      kind: "invalid-note",
    });
    expect(store.removeAnnotation("fu")).toStrictEqual({ kind: "invalid-note" });
    expect(lifecycle().reply("fu", "x", noRelay)).toStrictEqual({ kind: "invalid-note" });

    // (ii) claude-authored: the demotion is user-scoped, so it becomes
    // `{note, outbound}` and is refused PURELY by the `type === "note"` half.
    // Together these two pin the after-sanitize ordering on the families that
    // previously had no such row.
    seed("fc", { type: "flag", author: "claude", audience: "outbound" });
    expect(acceptPending("fc", doc, map, noRelay)).toStrictEqual({ kind: "invalid-note" });
    expect(lifecycle().editPending("fc", { content: "x" }, noRelay)).toStrictEqual({
      kind: "invalid-note",
    });
    expect(store.removeAnnotation("fc")).toStrictEqual({ kind: "invalid-note" });
    expect(lifecycle().reply("fc", "x", noRelay)).toStrictEqual({ kind: "invalid-note" });
  });
});

describe("the tutorial note, which is the reachable instance", () => {
  it("cannot be resolved or removed, and its id really is derivable", () => {
    // **The first version of this spec seeded the id it then asserted**, so it
    // was self-consistent by construction: turning the id into a nonce would
    // have left it green while its own comment claimed it would notice.
    // Stripped of prose it was a duplicate of the first spec in this file.
    //
    // It now runs the real injector and reads the seeded id back out, so the
    // "guessable" half is asserted against the product rather than against the
    // fixture. If the tutorial ever mints a nonce instead, THIS line fails —
    // which is the outcome that should make someone delete the spec on purpose
    // rather than have it quietly stop meaning anything.
    // Read the id off the PRODUCT's own definition list rather than off a
    // fixture. Running the injector is not an option here — it anchors on the
    // real welcome document's text, so against this doc it would inject nothing
    // and the spec would assert over an empty map, which is the failure mode
    // this rewrite exists to remove rather than reintroduce.
    const noteDef = TUTORIAL_ANNOTATIONS.find((d) => d.type === "note");
    expect(noteDef, "the tutorial still seeds a note").toBeDefined();
    if (!noteDef) return;
    const noteId = noteDef.id;

    expect(noteId, "and its id is still a constant, not a nonce").toBe("tutorial-note-1");
    seed(noteId, { type: "note" });

    expect(acceptPending(noteId, doc, map, noRelay)).toStrictEqual({ kind: "invalid-note" });
    expect(dismissPending(noteId, doc, map, noRelay)).toStrictEqual({ kind: "invalid-note" });
    expect(store.removeAnnotation(noteId)).toStrictEqual({ kind: "invalid-note" });
    expect(map.has(noteId), "and it is still there").toBe(true);
  });
});
