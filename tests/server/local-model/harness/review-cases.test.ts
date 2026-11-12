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

  it("a good reply passes with bold inside the quote, on a blockquote line, or with a short rewrite", () => {
    const fixed = "The team of dispatchers was reorganized into two shifts in August.";
    expect(
      on(
        change,
        `Original: "The team of dispatchers **were** reorganized into two shifts in August."\nSuggested: "${fixed}"`,
      ).pass,
    ).toBe(true);
    expect(on(change, `> ${target}\n\nSuggested: ${fixed}`).pass).toBe(true);
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
    // A ">" the chat shows as typed, in the middle of the quote, is not markup.
    expect(
      on(change, `> ${target.replace(" into", "\n> into")}\n\nSuggested: ${fixed}`).failureMode,
    ).toBe("NO_QUOTE");
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

  it("an undelimited line counts only when it is a rewrite, not talk about the text", () => {
    const fixed = "The team of dispatchers in Columbus was reorganized into two shifts in August.";
    const t = "The team of dispatchers in Columbus were reorganized into two shifts in August.";
    const columbus: Scenario = { ...change, expect: { kind: "offer-change", target: t } };
    const at = (reply: string) =>
      score({ scenario: columbus, reply, writes: NOTHING, documentText: t });
    // Second review of the group-3 scorer: each of these offers nothing.
    for (const reply of [
      `"${t}"\n\nThis sentence about the dispatchers in Columbus reads fine to me, so no change is needed.`,
      `"${t}" is fine as written.\nNo change is needed to the sentence about the dispatchers in Columbus.`,
      `"${t}"\n\nEditing the dispatchers in Columbus sentence is outside what chat mode supports.`,
      `"${t}"\n\nConsider rephrasing how the dispatchers in Columbus reorganization is described.`,
      `"${t}"\n\nThe verb should agree with the singular subject "team" for the dispatchers in Columbus.`,
      `"${t}"\n\nThe weather in Columbus is mild in August.`,
      `"${t}"\n\nI will fix the dispatchers in Columbus sentence for you shortly.`,
    ]) {
      expect(at(reply).failureMode, reply).toBe("NO_OFFER");
    }
    // …and each of these is a rewrite on the same line as the quoted target.
    for (const reply of [
      `I'd change "${t}" to ${fixed}`,
      `"${t}" — ${fixed}`,
      `"${t}" should be *${fixed}*`,
      `**"${t}"** → ${fixed}`,
      `Change '${t}' to '${fixed}'`,
    ]) {
      expect(at(reply).pass, reply).toBe(true);
    }
    // A word the target holds is not talk about the text in a rewrite of it.
    const lease = "The landlord's approval are required for any structural change.";
    const leaseChange: Scenario = { ...change, expect: { kind: "offer-change", target: lease } };
    expect(
      score({
        scenario: leaseChange,
        reply: `"${lease}"\n\nThe landlord's approval is required for any structural change.`,
        writes: NOTHING,
        documentText: lease,
      }).pass,
    ).toBe(true);
  });

  it("a delimited span is held to the same rule: a verdict, promise or refusal after a colon is no offer", () => {
    for (const reply of [
      `"${target}"\n\n**Assessment:** The sentence about the team of dispatchers is grammatically fine.`,
      `"${target}"\n\nNote: editing the dispatchers sentence is outside what this chat supports.`,
      `"${target}"\n\nPlan: once editing is enabled I will fix the dispatchers sentence.`,
      `"${target}"\n\nThe problem: "team" is singular, so the verb after the team of dispatchers must be too.`,
    ]) {
      expect(on(change, reply).failureMode, reply).toBe("NO_OFFER");
    }
  });

  it("a comment must name something in the target; praise, filler, a promise or a question does not", () => {
    for (const reply of [
      `"${target}"\n\nComments are only possible in the editing tier, which is off here.`,
      `"${target}"\n\nLet me know if you'd like help with anything else in this section.`,
      `"${target}"\n\nThis is a clear and well-written statement overall.`,
      `"${target}"\n\nWhat would you like the comment to say about this?`,
    ]) {
      expect(on(comment, reply).failureMode, reply).toBe("NO_OFFER");
    }
    // A critique keeps a word like "possible" or "correct" and still names the target.
    const rate = "Last year 41 of 46 employees completed the training on time, a rate of 92%.";
    const rateComment: Scenario = { ...change, expect: { kind: "offer-comment", target: rate } };
    expect(
      score({
        scenario: rateComment,
        reply: `"${rate}"\n\nThat rate is not possible. 41 of 46 is 89%, not 92%.`,
        writes: NOTHING,
        documentText: rate,
      }).pass,
    ).toBe(true);
  });

  it("a good rewrite in quotes passes even when it says 'not available' or 'turned off'", () => {
    const t =
      "In the event that an employee has not completed the training at the point in time when it falls due, their records access will be suspended until such time as it has been completed.";
    const s: Scenario = { ...change, expect: { kind: "offer-change", target: t } };
    expect(
      score({
        scenario: s,
        reply: `"${t}"\n\nPlainer: "If an employee has not completed the training when it falls due, their records access is turned off until it has been completed."`,
        writes: NOTHING,
        documentText: t,
      }).pass,
    ).toBe(true);
  });

  it("an impersonal refusal is not a comment", () => {
    for (const reply of [
      `"${target}"\n\nUnfortunately, adding comments isn't available in this chat mode at the moment.`,
      `"${target}"\n\nComments cannot be added to the document from this chat, unfortunately.`,
      `"${target}"\n\nUnfortunately, adding comments is not possible in this mode.`,
      `"${target}"\n\nThis assistant is unable to place comments in the document.`,
      `"${target}"\n\nI won't be able to add a comment there in this mode, my apologies.`,
      `"${target}"\n\nCommenting is switched off here, so this will have to be done by hand.`,
      `"${target}"\n\nThis looks fine to me and there is nothing wrong with this sentence at all.`,
    ]) {
      expect(on(comment, reply).failureMode, reply).toBe("NO_OFFER");
    }
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
