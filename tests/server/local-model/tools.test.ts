import { afterEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";
import { dispatch, TOOLS } from "../../../src/server/local-model/tools.js";
import { Y_MAP_ANNOTATION_REPLIES } from "../../../src/shared/constants.js";
import { MCP_ORIGIN } from "../../../src/shared/origins.js";
import type { Annotation } from "../../../src/shared/types.js";
import { getAnnotationsMap, makeMarkdownDoc } from "../../helpers/ydoc-factory.js";

const FIXTURE = `# Cost Summary

The budget is $500 for the first phase of the rollout.

The team agreed. We proceeded carefully. The team agreed once more before launch.
`;

let doc: Y.Doc | undefined;
afterEach(() => {
  doc?.destroy();
  doc = undefined;
});

/** Capture the origin of the last Y.Doc transaction (to assert withMcp tagging). */
function watchOrigin(d: Y.Doc): { last: () => unknown } {
  let last: unknown;
  d.on("afterTransaction", (txn) => {
    last = txn.origin;
  });
  return { last: () => last };
}

describe("local-model tool registry (ADR-027 lock)", () => {
  it("exposes exactly the read + write tools — and NO annotation-reading tool", () => {
    const names = TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "comment_on_quote",
        "get_outline",
        "propose_replacement",
        "read_section",
        "reply_to_annotation",
      ].sort(),
    );
    // ADR-027: notes/annotations are never exposed to the model. Guard against a
    // future "let the model read existing comments/notes" tool slipping in. The
    // one write tool that references annotations (reply_to_annotation) is a WRITE,
    // not a read, so the guard targets read verbs paired with annotation nouns.
    expect(
      TOOLS.some((t) => /^(get|list|read|view|fetch)_?(annotation|comment|note)/i.test(t.name)),
    ).toBe(false);
  });
});

describe("dispatch — annotation writes", () => {
  it("creates a comment via withMcp, correctly anchored and shaped", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const origin = watchOrigin(doc);
    const out = dispatch(
      "comment_on_quote",
      { quoted_text: "the first phase", comment: "tighten this" },
      { ydoc: doc },
    );
    expect(out.effect.kind).toBe("comment");
    expect((out.result as { ok?: boolean }).ok).toBe(true);
    expect(origin.last()).toBe(MCP_ORIGIN); // Critical Rule #2

    const map = getAnnotationsMap(doc);
    expect(map.size).toBe(1);
    const id = (out.result as { annotation_id: string }).annotation_id;
    const ann = map.get(id) as Annotation;
    expect(ann.type).toBe("comment");
    expect(ann.author).toBe("claude");
    expect(ann.status).toBe("pending");
    expect(ann.content).toBe("tighten this");
  });

  it("creates a replacement (comment carrying suggestedText)", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch(
      "propose_replacement",
      { quoted_text: "the first phase", suggested_text: "phase one", rationale: "shorter" },
      { ydoc: doc },
    );
    expect((out.result as { ok?: boolean }).ok).toBe(true);
    const id = (out.result as { annotation_id: string }).annotation_id;
    const ann = getAnnotationsMap(doc).get(id) as Annotation;
    expect(ann.type).toBe("comment");
    expect(ann.suggestedText).toBe("phase one");
  });

  it("returns ANCHOR_NOT_FOUND for a quote that isn't in the document", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch(
      "comment_on_quote",
      { quoted_text: "this phrase does not exist", comment: "x" },
      { ydoc: doc },
    );
    expect((out.result as { error?: string }).error).toBe("ANCHOR_NOT_FOUND");
    expect(getAnnotationsMap(doc).size).toBe(0);
  });

  it("returns HEADING_OVERLAP when the quote includes the heading marker", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch(
      "comment_on_quote",
      { quoted_text: "# Cost Summary", comment: "x" },
      { ydoc: doc },
    );
    expect((out.result as { error?: string }).error).toBe("HEADING_OVERLAP");
    expect(getAnnotationsMap(doc).size).toBe(0);
  });
});

