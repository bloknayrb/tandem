/**
 * Quote-anchored tool registry + dispatch for the local-model loop
 * (#1123 M1, ADR-039) — productionized from `probe/local-model-spike/tools.ts`.
 *
 * The model NEVER sees or emits character offsets. Every mutating tool takes
 * (quoted_text, occurrence_index); the server resolves to a CRDT-anchored range:
 *
 *   unescape -> countOccurrences -> (clamp occ->1 iff occ>1 and count===1) ->
 *   findOccurrence -> anchoredRange({rejectHeadingOverlap, rejectHeadingInterior}) ->
 *   AnnotationReplier.create / .reply                 (wrapped in withMcp)
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
 * Editing permission (#1123, ADR-039's tiers): chat is the default tier, and
 * commenting, suggesting and replying in threads are an opt-in. `dispatch` is
 * the ONE route by which model output reaches a document, so the gate is its
 * first statement: unless `ctx.canEdit()` answers exactly `true`, every name
 * that is not in {@link READ_TOOL_NAMES} is refused before anything is built or
 * read. It is an allowlist on purpose — a writing tool added later, a tool the
 * model was never offered and a name that is no tool at all are all refused
 * with no edit here. **Omitted means refused**, the opposite of `isDocCurrent`.
 *
 * License (#1521): nothing here. The local model is an AI surface, and an
 * unlicensed install runs no turn at all — the collaborator refuses per run
 * before this dispatcher is ever reached (`collaborator.ts`).
 */
import type * as Y from "yjs";

import type { AgentIdentity } from "../../shared/types.js";
import {
  type AnnotationReplier,
  type CreateExtras,
  createAnnotationLifecycle,
  describeReplyWriteRefusal,
} from "../annotations/lifecycle.js";
import { relaySanitizationEvent } from "../annotations/migration-log.js";
import { captureSnapshot } from "../mcp/annotations.js";
import { getOutline, getSection } from "../mcp/document.js";
import { extractText } from "../mcp/document-model.js";
import { countOccurrences, findOccurrence } from "../mcp/navigation.js";
import { anchoredRange, describeRangeFailure } from "../positions.js";
import type { ToolSchema } from "./ollama-client.js";

export interface DispatchCtx {
  ydoc: Y.Doc;
  /** #1123 M3: the authoring agent's identity, stamped onto every annotation /
   *  reply this dispatch writes so the client byline names the specific model.
   *  Undefined ⇒ no stamp (byte-identical to pre-M3 + the MCP path). */
  agentIdentity?: AgentIdentity;
  /**
   * Is `ydoc` still the document this run reasoned about — the room's live
   * instance, with its content not replaced since the run started? (#2039,
   * #2070) Omitted ⇒ treated as `true`. When it answers `false` every WRITE
   * tool refuses with `DOCUMENT_CHANGED` and writes nothing; the read tools
   * stay open, since they read the live document by construction.
   */
  isDocCurrent?: () => boolean;
  /**
   * May this run write — comment, suggest a replacement, reply in a thread?
   * Read on EVERY dispatch, so switching editing off stops a run already in
   * flight. **Fail-closed: anything but a function returning exactly `true`
   * refuses every tool outside {@link READ_TOOL_NAMES}.** Required in the type
   * so forgetting it is a compile error, and refused at run time so a cast, a
   * JS caller or a later refactor that drops it still writes nothing.
   */
  canEdit: () => boolean;
}

