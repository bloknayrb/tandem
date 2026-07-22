/**
 * Quote-anchored tool registry + dispatch for the local-model loop
 * (#1123 M1, ADR-039) — productionized from `probe/local-model-spike/tools.ts`.
 *
 * The model NEVER sees or emits character offsets. Every mutating tool takes
 * (quoted_text, occurrence_index); the server resolves to a CRDT-anchored range:
 *
 *   unescape -> countOccurrences -> (clamp occ->1 iff occ>1 and count===1) ->
 *   findOccurrence -> anchoredRange({rejectHeadingOverlap}) ->
 *   createAnnotation / addReplyToAnnotation   (wrapped in withMcp)
 *
 * Anchor/validation failures are returned to the model as structured tool errors
 * so it can retry with a tighter quote (the bounded repair is loop-level, via
 * the loop's turn/tool-call budget — there is no hidden inner retry).
 *
 * M0-measured hardening (ADR-039 §2), gated to NEVER mis-anchor a repeated quote:
 *  1. markdown-unescape the model's quote (it copies `\$`, `\*` from rendered md);
 *  2. occurrence-clamp: if occurrence_index>1 but the quote occurs exactly once,
 *     clamp to 1 (information-free on a unique quote; the count===1 gate makes
 *     collapsing two distinct spans structurally impossible).
 *
 * License (ADR-040 §3 / #1116): the loop is a write surface that bypasses both
 * license enforcement surfaces (no Hocuspocus connection; not an MCP tool), so
 * the THREE mutating tools consult the gate here. Reads + chat are the read-only
 * escape hatch and are never gated. `isLicenseRestricted` is injectable for
 * tests; it defaults to the live `licenseGate()` (a no-op while the gate is dark).
 */
import type * as Y from "yjs";

import { Y_MAP_ANNOTATIONS } from "../../shared/constants.js";
import { withMcp } from "../../shared/origins.js";
import type { AgentIdentity } from "../../shared/types.js";
import { addReplyToAnnotation, createAnnotation } from "../mcp/annotations.js";
import { getOutline, getSection } from "../mcp/document.js";
import { extractText } from "../mcp/document-model.js";
import { licenseGate } from "../mcp/license-gate.js";
import { countOccurrences, findOccurrence } from "../mcp/navigation.js";
import { anchoredRange } from "../positions.js";
import type { ToolSchema } from "./ollama-client.js";

export interface DispatchCtx {
  ydoc: Y.Doc;
  /** True when editing must be blocked (trial expired). Defaults to the live
   *  license gate; injectable so tests don't touch the filesystem. */
  isLicenseRestricted?: () => boolean;
  /** #1123 M3: the authoring agent's identity, stamped onto every annotation /
   *  reply this dispatch writes so the client byline names the specific model.
   *  Undefined ⇒ no stamp (byte-identical to pre-M3 + the MCP path). */
  agentIdentity?: AgentIdentity;
}

export interface ToolOutcome {
  /** JSON-serializable result handed back to the model as the tool message.
   *  Opaque to host code — branch on `effect`, never parse `result`. */
  result: unknown;
  /** structured record of what happened, for metrics / diagnostics; the
   *  host-side source of truth (the loop keys all metrics off this, not `result`). */
  effect:
    | { kind: "read" }
    | { kind: "blocked"; tool: string }
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
    description:
      "List the document's headings (level, text) to navigate before reading. Use this first on long documents.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_section",
    description:
      "Read the full text of one section by its exact heading text. Use to read a slice of a long document instead of the whole thing.",
    parameters: {
      type: "object",
      properties: {
        heading: { type: "string", description: "Exact heading text, e.g. 'Cost Summary'." },
      },
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
        quoted_text: {
          type: "string",
          description: "Exact text to anchor to (verbatim, no markdown markers).",
        },
        occurrence_index: {
          type: "integer",
          description: "1-based occurrence of quoted_text (1 if unique).",
          default: 1,
        },
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
        quoted_text: {
          type: "string",
          description: "Exact text to replace (verbatim, no markdown markers).",
        },
        occurrence_index: {
          type: "integer",
          description: "1-based occurrence of quoted_text.",
          default: 1,
        },
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

/** Tools that write to the Y.Doc — gated by the license check. Reads + chat aren't. */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "comment_on_quote",
  "propose_replacement",
  "reply_to_annotation",
]);

