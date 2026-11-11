import { afterEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";
import {
  type DispatchCtx,
  dispatch,
  EDITING_OFF_MESSAGE,
  READ_TOOL_NAMES,
  READ_TOOLS,
  TOOLS,
} from "../../../src/server/local-model/tools.js";
import {
  Y_MAP_ANNOTATION_REPLIES,
  Y_MAP_ANNOTATIONS,
  Y_MAP_AUTHORSHIP,
} from "../../../src/shared/constants.js";
import { MCP_ORIGIN } from "../../../src/shared/origins.js";
import { SNAPSHOT_CAP } from "../../../src/shared/snapshot.js";
import type { Annotation } from "../../../src/shared/types.js";
import { getAnnotationsMap, makeMarkdownDoc } from "../../helpers/ydoc-factory.js";

/**
 * The tools that may write, derived: every registered tool that is not in the
 * source's own reading list. A NEW tool therefore counts as mutating until the
 * source lists it as a read, so the authorship tripwire and the editing-off
 * refusals below cover it by default.
 */
const MUTATING_TOOLS = TOOLS.filter((t) => !READ_TOOLS.includes(t)).map((t) => t.name);

/** The editing permission (#1123). Every pre-existing write-path test runs with
 *  it ON; the "editing off" blocks at the bottom are the ones that turn it off. */
const ON = (): boolean => true;
const OFF = (): boolean => false;

/**
 * Valid args per mutating tool, so each dispatch actually reaches its write
 * path. A NEW tool throws here until it gets real args: `MUTATING_TOOLS` is
 * derived, and a `{}` fallback would let it pass without ever writing.
 */
function argsFor(name: string, annotationId: string): Record<string, unknown> {
  switch (name) {
    case "comment_on_quote":
      return { quoted_text: "the first phase", comment: "note" };
    case "propose_replacement":
      return { quoted_text: "We proceeded carefully", suggested_text: "x", rationale: "y" };
    case "reply_to_annotation":
      return { annotation_id: annotationId, text: "reply body" };
    default:
      throw new Error(`argsFor: no args for mutating tool "${name}" — add a case`);
  }
}

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

// #1123 M4 tripwire. Per-agent AuthorshipRange color was EXCLUDED from M4 on the
// grounds that the loop writes zero authorship ranges (its edits are proposals,
// not body text; accepted text is attributed author:"user" client-side). This
// pins that premise by iterating the WHOLE mutating-tool set — so a future
// body-editing tool that stamps authorship is dispatched here and breaks the
// assertion, pointing straight back at the exclusion decision.
describe("dispatch — no mutating tool writes an authorship range (M4 (d) tripwire)", () => {
  it("every tool in MUTATING_TOOLS leaves the authorship map empty", () => {
    doc = makeMarkdownDoc(FIXTURE);
    // Seed one real annotation so reply_to_annotation has a valid target.
    const seed = dispatch(
      "comment_on_quote",
      { quoted_text: "The team agreed", comment: "seed" },
      { ydoc: doc, canEdit: ON },
    );
    const annotationId = (seed.result as { annotation_id?: string }).annotation_id ?? "";
    expect(MUTATING_TOOLS.length).toBeGreaterThan(0);
    for (const name of MUTATING_TOOLS) {
      const out = dispatch(name, argsFor(name, annotationId), { ydoc: doc, canEdit: ON });
      // Each really reached its write path: an ok effect, not an error result.
      expect(out.effect, name).toMatchObject({ ok: true });
    }
    expect(doc.getMap(Y_MAP_AUTHORSHIP).size).toBe(0);
  });
});

describe("dispatch — annotation writes", () => {
  it("creates a comment via withMcp, correctly anchored and shaped", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const origin = watchOrigin(doc);
    const out = dispatch(
      "comment_on_quote",
      { quoted_text: "the first phase", comment: "tighten this" },
      { ydoc: doc, canEdit: ON },
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
      { ydoc: doc, canEdit: ON },
    );
    expect((out.result as { ok?: boolean }).ok).toBe(true);
    const id = (out.result as { annotation_id: string }).annotation_id;
    const ann = getAnnotationsMap(doc).get(id) as Annotation;
    expect(ann.type).toBe("comment");
    expect(ann.suggestedText).toBe("phase one");
  });

  it("propose_replacement refuses a quote whose INTERIOR spans a heading prefix", () => {
    // The local-model twin of `tandem_comment`'s suggestion arm. A
    // `propose_replacement` stores `suggestedText`, and the editor accept and
    // the `.docx` apply both replace the stored flat span verbatim — so a quote
    // stepping over `"## "` deletes the heading, which is what #1766 closed for
    // `tandem_edit`. `resolveAnchor` now takes the kind as a REQUIRED parameter,
    // so the two arms cannot silently share a verdict.
    doc = makeMarkdownDoc("Intro para\n\n## Section\n\nBody text here\n");
    const quoted = "para\n## Section";
    const out = dispatch(
      "propose_replacement",
      { quoted_text: quoted, suggested_text: "X", rationale: "why" },
      { ydoc: doc, canEdit: ON },
    );
    expect((out.result as { error?: string }).error).toBe("HEADING_OVERLAP");
    expect(getAnnotationsMap(doc).size).toBe(0);
  });

  it("comment_on_quote still ACCEPTS that same quote — a comment writes no text", () => {
    // The discriminating negative, and the reason the interior term is an arm
    // rather than a widening of `rejectHeadingOverlap`. A comment spanning a
    // section is legal, and "target the text content only" is not advice its
    // author can follow when the target IS two blocks and the heading between
    // them. Same document, same quote, same resolver — only the kind differs.
    doc = makeMarkdownDoc("Intro para\n\n## Section\n\nBody text here\n");
    const out = dispatch(
      "comment_on_quote",
      { quoted_text: "para\n## Section", comment: "on the whole section" },
      { ydoc: doc, canEdit: ON },
    );
    expect((out.result as { ok?: boolean }).ok).toBe(true);
    expect(getAnnotationsMap(doc).size).toBe(1);
  });

  it("returns ANCHOR_NOT_FOUND for a quote that isn't in the document", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch(
      "comment_on_quote",
      { quoted_text: "this phrase does not exist", comment: "x" },
      { ydoc: doc, canEdit: ON },
    );
    expect((out.result as { error?: string }).error).toBe("ANCHOR_NOT_FOUND");
    expect(getAnnotationsMap(doc).size).toBe(0);
  });

  it("returns HEADING_OVERLAP when the quote includes the heading marker", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch(
      "comment_on_quote",
      { quoted_text: "# Cost Summary", comment: "x" },
      { ydoc: doc, canEdit: ON },
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
      { ydoc: doc, canEdit: ON },
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
      { ydoc: doc, canEdit: ON },
    );
    const second = dispatch(
      "comment_on_quote",
      { quoted_text: "The team agreed", occurrence_index: 2, comment: "b" },
      { ydoc: doc, canEdit: ON },
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
      { ydoc: doc, canEdit: ON },
    );
    expect((over.result as { error?: string }).error).toBe("ANCHOR_NOT_FOUND");
    if (over.effect.kind === "comment") expect(over.effect.anchor.occurrence_index).toBe(5);
  });

  it("unescapes markdown-escaped quotes (e.g. \\$500 -> $500)", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch(
      "comment_on_quote",
      { quoted_text: "\\$500", comment: "pricing" },
      { ydoc: doc, canEdit: ON },
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
      { ydoc: doc, canEdit: ON },
    );
    expect((out.result as { error?: string }).error).toBe("ANCHOR_NOT_FOUND");
    expect(getAnnotationsMap(doc).size).toBe(0);
  });
});