describe("dispatch — M0 anchor hardening", () => {
  it("clamps a redundant occurrence_index to 1 ONLY when the quote is unique", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch(
      "comment_on_quote",
      { quoted_text: "the first phase", occurrence_index: 3, comment: "x" },
      { ydoc: doc },
    );
    expect((out.result as { ok?: boolean }).ok).toBe(true);
    // occurrence_index was clamped 3 -> 1 because the quote occurs exactly once.
    if (out.effect.kind === "comment") expect(out.effect.anchor.occurrence_index).toBe(1);
  });

  it("does NOT clamp a repeated quote — distinct occurrences stay distinct", () => {
    doc = makeMarkdownDoc(FIXTURE);
    // "The team agreed" occurs twice. occ=2 must resolve to the SECOND span,
    // proving the clamp never collapses two occurrences into one.
    const first = dispatch(
      "comment_on_quote",
      { quoted_text: "The team agreed", occurrence_index: 1, comment: "a" },
      { ydoc: doc },
    );
    const second = dispatch(
      "comment_on_quote",
      { quoted_text: "The team agreed", occurrence_index: 2, comment: "b" },
      { ydoc: doc },
    );
    expect((first.result as { ok?: boolean }).ok).toBe(true);
    expect((second.result as { ok?: boolean }).ok).toBe(true);
    if (first.effect.kind === "comment" && second.effect.kind === "comment") {
      expect(second.effect.anchor.occurrence_index).toBe(2); // unchanged, not clamped
      expect(second.effect.resolvedSpan?.from).toBeGreaterThan(
        first.effect.resolvedSpan?.from ?? 0,
      );
    }
    // An out-of-range occurrence on a repeated quote misses (no silent clamp).
    const over = dispatch(
      "comment_on_quote",
      { quoted_text: "The team agreed", occurrence_index: 5, comment: "c" },
      { ydoc: doc },
    );
    expect((over.result as { error?: string }).error).toBe("ANCHOR_NOT_FOUND");
    if (over.effect.kind === "comment") expect(over.effect.anchor.occurrence_index).toBe(5);
  });

  it("unescapes markdown-escaped quotes (e.g. \\$500 -> $500)", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch(
      "comment_on_quote",
      { quoted_text: "\\$500", comment: "pricing" },
      { ydoc: doc },
    );
    expect((out.result as { ok?: boolean }).ok).toBe(true);
  });

  // Regression: an empty quote + a non-integer occurrence_index would drive
  // findOccurrence into a synchronous, un-abortable infinite loop (#1123). This
  // test HANGS the runner on a regression; terminating with a clean miss is the
  // assertion. No annotation must be written.
  it("returns a miss for an empty quote (no hang) and writes nothing", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch(
      "comment_on_quote",
      { quoted_text: "", occurrence_index: 1.5, comment: "x" },
      { ydoc: doc },
    );
    expect((out.result as { error?: string }).error).toBe("ANCHOR_NOT_FOUND");
    expect(getAnnotationsMap(doc).size).toBe(0);
  });
});

describe("dispatch — reads", () => {
  it("reads a section by heading text", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch("read_section", { heading: "Cost Summary" }, { ydoc: doc });
    expect(out.effect.kind).toBe("read");
    expect((out.result as { text?: string }).text).toContain("The budget is $500");
  });

  it("returns SECTION_NOT_FOUND for an unknown heading", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch("read_section", { heading: "No Such Heading" }, { ydoc: doc });
    expect(out.effect.kind).toBe("read");
    expect((out.result as { error?: string }).error).toBe("SECTION_NOT_FOUND");
  });
});

describe("dispatch — replies", () => {
  it("replies to a pending comment via withMcp and returns a reply id", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const created = dispatch(
      "comment_on_quote",
      { quoted_text: "the first phase", comment: "needs detail" },
      { ydoc: doc },
    );
    const annotationId = (created.result as { annotation_id: string }).annotation_id;

    const origin = watchOrigin(doc);
    const out = dispatch(
      "reply_to_annotation",
      { annotation_id: annotationId, text: "here is the detail" },
      { ydoc: doc },
    );
    expect(out.effect.kind).toBe("reply");
    expect((out.result as { ok?: boolean }).ok).toBe(true);
    expect((out.result as { reply_id?: string }).reply_id).toBeDefined();
    expect(origin.last()).toBe(MCP_ORIGIN); // Critical Rule #2 — reply uses a distinct write path
  });

  it("surfaces a failure (no swallow) when replying to a non-existent id", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch(
      "reply_to_annotation",
      { annotation_id: "does-not-exist", text: "hi" },
      { ydoc: doc },
    );
    expect(out.effect.kind).toBe("reply");
    expect((out.result as { ok?: boolean }).ok).toBeUndefined();
    expect((out.result as { error?: string }).error).toBeDefined();
    if (out.effect.kind === "reply") expect(out.effect.ok).toBe(false);
  });
});