function asString(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}
function asOccurrence(v: unknown): number {
  const n = typeof v === "number" ? v : Number.parseInt(asString(v), 10);
  // Floor to a positive integer: occurrence_index is 1-based and integral, and a
  // non-integer here (e.g. a model emitting 1.5) would never equal findOccurrence's
  // integer `count` — on an empty pattern that is an infinite loop (see the guard
  // there). Math.floor keeps a valid occurrence; anything else falls back to 1.
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/**
 * Undo markdown backslash-escapes the model copies from rendered text (`\$`,
 * `\*`, …). Conservative: only strips a backslash before a known markdown
 * special, so it can't corrupt a quote that legitimately contains a backslash.
 */
function unescapeMarkdown(quote: string): string {
  return quote.replace(/\\([\\`*_{}[\]()#+\-.!$>~|])/g, "$1");
}

/**
 * Resolve a quote anchor to a validated, CRDT-anchored range, or a structured
 * error. Unescape + count + clamp all run against the SAME `fullText` snapshot.
 */
function resolveAnchor(ydoc: Y.Doc, rawQuote: string, rawOcc: number) {
  const fullText = extractText(ydoc);
  const quoted = unescapeMarkdown(rawQuote);
  // M0 fix #2: a redundant occurrence_index on a unique quote is clamped to 1.
  // Gated strictly on count===1 so it can never collapse two distinct spans.
  const count = countOccurrences(fullText, quoted);
  const occ = rawOcc > 1 && count === 1 ? 1 : rawOcc;

  const hit = findOccurrence(fullText, quoted, occ);
  if ("error" in hit) {
    return {
      ok: false as const,
      errorCode: "ANCHOR_NOT_FOUND",
      message: hit.error,
      totalCount: hit.totalCount,
      occ,
    };
  }
  const anchored = anchoredRange(ydoc, hit.from, hit.to, undefined, { rejectHeadingOverlap: true });
  if (!anchored.ok) {
    return {
      ok: false as const,
      errorCode: anchored.code,
      message: `Range rejected: ${anchored.code}`,
      span: { from: hit.from, to: hit.to },
      occ,
    };
  }
  return { ok: true as const, anchored, span: { from: hit.from, to: hit.to }, occ };
}

/**
 * Create a comment- or replacement-kind annotation from a quote anchor. The two
 * mutating annotate tools share the resolve→createAnnotation→effect shape; they
 * differ only in the effect `kind`, the annotation body, and whether a
 * `suggestedText` extra rides along (replacement only). The stored annotation
 * type is always "comment" — a replacement is a comment carrying suggestedText.
 */
function annotateFromQuote(
  kind: "comment" | "replacement",
  ydoc: Y.Doc,
  annotations: Y.Map<unknown>,
  args: Record<string, unknown>,
  body: string,
  extra?: Parameters<typeof createAnnotation>[5],
  agentIdentity?: AgentIdentity,
): ToolOutcome {
  const quoted = asString(args.quoted_text);
  const occ = asOccurrence(args.occurrence_index);
  const r = resolveAnchor(ydoc, quoted, occ);
  if (!r.ok) {
    return {
      result: { error: r.errorCode, message: r.message },
      effect: {
        kind,
        ok: false,
        anchor: { quoted_text: quoted, occurrence_index: r.occ },
        errorCode: r.errorCode,
      },
    };
  }
  // #1123 M3: stamp the authoring agent. When absent, pass `extra` unchanged so
  // the created record is byte-identical to pre-M3.
  const mergedExtra = agentIdentity ? { ...extra, agentIdentity } : extra;
  const id = createAnnotation(annotations, ydoc, "comment", r.anchored, body, mergedExtra);
  return {
    result: { ok: true, annotation_id: id },
    effect: {
      kind,
      ok: true,
      annotationId: id,
      anchor: { quoted_text: quoted, occurrence_index: r.occ },
      resolvedSpan: r.span,
      fullyAnchored: r.anchored.fullyAnchored,
    },
  };
}

export function dispatch(
  name: string,
  args: Record<string, unknown> | null,
  ctx: DispatchCtx,
): ToolOutcome {
  const { ydoc } = ctx;
  const annotations = ydoc.getMap(Y_MAP_ANNOTATIONS);

  if (args == null) {
    return {
      result: { error: "MALFORMED_ARGS", message: "Tool arguments were not valid JSON." },
      effect: { kind: "read" },
    };
  }

  // License gate: block the mutating tools when restricted; reads + chat pass.
  if (MUTATING_TOOLS.has(name)) {
    const restricted = ctx.isLicenseRestricted ? ctx.isLicenseRestricted() : licenseGate() !== null;
    if (restricted) {
      return {
        result: {
          error: "LICENSE_REQUIRED",
          message:
            "Editing is unavailable — the Tandem trial has ended; activate a license to keep editing.",
        },
        effect: { kind: "blocked", tool: name },
      };
    }
  }

  switch (name) {
    case "get_outline": {
      const outline = getOutline(ydoc.getXmlFragment("default"));
      return { result: { outline }, effect: { kind: "read" } };
    }
    case "read_section": {
      const section = getSection(ydoc.getXmlFragment("default"), asString(args.heading));
      return {
        result: section.found ? { text: section.text } : { error: "SECTION_NOT_FOUND" },
        effect: { kind: "read" },
      };
    }
    case "comment_on_quote":
      return annotateFromQuote(
        "comment",
        ydoc,
        annotations,
        args,
        asString(args.comment),
        undefined,
        ctx.agentIdentity,
      );
    case "propose_replacement":
      return annotateFromQuote(
        "replacement",
        ydoc,
        annotations,
        args,
        asString(args.rationale) || "Suggested replacement.",
        { suggestedText: asString(args.suggested_text) },
        ctx.agentIdentity,
      );
    case "reply_to_annotation": {
      const annotationId = asString(args.annotation_id);
      const reply = addReplyToAnnotation(
        ydoc,
        annotations,
        annotationId,
        asString(args.text),
        "claude",
        withMcp,
        ctx.agentIdentity,
      );
      return {
        result: reply.ok
          ? { ok: true, reply_id: reply.replyId }
          : { error: reply.code ?? "REPLY_FAILED", message: reply.error },
        effect: {
          kind: "reply",
          ok: reply.ok,
          annotationId,
          replyId: reply.ok ? reply.replyId : undefined,
          errorCode: reply.ok ? undefined : reply.code,
        },
      };
    }
    default:
      return {
        result: { error: "UNKNOWN_TOOL", message: `No tool named ${name}` },
        effect: { kind: "read" },
      };
  }
}