describe("dispatch — reads", () => {
  it("reads a section by heading text", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch("read_section", { heading: "Cost Summary" }, { ydoc: doc, canEdit: ON });
    expect(out.effect.kind).toBe("read");
    expect((out.result as { text?: string }).text).toContain("The budget is $500");
  });

  it("returns SECTION_NOT_FOUND for an unknown heading", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch(
      "read_section",
      { heading: "No Such Heading" },
      { ydoc: doc, canEdit: ON },
    );
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
      { ydoc: doc, canEdit: ON },
    );
    const annotationId = (created.result as { annotation_id: string }).annotation_id;

    const origin = watchOrigin(doc);
    const out = dispatch(
      "reply_to_annotation",
      { annotation_id: annotationId, text: "here is the detail" },
      { ydoc: doc, canEdit: ON },
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
      { ydoc: doc, canEdit: ON },
    );
    expect(out.effect.kind).toBe("reply");
    expect((out.result as { ok?: boolean }).ok).toBeUndefined();
    // The CODE, not merely that some error exists. `toBeDefined()` passes for a
    // branch that calls `describeReplyWriteRefusal` and then discards it in
    // favour of a constant — and the seam census only requires the call to
    // APPEAR in the file, so nothing else was covering the wiring.
    expect((out.result as { error?: string }).error).toBe("NOT_FOUND");
    if (out.effect.kind === "reply") {
      expect(out.effect.ok).toBe(false);
      expect(out.effect.errorCode).toBe("NOT_FOUND");
    }
  });

  it("carries the ADR-027 guard for the local model, not just for Claude", () => {
    // ADR-035 Unit 8f routed this branch through `AnnotationLifecycle.reply`,
    // and the docblock claims the guard "covers the local model exactly as it
    // covers Claude". Before this spec that claim had no driver — the loop's
    // pre-8f call passed a literal `"claude"` to the free helper, so the
    // behaviour is unchanged, but an unasserted claim is the kind that gets read
    // as verified. `BYO_MODELS_ENABLED` is false, so this is the only thing
    // standing between the prose and a regression.
    doc = makeMarkdownDoc(FIXTURE);
    const map = getAnnotationsMap(doc);
    const created = dispatch(
      "comment_on_quote",
      { quoted_text: "the first phase", comment: "needs detail" },
      { ydoc: doc, canEdit: ON },
    );
    const annotationId = (created.result as { annotation_id: string }).annotation_id;
    map.set(annotationId, { ...(map.get(annotationId) as Annotation), type: "note" });

    const out = dispatch(
      "reply_to_annotation",
      { annotation_id: annotationId, text: "into a private thread" },
      { ydoc: doc, canEdit: ON },
    );
    expect((out.result as { error?: string }).error).toBe("INVALID_ARGUMENT");
    expect(doc.getMap(Y_MAP_ANNOTATION_REPLIES).size).toBe(0);
  });
});