export interface ToolOutcome {
  /** JSON-serializable result handed back to the model as the tool message.
   *  Opaque to host code — branch on `effect`, never parse `result`. */
  result: unknown;
  /** structured record of what happened, for metrics / diagnostics; the
   *  host-side source of truth (the loop keys all metrics off this, not `result`). */
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
    | { kind: "reply"; ok: boolean; annotationId: string; replyId?: string; errorCode?: string }
    /** Refused before anything was read or written: editing is off for this
     *  run. Its own kind so the loop's anchor- and reply-failure metrics stay
     *  a record of what the model got wrong, not of what it was not allowed. */
    | { kind: "refused"; tool: string; errorCode: "EDITING_OFF" | "UNKNOWN_TOOL" };
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
    description:
      "Reply to a pending comment thread you or another AI authored, by its annotation id. Comments written by the user cannot be replied to (NOT_OWNED, or INVALID_ARGUMENT for a private one); leave a new comment_on_quote instead.",
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

/**
 * The reading tools: the whole of what a chat-tier run may call. An allowlist —
 * `dispatch` refuses everything else unless editing is on, so adding a tool to
 * {@link TOOLS} leaves it refused in the chat tier until it is named here.
 */
export const READ_TOOL_NAMES: ReadonlySet<string> = new Set(["get_outline", "read_section"]);

/** The tool list a chat-tier run is offered: exactly the reading tools. */
export const READ_TOOLS: ToolSchema[] = TOOLS.filter((t) => READ_TOOL_NAMES.has(t.name));

/** "get_outline and read_section", derived so a third reading tool is named too. */
const READ_TOOL_LIST = READ_TOOLS.map((t) => t.name).join(" and ");

/** What the model is told when it calls a writing tool in a run that may not
 *  write. Names no writing tool, and says what to do instead so it answers in
 *  chat rather than spending its tool budget on refused calls. Worded as "not
 *  available for this reply" because it is also what a run that started in the
 *  chat tier hears after the user has switched editing on. */
export const EDITING_OFF_MESSAGE =
  "Commenting on and suggesting changes to the document are switched off for this reply, so nothing was written. Call no more tools: your next message is your reply, so answer the user in plain text.";

function refusedOutcome(name: string): ToolOutcome {
  if (TOOLS.some((t) => t.name === name)) {
    return {
      result: { error: "EDITING_OFF", message: EDITING_OFF_MESSAGE },
      effect: { kind: "refused", tool: name, errorCode: "EDITING_OFF" },
    };
  }
  return {
    result: {
      error: "UNKNOWN_TOOL",
      message: `No tool named ${name}. Only ${READ_TOOL_LIST} are available. Answer the user in plain text.`,
    },
    effect: { kind: "refused", tool: name, errorCode: "UNKNOWN_TOOL" },
  };
}

/** What a successful write tells the model (#1123 R3): it proposed, it did not
 *  change the document. The measured failure was a reply saying "the suggested
 *  change has been made and is now part of the document" after a proposal the
 *  user then dismissed. */
const REPLACEMENT_NOTE =
  "This is a suggestion waiting for the user to accept or reject. The document text has NOT been changed.";
const COMMENT_NOTE =
  "The comment was added for the user to read. The document text has NOT been changed.";
const REPLY_NOTE = "The reply was posted in the thread. The document text has NOT been changed.";

/**
 * The `not-owned` remedy for the local model (#2216). The shared default names
 * `tandem_reply` / `tandem_comment`, neither of which this tool set has; the
 * equivalent here is `comment_on_quote`. Kept as a named const so the dispatch
 * site stays a plain `describeReplyWriteRefusal(` call for the seam census.
 */
const LOCAL_NOT_OWNED_REMEDY =
  "start a fresh thread on the user's text with comment_on_quote instead";

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
 *
 * **`kind` decides the heading-INTERIOR term (#1766 follow-up), and it is a
 * required parameter so forgetting it is a compile error.** A `"replacement"`
 * stores `suggestedText`, which the editor's accept and the `.docx` apply both
 * turn into a verbatim replacement of the stored flat span — so a replacement
 * whose interior steps over a `"## "` deletes the heading, exactly as
 * `tandem_edit` did before #1766. A `"comment"` writes nothing and keeps the
 * endpoint-only rule, because a comment spanning a section is legal.
 */
function resolveAnchor(
  ydoc: Y.Doc,
  rawQuote: string,
  rawOcc: number,
  kind: "comment" | "replacement",
) {
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
  const anchored = anchoredRange(ydoc, hit.from, hit.to, undefined, {
    rejectHeadingOverlap: true,
    rejectHeadingInterior: kind === "replacement",
  });
  if (!anchored.ok) {
    return {
      ok: false as const,
      errorCode: anchored.code,
      message: `Range rejected: ${describeRangeFailure(anchored)}`,
      span: { from: hit.from, to: hit.to },
      occ,
    };
  }
  return { ok: true as const, anchored, span: { from: hit.from, to: hit.to }, occ };
}

/**
 * Create a comment- or replacement-kind annotation from a quote anchor. The two
 * mutating annotate tools share the resolve→creator.create→effect shape; they
 * differ only in the effect `kind`, the annotation body, and whether a
 * `suggestedText` extra rides along (replacement only). The stored annotation
 * type is always "comment" — a replacement is a comment carrying suggestedText.
 */
function annotateFromQuote(
  kind: "comment" | "replacement",
  ydoc: Y.Doc,
  creator: AnnotationReplier,
  args: Record<string, unknown>,
  body: string,
  extra?: CreateExtras,
  agentIdentity?: AgentIdentity,
): ToolOutcome {
  const quoted = asString(args.quoted_text);
  const occ = asOccurrence(args.occurrence_index);
  const r = resolveAnchor(ydoc, quoted, occ, kind);
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
  // Capture the same snapshot `tandem_comment` does (#1486). Without it the
  // record has no `textSnapshot` at all, and the undo path is gated on the
  // snapshot being a string — so undoing one of these annotations silently
  // returns success, clears the Undo button and flips the record back to
  // `pending` while the replacement text is still in the document. Declining
  // is a designed outcome here; succeeding without reverting is not.
  const snap = captureSnapshot(ydoc, r.anchored.range.from, r.anchored.range.to);
  const mergedExtra = {
    ...extra,
    textSnapshot: snap.text,
    ...(snap.truncated ? { textSnapshotTruncated: true } : {}),
    ...(snap.breaks.length > 0 ? { textSnapshotBreaks: snap.breaks } : {}),
    // #1123 M3: stamp the authoring agent.
    ...(agentIdentity ? { agentIdentity } : {}),
  };
  // ADR-035 (Unit 8b): the create goes through the lifecycle seam. The loop
  // gets `AnnotationReplier`, not the full lifecycle — it has no accept or
  // dismiss tool and no unit may hand it one by widening a binding.
  const { annotation } = creator.create({
    anchored: r.anchored,
    content: body,
    extras: mergedExtra,
  });
  return {
    // The id stays: a create result is the only place the model learns one, and
    // `reply_to_annotation` needs it. The prompt tells it not to quote ids.
    result:
      kind === "replacement"
        ? { ok: true, annotation_id: annotation.id, status: "proposed", note: REPLACEMENT_NOTE }
        : { ok: true, annotation_id: annotation.id, note: COMMENT_NOTE },
    effect: {
      kind,
      ok: true,
      annotationId: annotation.id,
      anchor: { quoted_text: quoted, occurrence_index: r.occ },
      resolvedSpan: r.span,
      fullyAnchored: r.anchored.fullyAnchored,
    },
  };
}

/** The refusal an annotate tool returns when the document changed under the run (#2070). */
function changedAnnotateOutcome(
  kind: "comment" | "replacement",
  args: Record<string, unknown>,
  result: { error: string; message: string },
): ToolOutcome {
  return {
    result,
    effect: {
      kind,
      ok: false,
      anchor: {
        quoted_text: asString(args.quoted_text),
        occurrence_index: asOccurrence(args.occurrence_index),
      },
      errorCode: "DOCUMENT_CHANGED",
    },
  };
}

export function dispatch(
  name: string,
  args: Record<string, unknown> | null,
  ctx: DispatchCtx,
): ToolOutcome {
  const { ydoc } = ctx;
  // The editing gate — FIRST, before the lifecycle is built, before the args are
  // looked at, before the switch. `=== true` on a real function only: an
  // omitted, non-function or truthy-but-not-boolean answer refuses.
  if (!READ_TOOL_NAMES.has(name)) {
    const allowed = typeof ctx.canEdit === "function" && ctx.canEdit() === true;
    if (!allowed) return refusedOutcome(name);
  }
  // Built per dispatch, never cached on `ctx`. Two reasons, both silent if
  // broken: a lifecycle outliving a Hocuspocus `onLoadDocument` doc swap writes
  // into a destroyed doc, and a lifecycle injected alongside a different `ydoc`
  // would resolve flat offsets against one document and write them into
  // another (Critical Rule 4) with nothing to typecheck the mismatch.
  const creator: AnnotationReplier = createAnnotationLifecycle(ydoc);

  if (args == null) {
    return {
      result: { error: "MALFORMED_ARGS", message: "Tool arguments were not valid JSON." },
      effect: { kind: "read" },
    };
  }

  // #2070: a write whose quote was chosen against content that has since been
  // replaced would anchor on the NEW text wherever the quote still occurs, and
  // verify perfectly. Refused before resolving anything.
  const documentChanged = ctx.isDocCurrent !== undefined && !ctx.isDocCurrent();
  const changedResult = {
    error: "DOCUMENT_CHANGED",
    message:
      "The document was replaced since you read it (reloaded or reconnected). Nothing was written.",
  };

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
      if (documentChanged) return changedAnnotateOutcome("comment", args, changedResult);
      return annotateFromQuote(
        "comment",
        ydoc,
        creator,
        args,
        asString(args.comment),
        undefined,
        ctx.agentIdentity,
      );
    case "propose_replacement":
      if (documentChanged) return changedAnnotateOutcome("replacement", args, changedResult);
      return annotateFromQuote(
        "replacement",
        ydoc,
        creator,
        args,
        asString(args.rationale) || "Suggested replacement.",
        { suggestedText: asString(args.suggested_text) },
        ctx.agentIdentity,
      );
    case "reply_to_annotation": {
      const annotationId = asString(args.annotation_id);
      if (documentChanged) {
        return {
          result: changedResult,
          effect: { kind: "reply", ok: false, annotationId, errorCode: "DOCUMENT_CHANGED" },
        };
      }
      // ADR-035 Unit 8f: through the seam, so the ADR-027 guard covers the
      // local model exactly as it covers Claude. This previously called the
      // free `addReplyToAnnotation` with a literal "claude" — which is why
      // widening `AnnotationReplier` grants nothing that was not already
      // reachable here; see its docblock.
      const reply = creator.reply(
        annotationId,
        asString(args.text),
        // #1626: the local-model loop has no reply-suggestion tool, so it takes
        // the `none` arm explicitly. Required and positioned before the
        // optionals for the same reason `anchorRange`'s `purpose` is: a bare
        // optional would let this producer acquire the eventual-rewrite
        // capability silently, with no compile error to notice it.
        { kind: "none" },
        (event) => relaySanitizationEvent(undefined, event),
        ctx.agentIdentity,
      );
      // Branch once. The earlier shape computed the refusal in one ternary and
      // read it in another, so every access needed a `?? "REPLY_FAILED"` for a
      // case that cannot occur — TypeScript will not carry the narrowing across
      // two expressions, and an unreachable fallback string is indistinguishable
      // from a reachable one to anyone reading it later.
      if (reply.kind === "ok") {
        return {
          result: { ok: true, reply_id: reply.replyId, note: REPLY_NOTE },
          effect: { kind: "reply", ok: true, annotationId, replyId: reply.replyId },
        };
      }
      const refusal = describeReplyWriteRefusal(reply, {
        notOwnedRemedy: LOCAL_NOT_OWNED_REMEDY,
      });
      return {
        result: { error: refusal.code, message: refusal.message },
        effect: { kind: "reply", ok: false, annotationId, errorCode: refusal.code },
      };
    }
    default:
      return {
        result: { error: "UNKNOWN_TOOL", message: `No tool named ${name}` },
        effect: { kind: "read" },
      };
  }
}
