/**
 * `POST /api/annotation-reply` — the handler, driven.
 *
 * **This file exists because review found the route had no executing coverage at
 * all.** It is the one production path that reaches the *unguarded* reply entry,
 * and every one of these was measured green before it was written:
 *
 * - swapping 409 and 404 in the status map
 * - dropping the `NOT_FOUND` case so every refusal becomes 400
 * - deleting the `pushNotification` block entirely, so a failed reply produces
 *   no toast and the user watches their text vanish
 * - keying `dedupKey` on `Date.now()`, so a retried failure stacks toasts in
 *   the client instead of collapsing
 *
 * `annotation-reply-seam.test.ts` reads this route as *text* — it pins which
 * symbol the file may call. Text cannot tell 409 from 404.
 */

import type { Request, Response } from "express";
import { beforeEach, describe, expect, it } from "vitest";
import { addUserReply, createAnnotationLifecycle } from "../../src/server/annotations/lifecycle.js";
import { handleAnnotationReply } from "../../src/server/mcp/routes/annotation-reply.js";
import { getBuffer, resetForTesting } from "../../src/server/notifications.js";
import { Y_MAP_ANNOTATION_REPLIES, Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import type { Annotation } from "../../src/shared/types.js";
import { createAnnotation } from "../helpers/annotation-minter.js";
import { clearOpenDocs, setupDoc } from "../helpers/doc-service.js";
import { noRelay, rangeOf } from "../helpers/ydoc-factory.js";

beforeEach(() => {
  clearOpenDocs();
  resetForTesting();
});

function mockRes(): Response & { _status: number; _json: unknown } {
  const res = {
    _status: 200,
    _json: undefined as unknown,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(body: unknown) {
      this._json = body;
      return this;
    },
  };
  return res as unknown as Response & { _status: number; _json: unknown };
}

const reqWith = (body: unknown) => ({ body }) as unknown as Request;

/** The route's own toasts, separated from the seed's `review-pending` one. */
const errorToasts = () => getBuffer().filter((n) => n.type === "annotation-error");

/** Open a doc under `docId` and return its ydoc plus a fresh pending comment. */
function seed(docId: string): { ydoc: ReturnType<typeof setupDoc>; annId: string } {
  const ydoc = setupDoc(docId, "Hello world");
  const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
  const annId = createAnnotation(map, ydoc, "comment", rangeOf(0, 5, ydoc), "parent");
  return { ydoc, annId };
}

describe("handleAnnotationReply — the happy path", () => {
  it("writes the reply and answers with its id", () => {
    const { ydoc, annId } = seed("route-ok");
    const res = mockRes();

    handleAnnotationReply(reqWith({ annotationId: annId, text: "ack" }), res);

    expect(res._status).toBe(200);
    expect(res._json).toStrictEqual({
      data: { replyId: expect.stringMatching(/^rpl_/), annotationId: annId },
    });
    expect(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).size).toBe(1);
    // No ERROR toast on success — the notification path is failure-only, and a
    // spec that only ever drove failures could not tell the difference. Scoped
    // to the type because the seed's own `createAnnotation` pushes a
    // `review-pending` toast; a whole-buffer count would be measuring that.
    expect(errorToasts()).toHaveLength(0);
  });

  it("reaches the UNGUARDED entry: a user may reply in their own note thread", () => {
    // The route's whole reason for calling `addUserReply` rather than
    // `lifecycle.reply`, and #1000's rule. The seam census pins which symbol the
    // file names; only this can tell that the symbol still behaves that way.
    const ydoc = setupDoc("route-note", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "note", rangeOf(0, 5, ydoc), "private note");
    const res = mockRes();

    handleAnnotationReply(reqWith({ annotationId: annId, text: "to myself" }), res);

    expect(res._status).toBe(200);
    const replies = [...ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).values()] as Annotation[];
    expect(replies).toHaveLength(1);
    // …and it inherits the parent's privacy, so reaching the unguarded entry is
    // not the same as writing an unprotected record.
    expect((replies[0] as unknown as { private?: boolean }).private).toBe(true);
  });
});

describe("handleAnnotationReply — the status map", () => {
  it("answers 409 for a resolved parent", () => {
    const { ydoc, annId } = seed("route-409");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    map.set(annId, { ...(map.get(annId) as Annotation), status: "accepted" });
    const res = mockRes();

    handleAnnotationReply(reqWith({ annotationId: annId, text: "too late" }), res);

    expect(res._status).toBe(409);
    expect(res._json).toMatchObject({ error: "ANNOTATION_RESOLVED" });
  });

  it("answers 404 for a missing parent", () => {
    seed("route-404");
    const res = mockRes();

    handleAnnotationReply(reqWith({ annotationId: "nope", text: "hi" }), res);

    // 404 and 409 are asserted as a PAIR on purpose: either alone is satisfied
    // by a map that returns one constant, and swapping the two entries was one
    // of the mutations that used to survive.
    expect(res._status).toBe(404);
    expect(res._json).toMatchObject({ error: "NOT_FOUND" });
  });

  it("answers 400 for a highlight parent, the INVALID_ARGUMENT bucket", () => {
    const ydoc = setupDoc("route-400", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "highlight", rangeOf(0, 5, ydoc), "");
    const res = mockRes();

    handleAnnotationReply(reqWith({ annotationId: annId, text: "no thread here" }), res);

    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({ error: "INVALID_ARGUMENT" });
  });
});

