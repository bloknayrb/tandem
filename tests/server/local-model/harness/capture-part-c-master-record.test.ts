/**
 * The helper that captured `__fixtures__/part-c-master-record.json` (#1123
 * part B, R0.8). That fixture is a trial record written by MASTER'S code
 * before part C (b57d850), so `part-c.test.ts` can check that a record made
 * before part C still loads, reports and renders with nothing defaulted in.
 *
 * Method: check out b57d850, copy this file into the same path there, and run
 *
 *   TANDEM_CAPTURE_PART_C_RECORD=1 npx vitest run tests/server/local-model/harness/capture-part-c-master-record.test.ts
 *
 * It drives master's own `runTrial` + `evaluateTrial` through the scripted
 * model for the one script below and writes the record. Re-run there on
 * 2026-11-15, it reproduced the committed record in every field but the two
 * wall-clock timings (`timeToFirstTextMs`, `totalMs`) and so the `hash` over
 * them; the committed file is the original capture, kept verbatim.
 *
 * Run on any later commit it records that commit's shape instead (part C's
 * fields included), so it is skipped unless asked, and it never overwrites
 * the committed fixture: it writes beside it.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import { evaluateTrial } from "../../../../probe/local-model-spike/harness/evaluate.js";
import { runScripted, scenario } from "./helpers.js";

const CAPTURE = process.env.TANDEM_CAPTURE_PART_C_RECORD === "1";
const OUT = join(
  process.cwd(),
  "tests/server/local-model/__fixtures__/part-c-master-record.captured.json",
);

describe.skipIf(!CAPTURE)("capture the pre-part-C trial record (opt-in)", () => {
  it("writes the record for the <think> + answer script", async () => {
    const s = scenario("ans-ops-review-q3-revenue");
    const { obs } = await runScripted(s, [
      {
        content: ["<think>The Q2 figure was $4.41 million.</think>", "Revenue was $4.82 million."],
      },
    ]);
    const evaluated = evaluateTrial({
      runId: "run-master",
      trialId: "t1",
      repeat: 1,
      scenario: s,
      observation: obs,
      contextLength: "unknown",
    });
    if (!("record" in evaluated)) throw new Error("the trial was not scored");
    writeFileSync(OUT, `${JSON.stringify(evaluated.record, null, 2)}\n`);
  });
});
