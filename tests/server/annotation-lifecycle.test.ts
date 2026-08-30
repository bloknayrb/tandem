/**
 * Tests for the ADR-035 AnnotationLifecycle module (part 1/N).
 *
 * The lifecycle exposes typed state transitions for annotation
 * mutations. Part 1 covers the two pending-only transitions:
 * `acceptPending` and `dismissPending`. Both refuse non-pending
 * annotations as a structurally-typed `LifecycleResult` arm — the
 * previous runtime check in #694 / PR 0a (`ANNOTATION_NOT_PENDING`)
 * becomes a kind-tagged result the caller branches on.
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { acceptPending, dismissPending } from "../../src/server/annotations/lifecycle.js";
import { createAnnotation } from "../../src/server/mcp/annotations.js";
import { MCP_ORIGIN } from "../../src/shared/origins.js";
import type { Annotation } from "../../src/shared/types.js";
import { getAnnotationsMap, makeDoc, noRelay, rangeOf } from "../helpers/ydoc-factory.js";

let doc: Y.Doc;

beforeEach(() => {
  doc = makeDoc("Hello world");
});

describe("acceptPending", () => {
  it("returns kind: 'ok' for a pending annotation, transitions to accepted, bumps rev", () => {
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, doc, "comment", rangeOf(0, 5, doc), "test");
    const before = map.get(id) as Annotation;

    const result = acceptPending(id, doc, map, noRelay);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.data.status).toBe("accepted");
    expect(result.data.rev).toBeGreaterThan(before.rev ?? 0);

    const after = map.get(id) as Annotation;
    expect(after.status).toBe("accepted");
    // The STORED rev, not just the returned one. Until Unit 8d this line was
    // absent and the title's "bumps rev" was satisfied by the return value
    // alone — a write of `{...updated, rev: ann.rev}` passed, and so did
    // `nextRev(ann) -> nextRev()`, which pins every accept at 1.
    expect(after.rev, "the rev that was WRITTEN, which is the one that matters").toBe(
      result.data.rev,
    );
    expect(after.rev).toBeGreaterThan(before.rev ?? 0);
  });

  it("preserves every field the record already carried", () => {
    // **The highest-value spec in this file, and the family had nothing like
    // it.** Accept is the most common resolve action, and `transitionPending`
    // rebuilds the record with a spread. Replace that spread with a
    // field-listing rebuild — or write the RAW record instead of the sanitized
    // one — and `relRange`, `textSnapshot`, `audience` and `suggestedText` fall
    // off silently. A dropped `relRange` is CRDT degradation: the annotation
    // falls back to flat offsets and drifts on the next edit.
    //
    // It reads `map.get(id)`, never `result.data`, because the two mutants
    // differ exactly there — `result.data` IS the object the literal built, so
    // a return-value assertion cannot see a divergent write.
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, doc, "comment", rangeOf(0, 5, doc), "test", {
      suggestedText: "replacement",
      textSnapshot: "Hello",
    });
    // **A SPREAD, not the reference.** `map.get` hands back the stored object, so
    // a bare `const before = map.get(id)` is a live alias — and a mutant that
    // writes the record in place (`Object.assign(raw, updated); map.set(id, raw)`)
    // then makes the assertion below compare an object to a spread of itself and
    // pass. Measured, not reasoned: that mutant left this spec green and reds
    // only the two rev specs.
    const before = { ...(map.get(id) as Annotation) };
    expect(before.relRange, "fixture precondition: the record is anchored").toBeDefined();

    acceptPending(id, doc, map, noRelay);

    const after = map.get(id) as Annotation;
    // Status and rev are the two fields the transition OWNS; everything else
    // must survive byte-for-byte, so assert the whole record rather than a
    // field list that a future field would silently escape. `rev` is asserted
    // by its own specs above and below — reading it off `after` here would be
    // circular, so it is excluded from the comparison rather than smuggled in.
    const { rev: _afterRev, ...afterRest } = after;
    const { rev: _beforeRev, ...beforeRest } = before;
    expect(afterRest).toStrictEqual({ ...beforeRest, status: "accepted" });
    expect(after.rev, "and the transition did bump it").toBeGreaterThan(before.rev ?? 0);
  });

  it("returns kind: 'not-found' when the annotation doesn't exist", () => {
    const map = getAnnotationsMap(doc);
    const result = acceptPending("nonexistent", doc, map, noRelay);
    expect(result.kind).toBe("not-found");
  });

  it("returns kind: 'not-pending' for an already-accepted annotation; rev unchanged", () => {
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, doc, "comment", rangeOf(0, 5, doc), "test");
    acceptPending(id, doc, map, noRelay); // first accept
    const acceptedRev = (map.get(id) as Annotation).rev;

    const result = acceptPending(id, doc, map, noRelay); // second accept attempt

    expect(result.kind).toBe("not-pending");
    if (result.kind !== "not-pending") throw new Error("unreachable");
    expect(result.currentStatus).toBe("accepted");
    expect(result.id).toBe(id);

    const after = map.get(id) as Annotation;
    expect(after.rev).toBe(acceptedRev); // unchanged
  });

  it("returns kind: 'not-pending' for an already-dismissed annotation", () => {
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, doc, "comment", rangeOf(0, 5, doc), "test");
    dismissPending(id, doc, map, noRelay);

    const result = acceptPending(id, doc, map, noRelay);
    expect(result.kind).toBe("not-pending");
    if (result.kind !== "not-pending") throw new Error("unreachable");
    expect(result.currentStatus).toBe("dismissed");
  });
});

describe("dismissPending", () => {
  it("returns kind: 'ok' for a pending annotation, transitions to dismissed", () => {
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, doc, "comment", rangeOf(0, 5, doc), "test");

    const result = dismissPending(id, doc, map, noRelay);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.data.status).toBe("dismissed");
  });

  it("returns kind: 'not-pending' for an already-resolved annotation", () => {
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, doc, "comment", rangeOf(0, 5, doc), "test");
    acceptPending(id, doc, map, noRelay);

    const result = dismissPending(id, doc, map, noRelay);
    expect(result.kind).toBe("not-pending");
  });

  it("returns kind: 'not-found' when the annotation doesn't exist", () => {
    // Accept had this arm covered and dismiss did not. The two share a body
    // today, which is exactly why the asymmetry was invisible — and why it
    // would stay invisible if the bodies ever diverged.
    const map = getAnnotationsMap(doc);

    expect(dismissPending("nonexistent", doc, map, noRelay)).toStrictEqual({
      kind: "not-found",
      id: "nonexistent",
    });
  });

  it("bumps the STORED rev", () => {
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, doc, "comment", rangeOf(0, 5, doc), "test");
    const before = map.get(id) as Annotation;

    dismissPending(id, doc, map, noRelay);

    expect((map.get(id) as Annotation).rev).toBeGreaterThan(before.rev ?? 0);
  });
});

describe("transactions are tagged with MCP_ORIGIN (channel-event skip)", () => {
  // ADR-031: catches a wrong-helper substitution (e.g. `withBrowser` for
  // `withMcp`) that the raw-`doc.transact` pre-commit hook cannot see.
  it.each([
    [
      "acceptPending",
      (id: string, d: Y.Doc, m: Y.Map<unknown>) => acceptPending(id, d, m, noRelay),
    ],
    [
      "dismissPending",
      (id: string, d: Y.Doc, m: Y.Map<unknown>) => dismissPending(id, d, m, noRelay),
    ],
  ])("%s fires under MCP_ORIGIN", (_label, op) => {
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, doc, "comment", rangeOf(0, 5, doc), "test");

    const origins: unknown[] = [];
    doc.on("beforeTransaction", (tr: Y.Transaction) => origins.push(tr.origin));

    op(id, doc, map);

    // The title claims a CHANNEL-EVENT SKIP, and `toContain("mcp")` cannot
    // establish it: a correct `withMcp` write plus a spurious `withBrowser`
    // echo contains "mcp" and emits the channel event anyway. So assert the
    // absence of any other origin, plus that something happened at all.
    //
    // Phrased that way rather than as `toStrictEqual([MCP_ORIGIN])` on purpose:
    // an exact-array pin also reds a refactor that splits the write into two
    // `withMcp` transactions, which emits no channel event and does not violate
    // this title. The invariant is "nothing but mcp", not "exactly one write".
    //
    // Sound with no `tr.changed` key filter only because the listener is
    // attached after `createAnnotation` and nothing else transacts here — do
    // NOT add one, since `changed` is empty on `beforeTransaction` and the
    // filter would silently assert over `[]`.
    expect(origins.filter((o) => o !== MCP_ORIGIN)).toStrictEqual([]);
    expect(origins.length, "and the write happened").toBeGreaterThan(0);
  });
});
