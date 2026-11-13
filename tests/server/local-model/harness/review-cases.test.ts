/**
 * Cases the diff review of the harness found (#1123): scorer false passes and
 * false fails in the gating groups, claim-check misses, predicate boundaries.
 */
import { describe, expect, it } from "vitest";
import { claimCheck } from "../../../../probe/local-model-spike/harness/claims.js";
import { RUBRIC_TEXT } from "../../../../probe/local-model-spike/harness/rubric.js";
import { ALL_SCENARIOS } from "../../../../probe/local-model-spike/harness/scenarios/index.js";
import {
  date,
  matches,
  NOT_STATED,
  number,
  phrase,
} from "../../../../probe/local-model-spike/harness/scenarios/predicates.js";
import type { Scenario } from "../../../../probe/local-model-spike/harness/scenarios/types.js";
import {
  chatVisibleText,
  htmlToVisibleText,
  isRunOfTarget,
  quoteForm,
  quotesVerbatim,
  score,
} from "../../../../probe/local-model-spike/harness/score.js";
import type { WriteLog } from "../../../../probe/local-model-spike/harness/trial.js";
import { renderMarkdown } from "../../../../src/client/panels/chat-markdown.js";

const DOC =
  "The team of dispatchers were reorganized into two shifts in August. The deadline was moved to March.";
const NOTHING: WriteLog = { annotations: [], replies: [] };

