/**
 * Scenario bank for the #1123 M0 spike.
 *
 * Each scenario is a SELF-GRADING record: it carries the gold anchor + content
 * predicates the scorer checks, so grading is a pure function, not a judgment.
 * Stratified across THREE fixtures and across target location, occurrence-index
 * disambiguation, quote length, instruction phrasing, and distractors.
 *
 * Gold anchors are stated as (quoted_text, occurrence_index) and resolved by
 * findOccurrence against extractText(fixture) — the same path the model's
 * output takes — so a gold label that doesn't resolve is a scenario bug caught
 * FAIL-FAST by batch.ts's validateScenarios(), not a silent mis-grade.
 *
 * Counts (medium fixtures): comment 12, replacement 12, chat 12, no-op 3,
 * sequence 6. Batch runs each × 2 seeds (>=20 trials/op). Envelope scenarios
 * live in scenarios.envelope.ts and are merged at load time.
 */

export type Operation = "comment" | "replacement" | "chat" | "no-op" | "sequence";

export interface ContentAssertion {
  must_match_any?: string[];
  must_not_match?: string[];
  min_chars?: number;
}

export interface ReplacementAssertion {
  must_match?: string; // regex source, case-insensitive
  must_not_match?: string;
  max_len_ratio?: number; // suggested.length must be <= goldText.length * ratio
  contains?: string;
}

export interface AnchorRef {
  quoted_text: string;
  occurrence_index?: number;
}

/** Composite end-state checks for multi-step sequences (all must pass). */
export interface SequenceAssertion {
  final_annotation_count?: number; // exact count of created annotations
  min_annotation_count?: number;
  must_anchor?: AnchorRef & { acceptable_anchors?: AnchorRef[] }; // some annotation overlaps this (IoU >= 0.5)
  must_suggest?: string; // regex the anchored annotation's suggestedText must match
  chat_must_match_any?: string[]; // verify/summary step keywords in final chat content
}

export interface Scenario {
  id: string;
  operation: Operation;
  fixture: string; // path relative to probe/local-model-spike/
  envelope?: boolean;
  prompt: string;
  target: AnchorRef & { acceptable_anchors?: AnchorRef[] };
  content_assertion?: ContentAssertion;
  replacement_assertion?: ReplacementAssertion;
  sequence?: SequenceAssertion;
  strata?: string[];
}

const COST = "fixtures/cost-report-medium.md";
const PROD = "fixtures/product-notes-medium.md";
const RES = "fixtures/research-brief-medium.md";
const ENV = "fixtures/envelope-50page.md";

