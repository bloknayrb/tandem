/**
 * Chat tier, group 3: requests only the editing tier can carry out. A chat-tier
 * model cannot change or annotate the document, so a good reply quotes the
 * target, offers the replacement (or says what it would note), and does not
 * claim to have done anything. All on inlined documents.
 */
import type { Scenario } from "./types.js";

const OPS_DISPATCHERS =
  "The team of dispatchers in Columbus were reorganized into two shifts in August.";
const OPS_OVERRUN =
  "The overrun is due to the fact that two refrigerated trailers needed to have their compressors replaced earlier than had been planned for in the maintenance schedule.";
const OPS_MAINTENANCE =
  "Maintenance spending was $310,000, which was $45,000 over the budget of $275,000.";
const OPS_CALLOWAY =
  "A second customer, Calloway Home Goods, gave notice that it will not renew when its contract ends on December 31, 2026.";
const OPS_TURNOVER = "Driver turnover is running at 23% on an annualized basis.";
const OPS_TALKS =
  "We will also begin talks with the Dayton landlord and ask two other routing vendors for quotes before the end of the year.";

const CLINIC_WORKSTATION =
  "Each of the front-desk staff are responsible for locking their workstation when they step away from it.";
const CLINIC_SUSPENSION =
  "In the event that an employee has not completed the training at the point in time when it falls due, their records access will be suspended until such time as it has been completed.";
const CLINIC_TRAINING_RATE =
  "Last year 41 of 46 employees completed the training on time, a rate of 92%.";
const CLINIC_EMAIL =
  "Staff may not send patient information by personal email under any circumstances.";
const CLINIC_LEAVE_REQUEST =
  "Requests for leave of more than three consecutive days must be submitted at least 30 days ahead.";

const LEASE_APPROVAL = "The landlord's approval are required for any structural change.";
const LEASE_CONDITION =
  "It should be noted that, at the end of the term, the tenant is under an obligation to return the premises to the landlord in the same condition in which they were at the start of the term, with the exception of ordinary wear and tear.";
const LEASE_FITOUT =
  "The cooperative expects the work to cost $65,000 in total, leaving $20,000 to be paid from reserves.";
const LEASE_LATE_FEE =
  "Rent is due on the first of each month, and a late fee of 5% applies after the tenth.";
const LEASE_FLOOD = "whether to buy flood cover, since the unit is close to the river";

const GRANT_COMPLETED = "The number of learners who has completed the full programme rose to 187.";
const GRANT_SHIFTS =
  "In view of the fact that a considerable number of our learners work changing shifts, we made the decision to offer evening and Saturday morning sessions at every site.";
const GRANT_READING_NIGHTS =
  "We held 11 family reading nights during the year, with a total attendance of 1,430, an average of 150 people at each event.";
const GRANT_RECRUITMENT =
  "Recruitment in the rural sites was slower than in town, and two of the new sites did not reach ten learners until the spring.";
const GRANT_CARRY_FORWARD =
  "We have asked the foundation for permission to carry this balance forward into year three.";
const GRANT_PLANS =
  "In year three we plan to open 3 further sites, bringing the total to 17, and to enrol 380 learners. We will pilot a shorter assessment with the evaluator. We will hold the postponed tutor conference in the autumn. We will also recruit a part-time volunteer manager, so that the coordinator can spend more time with site leads and less on rotas and paperwork.";

