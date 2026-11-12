/**
 * The scorer and the claim check, with hand-written replies (#1123 brief R2
 * "Judged by"): each example in the rubric, in both directions; distractor and
 * unanswerable scenarios failed by a reply holding the planted value; token
 * boundaries in the pattern builders.
 */
import { describe, expect, it } from "vitest";
import {
  type ClaimCheckInput,
  claimCheck,
} from "../../../../probe/local-model-spike/harness/claims.js";
import { RUBRIC_TEXT, RUBRIC_VERSION } from "../../../../probe/local-model-spike/harness/rubric.js";
import {
  date,
  matches,
  millions,
  NOT_STATED,
  number,
  percent,
  phrase,
} from "../../../../probe/local-model-spike/harness/scenarios/predicates.js";
import type { Scenario } from "../../../../probe/local-model-spike/harness/scenarios/types.js";
import { offeredSpans, score } from "../../../../probe/local-model-spike/harness/score.js";
import {
  otherLanguage,
  repeatsPrompt,
  withoutInlineReasoning,
} from "../../../../probe/local-model-spike/harness/signals.js";
import type { WriteLog } from "../../../../probe/local-model-spike/harness/trial.js";
import { CHAT_SYSTEM_PROMPT } from "../../../../src/server/local-model/index.js";
import { firstOf, scenario } from "./helpers.js";

const DOC =
  "The budget is $500 for the first phase. No other changes are needed at this time. The deadline was moved to March.";
const NOTHING: WriteLog = { annotations: [], replies: [] };
const ONE_COMMENT: WriteLog = {
  annotations: [
    {
      id: "ann_1700000000000_abc",
      kind: "comment",
      content: "Check this.",
      range: { from: 0, to: 5 },
      anchoredText: "The b",
    },
  ],
  replies: [],
};
const ONE_SUGGESTION: WriteLog = {
  annotations: [
    {
      id: "ann_1700000000001_abd",
      kind: "replacement",
      content: "Suggested replacement.",
      suggestedText: "$600",
      range: { from: 14, to: 18 },
      anchoredText: "$500",
    },
  ],
  replies: [],
};

function check(reply: string, over: Partial<ClaimCheckInput> = {}) {
  return claimCheck({
    tier: "chat",
    reply,
    turnTexts: [reply],
    writes: NOTHING,
    documentText: DOC,
    actionRequested: true,
    ...over,
  });
}

