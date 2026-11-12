/**
 * Write the reading file and a verdict template for a run (#1123).
 *
 *   npx tsx probe/local-model-spike/read.ts --run <run id>
 *
 * Writes, in the run directory:
 *   reading.txt             every trial, in reading order, with the rubric
 *   verdicts.template.json  one empty entry per trial
 * The reader copies the template to `verdicts.json`, fills in every entry and
 * the `reader` field, and runs `report.ts`. This script never writes
 * `verdicts.json`; verdicts already there (same trial, same hash) are carried
 * into the new template so a resumed run does not lose them.
 */
import fs from "node:fs";
import path from "node:path";

import { parseArgs } from "./harness/args.js";
import { isolateAppData, printable, say } from "./harness/entry-common.js";
import { isMain } from "./harness/main-guard.js";
import { RUNS_DIR } from "./harness/paths.js";
import { readingOrder, renderReadingFile } from "./harness/reading.js";
import type { TrialRecord } from "./harness/record.js";
import { RUBRIC_VERSION } from "./harness/rubric.js";
import { existingRunDir, readIdentity, readTrials } from "./harness/run-store.js";
import { parseVerdictFile, verdictTemplate } from "./harness/verdicts.js";

export async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs(argv);
  const runId = values.get("run");
  if (!runId) {
    say("usage: read.ts --run <run id>");
    return 2;
  }
  let runDir: string;
  try {
    runDir = existingRunDir(runId, values.get("runs-dir") ?? RUNS_DIR);
  } catch (err) {
    say(printable(err instanceof Error ? err.message : String(err)));
    return 2;
  }
  const identity = readIdentity(runDir);
  const trials = readTrials<TrialRecord>(runDir);

  // The fixture texts come from the product's own extraction, so the product
  // is loaded — after its app data is pointed inside the run directory.
  isolateAppData(runDir);
  const { fixtureTexts } = await import("./harness/fixture-texts.js");
  const used = new Set(trials.map((t) => t.fixture));
  const texts = fixtureTexts([...used]);

  fs.writeFileSync(
    path.join(runDir, "reading.txt"),
    renderReadingFile({ identity, trials, fixtureTexts: texts }),
    "utf8",
  );

  // In the reading file's order, so the two can be worked through side by side.
  const template = verdictTemplate(identity.runId, readingOrder(trials), RUBRIC_VERSION);
  const existing = path.join(runDir, "verdicts.json");
  if (fs.existsSync(existing)) {
    try {
      const prior = parseVerdictFile(fs.readFileSync(existing, "utf8"));
      if (prior.rubricVersion === RUBRIC_VERSION) {
        template.reader = prior.reader;
        const byTrial = new Map(prior.entries.map((e) => [`${e.trialId}\u0000${e.hash}`, e]));
        template.entries = template.entries.map((e) => byTrial.get(`${e.trialId}\u0000${e.hash}`) ?? e);
      }
    } catch {
      // An unreadable verdicts.json is left alone and not carried over.
    }
  }
  fs.writeFileSync(
    path.join(runDir, "verdicts.template.json"),
    `${JSON.stringify(template, null, 2)}\n`,
    "utf8",
  );

  say(`Reading file: ${path.join(runDir, "reading.txt")} (${trials.length} trials, rubric ${RUBRIC_VERSION})`);
  say(`Verdict template: ${path.join(runDir, "verdicts.template.json")}`);
  say(`Copy it to verdicts.json in the same directory, fill in every entry and "reader", then:`);
  say(`  npx tsx probe/local-model-spike/report.ts --run ${identity.runId}`);
  return 0;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      say(`read failed: ${printable(err instanceof Error ? err.message : String(err), 2000)}`);
      process.exit(2);
    },
  );
}
