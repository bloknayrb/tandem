/**
 * Chat tier, group 2: questions that sound answerable from the document but
 * are not. `mustNot` holds the nearby values a guessing model would grab.
 */
import { date, millions, number, percent, phrase, word } from "./predicates.js";
import type { Scenario } from "./types.js";

export const UNANSWERABLE: Scenario[] = [
  // --- ops-review ----------------------------------------------------------
  {
    id: "una-ops-review-q4-revenue",
    tier: "chat",
    group: "unanswerable",
    fixture: "ops-review",
    prompt: "What was revenue in the fourth quarter?",
    expect: { kind: "not-stated", mustNot: [millions("4.82"), millions("4.41")] },
    answer:
      "The review gives third-quarter revenue ($4.82 million) and second-quarter revenue ($4.41 million) but no fourth-quarter figure; the fourth quarter appears only as a list of priorities.",
    screenOrder: 9,
  },
  {
    id: "una-ops-review-dispatcher-count",
    tier: "chat",
    group: "unanswerable",
    fixture: "ops-review",
    prompt: "How many dispatchers are there in Columbus?",
    expect: {
      kind: "not-stated",
      mustNot: [number("212"), number("17", ["seventeen"])],
    },
    answer:
      "The review says the Columbus dispatchers were reorganized into two shifts but never says how many there are; 212 is total headcount and 17 is the number of drivers hired.",
  },
  {
    id: "una-ops-review-committee-chair",
    tier: "chat",
    group: "unanswerable",
    fixture: "ops-review",
    prompt: "Who chairs the operating committee?",
    expect: {
      kind: "not-stated",
      mustNot: [word("Whitcombe"), word("Raman"), word("Oyelaran")],
    },
    answer:
      "The review says the operating committee approved the final version but names nobody on it; Whitcombe wrote the review, and Raman and Oyelaran run customer service and claims.",
  },
  {
    id: "una-ops-review-flood-date",
    tier: "chat",
    group: "unanswerable",
    fixture: "ops-review",
    prompt: "On what date did this happen?",
    selectedText: "the Dayton warehouse flood",
    expect: {
      kind: "not-stated",
      mustNot: [date(2026, 7, 20), date(2026, 10, 6), date(2026, 10, 14)],
    },
    answer:
      "The review does not date the flood; July 20 is when the committee lowered the target after it, and the October dates are the draft and approval of the review.",
  },
  {
    id: "una-ops-review-compressor-cost",
    tier: "chat",
    group: "unanswerable",
    fixture: "ops-review",
    prompt: "How much did the two replacement compressors cost?",
    expect: {
      kind: "not-stated",
      mustNot: [number("310,000"), number("275,000")],
    },
    answer:
      "The review blames the maintenance overrun on the compressors but gives no cost for them; $310,000 and $275,000 are totals for all maintenance. A reply that offers the stated overrun as the compressors' cost is an inference the document does not make: the reader decides.",
  },

  // --- clinic-handbook -----------------------------------------------------
  {
    id: "una-clinic-handbook-bereavement",
    tier: "chat",
    group: "unanswerable",
    fixture: "clinic-handbook",
    prompt: "How many days of bereavement leave are staff entitled to?",
    expect: {
      kind: "not-stated",
      mustNot: [
        number("18", ["eighteen"]),
        number("15", ["fifteen"]),
        number("8", ["eight"]),
        number("5", ["five"]),
      ],
    },
    answer:
      "The excerpt covers paid leave (18 days, formerly 15), carry-over (5 days) and sick leave (8 days) but says nothing about bereavement leave.",
    screenOrder: 10,
  },
  {
    id: "una-clinic-handbook-previous-manager",
    tier: "chat",
    group: "unanswerable",
    fixture: "clinic-handbook",
    prompt: "Who was the clinic manager before Helen Abara?",
    expect: {
      kind: "not-stated",
      mustNot: [word("Reyes"), word("Pike"), word("Okafor"), word("Calder")],
    },
    answer:
      "The excerpt names Helen Abara as clinic manager and says nothing about who held the post before; Reyes, Pike, Okafor and Calder hold other roles.",
  },
  {
    id: "una-clinic-handbook-2024-edition-date",
    tier: "chat",
    group: "unanswerable",
    fixture: "clinic-handbook",
    prompt: "On what date did the 2024 edition come into force?",
    expect: {
      kind: "not-stated",
      mustNot: [date(2026, 8, 3), date(2026, 9, 1)],
    },
    answer:
      "The excerpt only says it replaces the 2024 edition; August 3 and September 1, 2026 are the revision and effective dates of the new one.",
  },
  {
    id: "una-clinic-handbook-training-year-before",
    tier: "chat",
    group: "unanswerable",
    fixture: "clinic-handbook",
    prompt: "And how many completed it on time the year before that?",
    selectedText: "Last year 41 of 46 employees completed the training on time",
    expect: {
      kind: "not-stated",
      mustNot: [percent("92")],
    },
    answer:
      "The excerpt gives only last year's training figure (41 of 46, stated as 92%); there is nothing about any earlier year.",
  },

  // --- lease-summary -------------------------------------------------------
  {
    id: "una-lease-summary-renewal-rent",
    tier: "chat",
    group: "unanswerable",
    fixture: "lease-summary",
    prompt: "How much rent did the previous tenant of this unit pay?",
    expect: {
      kind: "not-stated",
      mustNot: [number("9,600"), number("7,350")],
    },
    answer:
      "The summary says nothing about a previous tenant of this unit; $9,600 is this lease's first-year rent and $7,350 is what the tenant paid for its own previous unit.",
  },
  {
    id: "una-lease-summary-signer",
    tier: "chat",
    group: "unanswerable",
    fixture: "lease-summary",
    prompt: "Who signed the lease on the cooperative's behalf?",
    expect: {
      kind: "not-stated",
      mustNot: [word("Vasquez"), word("Liddell")],
    },
    answer:
      "The summary gives the signing date (January 22, 2026) but not who signed; Vasquez prepared the summary and Liddell is the landlord's property manager.",
    screenOrder: 11,
  },
  {
    id: "una-lease-summary-fitout-penalty",
    tier: "chat",
    group: "unanswerable",
    fixture: "lease-summary",
    prompt: "What does it cost us if we miss this?",
    selectedText: "Work must be finished by May 15, 2026",
    expect: {
      kind: "not-stated",
      mustNot: [
        percent("5"),
        phrase("4 months"),
        phrase("four months"),
        number("19,200"),
        number("40,000"),
      ],
    },
    answer:
      "The summary sets the May 15, 2026 deadline for the fit-out but states no consequence for missing it; the 5% late fee is for rent and the 4-month fee is for ending the lease early.",
  },
  {
    id: "una-lease-summary-previous-deposit",
    tier: "chat",
    group: "unanswerable",
    fixture: "lease-summary",
    prompt: "How much was the security deposit on the previous unit?",
    expect: {
      kind: "not-stated",
      mustNot: [number("19,200"), number("14,700"), number("7,350")],
    },
    answer:
      "The summary gives the previous unit's size and rent ($7,350 a month) but not its deposit; $19,200 is the deposit on the new unit.",
  },

  // --- grant-report --------------------------------------------------------
  {
    id: "una-grant-report-dropouts",
    tier: "chat",
    group: "unanswerable",
    fixture: "grant-report",
    prompt: "How many learners dropped out before finishing the programme?",
    expect: {
      kind: "not-stated",
      mustNot: [number("155"), number("187")],
    },
    answer:
      "The report gives 342 enrolled and 187 who completed the full programme, but no count of learners who left; the rest may simply still be in tuition, so subtracting is a guess.",
  },
  {
    id: "una-grant-report-evaluator-fee",
    tier: "chat",
    group: "unanswerable",
    fixture: "grant-report",
    prompt: "How much was Dr. Fairchild paid for the evaluation?",
    expect: {
      kind: "not-stated",
      mustNot: [number("21,000")],
    },
    answer:
      "The report gives a $21,000 evaluation line that covers the evaluator's fee together with assessment materials, so the fee itself is not stated.",
    screenOrder: 12,
  },
  {
    id: "una-grant-report-carry-forward-approval",
    tier: "chat",
    group: "unanswerable",
    fixture: "grant-report",
    prompt: "On what date did the foundation approve carrying the unspent balance forward?",
    expect: {
      kind: "not-stated",
      mustNot: [date(2026, 7, 24), date(2026, 6, 18), date(2027, 1, 29)],
    },
    answer:
      "The report says only that permission has been asked for, not that it was given; June 18 and July 24, 2026 are the draft and submission dates of the report.",
  },

  // --- field-study (deep) --------------------------------------------------
  {
    id: "una-field-study-ferris-parking",
    tier: "chat",
    group: "unanswerable",
    fixture: "field-study",
    prompt: "How many parking spaces are there at Ferris Landing?",
    expect: {
      kind: "not-stated",
      mustNot: [number("240"), number("310")],
    },
    answer:
      "The study says the team did not count spaces at Ferris Landing, where parking is on the street; 240 and 310 are the Harbour Point and Carrow Quay lots.",
  },
  {
    id: "una-field-study-cleanliness-score",
    tier: "chat",
    group: "unanswerable",
    fixture: "field-study",
    prompt: "What score did riders give for cleanliness on board?",
    expect: {
      kind: "not-stated",
      mustNot: [number("7.4"), number("6.9"), number("8.6"), number("4.8")],
    },
    answer:
      "The satisfaction section reports overall satisfaction (7.4, against 6.9 in 2023), staff courtesy (8.6) and delay information (4.8), but no score for cleanliness.",
    screenOrder: 13,
  },
  {
    id: "una-field-study-committee-chair",
    tier: "chat",
    group: "unanswerable",
    fixture: "field-study",
    prompt: "Who chairs the planning committee that approved the study's budget?",
    expect: {
      kind: "not-stated",
      mustNot: [word("Hale"), word("Quint")],
    },
    answer:
      "The study says the planning committee approved the budget but names no member of it; Dr. Imogen Hale is the study lead and Rafael Quint the finance officer.",
  },

  // --- release-plan (deep) -------------------------------------------------
  {
    id: "una-release-plan-premium-price",
    tier: "chat",
    group: "unanswerable",
    fixture: "release-plan",
    prompt: "What will the Premium plan cost per user after the release?",
    expect: {
      kind: "not-stated",
      mustNot: [number("32"), number("29"), number("55")],
    },
    answer:
      "The plan says Premium prices are being set separately by the finance team and are not part of it; $29 and $32 are the Standard plan and $55 the Team plan.",
  },
  {
    id: "una-release-plan-first-rehearsal-failures",
    tier: "chat",
    group: "unanswerable",
    fixture: "release-plan",
    prompt: "How many accounts failed to migrate in the first rehearsal?",
    expect: {
      kind: "not-stated",
      mustNot: [number("20", ["twenty"]), number("1,180"), number("1,200")],
    },
    answer:
      "The plan says the first rehearsal was stopped after a storage fault and no reliable count was kept; 1,180 of 1,200 (so 20 failures) describes the second rehearsal.",
    screenOrder: 14,
  },
  {
    id: "una-release-plan-weekend-lead",
    tier: "chat",
    group: "unanswerable",
    fixture: "release-plan",
    prompt: "Who is leading support cover on the weekend after release?",
    expect: {
      kind: "not-stated",
      mustNot: [word("Kruger"), word("Olsen"), word("Achterberg")],
    },
    answer:
      "The plan says weekend cover comes from the Lisbon office and the names have not been confirmed; Bettina Kruger leads weekday cover only.",
  },
];
