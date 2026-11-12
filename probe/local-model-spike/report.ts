/**
 * Print the report for a run (#1123): PASS, FAIL or INCONCLUSIVE for a full
 * chat-tier run; REPORTED for the editing tier; SCREEN for a screen.
 *
 *   npx tsx probe/local-model-spike/report.ts --run <run id>
 *
 * Reads the run directory (`identity.json`, `planned.json`, `trials.jsonl`,
 * `infra.jsonl`, and `verdicts.json` when the reader has written one) and the
 * tracked `fingerprint.json`. Loads nothing from the product. Works for any
 * model name. Exit codes: 0 printed (whatever the outcome); 2 could not read
 * the run.
 */
import fs from "node:fs";
import path from "node:path";

import { parseArgs } from "./harness/args.js";
import { printable, say } from "./harness/entry-common.js";
import { isMain } from "./harness/main-guard.js";
import { RUNS_DIR, SPIKE_DIR } from "./harness/paths.js";
import type { InfraRecord, PlannedTrial, TrialRecord } from "./harness/record.js";
import { computeReport } from "./harness/report-core.js";
import { RUBRIC_VERSION } from "./harness/rubric.js";
import {
  existingRunDir,
  identityPath,
  readIdentity,
  readInfra,
  readTrials,
  type RunIdentity,
} from "./harness/run-store.js";
import { parseVerdictFile, type VerdictFile } from "./harness/verdicts.js";

export interface FingerprintFile {
  current: string;
  published: string | null;
  statement: string;
}

export function readFingerprintFile(file = path.join(SPIKE_DIR, "fingerprint.json")): FingerprintFile {
  return JSON.parse(fs.readFileSync(file, "utf8")) as FingerprintFile;
}

/** Other full runs in `runsDir` of the same model digest and tier. */
export function otherFullRuns(identity: RunIdentity, runsDir: string): string[] {
  const out: string[] = [];
  for (const name of fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []) {
    if (name === identity.runId) continue;
    const file = identityPath(path.join(runsDir, name));
    if (!fs.existsSync(file)) continue;
    try {
      const other = JSON.parse(fs.readFileSync(file, "utf8")) as RunIdentity;
      if (
        other.mode === "full" &&
        other.tier === identity.tier &&
        other.modelDigest === identity.modelDigest &&
        other.modelDigest !== "unknown"
      ) {
        out.push(other.runId);
      }
    } catch {
      // Not a run directory this report can read.
    }
  }
  return out.sort();
}

export async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs(argv);
  const runId = values.get("run");
  if (!runId) {
    say("usage: report.ts --run <run id>");
    return 2;
  }
  const runsDir = values.get("runs-dir") ?? RUNS_DIR;
  let runDir: string;
  try {
    runDir = existingRunDir(runId, runsDir);
  } catch (err) {
    say(printable(err instanceof Error ? err.message : String(err)));
    return 2;
  }
  const identity = readIdentity(runDir);
  const planned = JSON.parse(fs.readFileSync(path.join(runDir, "planned.json"), "utf8")) as PlannedTrial[];
  let verdicts: VerdictFile | null = null;
  const verdictPath = path.join(runDir, "verdicts.json");
  let verdictProblem: string | null = null;
  if (fs.existsSync(verdictPath)) {
    try {
      verdicts = parseVerdictFile(fs.readFileSync(verdictPath, "utf8"));
    } catch (err) {
      verdictProblem = `verdicts.json could not be read: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const report = computeReport({
    identity,
    planned,
    trials: readTrials<TrialRecord>(runDir),
    infra: readInfra<InfraRecord>(runDir),
    verdicts,
    rubricVersion: RUBRIC_VERSION,
    fingerprint: readFingerprintFile(),
    otherFullRuns: otherFullRuns(identity, runsDir),
  });
  // Model tags and server metadata are untrusted text: print them bounded and
  // without control characters.
  for (const line of report.text.split("\n")) say(printable(line, 2000));
  if (verdictProblem) say(printable(verdictProblem));
  return 0;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      say(`report failed: ${printable(err instanceof Error ? err.message : String(err), 2000)}`);
      process.exit(2);
    },
  );
}
