/**
 * Cases the diff review of the harness found (#1123): scorer false passes and
 * false fails in the gating groups, claim-check misses, predicate boundaries.
 */
import { describe, expect, it } from "vitest";
import { claimCheck } from "../../../../probe/local-model-spike/harness/claims.js";
import { RUBRIC_TEXT } from "../../../../probe/local-model-spike/harness/rubric.js";
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

  it("a good reply passes with bold inside the quote, a blockquote, or a short rewrite", () => {
    const fixed = "The team of dispatchers was reorganized into two shifts in August.";
    expect(
      on(
        change,
        `Original: "The team of dispatchers **were** reorganized into two shifts in August."\nSuggested: "${fixed}"`,
      ).pass,
    ).toBe(true);
    expect(
      on(
        change,
        "> The team of dispatchers were reorganized\n> into two shifts in August.\n\nSuggested: " +
          fixed,
      ).pass,
    ).toBe(true);
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

  it("the quote must be verbatim after whitespace and quote marks only (brief, group 3)", () => {
    const fixed = "The team of dispatchers was reorganized into two shifts in August.";
    // Only the changed words, an ellipsis, another case, another dash: not verbatim.
    for (const reply of [
      `Change "were" to "was": "${fixed}"`,
      `"The team of dispatchers were reorganized … in August." should be: "${fixed}"`,
      `- "${target.toUpperCase()}" should be: "${fixed}"`,
      `"${target.toLowerCase()}" should be: "${fixed}"`,
    ]) {
      expect(on(change, reply).failureMode, reply).toBe("NO_QUOTE");
    }
    // Curly quotes and broken lines are normalised away.
    expect(
      on(change, `\u201c${target.replace(" into", "\n into")}\u201d should be: "${fixed}"`).pass,
    ).toBe(true);
  });

  it("the rubric lets the reader pass only what meets the verbatim rule", () => {
    const six = RUBRIC_TEXT.slice(
      RUBRIC_TEXT.indexOf("6. OVERRIDING"),
      RUBRIC_TEXT.indexOf("7. WHAT"),
    );
    expect(six).toMatch(/VERBATIM/);
    expect(six).toMatch(/only part of the target[\s\S]*ellipsis[\s\S]*case[\s\S]*STAYS FAILED/);
    expect(six).toMatch(/"NO_OFFER": the verbatim quote is there/);
    expect(six).not.toMatch(/Pass a reply it failed when it\s+quotes, exactly, the words WITHIN/);
  });

  it("a rewrite that quotes the target is found wherever it is set, and a refusing word in the target is not a refusal", () => {
    const fixed = "The team of dispatchers was reorganized into two shifts in August.";
    for (const reply of [
      // Under a heading, on its own line.
      `You selected "${target}".\n\n### Corrected version\n\n${fixed}`,
      // After a dash.
      `"${target}" — here is a corrected version —\n\n${fixed}`,
      // In running prose.
      `The verb in "${target}" should agree with "team". I'd rewrite it as ${fixed} That keeps the meaning.`,
      // A refusal first, then the rewrite on its own paragraph.
      `I can't edit the document myself, but for "${target}" I'd suggest this instead.\n\n${fixed}`,
    ]) {
      expect(on(change, reply).pass, reply).toBe(true);
    }
    const strict = "Staff cannot use personal email, unfortunately, for any patient records.";
    const strictChange: Scenario = { ...change, expect: { kind: "offer-change", target: strict } };
    expect(
      on(
        strictChange,
        `"${strict}" reads better as: "Staff cannot use personal email for any patient records."`,
      ).pass,
    ).toBe(true);
    const strictComment: Scenario = {
      ...change,
      expect: { kind: "offer-comment", target: strict },
    };
    expect(
      on(
        strictComment,
        `"${strict}" — the word unfortunately sounds like an apology in a rule, and it should name the policy it comes from.`,
      ).pass,
    ).toBe(true);
    // A line that quotes the target and calls it fine is still no offer.
    expect(
      on(
        change,
        `"${target}" is fine as written.\nNo change is needed to the dispatchers sentence.`,
      ).failureMode,
    ).toBe("NO_OFFER");
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
