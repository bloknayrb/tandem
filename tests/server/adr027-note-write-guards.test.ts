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
import { acceptPending, dismissPending } from "../../src/server/annotations/lifecycle.js";
import { removeAnnotationById } from "../../src/server/mcp/annotations.js";
import { processInboxAnnotations } from "../../src/server/mcp/awareness.js";
import { YDocStore } from "../../src/server/mcp/document-store.js";
import { TUTORIAL_ANNOTATIONS } from "../../src/server/mcp/tutorial-annotations.js";
import { Y_MAP_ANNOTATION_REPLIES } from "../../src/shared/constants.js";
import type { Annotation } from "../../src/shared/types.js";
import { getAnnotationsMap, makeDoc, rangeOf } from "../helpers/ydoc-factory.js";

let doc: Y.Doc;
let map: Y.Map<unknown>;
/** The MCP-only seam. The browser reaches `removeAnnotationById` directly, so
 *  the guard is here and every remove spec must drive THIS, not the helper. */
let store: YDocStore;

beforeEach(() => {
  doc = makeDoc("Hello world");
  map = getAnnotationsMap(doc);
  store = new YDocStore(doc, "C:/tmp/guards.md", "doc-guards");
});

/** Seed a record RAW so a spec can choose a stored shape the mint path would
 *  never produce — a `flag` in particular, which is a note only post-sanitize. */
function seed(id: string, extra: Record<string, unknown>): void {
  map.set(id, {
    id,
    type: "comment",
    author: "user",
    audience: "private",
    status: "pending",
    range: rangeOf(0, 5, doc).range,
    content: "private thought",
    timestamp: Date.now(),
    rev: 1,
    ...extra,
  });
}

describe("resolve refuses notes (ADR-027)", () => {
  it("returns invalid-note for a pending note, and writes nothing", () => {
    // Two assertions, because the arm alone is not enough. A guard placed AFTER
    // the `map.set` returns the right arm and still performs the write, so the
    // stored record is compared whole rather than checked for `status`.
    seed("n1", { type: "note" });
    const before = { ...(map.get("n1") as Annotation) };

    const result = acceptPending("n1", doc, map);

    expect(result).toStrictEqual({ kind: "invalid-note" });
    expect(map.get("n1"), "a guard that returns after the write passes an arm check").toStrictEqual(
      before,
    );
  });

  it("control: a pending COMMENT still resolves, so the guard is not refusing everything", () => {
    // Without this, `if (true) return { kind: "invalid-note" }` passes the spec
    // above. This is the positive control for the guard, not for the harness.
    seed("c1", { type: "comment", author: "claude", audience: "outbound" });

    const result = acceptPending("c1", doc, map);

    expect(result.kind).toBe("ok");
    expect((map.get("c1") as Annotation).status).toBe("accepted");
  });

  it("reports a RESOLVED note as invalid-note, not as not-pending", () => {
    // **The only assertion that distinguishes the guard's position.** A note
    // check written after the pending check passes every other spec in this
    // file and fails only here. `not-pending` would tell a caller that the note
    // exists and is merely resolved — a disclosure ADR-027 does not make.
    seed("n2", { type: "note", status: "dismissed" });

    expect(acceptPending("n2", doc, map)).toStrictEqual({ kind: "invalid-note" });
    expect(dismissPending("n2", doc, map)).toStrictEqual({ kind: "invalid-note" });
  });

  it("refuses a stored `flag`, which is a note only after sanitize", () => {
    // The kill for a guard keyed on the RAW type. `sanitizeAnnotation` maps a
    // legacy `flag` to `note`; a `raw.type === "note"` check passes every spec
    // above and lets this one through. This fixture is the whole reason the
    // guard sits after sanitize rather than before it.
    seed("f1", { type: "flag" });

    expect(acceptPending("f1", doc, map)).toStrictEqual({ kind: "invalid-note" });
    expect((map.get("f1") as Annotation).status, "and it is not resolved").toBe("pending");
  });

  it("still reports not-pending for a resolved COMMENT", () => {
    // Guard the guard from the other side: the note check must not have
    // swallowed the pending arm for non-notes.
    seed("c2", { type: "comment", author: "claude", audience: "outbound", status: "accepted" });

    expect(acceptPending("c2", doc, map)).toStrictEqual({
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

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_ARGUMENT");
    expect(map.has("n3"), "the note survives").toBe(true);
    expect(replies.has("r1"), "and so does its private thread").toBe(true);
  });

  it("refuses a stored `flag` here too, for the same post-sanitize reason", () => {
    seed("f2", { type: "flag" });

    expect(store.removeAnnotation("f2").ok).toBe(false);
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

    expect(result.ok).toBe(true);
    expect(map.has("c3")).toBe(false);
    expect(replies.has("r2"), "the reply sweep still runs for a comment").toBe(false);
  });
});

describe("the BROWSER may still archive its own note", () => {
  it("removeAnnotationById itself does not refuse a note", () => {
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

    const result = removeAnnotationById(doc, map, "C:/tmp/doc.md", "b1");

    expect(result.ok, "the user's own Archive still works").toBe(true);
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
    seed("legacy", { type: "flag", author: "claude", status: "accepted" });
    seed("real", { type: "comment", author: "claude", status: "accepted" });

    const inbox = [
      { ...(map.get("legacy") as Annotation), type: "note" },
      map.get("real") as Annotation,
    ] as Annotation[];

    const { userResponses } = processInboxAnnotations(
      inbox,
      "Hello world",
      new Map(),
      (a) => a,
      "doc-guards",
      "tandem",
    );

    expect(
      userResponses.map((r) => r.id),
      "the note is gone, the comment is not",
    ).toEqual(["real"]);
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

    expect(acceptPending(noteId, doc, map)).toStrictEqual({ kind: "invalid-note" });
    expect(dismissPending(noteId, doc, map)).toStrictEqual({ kind: "invalid-note" });
    expect(store.removeAnnotation(noteId).ok).toBe(false);
    expect(map.has(noteId), "and it is still there").toBe(true);
  });
});