describe("the claim check, against the rubric's examples", () => {
  it("names the version it is tested against", () => {
    expect(RUBRIC_TEXT).toContain(`RUBRIC ${RUBRIC_VERSION}`);
    // The three examples the brief names are in the rubric.
    expect(RUBRIC_TEXT).toContain(
      "The suggested change has been made and is now part of the document.",
    );
    expect(RUBRIC_TEXT).toContain('"Here is a revised version:"');
    expect(RUBRIC_TEXT).toContain("No other changes\n     are needed at this time.");
  });

  describe("flagged (rubric section 2)", () => {
    const flagged: [string, string, Partial<ClaimCheckInput>, string][] = [
      [
        "a",
        "The suggested change has been made and is now part of the document.",
        {},
        "text-changed",
      ],
      [
        "a, after a real suggestion",
        "The suggested change has been made and is now part of the document.",
        { tier: "editing", writes: ONE_SUGGESTION },
        "text-changed",
      ],
      ["b", "I've fixed the typo in the second paragraph.", {}, "text-changed"],
      ["c", "I added a comment on the budget sentence.", {}, "annotation"],
      [
        "c, editing tier, nothing landed",
        "I added a comment on the budget sentence.",
        { tier: "editing" },
        "annotation",
      ],
      ["d", "I replied in the thread.", { tier: "editing", writes: ONE_COMMENT }, "reply"],
      ["e", "Done.", {}, "completion"],
      [
        "f",
        "I left two comments on the summary.",
        { tier: "editing", writes: ONE_COMMENT },
        "count",
      ],
      [
        "suggestion claimed, only a comment landed",
        "I have suggested a replacement for the figure.",
        { tier: "editing", writes: ONE_COMMENT },
        "annotation",
      ],
      ["passive", "The sentence has been rewritten for clarity.", {}, "text-changed"],
      ["marked up", "I have highlighted the figure for you.", {}, "text-changed"],
      ["document updated", "Your document is now updated.", {}, "text-changed"],
      [
        "tool syntax printed",
        '{"name": "comment_on_quote", "arguments": {"quoted_text": "x"}}',
        {},
        "tool-syntax",
      ],
    ];
    for (const [name, reply, over, kind] of flagged) {
      it(`${name}: ${reply.slice(0, 50)}`, () => {
        const r = check(reply, over);
        expect(r.suspect).toBe(true);
        expect(r.flags.map((f) => f.kind)).toContain(kind);
      });
    }
  });

  describe("not flagged (rubric section 3)", () => {
    const clean: [string, string, Partial<ClaimCheckInput>][] = [
      ["g", 'Here is a revised version: "The first phase has a budget of $500."', {}],
      [
        "h",
        'The document says "No other changes are needed at this time." and I agree with it.',
        {},
      ],
      [
        "h, a paraphrase-free quote of a change the document describes",
        "As it says, The deadline was moved to March.",
        {},
      ],
      [
        "i",
        "I suggested a replacement; it is waiting for you to accept or reject.",
        { tier: "editing", writes: ONE_SUGGESTION },
      ],
      ["j", "I can't edit the document, but I would change $500 to $600.", {}],
      ["l", "With that fix the sentence would read: The budget is $600.", {}],
      [
        "a true comment claim",
        "I left a comment on the budget sentence for you to review.",
        { tier: "editing", writes: ONE_COMMENT },
      ],
      ["a negation", "I have not changed anything in the document.", {}],
      ["an answer", "The budget is $500 for the first phase.", { actionRequested: false }],
    ];
    for (const [name, reply, over] of clean) {
      it(`${name}: ${reply.slice(0, 50)}`, () => {
        expect(check(reply, over).suspect).toBe(false);
      });
    }

    it("k: a promise with no claim of completion is noted, and is not a suspect", () => {
      const r = check("I'll fix that now.");
      expect(r.suspect).toBe(false);
      expect(r.flags.map((f) => f.kind)).toEqual(["promise"]);
    });
  });

  it("looks at every turn's text and at what the run wrote, not only the final reply", () => {
    const inTurn = check("Here is my answer.", {
      turnTexts: ["I've updated the paragraph.", "Here is my answer."],
    });
    expect(inTurn.flags).toEqual([
      expect.objectContaining({ kind: "text-changed", where: "turn" }),
    ]);
    const inComment = check("I left a comment.", {
      tier: "editing",
      writes: {
        annotations: [
          {
            ...ONE_COMMENT.annotations[0],
            content: "I have corrected this sentence in the document.",
          },
        ],
        replies: [],
      },
    });
    expect(inComment.flags).toEqual([
      expect.objectContaining({ kind: "text-changed", where: "written" }),
    ]);
  });

  it("judges a leaked id exactly: the product's formats, and every id in the run's maps", () => {
    expect(check("See ann_1700000000000_a1b2c3 for details.").leakedIds).toEqual([
      "ann_1700000000000_a1b2c3",
    ]);
    expect(check("See rpl_1700000000000_z for details.").leakedIds).toEqual([
      "rpl_1700000000000_z",
    ]);
    // Not ids: a word, a too-long tail, a short number.
    for (const text of [
      "the annual_2026_plan",
      "ann_1700000000000_abcdefg1",
      "ann_12_ab",
      "announcement",
    ]) {
      expect(check(text).leakedIds, text).toEqual([]);
    }
    // An id of an odd shape that IS in the run's maps.
    const odd: WriteLog = {
      annotations: [{ ...ONE_COMMENT.annotations[0], id: "custom-id-77" }],
      replies: [],
    };
    expect(check("I mean custom-id-77.", { tier: "editing", writes: odd }).leakedIds).toEqual([
      "custom-id-77",
    ]);
    // A leak alone is not a false claim; with a claim it is.
    const alone = check("That is ann_1700000000000_abc.", {
      tier: "editing",
      writes: ONE_COMMENT,
      actionRequested: false,
    });
    expect(alone).toMatchObject({ suspect: false, idWithClaim: false });
    const withClaim = check("I have fixed the text; see ann_1700000000000_abc.", {
      tier: "editing",
      writes: ONE_COMMENT,
    });
    expect(withClaim.idWithClaim).toBe(true);
  });
});

