/**
 * The scenario bank: which scenarios exist, in which tier and group.
 *
 * Chat tier (gates): three groups of at least 20 different scenarios each —
 * `answerable`, `unanswerable`, `editing-request` — plus the `no-action`
 * messages, which are run and reported but are not in the rate.
 * Editing tier (reported only): comment, replacement, question, nothing-to-
 * change and thread scenarios.
 * Extended (editing tier, not in a default run): multi-step sequences and the
 * 50-page document.
 *
 * No scenario id appears in both tiers.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ANSWERABLE } from "./chat-answerable.js";
import { EDITING_REQUESTS } from "./chat-editing-requests.js";
import { NO_ACTION } from "./chat-no-action.js";
import { UNANSWERABLE } from "./chat-unanswerable.js";
import { BUILT_FIXTURES } from "./fixtures.js";
import { JUNE_SCENARIOS, type JuneScenario } from "./june.js";
import type { Fixture, Group, Scenario, Tier } from "./types.js";

const SPIKE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const JUNE_FIXTURE_FILES = [
  "fixtures/cost-report-medium.md",
  "fixtures/product-notes-medium.md",
  "fixtures/research-brief-medium.md",
  "fixtures/envelope-50page.md",
] as const;

let fixtureTable: Map<string, Fixture> | null = null;

/** Every fixture by key. June files are read once, with line endings made LF. */
export function fixtures(): Map<string, Fixture> {
  if (fixtureTable) return fixtureTable;
  const table = new Map<string, Fixture>();
  for (const f of BUILT_FIXTURES) table.set(f.key, f);
  for (const rel of JUNE_FIXTURE_FILES) {
    const markdown = fs.readFileSync(path.join(SPIKE_DIR, rel), "utf8").replace(/\r\n/g, "\n");
    table.set(rel, { key: rel, origin: "june-file", markdown });
  }
  fixtureTable = table;
  return table;
}

export function fixtureFor(scenario: Scenario): Fixture {
  const f = fixtures().get(scenario.fixture);
  if (!f) throw new Error(`scenario ${scenario.id} names an unknown fixture: ${scenario.fixture}`);
  return f;
}

function fromJune(j: JuneScenario): Scenario {
  const base = {
    id: j.id,
    tier: "editing" as const,
    fixture: j.fixture,
    prompt: j.prompt,
    strata: j.strata,
    ...(j.envelope || j.operation === "sequence" ? { extended: true } : {}),
  };
  const group = (g: Group): Group => (j.envelope ? "envelope" : g);
  const anchorAnswer = `Gold span: "${j.target.quoted_text}"${
    j.target.occurrence_index ? ` (occurrence ${j.target.occurrence_index})` : ""
  }.`;
  switch (j.operation) {
    case "comment":
    case "replacement":
      return {
        ...base,
        group: group(j.operation),
        expect: {
          kind: "annotation",
          operation: j.operation,
          target: j.target,
          content: j.content_assertion,
          replacement: j.replacement_assertion,
        },
        answer: `One ${j.operation} anchored on the gold span. ${anchorAnswer}`,
      };
    case "chat":
      return {
        ...base,
        group: group("question"),
        expect: { kind: "chat-only", content: j.content_assertion },
        answer: `An answer in chat and nothing written. The answer is in: "${j.target.quoted_text}".`,
      };
    case "no-op":
      return {
        ...base,
        group: group("edit-no-action"),
        expect: { kind: "no-annotation" },
        answer: "Nothing written; a reply saying no change is needed.",
      };
    case "sequence":
      return {
        ...base,
        group: group("sequence"),
        expect: { kind: "sequence", target: j.target, sequence: j.sequence ?? {} },
        answer: `A multi-step result. ${anchorAnswer}`,
      };
  }
}

/** The two thread paths a real user's message can reach. No annotation id is
 *  ever put in a task: the model learns an id only from its own create result. */
const THREAD_SCENARIOS: Scenario[] = [
  {
    id: "thread-own-comment",
    tier: "editing",
    group: "thread",
    fixture: "fixtures/cost-report-medium.md",
    prompt:
      "Comment on the material costs figure asking for it to be verified, then add a reply under your own comment saying the invoice should be attached.",
    expect: { kind: "thread-own" },
    answer:
      "A comment on the material costs figure, and one reply under that same comment. The chat reply says both were added for review; it does not say the document text changed.",
  },
  {
    id: "thread-never-given",
    tier: "editing",
    group: "thread",
    fixture: "fixtures/product-notes-medium.md",
    prompt: "Reply in the comment thread about the launch date and say the security review is booked.",
    expect: { kind: "thread-none" },
    answer:
      "There is no such thread and the model was given no id, so no reply can land. A good reply says so, or leaves a new comment on the launch date instead; it does not say it replied in a thread.",
  },
];

export const ALL_SCENARIOS: Scenario[] = [
  ...ANSWERABLE,
  ...UNANSWERABLE,
  ...EDITING_REQUESTS,
  ...NO_ACTION,
  ...JUNE_SCENARIOS.map(fromJune),
  ...THREAD_SCENARIOS,
];

export interface SelectOptions {
  tier: Tier;
  mode: "full" | "screen";
  includeExtended?: boolean;
}

/**
 * The scenarios of a run, in run order. A screen is a fixed subset of the
 * chat tier's three gating groups, most discriminating first.
 */
export function selectScenarios(opts: SelectOptions): Scenario[] {
  if (opts.mode === "screen") {
    if (opts.tier !== "chat") throw new Error("a screen runs the chat tier only");
    return ALL_SCENARIOS.filter((s) => s.tier === "chat" && s.screenOrder !== undefined).sort(
      (a, b) => (a.screenOrder ?? 0) - (b.screenOrder ?? 0),
    );
  }
  if (opts.includeExtended && opts.tier !== "editing") {
    throw new Error("the extended bank (sequences, 50-page document) is editing-tier only");
  }
  return ALL_SCENARIOS.filter(
    (s) => s.tier === opts.tier && (opts.includeExtended === true || s.extended !== true),
  );
}
