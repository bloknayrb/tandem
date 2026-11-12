import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BYO_MODELS_ENABLED } from "../../src/shared/constants.js";

/**
 * **The local-model flip gate's tracked home** (#1123, "who answers chat").
 *
 * The feature is built in four PRs (ADR-039, amendment 2026-11-12). A1 builds
 * the switch and the local model's side; until **A2** (Claude is handed
 * nothing while the local model is chosen) and **B** (the editor's control,
 * labels and notices) land, turning `BYO_MODELS_ENABLED` on would ship a
 * switch with no control in Settings, notices naming a place where nothing
 * is, and two answerers for one chat.
 *
 * So ADR-039's owed-by-the-flip bullet carries a fixed sentence saying A2 and
 * B must land first, and this pins the two together:
 *  - while the flag is off, the sentence must be there (removing it without
 *    editing this file is a deliberate, visible act);
 *  - with the flag on, it must be gone: whoever flips the flag has to record,
 *    in the ADR, that A2 and B landed — and if they have not, `check` is red.
 * `check` is a required status check on `master`.
 */
const GATE_SENTENCE =
  "parts A2 (Claude's side) and B (the editor's control) must both land before the flip";

const adr039 = (): string => {
  const src = readFileSync(join(process.cwd(), "docs", "decisions.md"), "utf8");
  const start = src.indexOf("## ADR-039:");
  const end = src.indexOf("## ADR-040:");
  if (start === -1 || end === -1 || end < start) throw new Error("ADR-039 not found");
  return src.slice(start, end);
};

describe("local-model flip gate: A2 and B before BYO_MODELS_ENABLED (#1123)", () => {
  it("the gate sentence is in ADR-039 exactly while the flag is off", () => {
    expect(adr039().includes(GATE_SENTENCE)).toBe(!BYO_MODELS_ENABLED);
  });
});
