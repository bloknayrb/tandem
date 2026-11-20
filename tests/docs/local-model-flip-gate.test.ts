import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BYO_MODELS_ENABLED } from "../../src/shared/constants.js";

/**
 * **The local-model flip gate's tracked home** (#1123, "who answers chat").
 *
 * The feature was built in four PRs (ADR-039, amendment 2026-11-12). Turning
 * `BYO_MODELS_ENABLED` on before **A2** (Claude is handed nothing while the
 * local model is chosen) and **B** (the editor's control, labels and notices)
 * landed would have shipped a switch with no control in Settings and two
 * answerers for one chat. So ADR-039's owed-by-the-flip bullet carried a fixed
 * sentence saying A2 and B must land first, and this pins the two together:
 *  - with the flag off, the sentence must be there;
 *  - with the flag on, it must be gone.
 * Both landed, and the flip (ADR-039's amendment 2026-11-20) reworded the
 * clause to record that, so the flag is on and the sentence is absent. The test
 * stays as a guard: the old wording cannot return while the flag is on, and a
 * flag turned back off without restoring it is red. `check` is a required
 * status check on `master`.
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
