/**
 * Quote-anchored tool registry + dispatch for the #1123 M0 spike.
 *
 * The model NEVER sees or emits character offsets. Every mutating tool takes
 * (quoted_text, occurrence_index); the harness resolves to a range server-side
 * via findOccurrence — the same function used as the scoring oracle, so model
 * output and gold span are resolved by identical code.
 *
 * dispatch path:  findOccurrence -> anchoredRange({rejectHeadingOverlap}) ->
 *                 createAnnotation / addReplyToAnnotation  (wrapped in withMcp)
 * Anchor/validation failures are returned to the model as structured tool
 * errors so it can retry with a tighter quote — exercising the real recovery
 * loop an MCP client would get.
 */
import type * as Y from "yjs";

import { findOccurrence } from "../../src/server/mcp/navigation.js";
import { createAnnotation, addReplyToAnnotation } from "../../src/server/mcp/annotations.js";
import { anchoredRange } from "../../src/server/positions.js";
import { extractText } from "../../src/server/mcp/document-model.js";
import { getOutline, getSection } from "../../src/server/mcp/document.js";
import { withMcp } from "../../src/shared/origins.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";

import type { ToolSchema } from "./ollama.js";

export interface DispatchCtx {
  ydoc: Y.Doc;
}

export interface ToolOutcome {
  /** JSON-serializable result handed back to the model as the tool message */
  result: unknown;
  /** structured record for the trial log */
  effect:
    | { kind: "read" }
    | {
        kind: "comment" | "replacement";
        ok: boolean;
        annotationId?: string;
        anchor: { quoted_text: string; occurrence_index: number };
        resolvedSpan?: { from: number; to: number };
        fullyAnchored?: boolean;
        errorCode?: string;
      }
    | { kind: "reply"; ok: boolean; annotationId: string; replyId?: string; errorCode?: string };
}

export const TOOLS: ToolSchema[] = [
  {
    name: "get_outline",
    description: "List the document's headings (level, text) to navigate before reading. Use this first on long documents.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_section",
    description: "Read the full text of one section by its exact heading text. Use to read a slice of a long document instead of the whole thing.",
    parameters: {
      type: "object",
      properties: { heading: { type: "string", description: "Exact heading text, e.g. 'Cost Summary'." } },
      required: ["heading"],
    },
  },
  {
    name: "comment_on_quote",
    description:
      "Attach a comment to a span of text. Identify the span by quoting it EXACTLY (visible prose only — never include heading markers like # or ##) and giving the 1-based occurrence_index if the quote appears more than once.",
    parameters: {
      type: "object",
      properties: {
        quoted_text: { type: "string", description: "Exact text to anchor to (verbatim, no markdown markers)." },
        occurrence_index: { type: "integer", description: "1-based occurrence of quoted_text (1 if unique).", default: 1 },
        comment: { type: "string", description: "The comment to leave on this span." },
      },
      required: ["quoted_text", "comment"],
    },
  },
  {
    name: "propose_replacement",
    description:
      "Propose replacing a span of text with new text. Identify the span by quoting it EXACTLY (visible prose only) plus 1-based occurrence_index. Single paragraph only.",
    parameters: {
      type: "object",
      properties: {
        quoted_text: { type: "string", description: "Exact text to replace (verbatim, no markdown markers)." },
        occurrence_index: { type: "integer", description: "1-based occurrence of quoted_text.", default: 1 },
        suggested_text: { type: "string", description: "The replacement text." },
        rationale: { type: "string", description: "Why this change." },
      },
      required: ["quoted_text", "suggested_text"],
    },
  },
  {
    name: "reply_to_annotation",
    description: "Reply to an existing pending comment thread by its annotation id.",
    parameters: {
      type: "object",
      properties: {
        annotation_id: { type: "string", description: "Id of the comment to reply to." },
        text: { type: "string", description: "Reply text." },
      },
      required: ["annotation_id", "text"],
    },
  },
];