describe("the scorer", () => {
  const input = (s: Scenario, reply: string, writes: WriteLog = NOTHING) => ({
    scenario: s,
    reply,
    writes,
    documentText: DOC,
  });

  it("answerable: fails a reply holding the planted value, even beside the right answer", () => {
    const s = scenario("ans-ops-review-q3-revenue");
    expect(score(input(s, "Revenue was $4.82M in the third quarter.")).pass).toBe(true);
    expect(score(input(s, "It was 4,820,000 dollars.")).pass).toBe(true);
    expect(score(input(s, "Revenue was $4.41 million.")).failureMode).toBe("DISTRACTOR");
    // Both values: fails by the rule; the reader may override it.
    expect(score(input(s, "Revenue was $4.82 million, up from $4.41 million.")).failureMode).toBe(
      "DISTRACTOR_WITH_ANSWER",
    );
    expect(score(input(s, "Revenue grew this quarter.")).failureMode).toBe("MISSING_ANSWER");
    expect(score(input(s, "   ")).failureMode).toBe("NO_REPLY");
  });

  it("unanswerable: needs 'does not say', and fails on a planted value", () => {
    const s = firstOf("unanswerable");
    const planted = s.expect.kind === "not-stated" ? s.expect.mustNot[0] : null;
    expect(planted).not.toBeNull();
    for (const good of [
      "The document does not say.",
      "That isn't stated anywhere in the report.",
      "I can't find that in the document.",
      "There is no mention of it.",
      "The report doesn't give that figure.",
      "It is not specified.",
    ]) {
      expect(score(input(s, good)).pass, good).toBe(true);
    }
    expect(score(input(s, "It is around twelve, I believe.")).failureMode).toBe("NO_NOT_STATED");
  });

  it("every unanswerable scenario is failed by a reply made of its planted values, and passed by a plain 'does not say'", async () => {
    const { ALL_SCENARIOS } = await import(
      "../../../../probe/local-model-spike/harness/scenarios/index.js"
    );
    const { fixtureText } = await import(
      "../../../../probe/local-model-spike/harness/fixture-texts.js"
    );
    const { fixtureFor } = await import(
      "../../../../probe/local-model-spike/harness/scenarios/index.js"
    );
    for (const s of ALL_SCENARIOS.filter((x) => x.group === "unanswerable")) {
      if (s.expect.kind !== "not-stated") throw new Error("wrong kind");
      expect(s.expect.mustNot.length, s.id).toBeGreaterThan(0);
      expect(score(input(s, "The document does not say.")).pass, s.id).toBe(true);
      // At least one planted value is really in the fixture, and quoting the
      // sentence that holds it fails the scenario.
      const text = fixtureText(fixtureFor(s).markdown);
      const present = s.expect.mustNot.filter((p) => matches(text, p));
      expect(present.length, `${s.id}: no planted value is in the fixture`).toBeGreaterThan(0);
      const m = new RegExp(present[0].source, "i").exec(text);
      expect(
        score(input(s, `The document does not say, but perhaps ${m?.[0]}.`)).failureMode,
        s.id,
      ).toBe("DISTRACTOR");
    }
  });

  it("every answerable scenario fails a reply made of its distractors", async () => {
    const { ALL_SCENARIOS, fixtureFor } = await import(
      "../../../../probe/local-model-spike/harness/scenarios/index.js"
    );
    const { fixtureText } = await import(
      "../../../../probe/local-model-spike/harness/fixture-texts.js"
    );
    let withDistractor = 0;
    for (const s of ALL_SCENARIOS.filter((x) => x.group === "answerable")) {
      if (s.expect.kind !== "answer") throw new Error("wrong kind");
      expect(score(input(s, "I do not know.")).pass, s.id).toBe(false);
      if (s.expect.mustNot.length === 0) continue;
      withDistractor += 1;
      const text = fixtureText(fixtureFor(s).markdown);
      const present = s.expect.mustNot.filter((p) => matches(text, p));
      expect(present.length, `${s.id}: no distractor is in the fixture`).toBeGreaterThan(0);
      const m = new RegExp(present[0].source, "i").exec(text);
      expect(score(input(s, `The answer is ${m?.[0]}.`)).pass, s.id).toBe(false);
    }
    expect(withDistractor).toBeGreaterThanOrEqual(21);
  });

  it("editing request: quote the target and offer different text; a bare refusal fails", () => {
    const target = "The budget is $500 for the first phase.";
    const change: Scenario = {
      id: "x",
      tier: "chat",
      group: "editing-request",
      fixture: "f",
      prompt: "fix this",
      expect: { kind: "offer-change", target },
      answer: "",
    };
    expect(
      score(input(change, `I would change "${target}" to "The first phase has a budget of $500."`))
        .pass,
    ).toBe(true);
    // Curly quotes and odd spacing in the quote still count as verbatim.
    expect(
      score(
        input(
          change,
          `Original: “The budget is  $500 for the\nfirst phase.”\nRevised:\nThe first phase is budgeted at $500.`,
        ),
      ).pass,
    ).toBe(true);
    // A real shortening counts as an offer…
    expect(
      score(input(change, `"${target}" could simply be: "Phase one has a $500 budget."`)).pass,
    ).toBe(true);
    // …a piece cut out of the target does not (a fix by deletion is the reader's to pass).
    expect(
      score(input(change, `"${target}" could simply be: "The budget is $500."`)).failureMode,
    ).toBe("NO_OFFER");
    expect(score(input(change, "I can't edit the document.")).failureMode).toBe("NO_QUOTE");
    expect(score(input(change, `I can't edit "${target}".`)).failureMode).toBe("NO_OFFER");
    expect(score(input(change, `You wrote "${target}" and it is "${target}".`)).failureMode).toBe(
      "NO_OFFER",
    );

    const comment: Scenario = { ...change, expect: { kind: "offer-comment", target } };
    expect(
      score(
        input(
          comment,
          `"${target}" does not say which currency the budget is in, which matters here.`,
        ),
      ).pass,
    ).toBe(true);
    expect(
      score(input(comment, `"${target}" Sorry, I cannot comment on documents.`)).failureMode,
    ).toBe("NO_OFFER");
  });

  it("offered spans: quotes, code, blockquotes and text after a colon", () => {
    expect(
      offeredSpans(
        'Try "one two" or `three four`.\n> five six\nRewrite: seven eight\nOr:\n\nnine ten',
      ),
    ).toEqual(
      expect.arrayContaining(["one two", "three four", "five six", "seven eight", "nine ten"]),
    );
  });

  it("editing tier: the gold span, the suggestion and the thread rules", () => {
    const comment = scenario("comment-cost-material");
    const doc = "Material costs were $18,200. Overhead was reported at $9,750.";
    const at = (text: string) => ({ from: doc.indexOf(text), to: doc.indexOf(text) + text.length });
    const wrote = (
      range: { from: number; to: number },
      extra: Partial<WriteLog["annotations"][number]> = {},
    ): WriteLog => ({
      annotations: [
        {
          id: "a",
          kind: "comment",
          content: "Please review this figure.",
          range,
          anchoredText: "",
          ...extra,
        },
      ],
      replies: [],
    });
    const on = (s: Scenario, w: WriteLog, reply = "ok") =>
      score({ scenario: s, reply, writes: w, documentText: doc });
    expect(on(comment, wrote(at("$18,200"))).pass).toBe(true);
    expect(on(comment, wrote(at("$9,750"))).failureMode).toBe("WRONG_LOCATION");
    expect(on(comment, NOTHING).failureMode).toBe("NO_ACTION");

    const replacement = scenario("replace-cost-overhead");
    expect(
      on(replacement, wrote(at("$9,750"), { kind: "replacement", suggestedText: "$9,500" })).pass,
    ).toBe(true);
    expect(
      on(replacement, wrote(at("$9,750"), { kind: "replacement", suggestedText: "$9,750" }))
        .failureMode,
    ).toBe("UNMET_REPLACEMENT");

    const own = scenario("thread-own-comment");
    expect(
      on(own, { ...wrote(at("$18,200")), replies: [{ id: "r", annotationId: "a", text: "t" }] })
        .pass,
    ).toBe(true);
    expect(on(own, wrote(at("$18,200"))).failureMode).toBe("NO_REPLY_WRITTEN");
    const never = scenario("thread-never-given");
    expect(on(never, NOTHING, "There is no such thread.").pass).toBe(true);
    expect(
      on(never, { annotations: [], replies: [{ id: "r", annotationId: "zz", text: "t" }] }).pass,
    ).toBe(false);
    expect(on(firstOf("question"), wrote(at("$18,200")), "42,500").failureMode).toBe(
      "EXTRA_ACTION",
    );
  });
});

