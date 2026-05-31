/**
 * AR5 promote-transform unit tests.
 *
 * Covers the privacy-critical note→comment promotion that surfaces an
 * annotation to Claude: `sendNoteToClaude` (single) and `promoteNotesToComments`
 * (batch), both built on the private `promotedAnnotation` transform. These had
 * ZERO coverage before this file (the transform that flips
 * import→user / note→comment / private→outbound was untested).
 *
 * We exercise the EXPORTED helpers and read the result back off the Y.Map, so
 * the test pins the real transform rather than a hand-written copy of its shape.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  promoteNotesToComments,
  sendNoteToClaude,
} from "../../src/client/panels/annotation-actions.js";
import { type SanitizationEvent, sanitizeAnnotation } from "../../src/shared/sanitize.js";
import type { Annotation } from "../../src/shared/types.js";
import { getAnnotationsMap, makeImportNote } from "../helpers/ydoc-factory.js";

function makeDocWithAnnotations(seed: Record<string, unknown>): {
  doc: Y.Doc;
  map: Y.Map<unknown>;
} {
  const doc = new Y.Doc();
  const map = getAnnotationsMap(doc);
  // Seed under an arbitrary (non-browser) origin — we are not testing channel
  // emission here, only the stored transform result.
  doc.transact(() => {
    for (const [id, ann] of Object.entries(seed)) map.set(id, ann);
  }, "seed");
  return { doc, map };
}

function readBack(map: Y.Map<unknown>, id: string): Annotation {
  return map.get(id) as Annotation;
}

describe("AR5 promote transform — sendNoteToClaude", () => {
  it("promotes an import-authored note to a Claude-visible comment", () => {
    const seed = makeImportNote({ id: "n1", rev: 3 });
    const { doc, map } = makeDocWithAnnotations({ n1: seed });
    sendNoteToClaude(doc, "n1");

    const result = readBack(map, "n1");
    expect(result.type).toBe("comment");
    expect(result.author).toBe("user"); // import → user (becomes the active user's intent)
    expect(result.audience).toBe("outbound");
    expect(result.promotedFrom).toBe("note");
    expect(result.rev).toBe((seed.rev ?? 0) + 1); // monotonic bump, relative to seed
    // Preserved identity/anchor/content.
    expect(result.id).toBe("n1");
    expect(result.content).toBe(seed.content);
    expect(result.range).toEqual({ from: 0, to: 5 });
    doc.destroy();
  });

  it("keeps author 'user' when promoting a user-authored note", () => {
    const { doc, map } = makeDocWithAnnotations({
      n1: makeImportNote({ id: "n1", author: "user", importSource: undefined }),
    });
    sendNoteToClaude(doc, "n1");
    expect(readBack(map, "n1").author).toBe("user");
    expect(readBack(map, "n1").type).toBe("comment");
    doc.destroy();
  });

  it("strips color and suggestedText when collapsing to the comment variant", () => {
    // A note shouldn't carry these, but the transform strips defensively — the
    // comment variant of the discriminated union rejects `color`.
    const { doc, map } = makeDocWithAnnotations({
      n1: makeImportNote({ id: "n1", color: "yellow", suggestedText: "nope" }),
    });
    sendNoteToClaude(doc, "n1");
    const result = readBack(map, "n1") as Annotation & { color?: unknown };
    expect(result.color).toBeUndefined();
    expect(result.suggestedText).toBeUndefined();
    doc.destroy();
  });

  it("produces a sanitize-stable comment (no audience-conflict-resolved downgrade)", () => {
    // ADR-027 defense: sanitize downgrades a note/highlight/flag that claims
    // outbound back to private and emits `audience-conflict-resolved`. A
    // correctly-promoted comment must NOT trip that guard.
    const { doc, map } = makeDocWithAnnotations({
      n1: makeImportNote({ id: "n1", author: "user", importSource: undefined }),
    });
    sendNoteToClaude(doc, "n1");

    const events: SanitizationEvent[] = [];
    const sanitized = sanitizeAnnotation(readBack(map, "n1"), (e) => events.push(e));
    expect(sanitized.audience).toBe("outbound");
    expect(events.filter((e) => e.kind === "audience-conflict-resolved")).toHaveLength(0);
    doc.destroy();
  });

  it("is a no-op on a non-note annotation", () => {
    const { doc, map } = makeDocWithAnnotations({
      c1: makeImportNote({
        id: "c1",
        type: "comment",
        author: "claude",
        audience: "outbound",
        rev: 2,
      }),
    });
    sendNoteToClaude(doc, "c1");
    const result = readBack(map, "c1");
    expect(result.author).toBe("claude");
    expect(result.rev).toBe(2); // untouched
    doc.destroy();
  });

  it("is a no-op for a missing id and a null doc", () => {
    const { doc, map } = makeDocWithAnnotations({ n1: makeImportNote({ id: "n1" }) });
    expect(() => sendNoteToClaude(doc, "does-not-exist")).not.toThrow();
    expect(readBack(map, "n1").type).toBe("note"); // unrelated entry untouched
    expect(() => sendNoteToClaude(null, "n1")).not.toThrow();
    doc.destroy();
  });
});

describe("AR5 promote transform — promoteNotesToComments (batch)", () => {
  it("promotes only the notes among a mixed selection and returns the count", () => {
    const { doc, map } = makeDocWithAnnotations({
      n1: makeImportNote({ id: "n1" }),
      n2: makeImportNote({ id: "n2", author: "user", importSource: undefined }),
      c1: makeImportNote({ id: "c1", type: "comment", author: "claude", audience: "outbound" }),
    });
    const count = promoteNotesToComments(doc, ["n1", "n2", "c1", "missing"]);
    expect(count).toBe(2);
    expect(readBack(map, "n1").type).toBe("comment");
    expect(readBack(map, "n1").author).toBe("user");
    expect(readBack(map, "n2").type).toBe("comment");
    expect(readBack(map, "c1").type).toBe("comment"); // already a comment, untouched
    expect(readBack(map, "c1").author).toBe("claude");
    doc.destroy();
  });

  it("returns 0 for an empty selection and for a null doc", () => {
    const { doc } = makeDocWithAnnotations({ n1: makeImportNote({ id: "n1" }) });
    expect(promoteNotesToComments(doc, [])).toBe(0);
    expect(promoteNotesToComments(null, ["n1"])).toBe(0);
    doc.destroy();
  });
});
