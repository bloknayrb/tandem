/**
 * Chat tier, group 1: questions the document answers.
 *
 * Each scenario's `must` is a list of groups (every group must match; a group
 * matches when any of its patterns does) and `mustNot` holds the near-miss
 * values planted beside the answer in the fixture.
 */
import { date, millions, number, percent, phrase, word } from "./predicates.js";
import type { Scenario } from "./types.js";

export const ANSWERABLE: Scenario[] = [
  // --- ops-review (inlined) ------------------------------------------------
  {
    id: "ans-ops-review-q3-revenue",
    tier: "chat",
    group: "answerable",
    fixture: "ops-review",
    prompt: "What was revenue in the third quarter?",
    expect: {
      kind: "answer",
      must: [[millions("4.82")]],
      mustNot: [millions("4.41")],
    },
    answer:
      "Third-quarter revenue was $4.82 million; $4.41 million is the second-quarter figure beside it.",
  },
  {
    id: "ans-ops-review-ontime-target",
    tier: "chat",
    group: "answerable",
    fixture: "ops-review",
    prompt: "What on-time delivery target is the company working to now?",
    expect: {
      kind: "answer",
      must: [[percent("94")]],
      mustNot: [percent("93.4"), percent("91.2")],
    },
    answer:
      "The current target is 94% (lowered from the original 95%); 93.4% and 91.2% are the achieved rates for the third and second quarters, not targets.",
  },
  {
    id: "ans-ops-review-crossdock-date",
    tier: "chat",
    group: "answerable",
    fixture: "ops-review",
    prompt: "When is this opening now?",
    selectedText: "The Louisville cross-dock",
    expect: {
      kind: "answer",
      must: [[date(2026, 11, 17)]],
      mustNot: [date(2026, 10, 20)],
    },
    answer:
      "The Louisville cross-dock is now expected to open on November 17, 2026; October 20, 2026 was the first scheduled date.",
  },
  {
    id: "ans-ops-review-overtime-why",
    tier: "chat",
    group: "answerable",
    fixture: "ops-review",
    prompt: "Why did this happen, according to the review?",
    selectedText: "Overtime hours fell 12% from the second quarter",
    expect: {
      kind: "answer",
      must: [[phrase("second shift"), phrase("two shifts"), word("shifts")]],
      mustNot: [word("flood"), word("turnover")],
    },
    answer:
      "Whitcombe attributes the fall in overtime to the new second shift for the Columbus dispatchers; the flood and driver turnover are in the document but are not given as the cause.",
  },
  {
    id: "ans-ops-review-risks-summary",
    tier: "chat",
    group: "answerable",
    fixture: "ops-review",
    prompt: "Summarise the three risks in two sentences.",
    expect: {
      kind: "answer",
      must: [
        [word("turnover")],
        [word("lease"), word("Dayton")],
        [word("software"), word("vendor"), word("support")],
      ],
      mustNot: [],
    },
    answer:
      "The three risks are driver turnover at 23% annualized, the Dayton warehouse lease expiring in March 2027 with no renewal offered, and the routing software vendor ending support for the current version in June 2027 (a summary, so no distractor is defined).",
  },

  // --- clinic-handbook (inlined) -------------------------------------------
  {
    id: "ans-clinic-handbook-leave-days",
    tier: "chat",
    group: "answerable",
    fixture: "clinic-handbook",
    prompt: "How many days of paid leave do full-time staff get a year under this version?",
    expect: {
      kind: "answer",
      must: [[number("18", ["eighteen"])]],
      mustNot: [number("15", ["fifteen"])],
    },
    answer:
      "Full-time staff accrue 18 days of paid leave a year; 15 days was the allowance under the 2024 edition.",
  },
  {
    id: "ans-clinic-handbook-effective-date",
    tier: "chat",
    group: "answerable",
    fixture: "clinic-handbook",
    prompt: "From what date do these rules apply?",
    expect: {
      kind: "answer",
      must: [[date(2026, 9, 1)]],
      mustNot: [date(2026, 8, 3)],
    },
    answer:
      "The excerpt takes effect on September 1, 2026; August 3, 2026 is the date it was revised.",
  },
  {
    id: "ans-clinic-handbook-swap-approver",
    tier: "chat",
    group: "answerable",
    fixture: "clinic-handbook",
    prompt: "Who is that at the moment?",
    selectedText: "Shift swaps must be approved by the clinic manager",
    expect: {
      kind: "answer",
      must: [[word("Abara")]],
      mustNot: [word("Reyes"), word("Pike")],
    },
    answer:
      "The clinic manager is Helen Abara; Tomas Reyes is the nursing supervisor (weekend swaps between nurses only) and Samuel Pike is the office administrator.",
  },
  {
    id: "ans-clinic-handbook-carry-over",
    tier: "chat",
    group: "answerable",
    fixture: "clinic-handbook",
    prompt: "What happens to any days beyond this, and on what date?",
    selectedText: "Up to 5 unused days may be carried into the next year",
    expect: {
      kind: "answer",
      must: [[word("forfeited"), word("forfeit"), word("lost"), word("lose")], [date(2027, 1, 31)]],
      mustNot: [date(2026, 12, 31)],
    },
    answer:
      "Days beyond the five carried over are forfeited on January 31; December 31 is only the end of the leave year.",
  },

  // --- lease-summary (inlined) ---------------------------------------------
  {
    id: "ans-lease-summary-base-rent",
    tier: "chat",
    group: "answerable",
    fixture: "lease-summary",
    prompt: "What's the monthly base rent for the new unit in the first year?",
    expect: {
      kind: "answer",
      must: [[number("9,600")]],
      mustNot: [number("7,350")],
    },
    answer:
      "Base rent is $9,600 a month in the first year; $7,350 a month was the rent for the previous unit.",
  },
  {
    id: "ans-lease-summary-term-start",
    tier: "chat",
    group: "answerable",
    fixture: "lease-summary",
    prompt: "When does the lease term actually start?",
    expect: {
      kind: "answer",
      must: [[date(2026, 3, 1)]],
      mustNot: [date(2026, 1, 22), date(2026, 2, 9)],
    },
    answer:
      "The term begins on March 1, 2026; January 22, 2026 is when the lease was signed and February 9, 2026 is when the summary was drafted.",
  },
  {
    id: "ans-lease-summary-early-exit",
    tier: "chat",
    group: "answerable",
    fixture: "lease-summary",
    prompt: "How can the cooperative get out of the lease early, and what would it cost?",
    expect: {
      kind: "answer",
      must: [
        [phrase("9 months"), phrase("nine months")],
        [phrase("4 months"), phrase("four months")],
      ],
      mustNot: [number("12", ["twelve"])],
    },
    answer:
      "After the third year the tenant can end the lease by giving 9 months of written notice and paying a fee equal to 4 months of base rent; the 12 months is the notice needed to renew, not to leave.",
  },
  {
    id: "ans-lease-summary-landlord-rep",
    tier: "chat",
    group: "answerable",
    fixture: "lease-summary",
    prompt: "Who acts for them?",
    selectedText: "Kestrel Road Holdings LLC",
    expect: {
      kind: "answer",
      must: [[word("Liddell")]],
      mustNot: [word("Vasquez")],
    },
    answer:
      "The landlord is represented by its property manager, Gordon Liddell; Irene Vasquez is the cooperative's treasurer, who wrote the summary.",
  },

  // --- grant-report (just under the inline threshold) ----------------------
  {
    id: "ans-grant-report-learners-enrolled",
    tier: "chat",
    group: "answerable",
    fixture: "grant-report",
    prompt: "How many learners did the partnership enrol in year two?",
    expect: {
      kind: "answer",
      must: [[number("342")]],
      mustNot: [number("268"), number("187")],
    },
    answer:
      "342 learners were enrolled in year two; 268 is the year-one figure and 187 is the number who completed the programme (320 was the target).",
  },
  {
    id: "ans-grant-report-outcome-target",
    tier: "chat",
    group: "answerable",
    fixture: "grant-report",
    prompt: "What target was this being measured against by the end of the year?",
    selectedText: "64% of learners advanced at least one reading level",
    expect: {
      kind: "answer",
      must: [[percent("65")]],
      mustNot: [percent("58")],
    },
    answer:
      "By year end the target was 65%, revised in January 2026 from the original 70%; 58% is the year-one result, not a target.",
  },
  {
    id: "ans-grant-report-year-three-request",
    tier: "chat",
    group: "answerable",
    fixture: "grant-report",
    prompt: "How much is the partnership asking the foundation for in year three?",
    expect: {
      kind: "answer",
      must: [[number("195,000")]],
      mustNot: [number("180,000"), number("150,000"), number("171,400")],
    },
    answer:
      "The request for year three is $195,000; $180,000 was the year-two grant, $150,000 the year-one grant and $171,400 the amount spent.",
  },

  // --- field-study (deep) --------------------------------------------------
  {
    id: "ans-field-study-harbour-parking",
    tier: "chat",
    group: "answerable",
    fixture: "field-study",
    prompt: "How many parking spaces does the Harbour Point lot have?",
    expect: {
      kind: "answer",
      must: [[number("240")]],
      mustNot: [number("310")],
    },
    answer:
      "The Harbour Point lot has 240 spaces; 310 is the size of the Carrow Quay lot mentioned in the same section.",
    screenOrder: 15,
  },
  {
    id: "ans-field-study-overall-satisfaction",
    tier: "chat",
    group: "answerable",
    fixture: "field-study",
    prompt: "What was the overall rider satisfaction score in this study?",
    expect: {
      kind: "answer",
      must: [[number("7.4")]],
      mustNot: [number("6.9"), number("8.6"), number("4.8")],
    },
    answer:
      "Overall satisfaction averaged 7.4 out of ten; 6.9 is the 2023 survey's figure, and 8.6 and 4.8 are the scores for staff courtesy and delay information.",
    screenOrder: 16,
  },
  {
    id: "ans-field-study-fieldwork-cost",
    tier: "chat",
    group: "answerable",
    fixture: "field-study",
    prompt: "How much did the fieldwork end up costing?",
    expect: {
      kind: "answer",
      must: [[number("86,500")]],
      mustNot: [number("92,000"), number("74,000")],
    },
    answer:
      "The fieldwork and analysis cost $86,500; $92,000 was the approved budget and $74,000 was the cost of the 2023 survey.",
    screenOrder: 17,
  },
  {
    id: "ans-field-study-pilot-start",
    tier: "chat",
    group: "answerable",
    fixture: "field-study",
    prompt: "If the board agrees, when would the proposed pilot start?",
    expect: {
      kind: "answer",
      must: [[date(2026, 3, 9)]],
      mustNot: [date(2026, 2, 17)],
    },
    answer:
      "The pilot would begin on March 9, 2026; February 17, 2026 is the date of the board meeting that decides on it.",
  },

  // --- release-plan (deep) -------------------------------------------------
  {
    id: "ans-release-plan-beta-customers",
    tier: "chat",
    group: "answerable",
    fixture: "release-plan",
    prompt: "How many customers are actually taking part in the beta?",
    expect: {
      kind: "answer",
      must: [[number("45", ["forty-five"])]],
      mustNot: [number("60", ["sixty"])],
    },
    answer: "45 customers agreed to take part in the beta; 60 was the number the plan called for.",
    screenOrder: 18,
  },
  {
    id: "ans-release-plan-final-decision",
    tier: "chat",
    group: "answerable",
    fixture: "release-plan",
    prompt: "Who makes the final go or no-go decision?",
    expect: {
      kind: "answer",
      must: [[word("Achterberg")]],
      mustNot: [word("Olsen")],
    },
    answer:
      "The final decision rests with the chief product officer, Desmond Achterberg; Katrin Olsen, the release manager, only chairs the meeting.",
    screenOrder: 19,
  },
  {
    id: "ans-release-plan-release-date",
    tier: "chat",
    group: "answerable",
    fixture: "release-plan",
    prompt: "What date is general release set for?",
    expect: {
      kind: "answer",
      must: [[date(2027, 3, 16)]],
      mustNot: [date(2027, 2, 23), date(2027, 3, 2)],
    },
    answer:
      "General release is set for March 16, 2027; February 23, 2027 was the original date and March 2, 2027 is the go or no-go meeting.",
    screenOrder: 20,
  },
  {
    id: "ans-release-plan-rollback-threshold",
    tier: "chat",
    group: "answerable",
    fixture: "release-plan",
    prompt: "What share of failed migrations would trigger a rollback?",
    expect: {
      kind: "answer",
      must: [[percent("2")]],
      mustNot: [percent("5")],
    },
    answer:
      "The release is rolled back if more than 2% of migrations fail in the first four hours; 5% was the threshold in an earlier draft.",
  },
];