describe("handleAnnotationReply — the user-visible failure surface", () => {
  it("pushes an error toast per failure, each under the same stable dedup key", () => {
    const { ydoc, annId } = seed("route-toast");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    map.set(annId, { ...(map.get(annId) as Annotation), status: "accepted" });

    handleAnnotationReply(reqWith({ annotationId: annId, text: "one" }), mockRes());
    handleAnnotationReply(reqWith({ annotationId: annId, text: "two" }), mockRes());

    // **Both halves, and the second is the one that matters.**
    // `pushNotification` does NOT collapse by `dedupKey` — the buffer takes
    // every push and the CLIENT is what collapses them, so two failures are two
    // entries and a spec asserting one would be asserting a server-side dedup
    // that does not exist. What the key buys is that the two collapse *there*,
    // which is exactly what a `Date.now()`-keyed mutation breaks while leaving
    // "a toast fired" green. So: both pushed, both carrying the same stable key.
    const notes = errorToasts();
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.dedupKey)).toStrictEqual([
      `reply-error:${annId}`,
      `reply-error:${annId}`,
    ]);
    expect(notes[0].severity).toBe("error");
    expect(notes[0].message).toContain("Reply failed");
  });

  it("rejects a missing annotationId and a missing text without touching the doc", () => {
    const { ydoc } = seed("route-args");

    const noId = mockRes();
    handleAnnotationReply(reqWith({ text: "orphan" }), noId);
    expect(noId._status).toBe(400);
    expect(noId._json).toMatchObject({ error: "BAD_REQUEST" });

    const noText = mockRes();
    handleAnnotationReply(reqWith({ annotationId: "a1" }), noText);
    expect(noText._status).toBe(400);

    // A simple-request `text/plain` POST leaves `req.body` undefined — the shape
    // that reached `/api/save` unconditionally before #1320's siblings closed
    // it. Here it must fall to the same 400, not throw.
    const noBody = mockRes();
    handleAnnotationReply(reqWith(undefined), noBody);
    expect(noBody._status).toBe(400);

    expect(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).size).toBe(0);
    expect(errorToasts()).toHaveLength(0);
  });

  it("answers 404 when no document is open at all", () => {
    clearOpenDocs();
    const res = mockRes();

    handleAnnotationReply(reqWith({ annotationId: "a1", text: "hi" }), res);

    expect(res._status).toBe(404);
    expect(res._json).toMatchObject({ error: "NOT_FOUND", message: "No document open" });
  });
});

describe("handleAnnotationReply — parity with the seam", () => {
  it("writes the same record the seam's own entry writes", () => {
    // The route is a thin shell over `addUserReply`. Pinning parity here is what
    // stops the shell growing its own record-building — the failure `writeReply`
    // being a single builder exists to prevent, and one this suite would
    // otherwise be blind to since it never inspects the record's fields.
    const { ydoc, annId } = seed("route-parity");
    handleAnnotationReply(reqWith({ annotationId: annId, text: "via route" }), mockRes());
    const viaRoute = [...ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).values()][0] as Record<
      string,
      unknown
    >;

    const direct = addUserReply(ydoc, annId, "via seam", noRelay);
    expect(direct.kind).toBe("ok");
    const viaSeam = [...ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).values()].find(
      (r) => (r as { text: string }).text === "via seam",
    ) as Record<string, unknown>;

    const shape = (r: Record<string, unknown>) =>
      Object.keys(r)
        .filter((k) => k !== "id" && k !== "timestamp" && k !== "rev")
        .sort();
    expect(shape(viaRoute)).toStrictEqual(shape(viaSeam));
    expect(viaRoute.author).toBe("user");
    expect(viaSeam.author).toBe("user");
  });

  it("does NOT carry Claude's guard, which the same parent proves", () => {
    // The #1000 regression named in the seam census, driven rather than scanned:
    // the same note parent that Claude is refused on must accept the user's
    // reply through this route.
    const ydoc = setupDoc("route-vs-claude", "Hello world");
    const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
    const annId = createAnnotation(map, ydoc, "note", rangeOf(0, 5, ydoc), "private note");

    expect(createAnnotationLifecycle(ydoc).reply(annId, "claude probe", noRelay)).toStrictEqual({
      kind: "invalid-note",
    });

    const res = mockRes();
    handleAnnotationReply(reqWith({ annotationId: annId, text: "mine" }), res);
    expect(res._status).toBe(200);
    expect(ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).size).toBe(1);
  });
});