describe("dispatch — license gate", () => {
  it("blocks the mutating tools when restricted, without writing", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const restricted = () => true;
    for (const name of ["comment_on_quote", "propose_replacement", "reply_to_annotation"]) {
      const out = dispatch(
        name,
        {
          quoted_text: "the first phase",
          comment: "x",
          suggested_text: "y",
          annotation_id: "z",
          text: "t",
        },
        { ydoc: doc, isLicenseRestricted: restricted },
      );
      expect(out.effect.kind).toBe("blocked");
      expect((out.result as { error?: string }).error).toBe("LICENSE_REQUIRED");
    }
    expect(getAnnotationsMap(doc).size).toBe(0);
  });

  it("leaves reads open when restricted (escape hatch)", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch("get_outline", {}, { ydoc: doc, isLicenseRestricted: () => true });
    expect(out.effect.kind).toBe("read");
    expect((out.result as { outline?: unknown }).outline).toBeDefined();
  });

  it("allows mutating tools when not restricted", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch(
      "comment_on_quote",
      { quoted_text: "the first phase", comment: "x" },
      { ydoc: doc, isLicenseRestricted: () => false },
    );
    expect((out.result as { ok?: boolean }).ok).toBe(true);
  });
});

describe("dispatch — agent identity stamping (#1123 M3)", () => {
  const identity = { provider: "local-ollama" as const, displayName: "Qwen 2.5" };

  it("stamps agentIdentity on a comment when ctx carries one", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch(
      "comment_on_quote",
      { quoted_text: "the first phase", comment: "x" },
      { ydoc: doc, agentIdentity: identity },
    );
    const id = (out.result as { annotation_id: string }).annotation_id;
    const ann = getAnnotationsMap(doc).get(id) as Annotation;
    expect(ann.agentIdentity).toEqual(identity);
  });

  it("stamps agentIdentity on a replacement", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch(
      "propose_replacement",
      { quoted_text: "the first phase", suggested_text: "phase one", rationale: "shorter" },
      { ydoc: doc, agentIdentity: identity },
    );
    const id = (out.result as { annotation_id: string }).annotation_id;
    const ann = getAnnotationsMap(doc).get(id) as Annotation;
    expect(ann.agentIdentity).toEqual(identity);
    expect(ann.suggestedText).toBe("phase one");
  });

  it("stamps agentIdentity on a reply", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const created = dispatch(
      "comment_on_quote",
      { quoted_text: "the first phase", comment: "needs detail" },
      { ydoc: doc, agentIdentity: identity },
    );
    const annotationId = (created.result as { annotation_id: string }).annotation_id;
    const out = dispatch(
      "reply_to_annotation",
      { annotation_id: annotationId, text: "detail here" },
      { ydoc: doc, agentIdentity: identity },
    );
    const replyId = (out.result as { reply_id: string }).reply_id;
    const replies = doc.getMap(Y_MAP_ANNOTATION_REPLIES);
    const reply = replies.get(replyId) as { agentIdentity?: unknown };
    expect(reply.agentIdentity).toEqual(identity);
  });

  it("leaves agentIdentity absent when ctx has none (byte-identical to pre-M3 / MCP path)", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch(
      "comment_on_quote",
      { quoted_text: "the first phase", comment: "x" },
      { ydoc: doc },
    );
    const id = (out.result as { annotation_id: string }).annotation_id;
    const ann = getAnnotationsMap(doc).get(id) as Annotation;
    expect(ann.agentIdentity).toBeUndefined();
  });

  it("leaves agentIdentity absent on a replacement and a reply when ctx has none", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const repl = dispatch(
      "propose_replacement",
      { quoted_text: "the first phase", suggested_text: "phase one", rationale: "r" },
      { ydoc: doc },
    );
    const replId = (repl.result as { annotation_id: string }).annotation_id;
    expect((getAnnotationsMap(doc).get(replId) as Annotation).agentIdentity).toBeUndefined();

    const reply = dispatch(
      "reply_to_annotation",
      { annotation_id: replId, text: "t" },
      { ydoc: doc },
    );
    const replyId = (reply.result as { reply_id: string }).reply_id;
    const stored = doc.getMap(Y_MAP_ANNOTATION_REPLIES).get(replyId) as { agentIdentity?: unknown };
    expect(stored.agentIdentity).toBeUndefined();
  });
});

describe("dispatch — malformed input", () => {
  it("reports MALFORMED_ARGS when tool args failed to parse (null)", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch("comment_on_quote", null, { ydoc: doc });
    expect((out.result as { error?: string }).error).toBe("MALFORMED_ARGS");
  });
});
