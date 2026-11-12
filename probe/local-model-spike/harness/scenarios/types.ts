/**
 * Scenario records. A scenario is DATA: what the user's message is, on which
 * document, and what a deterministic scorer can check about the outcome. It
 * carries no prompt wording of the product's, no tool list and no model name.
 */
import type { Pattern } from "./predicates.js";

export type Tier = "chat" | "editing";

/** The three groups whose observed rate gates the chat tier (brief R2). */
export const GATING_GROUPS = ["answerable", "unanswerable", "editing-request"] as const;
export type GatingGroup = (typeof GATING_GROUPS)[number];

export type ChatGroup = GatingGroup | "no-action";
export type EditingGroup =
  | "comment"
  | "replacement"
  | "question"
  | "edit-no-action"
  | "thread"
  | "sequence"
  | "envelope";
export type Group = ChatGroup | EditingGroup;

/** Names printed in the report, one per group. */
export const GROUP_TITLES: Record<Group, string> = {
  answerable: "Questions the document answers",
  unanswerable: "Questions the document does not answer",
  "editing-request": "Requests only the editing tier can carry out",
  "no-action": "Messages that need no action (reported, not in the rate)",
  comment: "Comment on a quote",
  replacement: "Suggest a replacement",
  question: "Question answered in chat",
  "edit-no-action": "Nothing to change",
  thread: "Replies in threads",
  sequence: "Multi-step sequences (extended)",
  envelope: "50-page document (extended)",
};

export interface AnchorRef {
  quoted_text: string;
  occurrence_index?: number;
}

export interface ContentAssertion {
  must_match_any?: string[];
  must_not_match?: string[];
  min_chars?: number;
}

export interface ReplacementAssertion {
  must_match?: string;
  must_not_match?: string;
  max_len_ratio?: number;
  contains?: string;
}

export interface SequenceAssertion {
  final_annotation_count?: number;
  min_annotation_count?: number;
  must_anchor?: AnchorRef & { acceptable_anchors?: AnchorRef[] };
  must_suggest?: string;
  chat_must_match_any?: string[];
}

export type Expectation =
  /** The reply must hold the answer and none of the planted distractors. */
  | { kind: "answer"; must: Pattern[][]; mustNot: Pattern[] }
  /** The reply must say the document does not say, and hold no planted value. */
  | { kind: "not-stated"; mustNot: Pattern[] }
  /** Chat tier, a request to change text: quote `target`, offer different text. */
  | { kind: "offer-change"; target: string }
  /** Chat tier, a request to comment: quote `target`, say something about it. */
  | { kind: "offer-comment"; target: string }
  /** A message that needs no action: any non-empty reply. */
  | { kind: "acknowledge" }
  /** Editing tier: one annotation of this kind on (or overlapping) the gold span. */
  | {
      kind: "annotation";
      operation: "comment" | "replacement";
      target: AnchorRef & { acceptable_anchors?: AnchorRef[] };
      content?: ContentAssertion;
      replacement?: ReplacementAssertion;
    }
  /** Editing tier: an answer in chat and nothing written. */
  | { kind: "chat-only"; content?: ContentAssertion }
  /** Editing tier: nothing written. */
  | { kind: "no-annotation" }
  /** Editing tier: a comment, and a reply under that same comment. */
  | { kind: "thread-own" }
  /** Editing tier: asked to reply in a thread it was never given: no reply lands. */
  | { kind: "thread-none" }
  | { kind: "sequence"; target: AnchorRef; sequence: SequenceAssertion };

export interface Scenario {
  id: string;
  tier: Tier;
  group: Group;
  /** Key into the fixture table. */
  fixture: string;
  /** The user's chat message, exactly as sent. */
  prompt: string;
  /** Text the user has selected (verbatim from the document), if any. */
  selectedText?: string;
  expect: Expectation;
  /** The right answer in a sentence, for the person reading the reply. */
  answer: string;
  /** Out of a default run; reported in its own section when asked for. */
  extended?: boolean;
  /** Position in the screening subset (1 = first), when it is part of it. */
  screenOrder?: number;
  strata?: string[];
}

export interface Fixture {
  key: string;
  /** Where it came from: a June `.md` file, or built by code. */
  origin: "june-file" | "built";
  markdown: string;
  /**
   * What this fixture claims about itself, checked by a test against the
   * product's inline threshold and the extracted text.
   */
  shape?: {
    /** `inlined`: at or under the threshold. `just-under`: within 10% below it. `deep`: above it. */
    size: "inlined" | "just-under" | "deep";
    /** Facts a scenario asks for, each with the heading of the section holding it. */
    facts?: { text: string; heading?: string }[];
    /** Planted near-miss values that must really be in the text. */
    distractors?: string[];
    /** Values a scenario asks about that must NOT be in the text. */
    absent?: string[];
  };
}
