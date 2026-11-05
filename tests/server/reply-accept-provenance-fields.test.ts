import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseAnnotationDoc } from "../../src/server/annotations/schema.js";
import { getAnnotationsOutputShape } from "../../src/server/mcp/output-schemas.js";
import { sanitizeAnnotation } from "../../src/shared/sanitize.js";
import type { Annotation } from "../../src/shared/types.js";

/**
 * #2360: a reply accept stores `acceptedReplyId` and `priorSuggestedText` on the
 * parent so Undo can give it back its own proposal (or none). Three seams can
 * drop them silently, and each is pinned here:
 *
 *  - `sanitizeAnnotation`'s strict allowlist — undo reads the SANITIZED record;
 *  - the durable envelope — `null` (the parent had no proposal) must validate,
 *    or a reload rejects the record;
 *  - the MCP output schema, which parses `tandem_getAnnotations` strictly.
 */

const record = {
  id: "ann-u",
  author: "user",
  type: "comment",
  audience: "outbound",
  range: { from: 0, to: 5 },
  content: "can this be better?",
  status: "accepted",
  timestamp: 1,
  suggestedText: "earth",
};

const sanitize = (extras: object) =>
  sanitizeAnnotation({ ...record, ...extras } as unknown as Annotation, () => {});

describe("sanitizeAnnotation keeps reply-accept provenance", () => {
  it("keeps both fields, including the null marker", () => {
    const out = sanitize({ acceptedReplyId: "rpl-1", priorSuggestedText: null });
    expect(out.acceptedReplyId).toBe("rpl-1");
    expect(out.priorSuggestedText).toBeNull();
    expect(
      sanitize({ acceptedReplyId: "rpl-1", priorSuggestedText: "mine" }).priorSuggestedText,
    ).toBe("mine");
  });

  it("drops malformed values and adds nothing when absent", () => {
    const out = sanitize({ acceptedReplyId: 7, priorSuggestedText: 3 });
    expect("acceptedReplyId" in out).toBe(false);
    expect("priorSuggestedText" in out).toBe(false);
    expect("priorSuggestedText" in sanitize({})).toBe(false);
  });
});

describe("the durable envelope accepts the provenance", () => {
  it("round-trips priorSuggestedText: null", () => {
    const doc = {
      schemaVersion: 1,
      docHash: "sha256:deadbeef",
      meta: { filePath: "/doc.md", lastUpdated: 1 },
      annotations: [{ ...record, rev: 1, acceptedReplyId: "rpl-1", priorSuggestedText: null }],
      tombstones: [],
      replies: [],
    };
    const parsed = parseAnnotationDoc(JSON.parse(JSON.stringify(doc)));
    if (!parsed.ok) throw new Error(`expected success, got ${parsed.error}`);
    const ann = parsed.doc.annotations[0] as Record<string, unknown>;
    expect(ann.acceptedReplyId).toBe("rpl-1");
    expect(ann.priorSuggestedText).toBeNull();
  });
});

describe("the MCP output schema declares the provenance", () => {
  it("parses both fields through tandem_getAnnotations' output shape", () => {
    // zod strips undeclared keys, so an undeclared field parses to absent.
    const ann = {
      ...sanitize({ acceptedReplyId: "rpl-1", priorSuggestedText: null }),
      replies: [],
    };
    const parsed = z.object(getAnnotationsOutputShape).parse({ annotations: [ann], count: 1 });
    const out = parsed.annotations[0] as Record<string, unknown>;
    expect(out.acceptedReplyId).toBe("rpl-1");
    expect(out.priorSuggestedText).toBeNull();
  });
});