export const SCENARIOS: Scenario[] = [
  // ===================== comment-on-quote (12) =====================
  {
    id: "comment-cost-contradiction",
    operation: "comment",
    fixture: COST,
    prompt: "The labor cost figure in the Cost Summary contradicts the stated invoice total. Leave a comment on the contradictory figure pointing out the mismatch.",
    target: {
      quoted_text: "The labor cost figure is $42,500 for the quarter, which appears inconsistent with the stated invoice total of $40,000.",
      occurrence_index: 1,
      acceptable_anchors: [{ quoted_text: "$42,500", occurrence_index: 2 }, { quoted_text: "$40,000" }],
    },
    content_assertion: { must_match_any: ["invoice", "mismatch", "contradic", "inconsistent", "40,000", "reconcile", "discrepan", "investigat", "accuracy", "does not match", "doesn't match"], min_chars: 10 },
    strata: ["inferential", "mid-doc", "distractor"],
  },
  {
    id: "comment-cost-vendor-date",
    operation: "comment",
    fixture: COST,
    prompt: "In the Vendor Notes section, comment on the contract renewal date to flag that we should negotiate before it.",
    target: {
      quoted_text: "March 3, 2026",
      occurrence_index: 2,
      acceptable_anchors: [
        { quoted_text: "The contract renewal is due on March 3, 2026." },
        { quoted_text: "Our primary vendor raised prices in February. The contract renewal is due on March 3, 2026." },
        { quoted_text: "The contract renewal is due on March 3, 2026. We should negotiate before signing." },
      ],
    },
    content_assertion: { must_match_any: ["negotiat", "renew", "before", "vendor", "price", "sign", "term"], min_chars: 10 },
    strata: ["occurrence-index", "date-appears-twice"],
  },
  {
    id: "comment-cost-headcount",
    operation: "comment",
    fixture: COST,
    prompt: "Comment on the headcount growth, noting whether the hires add up.",
    target: { quoted_text: "The team grew from 14 to 17 people during the quarter.", acceptable_anchors: [{ quoted_text: "14 to 17" }] },
    content_assertion: { must_match_any: ["hire", "engineer", "designer", "grow", "growth", "headcount", "three", "3", "four", "add up", "consistent"], min_chars: 10 },
    strata: ["direct", "mid-doc"],
  },
  {
    id: "comment-cost-material",
    operation: "comment",
    fixture: COST,
    prompt: "Flag the material costs figure for review.",
    target: { quoted_text: "$18,200", acceptable_anchors: [{ quoted_text: "Material costs were $18,200." }] },
    content_assertion: { must_match_any: ["material", "cost", "review", "18", "figure", "verify", "check"], min_chars: 6 },
    strata: ["short-quote", "unique"],
  },
  {
    id: "comment-prod-onboarding",
    operation: "comment",
    fixture: PROD,
    prompt: "Comment on the current onboarding completion rate, noting it is the metric the redesign aims to improve.",
    target: { quoted_text: "48%", occurrence_index: 1, acceptable_anchors: [{ quoted_text: "improve onboarding completion, which currently sits at 48%" }, { quoted_text: "Onboarding completion is 48% today." }, { quoted_text: "48%", occurrence_index: 2 }] },
    content_assertion: { must_match_any: ["onboard", "complet", "48", "improve", "signup", "redesign", "low"], min_chars: 10 },
    strata: ["figure-appears-twice", "near-start"],
  },
  {
    id: "comment-prod-offline-risk",
    operation: "comment",
    fixture: PROD,
    prompt: "Comment on the feature described as the largest effort and highest risk.",
    target: { quoted_text: "The offline mode is the largest effort and carries the most risk.", acceptable_anchors: [{ quoted_text: "offline mode", occurrence_index: 1 }] },
    content_assertion: { must_match_any: ["offline", "risk", "effort", "largest", "sync", "slip"], min_chars: 10 },
    strata: ["direct", "scope"],
  },
  {
    id: "comment-prod-launch-date",
    operation: "comment",
    fixture: PROD,
    prompt: "Comment on the launch target date, flagging that it is pending a security review.",
    target: { quoted_text: "The launch target is April 15, 2026, pending a security review.", acceptable_anchors: [{ quoted_text: "April 15, 2026", occurrence_index: 1 }] },
    content_assertion: { must_match_any: ["launch", "security", "review", "pending", "date", "target", "april"], min_chars: 10 },
    strata: ["date-appears-thrice", "occurrence-index"],
  },
  {
    id: "comment-prod-dau",
    operation: "comment",
    fixture: PROD,
    prompt: "Comment on the daily active users growth figure in the Metrics section.",
    target: { quoted_text: "Daily active users grew 8% last month.", acceptable_anchors: [{ quoted_text: "grew 8%" }] },
    content_assertion: { must_match_any: ["daily active", "dau", "8%", "8 percent", "grow", "growth", "user"], min_chars: 8 },
    strata: ["near-end", "metric"],
  },
  {
    id: "comment-res-13pct",
    operation: "comment",
    fixture: RES,
    prompt: "Comment on the productivity-gain statistic to note that its sample was narrow.",
    target: { quoted_text: "The 13% productivity gain figure is frequently cited, though its sample was narrow.", acceptable_anchors: [{ quoted_text: "13% productivity gain", occurrence_index: 2 }, { quoted_text: "The 13% productivity gain figure comes from a single industry and may not generalize." }, { quoted_text: "13% productivity gain", occurrence_index: 3 }] },
    content_assertion: { must_match_any: ["sample", "narrow", "single industry", "generaliz", "cited", "caveat", "limit", "13"], min_chars: 10 },
    strata: ["figure-appears-thrice", "occurrence-index"],
  },
  {
    id: "comment-res-selfreport",
    operation: "comment",
    fixture: RES,
    prompt: "Comment on the reliance on self-reported data, which the brief calls unreliable.",
    target: { quoted_text: "Most studies rely on self-reported data, which is unreliable.", acceptable_anchors: [{ quoted_text: "self-reported data, which is unreliable" }] },
    content_assertion: { must_match_any: ["self-report", "self report", "unreliab", "bias", "data", "limit"], min_chars: 10 },
    strata: ["limitations", "direct"],
  },
  {
    id: "comment-res-collab",
    operation: "comment",
    fixture: RES,
    prompt: "Comment on the finding that collaboration scores declined.",
    target: { quoted_text: "Self-reported focus improved in most samples, but collaboration scores declined.", acceptable_anchors: [{ quoted_text: "collaboration scores declined" }] },
    content_assertion: { must_match_any: ["collaborat", "declin", "focus", "tradeoff", "trade-off", "concern"], min_chars: 10 },
    strata: ["findings", "mid-doc"],
  },
  {
    id: "comment-cost-overhead",
    operation: "comment",
    fixture: COST,
    prompt: "Comment on the overhead figure in the Cost Summary.",
    target: { quoted_text: "Overhead was reported at $9,750.", acceptable_anchors: [{ quoted_text: "$9,750" }] },
    content_assertion: { must_match_any: ["overhead", "9,750", "9750", "cost", "figure", "review"], min_chars: 8 },
    strata: ["short-quote", "unique"],
  },

  // ===================== propose_replacement (12) =====================
  {
    id: "replace-cost-reconcile",
    operation: "replacement",
    fixture: COST,
    prompt: "The labor cost figure should match the invoice total of $40,000. Propose a replacement for the labor cost amount in the Cost Summary so it reads $40,000.",
    target: { quoted_text: "$42,500", occurrence_index: 2, acceptable_anchors: [{ quoted_text: "The labor cost figure is $42,500 for the quarter, which appears inconsistent with the stated invoice total of $40,000.", occurrence_index: 1 }] },
    replacement_assertion: { must_match: "40[,.]?000", must_not_match: "42[,.]?500" },
    strata: ["number-update", "occurrence-index"],
  },
  {
    id: "replace-cost-tighten",
    operation: "replacement",
    fixture: COST,
    prompt: "Tighten this sentence to be more concise: 'Detailed tables are available on request.' Propose a shorter replacement.",
    target: { quoted_text: "Detailed tables are available on request.", acceptable_anchors: [{ quoted_text: "Detailed tables are available on request" }] },
    replacement_assertion: { max_len_ratio: 0.95 },
    strata: ["tighten", "appendix"],
  },
  {
    id: "replace-cost-vague-rec",
    operation: "replacement",
    fixture: COST,
    prompt: "The recommendation 'No other changes are needed at this time.' is vague. Propose a more specific replacement that mentions reviewing vendor pricing.",
    target: { quoted_text: "No other changes are needed at this time.", acceptable_anchors: [{ quoted_text: "No other changes are needed at this time" }] },
    replacement_assertion: { must_match: "vendor|pric|review", must_not_match: "no other changes are needed at this time" },
    strata: ["specificity", "recommendations"],
  },
  {
    id: "replace-cost-date",
    operation: "replacement",
    fixture: COST,
    prompt: "The finalization date in the Cost Summary is wrong; it should be March 10, 2026. Propose a replacement for that date.",
    target: { quoted_text: "March 3, 2026", occurrence_index: 1, acceptable_anchors: [{ quoted_text: "The report was finalized on March 3, 2026, after two rounds of review." }] },
    replacement_assertion: { must_match: "March 10|10, 2026", must_not_match: "March 3," },
    strata: ["date-update", "occurrence-index", "distractor"],
  },
  {
    id: "replace-cost-overhead",
    operation: "replacement",
    fixture: COST,
    prompt: "The overhead figure should be $9,500, not $9,750. Propose a replacement for the overhead amount.",
    target: { quoted_text: "$9,750", acceptable_anchors: [{ quoted_text: "Overhead was reported at $9,750." }] },
    replacement_assertion: { must_match: "9[,.]?500", must_not_match: "9[,.]?750" },
    strata: ["number-update", "unique"],
  },
  {
    id: "replace-prod-onboarding-target",
    operation: "replacement",
    fixture: PROD,
    prompt: "The expected onboarding completion after the redesign should be 65%, not roughly 60%. Propose a replacement for the expected figure.",
    target: { quoted_text: "roughly 60%", acceptable_anchors: [{ quoted_text: "We expect the redesigned signup flow to raise it to roughly 60%." }] },
    replacement_assertion: { must_match: "65", must_not_match: "60" },
    strata: ["number-update", "metrics"],
  },
  {
    id: "replace-prod-launch-date",
    operation: "replacement",
    fixture: PROD,
    prompt: "The launch target in the Scope section should move to April 22, 2026. Propose a replacement for that launch-target date.",
    target: { quoted_text: "April 15, 2026", occurrence_index: 1, acceptable_anchors: [{ quoted_text: "The launch target is April 15, 2026, pending a security review." }] },
    replacement_assertion: { must_match: "April 22|22, 2026", must_not_match: "April 15" },
    strata: ["date-update", "occurrence-index", "date-appears-thrice"],
  },
  {
    id: "replace-prod-dau",
    operation: "replacement",
    fixture: PROD,
    prompt: "Daily active users actually grew 10% last month, not 8%. Propose a replacement fixing that figure.",
    target: { quoted_text: "Daily active users grew 8% last month.", acceptable_anchors: [{ quoted_text: "grew 8%" }] },
    replacement_assertion: { must_match: "10\\s?%|10 percent", must_not_match: "8\\s?%" },
    strata: ["number-update", "metrics"],
  },
  {
    id: "replace-res-date",
    operation: "replacement",
    fixture: RES,
    prompt: "The review completion date should be May 16, 2025, not May 9, 2025. Propose a replacement for that date.",
    target: { quoted_text: "May 9, 2025", acceptable_anchors: [{ quoted_text: "The review was completed on May 9, 2025." }] },
    replacement_assertion: { must_match: "May 16|16, 2025", must_not_match: "May 9" },
    strata: ["date-update", "methodology"],
  },
  {
    id: "replace-res-tighten",
    operation: "replacement",
    fixture: RES,
    prompt: "Tighten this sentence: 'Further internal data collection is recommended before drawing firm conclusions.' Propose a shorter version.",
    target: { quoted_text: "Further internal data collection is recommended before drawing firm conclusions.", acceptable_anchors: [{ quoted_text: "Further internal data collection is recommended before drawing firm conclusions" }] },
    replacement_assertion: { max_len_ratio: 0.9 },
    strata: ["tighten", "recommendations"],
  },
  {
    id: "replace-res-hedge",
    operation: "replacement",
    fixture: RES,
    prompt: "The statement 'The 13% productivity gain figure is frequently cited, though its sample was narrow.' should explicitly say the figure may be unreliable. Propose a replacement that adds that the figure should be treated with caution.",
    target: { quoted_text: "The 13% productivity gain figure is frequently cited, though its sample was narrow.", occurrence_index: 1 },
    replacement_assertion: { must_match: "caution|unreliab|may not|treat|careful|tentativ", must_not_match: "^The 13% productivity gain figure is frequently cited, though its sample was narrow.$" },
    strata: ["specificity", "occurrence-index"],
  },
  {
    id: "replace-prod-tentative",
    operation: "replacement",
    fixture: PROD,
    prompt: "Tighten the note 'This planning doc will be revisited after the next cycle.' to be more concise. Propose a shorter replacement.",
    target: { quoted_text: "This planning doc will be revisited after the next cycle.", acceptable_anchors: [{ quoted_text: "This planning doc will be revisited after the next cycle" }] },
    replacement_assertion: { max_len_ratio: 0.95 },
    strata: ["tighten", "notes"],
  },

  // ===================== chat (12) =====================
  {
    id: "chat-cost-labor",
    operation: "chat",
    fixture: COST,
    prompt: "What labor cost figure does the report state for the quarter? Answer in chat.",
    target: { quoted_text: "$42,500" },
    content_assertion: { must_match_any: ["42,500", "42500", "$42"], min_chars: 4 },
    strata: ["must-cite", "fact-lookup"],
  },
  {
    id: "chat-cost-risk",
    operation: "chat",
    fixture: COST,
    prompt: "What is described as the largest risk in this report? Answer in chat, do not annotate.",
    target: { quoted_text: "Supply chain delays remain the largest risk." },
    content_assertion: { must_match_any: ["supply chain", "supply-chain", "supply"], min_chars: 8 },
    strata: ["must-cite", "fact-lookup"],
  },
  {
    id: "chat-cost-headcount",
    operation: "chat",
    fixture: COST,
    prompt: "How many people are on the team at the end of the quarter? Reply in chat.",
    target: { quoted_text: "14 to 17" },
    content_assertion: { must_match_any: ["17", "seventeen"], min_chars: 2 },
    strata: ["must-cite", "fact-lookup"],
  },
  {
    id: "chat-cost-material",
    operation: "chat",
    fixture: COST,
    prompt: "What were the material costs for the quarter? Answer in chat.",
    target: { quoted_text: "$18,200" },
    content_assertion: { must_match_any: ["18,200", "18200", "$18"], min_chars: 4 },
    strata: ["must-cite", "fact-lookup"],
  },
  {
    id: "chat-prod-goal",
    operation: "chat",
    fixture: PROD,
    prompt: "What is the primary goal for version 3? Answer in chat.",
    target: { quoted_text: "improve onboarding completion" },
    content_assertion: { must_match_any: ["onboard", "completion"], min_chars: 6 },
    strata: ["must-cite", "fact-lookup"],
  },
  {
    id: "chat-prod-launch",
    operation: "chat",
    fixture: PROD,
    prompt: "What is the launch target date for version 3? Reply in chat.",
    target: { quoted_text: "April 15, 2026", occurrence_index: 1 },
    content_assertion: { must_match_any: ["april 15", "april 15, 2026", "4/15"], min_chars: 6 },
    strata: ["must-cite", "fact-lookup"],
  },
  {
    id: "chat-prod-northstar",
    operation: "chat",
    fixture: PROD,
    prompt: "What is described as the north-star metric? Answer in chat.",
    target: { quoted_text: "retention is the north-star metric" },
    content_assertion: { must_match_any: ["retention"], min_chars: 5 },
    strata: ["must-cite", "fact-lookup"],
  },
  {
    id: "chat-prod-features",
    operation: "chat",
    fixture: PROD,
    prompt: "Name the three features planned for version 3. Reply in chat.",
    target: { quoted_text: "a redesigned signup flow, push notifications, and an offline mode" },
    content_assertion: { must_match_any: ["signup", "sign up"], must_not_match: [], min_chars: 10 },
    strata: ["must-cite", "list-recall"],
  },
  {
    id: "chat-res-gain",
    operation: "chat",
    fixture: RES,
    prompt: "What productivity-gain figure is frequently cited in the brief? Answer in chat.",
    target: { quoted_text: "13% productivity gain", occurrence_index: 1 },
    content_assertion: { must_match_any: ["13%", "13 percent", "13"], min_chars: 2 },
    strata: ["must-cite", "fact-lookup"],
  },
  {
    id: "chat-res-studies",
    operation: "chat",
    fixture: RES,
    prompt: "How many studies did the review cover? Reply in chat.",
    target: { quoted_text: "twelve studies" },
    content_assertion: { must_match_any: ["twelve", "12"], min_chars: 2 },
    strata: ["must-cite", "fact-lookup"],
  },
  {
    id: "chat-res-date",
    operation: "chat",
    fixture: RES,
    prompt: "When was the review completed? Answer in chat.",
    target: { quoted_text: "May 9, 2025" },
    content_assertion: { must_match_any: ["may 9", "may 9, 2025", "5/9"], min_chars: 4 },
    strata: ["must-cite", "fact-lookup"],
  },
  {
    id: "chat-res-managers",
    operation: "chat",
    fixture: RES,
    prompt: "According to the recommendations, what should managers measure? Reply in chat.",
    target: { quoted_text: "Managers should measure outcomes, not hours." },
    content_assertion: { must_match_any: ["outcome"], min_chars: 5 },
    strata: ["must-cite", "fact-lookup"],
  },

  // ===================== no-op discipline (3) =====================
  {
    id: "noop-cost-appendix",
    operation: "no-op",
    fixture: COST,
    prompt: "Review the Appendix section. If it is internally consistent and needs no changes, say so in chat and make NO annotations.",
    target: { quoted_text: "This section is consistent and complete." },
    content_assertion: { must_match_any: ["consistent", "no change", "complete", "fine", "nothing", "as-is", "as is"], min_chars: 6 },
    strata: ["no-op-discipline"],
  },
  {
    id: "noop-prod-notes",
    operation: "no-op",
    fixture: PROD,
    prompt: "Review the final Notes section. If it needs no changes, say so in chat and make NO annotations.",
    target: { quoted_text: "This section needs no changes and is left as-is." },
    content_assertion: { must_match_any: ["no change", "as-is", "as is", "fine", "nothing", "leave", "consistent"], min_chars: 6 },
    strata: ["no-op-discipline"],
  },
  {
    id: "noop-res-caveats",
    operation: "no-op",
    fixture: RES,
    prompt: "Review the Caveats section. If it is accurate and needs no edits, say so in chat and make NO annotations.",
    target: { quoted_text: "This caveats section is accurate and complete and requires no edits." },
    content_assertion: { must_match_any: ["accurate", "no edit", "complete", "fine", "nothing", "requires no", "consistent"], min_chars: 6 },
    strata: ["no-op-discipline"],
  },

  // ===================== sequences: read -> decide -> act -> verify (6) =====================
  {
    id: "seq-cost-reconcile",
    operation: "sequence",
    fixture: COST,
    prompt: "Read the report. One labor cost figure in the Cost Summary contradicts the stated invoice total. Decide which figure is wrong, propose a replacement so it matches the invoice total of $40,000, then confirm in chat what you changed.",
    target: { quoted_text: "$42,500", occurrence_index: 2 },
    sequence: {
      min_annotation_count: 1,
      must_anchor: { quoted_text: "$42,500", occurrence_index: 2, acceptable_anchors: [{ quoted_text: "The labor cost figure is $42,500 for the quarter, which appears inconsistent with the stated invoice total of $40,000.", occurrence_index: 1 }] },
      must_suggest: "40[,.]?000",
      chat_must_match_any: ["40,000", "40000", "invoice", "match", "reconcile", "changed", "replac"],
    },
    strata: ["read-decide-act-verify", "number-update"],
  },
  {
    id: "seq-prod-launch-risk",
    operation: "sequence",
    fixture: PROD,
    prompt: "Read the planning notes. Decide which scoped feature most threatens the launch date, comment on it explaining the risk, then summarize your concern in chat.",
    target: { quoted_text: "The offline mode is the largest effort and carries the most risk.", acceptable_anchors: [{ quoted_text: "offline mode", occurrence_index: 1 }, { quoted_text: "It is unclear whether offline mode can be completed by April 15, 2026." }] },
    sequence: {
      min_annotation_count: 1,
      must_anchor: { quoted_text: "The offline mode is the largest effort and carries the most risk.", acceptable_anchors: [{ quoted_text: "offline mode", occurrence_index: 1 }, { quoted_text: "It is unclear whether offline mode can be completed by April 15, 2026." }] },
      chat_must_match_any: ["offline", "risk", "sync", "slip", "launch", "date"],
    },
    strata: ["read-decide-act-verify", "inferential"],
  },
  {
    id: "seq-res-overcited",
    operation: "sequence",
    fixture: RES,
    prompt: "Read the brief. A single statistic is over-relied upon despite a narrow sample. Comment on the most-cited statistic flagging the limitation, then explain your reasoning in chat.",
    target: { quoted_text: "13% productivity gain", occurrence_index: 1, acceptable_anchors: [{ quoted_text: "The 13% productivity gain figure is frequently cited, though its sample was narrow.", occurrence_index: 1 }, { quoted_text: "13% productivity gain", occurrence_index: 2 }, { quoted_text: "13% productivity gain", occurrence_index: 3 }] },
    sequence: {
      min_annotation_count: 1,
      must_anchor: { quoted_text: "13% productivity gain", occurrence_index: 1, acceptable_anchors: [{ quoted_text: "13% productivity gain", occurrence_index: 2 }, { quoted_text: "13% productivity gain", occurrence_index: 3 }] },
      chat_must_match_any: ["sample", "narrow", "13", "generaliz", "single industry", "cited", "limit", "caution"],
    },
    strata: ["read-decide-act-verify", "inferential", "distractor"],
  },
  {
    id: "seq-cost-noop",
    operation: "sequence",
    fixture: COST,
    prompt: "Read the Appendix section. Decide whether it needs any changes. If it is consistent and complete, make NO annotations and say so in chat.",
    target: { quoted_text: "This section is consistent and complete." },
    sequence: { final_annotation_count: 0, chat_must_match_any: ["consistent", "complete", "no change", "nothing", "fine", "as-is", "as is"] },
    strata: ["read-decide-act-verify", "no-op-discipline"],
  },
  {
    id: "seq-prod-noop",
    operation: "sequence",
    fixture: PROD,
    prompt: "Read the final Notes section. Decide whether it needs changes. If not, make NO annotations and confirm in chat that it is fine as-is.",
    target: { quoted_text: "This section needs no changes and is left as-is." },
    sequence: { final_annotation_count: 0, chat_must_match_any: ["no change", "fine", "as-is", "as is", "nothing", "leave", "consistent"] },
    strata: ["read-decide-act-verify", "no-op-discipline"],
  },
  {
    id: "seq-cost-multi",
    operation: "sequence",
    fixture: COST,
    prompt: "Read the report. Find the labor-cost contradiction in the Cost Summary AND comment that the same labor cost figure is still listed as an unreconciled risk. Leave a comment on each of the two places, then summarize both in chat.",
    target: { quoted_text: "The labor cost figure is $42,500 for the quarter, which appears inconsistent with the stated invoice total of $40,000.", occurrence_index: 1, acceptable_anchors: [{ quoted_text: "A secondary risk is the labor cost figure, which is still unreconciled." }] },
    sequence: {
      min_annotation_count: 2,
      must_anchor: { quoted_text: "The labor cost figure is $42,500 for the quarter, which appears inconsistent with the stated invoice total of $40,000.", occurrence_index: 1, acceptable_anchors: [{ quoted_text: "A secondary risk is the labor cost figure, which is still unreconciled." }] },
      chat_must_match_any: ["risk", "unreconcil", "contradic", "invoice", "two", "both", "labor"],
    },
    strata: ["read-decide-act-verify", "multi-target"],
  },

  // ===================== 50-page envelope (separate gating column) =====================
  // includeText is OFF for envelope (batch passes envelope=true) — the model must
  // navigate via get_outline + read_section. Targets seeded at controlled depths.
  {
    id: "env-comment-early-figure",
    operation: "comment",
    fixture: ENV,
    envelope: true,
    prompt: "Somewhere early in this long document a material cost figure is flagged for review. Find it and comment on it.",
    target: { quoted_text: "Material costs in this division were $73,400, which is flagged for review.", acceptable_anchors: [{ quoted_text: "$73,400" }] },
    content_assertion: { must_match_any: ["material", "73,400", "73400", "cost", "review", "figure"], min_chars: 6 },
    strata: ["envelope", "depth:early", "windowed-read"],
  },
  {
    id: "env-comment-late-date",
    operation: "comment",
    fixture: ENV,
    envelope: true,
    prompt: "This long document mentions a final sign-off deadline (related to the audit). Find it and comment that it is pending the audit.",
    target: { quoted_text: "The final sign-off deadline is September 30, 2026, pending the audit.", acceptable_anchors: [{ quoted_text: "September 30, 2026" }] },
    content_assertion: { must_match_any: ["sign-off", "sign off", "deadline", "audit", "september", "pending"], min_chars: 8 },
    strata: ["envelope", "depth:late", "windowed-read"],
  },
  {
    id: "env-comment-variance-occ2",
    operation: "comment",
    fixture: ENV,
    envelope: true,
    prompt: "The sentence about a $5,000 quarterly variance appears in more than one section. Comment on the one in the 'Forecast Accuracy' section.",
    target: { quoted_text: "The quarterly variance is $5,000 in this region, which warrants a closer look.", occurrence_index: 2 },
    content_assertion: { must_match_any: ["variance", "5,000", "5000", "region", "forecast", "closer look"], min_chars: 8 },
    strata: ["envelope", "occurrence-at-scale"],
  },
  {
    id: "env-chat-deadline",
    operation: "chat",
    fixture: ENV,
    envelope: true,
    prompt: "What is the final sign-off deadline stated in this document? Answer in chat.",
    target: { quoted_text: "September 30, 2026" },
    content_assertion: { must_match_any: ["september 30", "sept 30", "9/30", "2026"], min_chars: 4 },
    strata: ["envelope", "depth:late", "must-cite"],
  },
  {
    id: "env-replace-budget-contradiction",
    operation: "replacement",
    fixture: ENV,
    envelope: true,
    prompt: "This document states two different total budgets: an early plan figure and a revised plan figure. Update the EARLY plan figure so it matches the revised figure of $1,500,000.",
    target: { quoted_text: "$1,200,000", acceptable_anchors: [{ quoted_text: "The total budget for the year is $1,200,000 according to the early plan." }] },
    replacement_assertion: { must_match: "1[,.]?500[,.]?000", must_not_match: "1[,.]?200[,.]?000" },
    strata: ["envelope", "cross-section-contradiction", "depth:early"],
  },
  {
    id: "env-sequence-budget",
    operation: "sequence",
    fixture: ENV,
    envelope: true,
    prompt: "Read this long report. It states two conflicting total-budget figures (an early plan and a revised plan). Decide which is outdated, comment on the early-plan figure flagging the conflict, then summarize the discrepancy in chat.",
    target: { quoted_text: "$1,200,000", acceptable_anchors: [{ quoted_text: "The total budget for the year is $1,200,000 according to the early plan." }] },
    sequence: {
      min_annotation_count: 1,
      must_anchor: { quoted_text: "$1,200,000", acceptable_anchors: [{ quoted_text: "The total budget for the year is $1,200,000 according to the early plan." }] },
      chat_must_match_any: ["1,500,000", "1,200,000", "1.5", "1.2", "revised", "conflict", "discrepan", "budget"],
    },
    strata: ["envelope", "read-decide-act-verify", "cross-section-contradiction"],
  },
];

export function listFixtures(): string[] {
  return [...new Set(SCENARIOS.map((s) => s.fixture))];
}