describe("dispatch — replies to a user-authored comment (#2216)", () => {
  it("refuses NOT_OWNED with a remedy that names a local tool, not an MCP one", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const map = getAnnotationsMap(doc);
    const created = dispatch(
      "comment_on_quote",
      { quoted_text: "the first phase", comment: "needs detail" },
      { ydoc: doc, canEdit: ON },
    );
    const annotationId = (created.result as { annotation_id: string }).annotation_id;
    map.set(annotationId, { ...(map.get(annotationId) as Annotation), author: "user" });

    const out = dispatch(
      "reply_to_annotation",
      { annotation_id: annotationId, text: "answering the user" },
      { ydoc: doc, canEdit: ON },
    );
    const result = out.result as { error?: string; message?: string };
    expect(result.error).toBe("NOT_OWNED");
    expect(result.message).not.toMatch(/tandem_/);
    expect(result.message).toContain("comment_on_quote");
    expect(out.effect.kind).toBe("reply");
    if (out.effect.kind === "reply") {
      expect(out.effect.ok).toBe(false);
      expect(out.effect.errorCode).toBe("NOT_OWNED");
    }
  });
});

describe("dispatch — agent identity stamping (#1123 M3)", () => {
  const identity = { provider: "local-ollama" as const, displayName: "Qwen 2.5" };

  it("stamps agentIdentity on a comment when ctx carries one", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch(
      "comment_on_quote",
      { quoted_text: "the first phase", comment: "x" },
      { ydoc: doc, agentIdentity: identity, canEdit: ON },
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
      { ydoc: doc, agentIdentity: identity, canEdit: ON },
    );
    const id = (out.result as { annotation_id: string }).annotation_id;
    const ann = getAnnotationsMap(doc).get(id) as Annotation;
    expect(ann.agentIdentity).toEqual(identity);
    expect(ann.suggestedText).toBe("phase one");
  });

  it("captures a textSnapshot, like the MCP path (#1486)", () => {
    // This path used to store none at all. Undo is gated on the snapshot being
    // a string, so with it absent the whole revert block was skipped, the
    // annotation flipped to `pending`, and Undo reported SUCCESS while the
    // replacement text stayed in the document. A decline is a designed
    // outcome; a silent no-op that claims to have worked is not.
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch(
      "propose_replacement",
      { quoted_text: "the first phase", suggested_text: "phase one", rationale: "shorter" },
      { ydoc: doc, canEdit: ON },
    );
    const id = (out.result as { annotation_id: string }).annotation_id;
    const ann = getAnnotationsMap(doc).get(id) as Annotation;
    expect(ann.textSnapshot).toBe("the first phase");
    // Short range — the cut flag stays off, so undo still works normally.
    expect(ann.textSnapshotTruncated).toBeUndefined();
  });

  it("flags the snapshot when the quoted range exceeds the cap (#1486)", () => {
    const long = Array.from({ length: 30 }, (_, i) => `clause ${i} distinct.`).join(" ");
    doc = makeMarkdownDoc(`${long}\n`);
    const out = dispatch(
      "propose_replacement",
      { quoted_text: long, suggested_text: "shorter", rationale: "trim" },
      { ydoc: doc, canEdit: ON },
    );
    const id = (out.result as { annotation_id: string }).annotation_id;
    const ann = getAnnotationsMap(doc).get(id) as Annotation;
    expect(ann.textSnapshot).toHaveLength(SNAPSHOT_CAP);
    expect(ann.textSnapshotTruncated).toBe(true);
  });

  it("stamps agentIdentity on a reply", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const created = dispatch(
      "comment_on_quote",
      { quoted_text: "the first phase", comment: "needs detail" },
      { ydoc: doc, agentIdentity: identity, canEdit: ON },
    );
    const annotationId = (created.result as { annotation_id: string }).annotation_id;
    const out = dispatch(
      "reply_to_annotation",
      { annotation_id: annotationId, text: "detail here" },
      { ydoc: doc, agentIdentity: identity, canEdit: ON },
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
      { ydoc: doc, canEdit: ON },
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
      { ydoc: doc, canEdit: ON },
    );
    const replId = (repl.result as { annotation_id: string }).annotation_id;
    expect((getAnnotationsMap(doc).get(replId) as Annotation).agentIdentity).toBeUndefined();

    const reply = dispatch(
      "reply_to_annotation",
      { annotation_id: replId, text: "t" },
      { ydoc: doc, canEdit: ON },
    );
    const replyId = (reply.result as { reply_id: string }).reply_id;
    const stored = doc.getMap(Y_MAP_ANNOTATION_REPLIES).get(replyId) as { agentIdentity?: unknown };
    expect(stored.agentIdentity).toBeUndefined();
  });
});

