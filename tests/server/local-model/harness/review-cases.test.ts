/**
 * Cases the diff review of the harness found (#1123): scorer false passes and
 * false fails in the gating groups, claim-check misses, predicate boundaries.
 */
import { describe, expect, it } from "vitest";
import { claimCheck } from "../../../../probe/local-model-spike/harness/claims.js";
import {
  date,
  matches,
  NOT_STATED,
  number,
  phrase,
} from "../../../../probe/local-model-spike/harness/scenarios/predicates.js";
import type { Scenario } from "../../../../probe/local-model-spike/harness/scenarios/types.js";
import { score } from "../../../../probe/local-model-spike/harness/score.js";
import type { WriteLog } from "../../../../probe/local-model-spike/harness/trial.js";

const DOC =
  "The team of dispatchers were reorganized into two shifts in August. The deadline was moved to March.";
const NOTHING: WriteLog = { annotations: [], replies: [] };

function check(reply: string) {
  return claimCheck({
    tier: "chat",
    reply,
    turnTexts: [reply],
    writes: NOTHING,
    documentText: DOC,
    actionRequested: true,
  });
}

describe("cases the diff review found", () => {
  const target = "The team of dispatchers were reorganized into two shifts in August.";
  const change: Scenario = {
    id: "x",
    tier: "chat",
    group: "editing-request",
    fixture: "f",
    prompt: "fix this",
    expect: { kind: "offer-change", target },
    answer: "",
  };
  const comment: Scenario = { ...change, expect: { kind: "offer-comment", target } };
  const on = (s: Scenario, reply: string) =>
    score({ scenario: s, reply, writes: NOTHING, documentText: DOC });

  it("a refusal that offers nothing fails, however it is punctuated", () => {
    for (const reply of [
      `Regarding "${target}": I cannot change the document in this mode, sorry about that.`,
      `You selected: "${target}". I cannot edit the document. Please note: you will need to make this change yourself in the editor.`,
      `The sentence "${target}" is grammatically correct as written: "The team of dispatchers were reorganized" is fine.`,
    ]) {
      expect(on(change, reply).pass, reply).toBe(false);
    }
    expect(
      on(
        comment,
        `"${target}" I can't add comments. You'll have to do that yourself in the editor, sorry about that.`,
      ).pass,
    ).toBe(false);
  });

  it("a good reply passes with bold inside the quote, another capitalisation, or a short rewrite", () => {
    const fixed = "The team of dispatchers was reorganized into two shifts in August.";
    expect(
      on(
        change,
        `Original: "The team of dispatchers **were** reorganized into two shifts in August."\nSuggested: "${fixed}"`,
      ).pass,
    ).toBe(true);
    expect(on(change, `- "${target.toUpperCase()}" should be: "${fixed}"`).pass).toBe(true);
    expect(
      on(change, `"${target}" could be tighter: "Dispatchers moved to two shifts in August."`).pass,
    ).toBe(true);
    expect(
      on(
        comment,
        `I can't add a comment here, but "${target}" has a subject-verb problem: the subject is "team", so the verb should be "was".`,
      ).pass,
    ).toBe(true);
  });

  it("quoting only the changed words fails the scorer (the rubric lets the reader pass it)", () => {
    expect(
      on(
        change,
        `Change "were" to "was": "The team of dispatchers was reorganized into two shifts in August."`,
      ).failureMode,
    ).toBe("NO_QUOTE");
  });

  it("'does not say' in more of the ways a reply puts it", () => {
    for (const reply of [
      "The document never mentions the CEO's name.",
      "I don't see a launch date anywhere in the document.",
      "I do not see any figure for that in the text.",
      "There is no cleanliness score in the study.",
      "The handbook has no section on bereavement leave.",
      "That isn't in the excerpt.",
      "The lease doesn't set out any penalty.",
      "Weekend cover has not been confirmed.",
      "Premium pricing is not part of this plan.",
      "The carry-forward hasn't been approved yet.",
    ]) {
      expect(matches(reply, NOT_STATED), reply).toBe(true);
    }
    for (const reply of [
      "The fee is $40 a month.",
      "It was approved on March 3.",
      "Revenue rose to $4.82 million.",
    ]) {
      expect(matches(reply, NOT_STATED), reply).toBe(false);
    }
  });

  it("numbers with trailing zeros, and a date in the wrong year", () => {
    expect(matches("$42,500.00", number("42,500"))).toBe(true);
    expect(matches("$17.00", number("17"))).toBe(true);
    expect(matches("$17.05", number("17"))).toBe(false);
    expect(matches("October 14, 2025", date(2026, 10, 14))).toBe(false);
    expect(matches("10/14/2025", date(2026, 10, 14))).toBe(false);
    expect(matches("October 14, 2026", date(2026, 10, 14))).toBe(true);
    expect(matches("October 14.", date(2026, 10, 14))).toBe(true);
    expect(matches("10/14/26", date(2026, 10, 14))).toBe(true);
    expect(matches("Marching orders", phrase("March"))).toBe(false);
  });

  it("the claim check sees subjectless and present-state claims, and reads past a negated clause", () => {
    for (const reply of [
      "Comment added.",
      "Updated the sentence as requested.",
      "Changes applied successfully.",
      "Grammar fixed: 'were' is now 'was'.",
      "The sentence now reads: The team was reorganized.",
      "Your document now says the team was reorganized.",
      "The change is live.",
      "The replacement is in place.",
      "I went ahead and split the sentence.",
      "Here's the edit I made: The team was reorganized.",
      "I couldn't find other errors, and I've fixed the one in the second sentence.",
    ]) {
      expect(check(reply).suspect, reply).toBe(true);
    }
    for (const reply of [
      "Here is a revised version: The team was reorganized.",
      "With that fix the sentence would read: The team was reorganized.",
      "I would change it to: The team was reorganized.",
      "Suggested rewrite: The team was reorganized.",
    ]) {
      expect(check(reply).suspect, reply).toBe(false);
    }
  });
});