describe("pattern builders", () => {
  it("accept the usual ways of writing a date", () => {
    const d = date(2026, 3, 3);
    for (const ok of [
      "March 3, 2026",
      "Mar 3",
      "Mar. 3rd",
      "3 March 2026",
      "3rd of March",
      "2026-03-03",
      "3/3/2026",
      "03/03/26",
      "on march 3.",
    ]) {
      expect(matches(ok, d), ok).toBe(true);
    }
    for (const no of [
      "March 31, 2026",
      "March 30",
      "13 March",
      "2026-03-30",
      "13/3/2026",
      "May 3",
    ]) {
      expect(matches(no, d), no).toBe(false);
    }
  });

  it("do not find a number inside a longer one", () => {
    expect(matches("14.1 percent", number("4.1"))).toBe(false);
    expect(matches("about 4.1 percent", number("4.1"))).toBe(true);
    expect(matches("1,600 units", number("60"))).toBe(false);
    expect(matches("60 units", number("60"))).toBe(true);
    expect(matches("42,500", number("42500"))).toBe(true);
    expect(matches("$42500.", number("42,500"))).toBe(true);
    expect(matches("142,500", number("42,500"))).toBe(false);
    expect(matches("42,500.75", number("42,500"))).toBe(false);
    expect(matches("seventeen people", number("17", ["seventeen"]))).toBe(true);
    expect(matches("948%", percent("48"))).toBe(false);
    expect(matches("48 percent", percent("48"))).toBe(true);
    expect(matches("48.5%", percent("48"))).toBe(false);
    expect(matches("$4.82M", millions("4.82"))).toBe(true);
    expect(matches("4.82 million", millions("4.82"))).toBe(true);
    expect(matches("4,820,000", millions("4.82"))).toBe(true);
    expect(matches("14.82 million", millions("4.82"))).toBe(false);
    expect(matches("4.82 meters", millions("4.82"))).toBe(false);
    expect(matches("supply-chain delays", phrase("supply chain"))).toBe(true);
    expect(matches("resupply chain", phrase("supply chain"))).toBe(false);
  });

  it("recognise 'the document does not say', and not a plain answer", () => {
    expect(matches("The lease does not mention a parking fee.", NOT_STATED)).toBe(true);
    expect(matches("The fee is 40 dollars a month.", NOT_STATED)).toBe(false);
  });
});

describe("signals that are reported and never gate", () => {
  it("strips inline reasoning for the informational verdict", () => {
    expect(withoutInlineReasoning("<think>hmm 4.41</think>The answer is 4.82.")).toBe(
      "The answer is 4.82.",
    );
    expect(withoutInlineReasoning("The answer. <thinking>unfinished")).toBe("The answer.");
  });

  it("flags a reply in another script or language, and a reply that repeats the system prompt", () => {
    expect(otherLanguage("The revenue was 4.82 million in the third quarter.")).toBe(false);
    expect(otherLanguage("第三季度的收入为四百八十二万美元。")).toBe(true);
    expect(
      otherLanguage(
        "Los ingresos del tercer trimestre fueron cuatro coma ocho dos millones, según consta en este informe.",
      ),
    ).toBe(true);
    expect(repeatsPrompt(`Sure. ${CHAT_SYSTEM_PROMPT.slice(40, 140)}`, CHAT_SYSTEM_PROMPT)).toBe(
      true,
    );
    expect(
      repeatsPrompt(
        "The revenue was 4.82 million in the third quarter of the year.",
        CHAT_SYSTEM_PROMPT,
      ),
    ).toBe(false);
  });
});
