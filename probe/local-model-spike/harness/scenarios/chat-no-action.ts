/**
 * Chat tier, group 4: messages that need no action. Reported, not part of the
 * gating rate: any non-empty reply passes.
 */
import type { Scenario } from "./types.js";

export const NO_ACTION: Scenario[] = [
  {
    id: "noa-ops-review-thanks",
    tier: "chat",
    group: "no-action",
    fixture: "ops-review",
    prompt: "Thanks!",
    expect: { kind: "acknowledge" },
    answer: "A short acknowledgement; nothing is being asked.",
  },
  {
    id: "noa-ops-review-all-for-now",
    tier: "chat",
    group: "no-action",
    fixture: "ops-review",
    prompt: "ok, that's all for now",
    selectedText: "Three risks need the committee's attention:",
    expect: { kind: "acknowledge" },
    answer:
      "A short acknowledgement; the selection is incidental and the user is ending the exchange.",
  },
  {
    id: "noa-clinic-handbook-never-mind",
    tier: "chat",
    group: "no-action",
    fixture: "clinic-handbook",
    prompt: "never mind",
    selectedText: "Paper records must be returned to the records room by the end of each shift.",
    expect: { kind: "acknowledge" },
    answer:
      "A short acknowledgement; the user has withdrawn whatever they were about to ask about the selection.",
  },
  {
    id: "noa-clinic-handbook-got-it",
    tier: "chat",
    group: "no-action",
    fixture: "clinic-handbook",
    prompt: "got it, thank you",
    expect: { kind: "acknowledge" },
    answer: "A short acknowledgement; nothing is being asked.",
  },
  {
    id: "noa-lease-summary-perfect",
    tier: "chat",
    group: "no-action",
    fixture: "lease-summary",
    prompt: "Perfect, that's what I needed.",
    expect: { kind: "acknowledge" },
    answer: "A short acknowledgement; nothing is being asked.",
  },
  {
    id: "noa-lease-summary-sort-it-myself",
    tier: "chat",
    group: "no-action",
    fixture: "lease-summary",
    prompt: "No worries, I'll sort it out myself. Thanks anyway.",
    expect: { kind: "acknowledge" },
    answer: "A short acknowledgement; the user is closing the conversation.",
  },
];