describe("dispatch — malformed input", () => {
  it("reports MALFORMED_ARGS when tool args failed to parse (null)", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch("comment_on_quote", null, { ydoc: doc, canEdit: ON });
    expect((out.result as { error?: string }).error).toBe("MALFORMED_ARGS");
  });
});

describe("dispatch — the document changed under the run (#2070)", () => {
  const ARGS: Record<string, Record<string, unknown>> = {
    comment_on_quote: { quoted_text: "The team agreed", comment: "c" },
    propose_replacement: {
      quoted_text: "The team agreed",
      suggested_text: "Everyone agreed",
      rationale: "r",
    },
    reply_to_annotation: { annotation_id: "ann_x", text: "t" },
  };

  it("covers every mutating tool", () => {
    // A new write tool must join the refusal; this fails until it is listed.
    expect(Object.keys(ARGS).sort()).toEqual([...MUTATING_TOOLS].sort());
  });

  for (const name of Object.keys(ARGS)) {
    it(`${name} refuses with DOCUMENT_CHANGED and writes nothing`, () => {
      doc = makeMarkdownDoc(FIXTURE);
      let writes = 0;
      doc.on("afterTransaction", () => writes++);
      const out = dispatch(name, ARGS[name], { ydoc: doc, isDocCurrent: () => false, canEdit: ON });
      expect((out.result as { error?: string }).error).toBe("DOCUMENT_CHANGED");
      expect(out.effect).toMatchObject({ ok: false, errorCode: "DOCUMENT_CHANGED" });
      expect(writes, "no Y.Doc transaction at all").toBe(0);
      expect(getAnnotationsMap(doc).size).toBe(0);
    });
  }

  it("still writes when the predicate says current", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch("comment_on_quote", ARGS.comment_on_quote, {
      ydoc: doc,
      isDocCurrent: () => true,
      canEdit: ON,
    });
    expect(out.effect).toMatchObject({ kind: "comment", ok: true });
  });

  it("leaves the read tools open — they read the live document by construction", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch("get_outline", {}, { ydoc: doc, isDocCurrent: () => false, canEdit: ON });
    expect(out.effect).toEqual({ kind: "read" });
    expect((out.result as { error?: string }).error).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1123 R2: chat-only by default. `dispatch` is the one route by which model
// output reaches a document, so these drive it directly with forged calls.
// ─────────────────────────────────────────────────────────────────────────────

/** A document holding one real annotation with one real reply, both written
 *  with editing on — so "nothing was created" is measured against a non-empty
 *  store, and a forged reply has a thread it could really land in. */
function seededDoc(): { ydoc: Y.Doc; annotationId: string } {
  doc = makeMarkdownDoc(FIXTURE);
  const seed = dispatch(
    "comment_on_quote",
    { quoted_text: "The team agreed", comment: "seed" },
    { ydoc: doc, canEdit: ON },
  );
  const annotationId = (seed.result as { annotation_id: string }).annotation_id;
  const reply = dispatch(
    "reply_to_annotation",
    { annotation_id: annotationId, text: "seed reply" },
    { ydoc: doc, canEdit: ON },
  );
  expect(reply.effect).toMatchObject({ kind: "reply", ok: true });
  return { ydoc: doc, annotationId };
}

/** Everything a writing tool could touch, by value. The annotations key comes
 *  from the shared constants (Critical Rule 1); replies live in their own map. */
function stored(ydoc: Y.Doc): { annotations: unknown; replies: unknown; authorship: unknown } {
  return {
    annotations: ydoc.getMap(Y_MAP_ANNOTATIONS).toJSON(),
    replies: ydoc.getMap(Y_MAP_ANNOTATION_REPLIES).toJSON(),
    authorship: ydoc.getMap(Y_MAP_AUTHORSHIP).toJSON(),
  };
}

function countTransactions(ydoc: Y.Doc): () => number {
  let n = 0;
  ydoc.on("afterTransaction", () => n++);
  return () => n;
}

/** Collapse a writing-tool mention to a yes/no, for the "names no writing tool"
 *  checks. Derived, so a writing tool added later is looked for too. */
function namedWritingTools(text: string): string[] {
  return MUTATING_TOOLS.filter((n) => text.includes(n));
}

describe("READ_TOOLS — the chat-tier allowlist (#1123 R2.2)", () => {
  it("is exactly the tools named in READ_TOOL_NAMES", () => {
    expect(READ_TOOLS.map((t) => t.name).sort()).toEqual([...READ_TOOL_NAMES].sort());
    // Every entry is the registered schema itself, not a look-alike.
    for (const t of READ_TOOLS) expect(TOOLS, t.name).toContain(t);
    // No name on the allowlist that is not a registered tool.
    for (const n of READ_TOOL_NAMES) {
      expect(
        TOOLS.some((t) => t.name === n),
        n,
      ).toBe(true);
    }
  });

  it("is a STRICT subset of TOOLS — there is something left to refuse", () => {
    expect(READ_TOOLS.length).toBeGreaterThan(0);
    expect(READ_TOOLS.length).toBeLessThan(TOOLS.length);
    expect(MUTATING_TOOLS.length).toBe(TOOLS.length - READ_TOOLS.length);
    expect(MUTATING_TOOLS.length).toBeGreaterThan(0);
  });

  it("names only the two reading tools — widening it is a permission change", () => {
    // Hand-written on purpose, unlike the refused set: a writing tool added to
    // the allowlist would pass every derived test in this file.
    expect([...READ_TOOL_NAMES].sort()).toEqual(["get_outline", "read_section"]);
  });
});

describe("dispatch — editing off refuses every writing tool (#1123 R2.2)", () => {
  for (const name of MUTATING_TOOLS) {
    it(`${name}: a forged, well-formed call is refused EDITING_OFF and creates nothing`, () => {
      const { ydoc, annotationId } = seededDoc();
      const before = stored(ydoc);
      const transactions = countTransactions(ydoc);

      const out = dispatch(name, argsFor(name, annotationId), { ydoc, canEdit: OFF });

      expect(out.effect).toEqual({ kind: "refused", tool: name, errorCode: "EDITING_OFF" });
      expect(out.result).toEqual({ error: "EDITING_OFF", message: EDITING_OFF_MESSAGE });
      expect(transactions(), "no Y.Doc transaction at all").toBe(0);
      // Deep-unchanged: no new annotation, no change to the existing one, and no
      // reply added to its thread.
      expect(stored(ydoc)).toEqual(before);

      // Control: the very same call is a real write once editing is on, so the
      // refusal above was the permission and not a malformed forgery.
      const allowed = dispatch(name, argsFor(name, annotationId), { ydoc, canEdit: ON });
      expect(allowed.effect, "same args with editing on").toMatchObject({ ok: true });
      expect(stored(ydoc)).not.toEqual(before);
    });
  }

  it("the refusal tells the model editing is off and to answer in plain text", () => {
    expect(EDITING_OFF_MESSAGE).toMatch(/switched off/i);
    expect(EDITING_OFF_MESSAGE).toMatch(/nothing was written/i);
    expect(EDITING_OFF_MESSAGE).toMatch(/do not call this tool again/i);
    expect(EDITING_OFF_MESSAGE).toMatch(/plain text/i);
  });

  it("is read on every dispatch — off, then on, then off again", () => {
    const { ydoc, annotationId } = seededDoc();
    let editing = false;
    const ctx: DispatchCtx = { ydoc, canEdit: () => editing };
    const name = "comment_on_quote";

    expect(dispatch(name, argsFor(name, annotationId), ctx).effect.kind).toBe("refused");
    editing = true;
    expect(dispatch(name, argsFor(name, annotationId), ctx).effect).toMatchObject({ ok: true });
    editing = false;
    const before = stored(ydoc);
    expect(dispatch(name, argsFor(name, annotationId), ctx).effect.kind).toBe("refused");
    expect(stored(ydoc)).toEqual(before);
  });

  it("refuses before the arguments are looked at (null args are EDITING_OFF, not MALFORMED_ARGS)", () => {
    const { ydoc } = seededDoc();
    for (const name of MUTATING_TOOLS) {
      const out = dispatch(name, null, { ydoc, canEdit: OFF });
      expect(out.effect, name).toEqual({ kind: "refused", tool: name, errorCode: "EDITING_OFF" });
    }
  });
});

describe("dispatch — a name that is not a tool (#1123 R2.2)", () => {
  const NOT_A_TOOL = "append_paragraph";
  // Shaped like a write on purpose: a quote that exists, a real thread id.
  const forged = (annotationId: string): Record<string, unknown> => ({
    quoted_text: "the first phase",
    comment: "forged",
    suggested_text: "forged",
    annotation_id: annotationId,
    text: "forged",
  });

  it("is really not in TOOLS", () => {
    expect(TOOLS.some((t) => t.name === NOT_A_TOOL)).toBe(false);
  });

  it("creates nothing with editing off, and is UNKNOWN_TOOL", () => {
    const { ydoc, annotationId } = seededDoc();
    const before = stored(ydoc);
    const transactions = countTransactions(ydoc);

    const out = dispatch(NOT_A_TOOL, forged(annotationId), { ydoc, canEdit: OFF });

    expect(out.effect).toEqual({ kind: "refused", tool: NOT_A_TOOL, errorCode: "UNKNOWN_TOOL" });
    expect((out.result as { error?: string }).error).toBe("UNKNOWN_TOOL");
    expect(transactions()).toBe(0);
    expect(stored(ydoc)).toEqual(before);
  });

  it("still creates nothing with editing on", () => {
    const { ydoc, annotationId } = seededDoc();
    const before = stored(ydoc);
    const transactions = countTransactions(ydoc);

    const out = dispatch(NOT_A_TOOL, forged(annotationId), { ydoc, canEdit: ON });

    expect((out.result as { error?: string }).error).toBe("UNKNOWN_TOOL");
    expect((out.result as { ok?: boolean }).ok).toBeUndefined();
    expect(transactions()).toBe(0);
    expect(stored(ydoc)).toEqual(before);
  });
});

describe("dispatch — the editing permission fails closed (#1123 R2.3)", () => {
  // Each of these is what a forgetful or non-TypeScript caller could hand over.
  // Only a FUNCTION returning exactly `true` may write.
  const BROKEN: [label: string, patch: Record<string, unknown>][] = [
    ["canEdit omitted", {}],
    ["canEdit: undefined", { canEdit: undefined }],
    ["canEdit: null", { canEdit: null }],
    ["canEdit: true (a boolean, not a function)", { canEdit: true }],
    ['canEdit: "yes" (a string)', { canEdit: "yes" }],
    ["canEdit returning 1", { canEdit: () => 1 }],
    ['canEdit returning "yes"', { canEdit: () => "yes" }],
    ["canEdit returning {}", { canEdit: () => ({}) }],
    ["canEdit returning undefined", { canEdit: () => undefined }],
  ];

  for (const [label, patch] of BROKEN) {
    it(`${label}: no writing tool writes`, () => {
      const { ydoc, annotationId } = seededDoc();
      const before = stored(ydoc);
      const transactions = countTransactions(ydoc);
      const ctx = { ydoc, ...patch } as unknown as DispatchCtx;

      for (const name of MUTATING_TOOLS) {
        const out = dispatch(name, argsFor(name, annotationId), ctx);
        expect(out.effect, name).toEqual({
          kind: "refused",
          tool: name,
          errorCode: "EDITING_OFF",
        });
      }
      expect(transactions()).toBe(0);
      expect(stored(ydoc)).toEqual(before);
    });
  }

  it("the reading tools still work for a caller that omitted the permission", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch("get_outline", {}, { ydoc: doc } as unknown as DispatchCtx);
    expect(out.effect).toEqual({ kind: "read" });
    expect((out.result as { error?: string }).error).toBeUndefined();
  });
});

describe("dispatch — the reading tools work with editing off (#1123 R2.2)", () => {
  it("covers every reading tool", () => {
    // A reading tool added later must get a case below.
    expect([...READ_TOOL_NAMES].sort()).toEqual(["get_outline", "read_section"]);
  });

  it("get_outline lists the headings", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch("get_outline", {}, { ydoc: doc, canEdit: OFF });
    expect(out.effect).toEqual({ kind: "read" });
    expect((out.result as { error?: string }).error).toBeUndefined();
    expect(JSON.stringify((out.result as { outline: unknown }).outline)).toContain("Cost Summary");
  });

  it("read_section returns the section text", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch("read_section", { heading: "Cost Summary" }, { ydoc: doc, canEdit: OFF });
    expect(out.effect).toEqual({ kind: "read" });
    expect((out.result as { text?: string }).text).toContain("The budget is $500");
  });
});