function asString(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}
function asOccurrence(v: unknown): number {
  const n = typeof v === "number" ? v : parseInt(asString(v), 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** Resolve a quote anchor to a validated, CRDT-anchored range, or a structured error. */
function resolveAnchor(ydoc: Y.Doc, quoted: string, occ: number) {
  const fullText = extractText(ydoc);
  const hit = findOccurrence(fullText, quoted, occ);
  if ("error" in hit) {
    return { ok: false as const, errorCode: "ANCHOR_NOT_FOUND", message: hit.error, totalCount: hit.totalCount };
  }
  const anchored = anchoredRange(ydoc, hit.from, hit.to, undefined, { rejectHeadingOverlap: true });
  if (!anchored.ok) {
    return { ok: false as const, errorCode: anchored.code, message: `Range rejected: ${anchored.code}`, span: { from: hit.from, to: hit.to } };
  }
  return { ok: true as const, anchored, span: { from: hit.from, to: hit.to } };
}

export function dispatch(name: string, args: Record<string, unknown> | null, ctx: DispatchCtx): ToolOutcome {
  const { ydoc } = ctx;
  const annotations = ydoc.getMap(Y_MAP_ANNOTATIONS);

  if (args == null) {
    return { result: { error: "MALFORMED_ARGS", message: "Tool arguments were not valid JSON." }, effect: { kind: "read" } };
  }

  switch (name) {
    case "get_outline": {
      const outline = getOutline(ydoc.getXmlFragment("default"));
      return { result: { outline }, effect: { kind: "read" } };
    }
    case "read_section": {
      const section = getSection(ydoc.getXmlFragment("default"), asString(args.heading));
      return { result: section.found ? { text: section.text } : { error: "SECTION_NOT_FOUND" }, effect: { kind: "read" } };
    }
    case "comment_on_quote": {
      const quoted = asString(args.quoted_text);
      const occ = asOccurrence(args.occurrence_index);
      const r = resolveAnchor(ydoc, quoted, occ);
      if (!r.ok) {
        return {
          result: { error: r.errorCode, message: r.message },
          effect: { kind: "comment", ok: false, anchor: { quoted_text: quoted, occurrence_index: occ }, errorCode: r.errorCode },
        };
      }
      const id = createAnnotation(annotations, ydoc, "comment", r.anchored, asString(args.comment));
      return {
        result: { ok: true, annotation_id: id },
        effect: {
          kind: "comment",
          ok: true,
          annotationId: id,
          anchor: { quoted_text: quoted, occurrence_index: occ },
          resolvedSpan: r.span,
          fullyAnchored: (r.anchored as { fullyAnchored?: boolean }).fullyAnchored,
        },
      };
    }
    case "propose_replacement": {
      const quoted = asString(args.quoted_text);
      const occ = asOccurrence(args.occurrence_index);
      const r = resolveAnchor(ydoc, quoted, occ);
      if (!r.ok) {
        return {
          result: { error: r.errorCode, message: r.message },
          effect: { kind: "replacement", ok: false, anchor: { quoted_text: quoted, occurrence_index: occ }, errorCode: r.errorCode },
        };
      }
      const id = createAnnotation(annotations, ydoc, "comment", r.anchored, asString(args.rationale) || "Suggested replacement.", {
        suggestedText: asString(args.suggested_text),
      });
      return {
        result: { ok: true, annotation_id: id },
        effect: {
          kind: "replacement",
          ok: true,
          annotationId: id,
          anchor: { quoted_text: quoted, occurrence_index: occ },
          resolvedSpan: r.span,
          fullyAnchored: (r.anchored as { fullyAnchored?: boolean }).fullyAnchored,
        },
      };
    }
    case "reply_to_annotation": {
      const annotationId = asString(args.annotation_id);
      const reply = addReplyToAnnotation(ydoc, annotations, annotationId, asString(args.text), "claude", withMcp);
      return {
        result: reply.ok ? { ok: true, reply_id: reply.replyId } : { error: reply.code ?? "REPLY_FAILED", message: reply.error },
        effect: { kind: "reply", ok: reply.ok, annotationId, replyId: reply.ok ? reply.replyId : undefined, errorCode: reply.ok ? undefined : reply.code },
      };
    }
    default:
      return { result: { error: "UNKNOWN_TOOL", message: `No tool named ${name}` }, effect: { kind: "read" } };
  }
}
