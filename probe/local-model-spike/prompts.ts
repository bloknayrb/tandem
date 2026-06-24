/**
 * Shared prompt construction for the #1123 M0 spike, so run.ts and the scored
 * batch use IDENTICAL prompting (a prompt difference would invalidate the
 * Claude-as-control calibration).
 *
 * Design note (ADR-039 context-window decision): short documents are primed
 * fully into context; the windowed get_outline/read_section tools are the
 * intended path only at the 50-page envelope, where the whole doc won't fit.
 */
import { extractText } from "../../src/server/mcp/document-model.js";
import type * as Y from "yjs";

export const SYSTEM_PROMPT = `You are a writing collaborator working inside a document editor. You act on the document ONLY through the provided tools.

HOW TO ACT
- Leave feedback: call comment_on_quote (always include the "comment" field).
- Suggest a rewrite: call propose_replacement (include "suggested_text").
- Answer the user conversationally: reply with PLAIN TEXT and no tool call.
- Reply in an existing thread: call reply_to_annotation with its annotation id.

ANCHORING — THIS IS CRITICAL
- quoted_text MUST be copied VERBATIM from the document text below — the exact characters, exactly as written. Do NOT paraphrase, summarize, or quote the user's instruction. Quote the document.
- Quote visible prose only. NEVER include heading markers (#, ##).
- If the same text appears more than once, set occurrence_index (1-based) to pick which one.
- If a tool returns ANCHOR_NOT_FOUND, the text you quoted is NOT in the document — you mis-typed or paraphrased it. Re-read the document text, copy the exact words, and CALL THE TOOL AGAIN. Do not ask the user for the text and do not give up — the document is right in front of you.
- If a tool returns HEADING_OVERLAP, your quote touched a heading; quote body prose instead.

DISCIPLINE
- Do exactly what is asked, then stop. Do not invent extra annotations.
- If nothing needs changing, say so in plain text and make no annotations.`;

/** Build the user turn. For short docs, the full text is inlined so the model
 *  can quote verbatim without a read tool; for the envelope, pass includeText=false. */
export function buildUserPrompt(ydoc: Y.Doc, task: string, includeText: boolean): string {
  if (!includeText) {
    return `${task}\n\nThe document is long. Use get_outline and read_section to read the relevant parts before anchoring.`;
  }
  const text = extractText(ydoc);
  return `Here is the full document text (quote from this verbatim when anchoring):\n\n<document>\n${text}\n</document>\n\nTask: ${task}`;
}