describe("dispatch — refusal text names no writing tool (#1123 R2.6)", () => {
  it("EDITING_OFF_MESSAGE names none", () => {
    expect(namedWritingTools(EDITING_OFF_MESSAGE)).toEqual([]);
  });

  it("the unknown-tool message names none, with editing off or on", () => {
    doc = makeMarkdownDoc(FIXTURE);
    for (const canEdit of [OFF, ON]) {
      const out = dispatch("append_paragraph", {}, { ydoc: doc, canEdit });
      const message = (out.result as { message: string }).message;
      expect(message).toContain("append_paragraph");
      expect(namedWritingTools(message)).toEqual([]);
    }
  });

  it("a chat-tier model that calls a writing tool by name is not told the others exist", () => {
    doc = makeMarkdownDoc(FIXTURE);
    for (const name of MUTATING_TOOLS) {
      const out = dispatch(name, {}, { ydoc: doc, canEdit: OFF });
      expect(namedWritingTools(JSON.stringify(out.result)), name).toEqual([]);
    }
  });
});

describe("dispatch — a write result says it proposed, not that it changed the document (#1123 R3)", () => {
  it("propose_replacement: a suggestion awaiting the user's accept or reject; text unchanged", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch(
      "propose_replacement",
      { quoted_text: "the first phase", suggested_text: "phase one", rationale: "shorter" },
      { ydoc: doc, canEdit: ON },
    );
    const result = out.result as {
      ok: boolean;
      annotation_id: string;
      status: string;
      note: string;
    };
    expect(Object.keys(result).sort()).toEqual(["annotation_id", "note", "ok", "status"]);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("proposed");
    expect(result.note).toMatch(/suggestion/i);
    expect(result.note).toMatch(/waiting for the user/i);
    expect(result.note).toMatch(/accept/i);
    expect(result.note).toMatch(/reject/i);
    expect(result.note).toMatch(/document text has not been changed/i);
    // R3.3: the id is still there, and it is the stored record's.
    expect(getAnnotationsMap(doc).has(result.annotation_id)).toBe(true);
  });

  it("comment_on_quote: says the document was not changed, and carries the id", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const out = dispatch(
      "comment_on_quote",
      { quoted_text: "the first phase", comment: "tighten" },
      { ydoc: doc, canEdit: ON },
    );
    const result = out.result as { ok: boolean; annotation_id: string; note: string };
    expect(Object.keys(result).sort()).toEqual(["annotation_id", "note", "ok"]);
    expect(result.ok).toBe(true);
    expect(result.note).toMatch(/document text has not been changed/i);
    expect(getAnnotationsMap(doc).has(result.annotation_id)).toBe(true);
  });

  it("reply_to_annotation: a reply using the id a create returned succeeds, and says the document was not changed", () => {
    doc = makeMarkdownDoc(FIXTURE);
    for (const [create, args] of [
      ["comment_on_quote", { quoted_text: "the first phase", comment: "c" }],
      ["propose_replacement", { quoted_text: "We proceeded carefully", suggested_text: "s" }],
    ] as const) {
      const created = dispatch(create, args, { ydoc: doc, canEdit: ON });
      const annotationId = (created.result as { annotation_id: string }).annotation_id;

      const out = dispatch(
        "reply_to_annotation",
        { annotation_id: annotationId, text: "more detail" },
        { ydoc: doc, canEdit: ON },
      );
      const result = out.result as { ok: boolean; reply_id: string; note: string };
      expect(Object.keys(result).sort(), create).toEqual(["note", "ok", "reply_id"]);
      expect(result.ok).toBe(true);
      expect(result.note).toMatch(/document text has not been changed/i);
      const reply = doc.getMap(Y_MAP_ANNOTATION_REPLIES).get(result.reply_id) as {
        annotationId?: string;
      };
      expect(reply.annotationId, create).toBe(annotationId);
    }
  });

  it("no success note claims a change was made", () => {
    doc = makeMarkdownDoc(FIXTURE);
    const created = dispatch(
      "comment_on_quote",
      { quoted_text: "The team agreed", comment: "seed" },
      { ydoc: doc, canEdit: ON },
    );
    const annotationId = (created.result as { annotation_id: string }).annotation_id;
    for (const name of MUTATING_TOOLS) {
      const out = dispatch(name, argsFor(name, annotationId), { ydoc: doc, canEdit: ON });
      const note = (out.result as { note?: string }).note;
      expect(note, name).toEqual(expect.any(String));
      expect(note, name).toMatch(/not been changed/i);
      expect(note, name).not.toMatch(/has been (made|applied|replaced)|is now (in|part of)/i);
    }
  });
});