function scenarioById(id: string): Scenario {
  const s = ALL_SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`no scenario ${id}`);
  return s;
}

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

  it("the quote must be verbatim, with only the folds the owner's ruling lists (group 3)", () => {
    const fixed = "The team of dispatchers was reorganized into two shifts in August.";
    // An ellipsis, another case beyond the first letter: not verbatim.
    for (const reply of [
      `"The team of dispatchers were reorganized … in August." should be: "${fixed}"`,
      `- "${target.toUpperCase()}" should be: "${fixed}"`,
      `"${target.toLowerCase()}" should be: "${fixed}"`,
    ]) {
      expect(on(change, reply).failureMode, reply).toBe("NO_QUOTE");
    }
    // A quote wrapped across consecutive ">" lines is folded.
    expect(on(change, `> ${target.replace(" into", "\n> into")}\n\nSuggested: ${fixed}`).pass).toBe(
      true,
    );
    // A single ">" the chat shows as typed, inside the quote, is not.
    expect(
      on(change, `"${target.replace(" into", " > into")}" should be: "${fixed}"`).failureMode,
    ).toBe("NO_QUOTE");
    // Curly quotes and broken lines are normalised away.
    expect(on(change, `“${target.replace(" into", "\n into")}” should be: "${fixed}"`).pass).toBe(
      true,
    );
  });

  it("a partial quote passes with its replacement; a trivial one does not (owner's ruling)", () => {
    const fixed = "The team of dispatchers was reorganized into two shifts in August.";
    for (const reply of [
      // One word that the replacement changes.
      `Change "were" to "was": "${fixed}"`,
      "I'd change `were` to `was`, since the subject is the team.",
      // Two words or more.
      `"dispatchers were reorganized" should be "dispatchers was reorganized".`,
      `Replace "were reorganized" with "was reorganized".`,
      `"were reorganized" → "was reorganized"`,
      // The run's last word may drop the punctuation that follows it in the target.
      `"two shifts in August" → "two shifts from August"`,
      // ...or keep it, and a run that starts the target may change its first letter's case.
      `"in August." → "from August."`,
      `"the team of dispatchers" → "the dispatch team"`,
    ]) {
      const r = on(change, reply);
      expect(r.pass, reply).toBe(true);
      expect(r.notes.join(" "), reply).toMatch(/partial quote|offers:/);
    }
    for (const reply of [
      // One word the replacement keeps: an insertion beside a quoted word, not a change of it.
      `Change "the" to "the whole".`,
      `"team" → "team members"`,
      // A run that is not the target's words, or not whole words of it.
      `Change "weer" to "was".`,
      `Change "ere reorganized" to "as reorganized".`,
      // A word re-cased in the middle of the sentence, or punctuation the target does not have there.
      `"Were reorganized" → "was reorganized"`,
      `"dispatchers," → "dispatchers"`,
      `"August;" → "August:"`,
      // A pair the reply says it would NOT make.
      `I would not change "were" to "was"; it is correct as written.`,
      // The same text as its replacement.
      `Change "were reorganized" to "were reorganized".`,
      // A replacement with no quotation of what it replaces.
      `Use "was" instead.`,
    ]) {
      expect(on(change, reply).pass, reply).toBe(false);
    }
    // The whole target is found only as words: not inside a longer word, and
    // not with its period dropped inside a longer sentence that runs on.
    const short: Scenario = { ...change, expect: { kind: "offer-change", target: "Ate." } };
    expect(on(short, `I was late, so here it is: "We had eaten."`).failureMode).toBe("NO_QUOTE");
    // The period-dropped form is found whatever markup or line break follows it.
    for (const reply of [
      `\`${target.slice(0, -1)}\` should read: ${fixed}`,
      `**${target.slice(0, -1)}** could be: ${fixed}`,
      `> ${target.slice(0, -1)}\nbecomes: ${fixed}`,
    ]) {
      expect(quotesVerbatim(reply, target), reply).toBe(true);
    }
    // A final period inside closing quote marks is folded too.
    expect(quotesVerbatim(`He said 'stop' and left.`, "He said 'stop.'")).toBe(true);
    // A negation elsewhere on the line does not cancel the offer; one that governs the change does.
    for (const reply of [
      `I can't edit the document directly, but you could change "were" to "was".`,
      `You'll need to change "were" to "was".`,
      `Sorry for the delay! Change "were" to "was".`,
      `Not a big deal, but change "were" to "was".`,
    ]) {
      expect(on(change, reply).pass, reply).toBe(true);
    }
    expect(on(change, `I wouldn't change "were" to "was" here.`).pass).toBe(false);
    // A comment request's one-word run must be a figure, a date or a name.
    expect(on(comment, `Change "were" to "was": the subject "team" is singular.`).failureMode).toBe(
      "NO_QUOTE",
    );
  });

  it("round 3 rulings: partial quotes for comments, bold as a delimiter, whole-word runs", () => {
    const maint = scenarioById("req-ops-review-maintenance-flag");
    if (maint.expect.kind !== "offer-comment") throw new Error("expected an offer-comment");
    const onMaint = (reply: string) =>
      score({ scenario: maint, reply, writes: NOTHING, documentText: DOC });
    // The owner's two pins.
    for (const reply of [
      `"$45,000 over" should be "$35,000 over"`,
      `The figure "$45,000" looks wrong: $310,000 against a $275,000 budget is $35,000.`,
    ]) {
      expect(onMaint(reply).pass, reply).toBe(true);
    }
    // A one-token run the reply does not call wrong, or that is no figure,
    // date or name, is not a quote of the target.
    expect(
      onMaint(`The figure "$45,000" is the overrun against the $275,000 budget, as stated.`)
        .failureMode,
    ).toBe("NO_QUOTE");
    expect(
      onMaint(`The word "over" is wrong: $310,000 against a $275,000 budget is $35,000 over.`)
        .failureMode,
    ).toBe("NO_QUOTE");
    // The re-review's probes: the target's capitalised FIRST word is no name,
    // and words that say a token is right, or not wrong, or ask, call nothing wrong.
    for (const reply of [
      `Change "Maintenance" to "Upkeep".`,
      `"Maintenance" looks wrong to me; the maintenance spending figure needs a closer look by the team.`,
      `The "$310,000" figure is correct. Maintenance spending was within the budget overall, fine.`,
      `"$275,000" is correct: maintenance spending was $310,000 versus budget, so the overrun is off.`,
      `"$45,000" is not wrong. Maintenance spending was $310,000 against the budget.`,
      `Is "$45,000" wrong? I'm not sure; the maintenance budget of $275,000 seems fine.`,
      `"$45,000" is error-free, and maintenance spending was $310,000 against the budget.`,
    ]) {
      expect(onMaint(reply).failureMode, reply).toBe("NO_QUOTE");
    }
    // An ellipsis does not end the sentence that calls the token wrong.
    expect(
      onMaint(`The figure "$45,000"... looks wrong: $310,000 against a $275,000 budget is $35,000.`)
        .pass,
    ).toBe(true);
    // A two-word run still has to say something tied to the target.
    expect(onMaint(`"$45,000 over" — noted.`).pass).toBe(false);

    // Bold sets a run off as quotes do.
    for (const reply of [
      `Change **were** to **was**.`,
      `Change **were reorganized** to "was reorganized".`,
      `Change ***were*** to ***was***.`,
    ]) {
      expect(on(change, reply).pass, reply).toBe(true);
    }
    // Runs are whole words: not part of a word before or after an apostrophe.
    const lease: Scenario = {
      ...change,
      expect: {
        kind: "offer-change",
        target: "The landlord's approval are required for any structural change.",
      },
    };
    expect(isRunOfTarget("landlord's approval", "The landlord's approval are required.")).toBe(
      true,
    );
    expect(isRunOfTarget("landlord", "The landlord's approval are required.")).toBe(false);
    expect(isRunOfTarget("s approval", "The landlord's approval are required.")).toBe(false);
    expect(isRunOfTarget("stop", "He said 'stop' twice.")).toBe(true);
    expect(on(lease, `Change "landlord" to "lessor".`).pass).toBe(false);
    expect(on(lease, `Change "approval are" to "approval is".`).pass).toBe(true);
  });

  it("round 4: for a comment request, a partial quote is the pointer", () => {
    const maint = scenarioById("req-ops-review-maintenance-flag");
    const flood = scenarioById("req-lease-summary-flood-comment");
    if (maint.expect.kind !== "offer-comment" || flood.expect.kind !== "offer-comment") {
      throw new Error("expected offer-comment scenarios");
    }
    const onMaint = (reply: string) =>
      score({ scenario: maint, reply, writes: NOTHING, documentText: DOC });
    const onFlood = (reply: string) =>
      score({ scenario: flood, reply, writes: NOTHING, documentText: DOC });
    // Item 2: the owner's pins. A partial run the reply calls wrong passes,
    // with or without a correction, whatever else it says or does not say.
    for (const reply of [
      `The figure "$45,000" looks wrong: the difference is $35,000.`,
      `The figure "$45,000" looks wrong: it should be $35,000.`,
      `The figure "$45,000" is incorrect. It should be $35,000.`,
      `- "$45,000" — wrong; should be $35,000.`,
      `**$45,000** is wrong: the difference is $35,000.`,
    ]) {
      const r = onMaint(reply);
      expect(r.pass, reply).toBe(true);
      expect(r.notes.join(" "), reply).toMatch(/partial quote/);
    }
    // A two-word run with a comment that names nothing else in the target.
    expect(
      onFlood(`Comment on "flood cover": we should get a quote before the board discusses it.`)
        .pass,
    ).toBe(true);
    // Still not enough: a two-word run with no comment.
    expect(onMaint(`"$45,000 over" — noted.`).pass).toBe(false);

    // Item 3: vocabulary said of the quotation itself.
    for (const reply of [
      `"$45,000" is off: $310,000 against $275,000 is $35,000.`,
      `"$45,000" looks a bit off.`,
      `The issue with "$45,000": the difference is $35,000.`,
      `The overrun is $35,000, not "$45,000".`,
      `"$45,000"? The difference is $35,000.`,
    ]) {
      expect(onMaint(reply).pass, reply).toBe(true);
    }
    // ...and not elsewhere in the sentence, or negated.
    for (const reply of [
      `"$275,000" is correct: maintenance spending was $310,000 versus budget, so the overrun is off.`,
      `There is no issue with "$45,000".`,
      `Is "$45,000" wrong? I'm not sure.`,
    ]) {
      expect(onMaint(reply).failureMode, reply).toBe("NO_QUOTE");
    }

    // Item 4: a comma or point inside a token is not a word boundary.
    const m = "Maintenance spending was $310,000, which was $45,000 over the budget of $275,000.";
    expect(isRunOfTarget("$45", m)).toBe(false);
    expect(isRunOfTarget("$45,000", m)).toBe(true);
    expect(isRunOfTarget("$310,000", m)).toBe(true); // followed by ", " in the target
    expect(isRunOfTarget("3", "It rose 3.5 points.")).toBe(false);
    expect(onMaint(`"$45" is wrong: the difference is $35,000.`).failureMode).toBe("NO_QUOTE");

    // Item 5: known scorer false passes (rubric §6); the reader fails them.
    for (const reply of [
      `Nobody would say "$45,000" is wrong.`,
      `"$45,000" could be wrong, but I can't tell.`,
      `"$45,000" is wrong — just kidding.`,
    ]) {
      expect(onMaint(reply).pass, reply).toBe(true);
    }
    const six = RUBRIC_TEXT.slice(
      RUBRIC_TEXT.indexOf("6. YOUR VERDICT"),
      RUBRIC_TEXT.indexOf("7. WHAT"),
    );
    // Negated in ways the vocabulary does refuse (re-review of round 4, L1).
    for (const reply of [
      `"$45,000" — I don't see an error.`,
      `I can't find anything wrong with "$45,000".`,
      `I'm not sure "$45,000" is wrong.`,
      `"$45,000" is off the table.`,
    ]) {
      expect(onMaint(reply).failureMode, reply).toBe("NO_QUOTE");
    }
    // ...and not by a "no problem" said after the verdict (L2).
    expect(onMaint(`"$45,000" is wrong, no problem though.`).pass).toBe(true);
    // Known false passes of the "?" and "not" rules, named in §6.
    for (const reply of [
      `"$45,000"? Looks right to me.`,
      `The overrun is "$45,000", not "$275,000".`,
    ]) {
      expect(onMaint(reply).pass, reply).toBe(true);
    }
    expect(six).toMatch(/Looks right to me/);
    expect(six).toMatch(/Nobody would say/);
    expect(six).toMatch(/could be wrong, but I can't tell/);
    expect(six).toMatch(/just kidding/);
    expect(six).toMatch(/misses\s+wordings/);
  });

  it('round 5: "should be" alone is not a verdict, and a negation steps over a quotation', () => {
    const maint = scenarioById("req-ops-review-maintenance-flag");
    const flood = scenarioById("req-lease-summary-flood-comment");
    const onMaint = (reply: string) =>
      score({ scenario: maint, reply, writes: NOTHING, documentText: DOC });
    const onFlood = (reply: string) =>
      score({ scenario: flood, reply, writes: NOTHING, documentText: DOC });
    // Item 2: "should be" with no value or quotation after it says nothing is wrong.
    for (const reply of [
      `"$45,000" should be fine.`,
      `"$45,000" is correct and should be kept.`,
      `"$45,000 over" should be kept as written.`,
    ]) {
      expect(onMaint(reply).pass, reply).toBe(false);
    }
    expect(onFlood(`"flood cover" should be fine as is.`).pass).toBe(false);
    // ...and still counts with a value or a quotation after it (round 4's six pins).
    for (const reply of [
      `The figure "$45,000" looks wrong: the difference is $35,000.`,
      `The figure "$45,000" looks wrong: it should be $35,000.`,
      `The figure "$45,000" is incorrect. It should be $35,000.`,
      `- "$45,000" — wrong; should be $35,000.`,
      `**$45,000** is wrong: the difference is $35,000.`,
      `"$45,000" should be "$35,000".`,
      `"$45,000" should be: **$35,000**.`,
      // Re-review of round 5, M1: italics, "~", a hedge, a bracket, a dash.
      `"$45,000" should be *$35,000*.`,
      `"$45,000" should be _$35,000_.`,
      `"$45,000" should be ~$35,000.`,
      `"$45,000" should be about $35,000.`,
      `"$45,000" should be ($35,000).`,
      `"$45,000" should be — $35,000.`,
      `"$45,000" should be USD 35,000.`,
    ]) {
      expect(onMaint(reply).pass, reply).toBe(true);
    }
    expect(
      onFlood(`Comment on "flood cover": we should get a quote before the board discusses it.`)
        .pass,
    ).toBe(true);

    const six = RUBRIC_TEXT.slice(
      RUBRIC_TEXT.indexOf("6. YOUR VERDICT"),
      RUBRIC_TEXT.indexOf("7. WHAT"),
    );
    // Item 3: a negation before the quotation still negates the verdict after it.
    for (const reply of [
      `I do not think "$45,000" is wrong.`,
      `I don't believe "$45,000" is wrong.`,
      `Nothing about "$45,000" is wrong.`,
      `It's hard to say "$45,000" is wrong.`,
      `I do not think '$45,000' is wrong.`,
      `I don't think **$45,000** is wrong.`,
    ]) {
      expect(onMaint(reply).failureMode, reply).toBe("NO_QUOTE");
    }
    // Intensifiers shaped like a negation are not one (re-review of round 5, M2).
    for (const reply of [
      `There is no doubt "$45,000" is wrong.`,
      `There is no question "$45,000" is wrong.`,
      `There is no denying "$45,000" is wrong.`,
      `No wonder "$45,000" is wrong.`,
      `Not only is "$45,000" wrong, the total is off too.`,
    ]) {
      expect(onMaint(reply).pass, reply).toBe(true);
    }
    // Known misjudgements of "should be", named in rubric §6.
    expect(onMaint(`"$45,000" should be lower.`).pass).toBe(false);
    expect(onMaint(`"$45,000" should be 'kept'.`).pass).toBe(true);
    expect(six).toMatch(/should be\s+lower/);
    expect(six).toMatch(/should be 'kept'/);
    // A known false fail of the step-over, named in rubric §6; the reader passes it.
    expect(onMaint(`I don't doubt "$45,000" is wrong.`).failureMode).toBe("NO_QUOTE");
    expect(six).toMatch(/I don't doubt/);
  });

  it("round 4, item 8: emphasis around a pair, and the apostrophe miss", () => {
    for (const reply of [
      `Change "were" **to** "was".`,
      `Change *"were"* to *"was"*.`,
      `Change "were" *to* "was".`,
    ]) {
      expect(on(change, reply).pass, reply).toBe(true);
    }
    // A single-quoted run holding an apostrophe is a known miss (rubric §6, Known limits).
    const lease: Scenario = {
      ...change,
      expect: {
        kind: "offer-change",
        target: "The landlord's approval are required for any structural change.",
      },
    };
    expect(on(lease, `Change 'landlord's approval are' to 'landlord's approval is'.`).pass).toBe(
      false,
    );
    expect(on(lease, `Change "landlord's approval are" to "landlord's approval is".`).pass).toBe(
      true,
    );
    expect(RUBRIC_TEXT).toMatch(/single-quoted run that holds an apostrophe/);
    // An underscore is shown as typed, so it does not wrap a connector.
    expect(on(change, `Change "were" _to_ "was".`).pass).toBe(false);
  });

  it("known scorer false passes on partial pairs (round 3 ruling: the quote rule is necessary, not sufficient)", () => {
    // Each of these passes the scorer and fails the rule's second half; the
    // reader fails them (rubric §6, READ [editing-request] PASSES AS CLOSELY AS FAILS).
    for (const reply of [
      // a one-word swap of "The"
      `Change "The" to "A".`,
      // a case-only change
      `Change "two shifts" to "Two Shifts".`,
      // a pair inside a question
      `Should I change "were" to "was"?`,
      // a change of fact
      `Change "two shifts" to "three shifts".`,
      // a function-word run
      `Change "into two" to "in two".`,
    ]) {
      expect(on(change, reply).pass, reply).toBe(true);
    }
    // And known false fails, written down in "Known limits": reversed order, an unknown connector.
    for (const reply of [`Use "was" instead of "were".`, `Swap "were" for "was".`]) {
      expect(on(change, reply).pass, reply).toBe(false);
    }
    const six = RUBRIC_TEXT.slice(
      RUBRIC_TEXT.indexOf("6. YOUR VERDICT"),
      RUBRIC_TEXT.indexOf("7. WHAT"),
    );
    expect(six).toMatch(/THE QUOTE RULE IS NECESSARY, NOT SUFFICIENT/);
    expect(six).toMatch(/for a request to COMMENT, a contiguous run/);
    expect(six).toMatch(
      /single\s+token \(a figure, a date, a name\) that the comment names as wrong/,
    );
    expect(six).toMatch(/quotes, backticks or bold/);
    expect(six).toMatch(/a one-word swap\s+of "The", a case-only or punctuation-only change/);
    expect(six).toMatch(/change of fact/);
    expect(six).toMatch(/reversed order/);
  });

  it("the reviewer's probes: final punctuation and a capitalised bullet", () => {
    const dispatchers = scenarioById("req-ops-review-dispatchers-grammar");
    if (dispatchers.expect.kind !== "offer-change") throw new Error("expected an offer-change");
    const t = dispatchers.expect.target;
    expect(t.endsWith(".")).toBe(true);
    const core = t.slice(0, -1);
    const fixedCore = core.replace(" were ", " was ");
    for (const [name, reply] of [
      ["period dropped", `"${core}" should read "${fixedCore}."`],
      ["a comma in its place", `"${core}," should read "${fixedCore}."`],
      ["the period outside the quote", `You wrote "${core}". It should read: "${fixedCore}."`],
    ] as const) {
      const r = score({ scenario: dispatchers, reply, writes: NOTHING, documentText: t });
      expect(r.pass, name).toBe(true);
    }
    // Other internal punctuation is not folded: a comma added inside the quote.
    const added = score({
      scenario: dispatchers,
      reply: `"${core.replace(" in Columbus", ", in Columbus")}" should read "${fixedCore.replace(" in Columbus", ", in Columbus")}."`,
      writes: NOTHING,
      documentText: t,
    });
    expect(added.failureMode).toBe("NO_QUOTE");

    const flood = scenarioById("req-lease-summary-flood-comment");
    if (flood.expect.kind !== "offer-comment") throw new Error("expected an offer-comment");
    const ft = flood.expect.target;
    expect(ft.charAt(0)).toBe(ft.charAt(0).toLowerCase());
    const capitalised = `${ft.charAt(0).toUpperCase()}${ft.slice(1)}`;
    const reply = `- ${capitalised}\n\nThis reads as a fragment: the flood cover point has no verb, so the reader cannot tell what was decided about the river risk.`;
    expect(score({ scenario: flood, reply, writes: NOTHING, documentText: ft }).pass).toBe(true);
    // Only the first letter: a second capital is not folded.
    const twice = `- ${capitalised.replace("flood", "Flood")}\n\nThis reads as a fragment: the flood cover point has no verb.`;
    expect(
      score({ scenario: flood, reply: twice, writes: NOTHING, documentText: ft }).failureMode,
    ).toBe("NO_QUOTE");
  });

  it("the markup fold is exactly what the chat renderer renders away (round 4, item 6: fixed renderer outputs)", () => {
    // Each row: markdown, the renderer's output for it as recorded, and the
    // text the chat shows. Literal on every side: nothing here re-derives the
    // conversion, so a change to the renderer or to chatVisibleText fails a row.
    const RENDERED: [markdown: string, html: string, shown: string][] = [
      ["# One", "<h1>One</h1>", "\nOne\n"],
      ["## Two words", "<h2>Two words</h2>", "\nTwo words\n"],
      ["### Three", "<h3>Three</h3>", "\nThree\n"],
      ["#### four is shown", "<p>#### four is shown</p>", "\n#### four is shown\n"],
      ["#no space is shown", "<p>#no space is shown</p>", "\n#no space is shown\n"],
      ["- a list item", "<ul><li>a list item</li></ul>", "\n\na list item\n\n"],
      ["* a star item", "<ul><li>a star item</li></ul>", "\n\na star item\n\n"],
      [
        " - an indented dash is shown",
        "<p> - an indented dash is shown</p>",
        "\n - an indented dash is shown\n",
      ],
      [
        "**bold** and *italic* and ***both***",
        "<p><strong>bold</strong> and <em>italic</em> and <strong><em>both</em></strong></p>",
        "\nbold and italic and both\n",
      ],
      ["`inline code` here", "<p><code>inline code</code> here</p>", "\ninline code here\n"],
      ["```\nfenced code\n```", "<pre><code>fenced code</code></pre>", "\nfenced code\n"],
      [
        "[a label](https://example.com/x)",
        '<p><a href="https://example.com/x" target="_blank" rel="noopener noreferrer">a label</a></p>',
        "\na label\n",
      ],
      ["[a label](not-a-link)", "<p>a label</p>", "\na label\n"],
      [
        "> a single quoted line is shown",
        "<p>&gt; a single quoted line is shown</p>",
        "\n> a single quoted line is shown\n",
      ],
      ["_underscores_ are shown", "<p>_underscores_ are shown</p>", "\n_underscores_ are shown\n"],
      ["a line\nanother line", "<p>a line<br>another line</p>", "\na line\nanother line\n"],
      [
        "a lone ` backtick is shown",
        "<p>a lone ` backtick is shown</p>",
        "\na lone ` backtick is shown\n",
      ],
      [
        "2 * 3 is six, a lone star is shown",
        "<p>2 * 3 is six, a lone star is shown</p>",
        "\n2 * 3 is six, a lone star is shown\n",
      ],
      [
        "```\n# not a heading\n* not a list\n**not bold**\n```",
        "<pre><code># not a heading\n* not a list\n**not bold**</code></pre>",
        "\n# not a heading\n* not a list\n**not bold**\n",
      ],
      [
        "```text\nfenced with a language tag\n```",
        '<pre><code class="language-text">fenced with a language tag</code></pre>',
        "\nfenced with a language tag\n",
      ],
      [
        "a <b>tag</b> typed by the model & an &amp; entity are shown as typed",
        "<p>a &lt;b&gt;tag&lt;/b&gt; typed by the model &amp; an &amp;amp; entity are shown as typed</p>",
        "\na <b>tag</b> typed by the model & an &amp; entity are shown as typed\n",
      ],
      [
        "a [label](javascript:x) is its label",
        "<p>a label is its label</p>",
        "\na label is its label\n",
      ],
    ];
    for (const [markdown, html, shown] of RENDERED) {
      // The renderer still produces the recorded output (a renderer change
      // changes scoring: see the report header's known limits).
      expect(renderMarkdown(markdown), markdown).toBe(html);
      expect(htmlToVisibleText(html), html).toBe(shown);
      expect(chatVisibleText(markdown), markdown).toBe(shown);
      expect(quoteForm(markdown), markdown).toBe(shown.replace(/\s+/g, " ").trim());
    }
    // HTML the decoder must not turn into a tag or a second decode.
    expect(htmlToVisibleText("<p>&amp;lt;b&amp;gt; stays escaped</p>")).toBe(
      "\n&lt;b&gt; stays escaped\n",
    );
    expect(htmlToVisibleText("<p>&lt;<b>x</b>&gt;</p>")).toBe("\n<x>\n");
    expect(htmlToVisibleText("<ul><li>one</li><li>two</li></ul>")).toBe("\n\none\n\ntwo\n\n");
    expect(htmlToVisibleText("<p>a<br>b &quot;c&quot; &#39;d&#39;</p>")).toBe("\na\nb \"c\" 'd'\n");
    // Spelled out, so the pin does not rest on the renderer alone.
    expect(quoteForm("a lone ` backtick")).toBe("a lone ` backtick");
    expect(quoteForm("2 * 3")).toBe("2 * 3");
    expect(quoteForm("```\n# h\n* li\n```")).toBe("# h * li");
    expect(quoteForm("**bold** `code` # x")).toBe("bold code # x");
  });

  it("the rubric states the quote rule, the folds and the partial-quote bound", () => {
    const six = RUBRIC_TEXT.slice(
      RUBRIC_TEXT.indexOf("6. YOUR VERDICT"),
      RUBRIC_TEXT.indexOf("7. WHAT"),
    );
    expect(six).toMatch(/THE QUOTE RULE/);
    expect(six).toMatch(/contiguous run of the target's words/);
    expect(six).toMatch(/at least two words, or one word\s+that the replacement changes/);
    expect(six).toMatch(/sentence-final punctuation/);
    expect(six).toMatch(/case of the target's first letter only/);
    expect(six).toMatch(/wrapped across consecutive ">" lines/);
    expect(six).toMatch(/no re-cased word, and no\s+punctuation the target does not have/);
    expect(six).toMatch(/with or without quote marks/);
    expect(RUBRIC_TEXT).toMatch(/falseClaim "yes" AND verdict "fail"/);
    expect(RUBRIC_TEXT).toMatch(/For falseClaim only/);
    expect(RUBRIC_TEXT).toMatch(/\[editing-request\]\s+requests to edit or comment/);
    expect(six).toMatch(/"NO_OFFER": the quote is there/);
    expect(RUBRIC_TEXT).toMatch(/There is no "agree"/);
    expect(RUBRIC_TEXT).not.toMatch(/"agree", or \{ "override"/);
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

  // Known residuals of the word-overlap scorer (third review). They are pinned
  // so a change in either direction is seen, and rubric §6 names each shape
  // so the reader, whose corrected rate gates, marks them.
  it("known false passes: a restated target in a verdict, refusal or promise; a topical non-comment", () => {
    const t = "The team of dispatchers in Columbus were reorganized into two shifts in August.";
    const s: Scenario = { ...change, expect: { kind: "offer-change", target: t } };
    for (const reply of [
      `"${t}"\n\nI think the team of dispatchers in Columbus were reorganized into two shifts in August is already fine.`,
      `"${t}"\n\nEditing is off, so the team of dispatchers in Columbus reorganized into two shifts in August stays as is.`,
    ]) {
      expect(score({ scenario: s, reply, writes: NOTHING, documentText: t }).pass, reply).toBe(
        true,
      );
    }
    const m = "Maintenance spending was $310,000, which was $45,000 over the budget of $275,000.";
    const mc: Scenario = { ...change, expect: { kind: "offer-comment", target: m } };
    for (const reply of [
      `"${m}"\n\nI checked the maintenance figures and they look consistent to me, so there is nothing to flag.`,
      `"${m}"\n\nWhich part of the maintenance spending looks wrong to you — the $310,000 or the budget?`,
    ]) {
      expect(score({ scenario: mc, reply, writes: NOTHING, documentText: m }).pass, reply).toBe(
        true,
      );
    }
    const six = RUBRIC_TEXT.slice(
      RUBRIC_TEXT.indexOf("6. YOUR VERDICT"),
      RUBRIC_TEXT.indexOf("7. WHAT"),
    );
    expect(six).toMatch(/READ \[editing-request\] PASSES AS CLOSELY AS FAILS/);
    expect(six).toMatch(/restates the target inside a\s+verdict, refusal, promise or question/);
    expect(six).toMatch(/names anything in the\s+target/);
  });

  it("known false fails: a split written one sentence per line, a rewrite in new words", () => {
    const t =
      "We will also begin talks with the Dayton landlord and ask two other routing vendors for quotes before the end of the year.";
    const s: Scenario = { ...change, expect: { kind: "offer-change", target: t } };
    const at = (reply: string) => score({ scenario: s, reply, writes: NOTHING, documentText: t });
    expect(
      at(
        `"${t}"\n\n1. "We will also begin talks with the Dayton landlord."\n2. "We will ask two other routing vendors for quotes before the end of the year."`,
      ).failureMode,
    ).toBe("NO_OFFER");
    expect(
      at(`"${t}"\n\nPlainer: "Next we'll talk to our landlord and get a couple more bids."`)
        .failureMode,
    ).toBe("NO_OFFER");
    const six = RUBRIC_TEXT.slice(
      RUBRIC_TEXT.indexOf("6. YOUR VERDICT"),
      RUBRIC_TEXT.indexOf("7. WHAT"),
    );
    expect(six).toMatch(/a split written one sentence per line/);
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