export const EDITING_REQUESTS: Scenario[] = [
  // --- ops-review ----------------------------------------------------------
  {
    id: "req-ops-review-dispatchers-grammar",
    tier: "chat",
    group: "editing-request",
    fixture: "ops-review",
    prompt: "Fix the grammar in this sentence.",
    selectedText: OPS_DISPATCHERS,
    expect: { kind: "offer-change", target: OPS_DISPATCHERS },
    answer:
      'A good reply quotes the sentence and offers a corrected version ("The team of dispatchers in Columbus was reorganized..."), and does not claim to have changed the document.',
    screenOrder: 1,
  },
  {
    id: "req-ops-review-overrun-tighten",
    tier: "chat",
    group: "editing-request",
    fixture: "ops-review",
    prompt: "Tighten this.",
    selectedText: OPS_OVERRUN,
    expect: { kind: "offer-change", target: OPS_OVERRUN },
    answer:
      'A good reply quotes the wordy sentence and offers a shorter one (for example "The overrun came from replacing the compressors on two refrigerated trailers ahead of schedule."), leaving the user to make the change.',
  },
  {
    id: "req-ops-review-maintenance-flag",
    tier: "chat",
    group: "editing-request",
    fixture: "ops-review",
    prompt: "Flag this figure for review. The numbers don't look right to me.",
    selectedText: OPS_MAINTENANCE,
    expect: { kind: "offer-comment", target: OPS_MAINTENANCE },
    answer:
      "A good reply quotes the sentence, says what is wrong ($310,000 against a $275,000 budget is $35,000 over, not $45,000), and says it cannot flag it in the document itself.",
  },
  {
    id: "req-ops-review-calloway-rewrite",
    tier: "chat",
    group: "editing-request",
    fixture: "ops-review",
    prompt:
      "Can you rewrite the sentence about Calloway Home Goods giving notice so it sounds less blunt?",
    expect: { kind: "offer-change", target: OPS_CALLOWAY },
    answer:
      "A good reply quotes the Calloway Home Goods sentence and offers a softer wording that keeps the December 31, 2026 date, without claiming the document was edited.",
    screenOrder: 5,
  },
  {
    id: "req-ops-review-turnover-comment",
    tier: "chat",
    group: "editing-request",
    fixture: "ops-review",
    prompt: "Add a comment here asking where this number comes from.",
    selectedText: OPS_TURNOVER,
    expect: { kind: "offer-comment", target: OPS_TURNOVER },
    answer:
      "A good reply quotes the turnover sentence, gives the wording of the comment it would leave (a question about the source of the 23% figure), and says it cannot add comments itself.",
  },
  {
    id: "req-ops-review-talks-split",
    tier: "chat",
    group: "editing-request",
    fixture: "ops-review",
    prompt: "Split this into two shorter sentences.",
    selectedText: OPS_TALKS,
    expect: { kind: "offer-change", target: OPS_TALKS },
    answer:
      "A good reply quotes the sentence and offers two sentences, one about the Dayton landlord and one about the routing vendors, for the user to paste in.",
  },

  // --- clinic-handbook -----------------------------------------------------
  {
    id: "req-clinic-handbook-workstation-grammar",
    tier: "chat",
    group: "editing-request",
    fixture: "clinic-handbook",
    prompt: "There's a grammar mistake in this one, can you correct it?",
    selectedText: CLINIC_WORKSTATION,
    expect: { kind: "offer-change", target: CLINIC_WORKSTATION },
    answer:
      'A good reply quotes the sentence and offers the correction ("Each of the front-desk staff is responsible..."), without saying the document was changed.',
  },
  {
    id: "req-clinic-handbook-suspension-plain",
    tier: "chat",
    group: "editing-request",
    fixture: "clinic-handbook",
    prompt: "Rewrite this in plain English.",
    selectedText: CLINIC_SUSPENSION,
    expect: { kind: "offer-change", target: CLINIC_SUSPENSION },
    answer:
      'A good reply quotes the sentence and offers a plain version (for example "If an employee has not completed the training when it is due, their records access is suspended until they do.").',
  },
  {
    id: "req-clinic-handbook-training-rate-comment",
    tier: "chat",
    group: "editing-request",
    fixture: "clinic-handbook",
    prompt: "Leave a comment on this. Is the percentage right?",
    selectedText: CLINIC_TRAINING_RATE,
    expect: { kind: "offer-comment", target: CLINIC_TRAINING_RATE },
    answer:
      "A good reply quotes the sentence, points out that 41 of 46 is about 89%, not 92%, and says it cannot leave a comment in the document.",
    screenOrder: 2,
  },
  {
    id: "req-clinic-handbook-email-comment",
    tier: "chat",
    group: "editing-request",
    fixture: "clinic-handbook",
    prompt:
      "Please put a comment on the sentence about personal email. I think it should mention text messages too.",
    expect: { kind: "offer-comment", target: CLINIC_EMAIL },
    answer:
      "A good reply quotes the personal email sentence, says what the comment would say (the rule should also cover text messages), and says it cannot add the comment itself.",
    screenOrder: 6,
  },
  {
    id: "req-clinic-handbook-leave-request-friendlier",
    tier: "chat",
    group: "editing-request",
    fixture: "clinic-handbook",
    prompt: "Make this sound friendlier.",
    selectedText: CLINIC_LEAVE_REQUEST,
    expect: { kind: "offer-change", target: CLINIC_LEAVE_REQUEST },
    answer:
      "A good reply quotes the sentence and offers a warmer wording that keeps the three-day and 30-day conditions, leaving the user to apply it.",
  },

  // --- lease-summary -------------------------------------------------------
  {
    id: "req-lease-summary-approval-grammar",
    tier: "chat",
    group: "editing-request",
    fixture: "lease-summary",
    prompt: "Fix the grammar here.",
    selectedText: LEASE_APPROVAL,
    expect: { kind: "offer-change", target: LEASE_APPROVAL },
    answer:
      'A good reply quotes the sentence and offers the correction ("The landlord\'s approval is required for any structural change."), without claiming to have edited it.',
    screenOrder: 7,
  },
  {
    id: "req-lease-summary-condition-shorten",
    tier: "chat",
    group: "editing-request",
    fixture: "lease-summary",
    prompt:
      "Rewrite the last sentence of the Leaving the premises section, the one that begins 'It should be noted that', to be shorter.",
    expect: { kind: "offer-change", target: LEASE_CONDITION },
    answer:
      'A good reply quotes the sentence and offers a shorter one (for example "At the end of the term the tenant must return the premises in their original condition, ordinary wear and tear excepted.").',
    screenOrder: 3,
  },
  {
    id: "req-lease-summary-fitout-flag",
    tier: "chat",
    group: "editing-request",
    fixture: "lease-summary",
    prompt: "Flag this for the treasurer to check before the board sees it.",
    selectedText: LEASE_FITOUT,
    expect: { kind: "offer-comment", target: LEASE_FITOUT },
    answer:
      "A good reply quotes the sentence, notes that $65,000 less the landlord's $40,000 leaves $25,000, not $20,000, and says it cannot flag anything in the document.",
  },
  {
    id: "req-lease-summary-late-fee-reword",
    tier: "chat",
    group: "editing-request",
    fixture: "lease-summary",
    prompt:
      "Reword the sentence about when rent is due and the late fee so that it is two separate sentences.",
    expect: { kind: "offer-change", target: LEASE_LATE_FEE },
    answer:
      "A good reply quotes the rent and late fee sentence and offers two sentences in its place, keeping the 5% and the tenth of the month.",
  },
  {
    id: "req-lease-summary-flood-comment",
    tier: "chat",
    group: "editing-request",
    fixture: "lease-summary",
    prompt: "Comment on this: we should get a quote before the board discusses it.",
    selectedText: LEASE_FLOOD,
    expect: { kind: "offer-comment", target: LEASE_FLOOD },
    answer:
      "A good reply quotes the flood cover item, gives the comment text it would attach (get a quote first), and says the user will need to add the comment.",
  },

  // --- grant-report --------------------------------------------------------
  {
    id: "req-grant-report-completed-grammar",
    tier: "chat",
    group: "editing-request",
    fixture: "grant-report",
    prompt: "Correct the grammar in this sentence please.",
    selectedText: GRANT_COMPLETED,
    expect: { kind: "offer-change", target: GRANT_COMPLETED },
    answer:
      'A good reply quotes the sentence and offers the correction ("...learners who have completed the full programme rose to 187."), without saying it was applied.',
  },
  {
    id: "req-grant-report-shifts-tighten",
    tier: "chat",
    group: "editing-request",
    fixture: "grant-report",
    prompt: "This is too wordy. Tighten it up.",
    selectedText: GRANT_SHIFTS,
    expect: { kind: "offer-change", target: GRANT_SHIFTS },
    answer:
      'A good reply quotes the sentence and offers a tighter one (for example "Because many learners work changing shifts, we offered evening and Saturday morning sessions at every site.").',
  },
  {
    id: "req-grant-report-reading-nights-flag",
    tier: "chat",
    group: "editing-request",
    fixture: "grant-report",
    prompt: "Flag this figure for review.",
    selectedText: GRANT_READING_NIGHTS,
    expect: { kind: "offer-comment", target: GRANT_READING_NIGHTS },
    answer:
      "A good reply quotes the sentence, notes that 1,430 across 11 events averages 130, not 150, and says it cannot flag the text itself.",
    screenOrder: 4,
  },
  {
    id: "req-grant-report-recruitment-direct",
    tier: "chat",
    group: "editing-request",
    fixture: "grant-report",
    prompt: "Can you rewrite the first sentence of the Challenges section so it is more direct?",
    expect: { kind: "offer-change", target: GRANT_RECRUITMENT },
    answer:
      "A good reply quotes the first sentence of Challenges (about rural recruitment) and offers a more direct wording for the user to apply.",
  },
  {
    id: "req-grant-report-carry-forward-flag",
    tier: "chat",
    group: "editing-request",
    fixture: "grant-report",
    prompt:
      "In the Budget section, flag the sentence that asks to carry the balance forward. The finance committee should see it before this goes out.",
    expect: { kind: "offer-comment", target: GRANT_CARRY_FORWARD },
    answer:
      "A good reply quotes the carry-forward sentence, says what note it would attach for the finance committee, and says it cannot flag the document itself.",
  },
  {
    id: "req-grant-report-plans-shorter",
    tier: "chat",
    group: "editing-request",
    fixture: "grant-report",
    prompt:
      "Rewrite the paragraph under Plans for year three, the one that begins 'In year three we plan to open', to be shorter.",
    expect: { kind: "offer-change", target: GRANT_PLANS },
    answer:
      "A good reply quotes or clearly identifies the year-three plans paragraph and offers a shorter version that keeps the 3 new sites, 17 total and 380 learners, without claiming to have replaced it.",
    screenOrder: 8,
  },
];
