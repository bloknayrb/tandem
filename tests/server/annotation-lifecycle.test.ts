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
import type { Annotation } from "../../src/shared/types.js";
import { getAnnotationsMap, makeDoc, rangeOf } from "../helpers/ydoc-factory.js";

let doc: Y.Doc;

beforeEach(() => {
  doc = makeDoc("Hello world");
});

describe("acceptPending", () => {
  it("returns kind: 'ok' for a pending annotation, transitions to accepted, bumps rev", () => {
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, doc, "comment", rangeOf(0, 5, doc), "test");
    const before = map.get(id) as Annotation;

    const result = acceptPending(id, doc, map);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.data.status).toBe("accepted");
    expect(result.data.rev).toBeGreaterThan(before.rev ?? 0);

    const after = map.get(id) as Annotation;
    expect(after.status).toBe("accepted");
  });

  it("returns kind: 'not-found' when the annotation doesn't exist", () => {
    const map = getAnnotationsMap(doc);
    const result = acceptPending("nonexistent", doc, map);
    expect(result.kind).toBe("not-found");
  });

  it("returns kind: 'not-pending' for an already-accepted annotation; rev unchanged", () => {
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, doc, "comment", rangeOf(0, 5, doc), "test");
    acceptPending(id, doc, map); // first accept
    const acceptedRev = (map.get(id) as Annotation).rev;

    const result = acceptPending(id, doc, map); // second accept attempt

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
    dismissPending(id, doc, map);

    const result = acceptPending(id, doc, map);
    expect(result.kind).toBe("not-pending");
    if (result.kind !== "not-pending") throw new Error("unreachable");
    expect(result.currentStatus).toBe("dismissed");
  });
});

describe("dismissPending", () => {
  it("returns kind: 'ok' for a pending annotation, transitions to dismissed", () => {
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, doc, "comment", rangeOf(0, 5, doc), "test");

    const result = dismissPending(id, doc, map);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.data.status).toBe("dismissed");
  });

  it("returns kind: 'not-pending' for an already-resolved annotation", () => {
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, doc, "comment", rangeOf(0, 5, doc), "test");
    acceptPending(id, doc, map);

    const result = dismissPending(id, doc, map);
    expect(result.kind).toBe("not-pending");
  });
});

describe("transactions are tagged with MCP_ORIGIN (channel-event skip)", () => {
  // ADR-031: catches a wrong-helper substitution (e.g. `withBrowser` for
  // `withMcp`) that the raw-`doc.transact` pre-commit hook cannot see.
  it.each([
    ["acceptPending", (id: string, d: Y.Doc, m: Y.Map<unknown>) => acceptPending(id, d, m)],
    ["dismissPending", (id: string, d: Y.Doc, m: Y.Map<unknown>) => dismissPending(id, d, m)],
  ])("%s fires under MCP_ORIGIN", (_label, op) => {
    const map = getAnnotationsMap(doc);
    const id = createAnnotation(map, doc, "comment", rangeOf(0, 5, doc), "test");

    const origins: unknown[] = [];
    doc.on("beforeTransaction", (tr: Y.Transaction) => origins.push(tr.origin));

    op(id, doc, map);

    expect(origins).toContain("mcp");
  });
});
