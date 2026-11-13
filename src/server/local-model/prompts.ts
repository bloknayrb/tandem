/**
 * Local-model prompt construction (#1123 M1, ADR-039).
 *
 * Two tiers (ADR-039, built 2026-11-11):
 *
 *  - **chat** — the default. The model can read the document and answer in
 *    chat. Its prompts name no writing tool, because it is offered none.
 *  - **editing** — the user's opt-in. The model can also comment, suggest
 *    replacements and reply in threads.
 *
 * **These prompts are no longer the ones the M0 spike measured.** The editing
 * prompt is the spike's text (`probe/local-model-spike/prompts.ts`) with one
 * section added, and the chat prompt is new. The section was added because a
 * real run showed the model telling the user a suggestion "has been made and is
 * now part of the document" after only proposing it, and quoting an internal
 * annotation id. So the spike's pass rates, which back ADR-039's "chat
 * default-on", do not describe either shipped prompt, and nothing in this
 * repository re-measures them: the spike's batch harness uses its own copies of
 * the loop and prompts and no longer loads on master. Treat a further change
 * here as a change to an unmeasured prompt, to be checked against a real model
 * (`probe/local-model-spike/dogfood-m1.ts` drives this code in either tier).
 *
 * Context-window decision (ADR-039 §4): short documents are primed fully into
 * the user turn so the model can quote verbatim without a read tool; long
 * documents pass `includeText:false` and navigate via get_outline/read_section.
 */
import type * as Y from "yjs";
import { extractText } from "../mcp/document-model.js";

export type LocalModelTier = "chat" | "editing";

/** Shared by both tiers (#1123 R3.2). */
const NO_INTERNAL_IDS =
  "- Never quote annotation ids, reply ids or any other internal id to the user. They mean nothing to the user; refer to the text instead.";

export const EDITING_SYSTEM_PROMPT = `You are a writing collaborator working inside a document editor. You act on the document ONLY through the provided tools.

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

YOU PROPOSE, THE USER DECIDES
- Your tools never change the document text. A comment is a note for the user. A replacement is a SUGGESTION: it changes nothing until the user accepts it, and the user may reject it.
- So never tell the user that a change was made, applied, or is now in the document. Say that you suggested it and that it is waiting for them to accept or reject.
${NO_INTERNAL_IDS}
- You only know the ids of comments you created in this same reply (each create result gives you one), so those are the only threads you can reply in.
- If a tool returns EDITING_OFF, commenting and suggesting are not allowed for this reply. Call no more tools: your next message is your reply, so answer in plain text.

DISCIPLINE
- Do exactly what is asked, then stop. Do not invent extra annotations.
- If nothing needs changing, say so in plain text and make no annotations.`;

export const CHAT_SYSTEM_PROMPT = `You are a writing collaborator working inside a document editor. You can read the document and talk with the user about it. You cannot change the document, add comments to it, or mark it up in any way.

HOW TO ACT
- Answer the user conversationally: reply with PLAIN TEXT.
- If you need to read part of a long document, call get_outline to list its headings and read_section to read one section. These are the only tools you have.
- If the user asks you to edit, fix, rewrite or comment on the document, do not pretend to. Say what you would change, quoting the exact words and giving your replacement, so the user can make the change themselves.

BE ACCURATE ABOUT WHAT YOU DID
- Never tell the user that you changed, edited, fixed or commented on the document. You only read it and replied.
${NO_INTERNAL_IDS}

DISCIPLINE
- Do exactly what is asked, then stop.
- Base what you say on the document text, not on guesses about it.`;

export function systemPromptFor(tier: LocalModelTier): string {
  return tier === "editing" ? EDITING_SYSTEM_PROMPT : CHAT_SYSTEM_PROMPT;
}

/**
 * Build the user turn. For short docs the full text is inlined so the model can
 * quote verbatim without a read tool; for long docs pass `includeText:false`.
 * `tier` is required: the chat-tier wording says nothing about anchoring,
 * because a chat-tier model has nothing to anchor.
 */
export function buildUserPrompt(
  ydoc: Y.Doc,
  task: string,
  includeText: boolean,
  tier: LocalModelTier,
): string {
  if (!includeText) {
    return tier === "editing"
      ? `${task}\n\nThe document is long. Use get_outline and read_section to read the relevant parts before anchoring.`
      : `${task}\n\nThe document is long. Use get_outline and read_section to read the relevant parts before answering.`;
  }
  const text = extractText(ydoc);
  const lead =
    tier === "editing"
      ? "Here is the full document text (quote from this verbatim when anchoring):"
      : "Here is the full document text:";
  return `${lead}\n\n<document>\n${text}\n</document>\n\nTask: ${task}`;
}
