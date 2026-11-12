/**
 * Measure one model in one tier (#1123): a full run, or a screen.
 *
 *   npx tsx probe/local-model-spike/measure.ts --model <tag> --tier chat --hardware "<what it ran on>"
 *   npx tsx probe/local-model-spike/measure.ts --model <tag> --tier chat --screen --hardware "<…>"
 *   npx tsx probe/local-model-spike/measure.ts --model <tag> --tier editing --hardware "<…>"
 *   npx tsx probe/local-model-spike/measure.ts --model <tag> --tier chat --hardware "<…>" --resume <run id>
 *
 * Options: --endpoint <url> (default http://127.0.0.1:11434), --repeats <n>
 * (default 1), --include-extended (editing tier only: sequences and the
 * 50-page document), --clear-stale-lock.
 *
 * How long it takes, at 45 to 120 seconds a trial on a CPU-only laptop: a
 * screen is 20 trials (15 to 40 minutes); a full chat-tier run is 74 trials
 * (about 1 to 2.5 hours); a full editing-tier run is 41 trials (about 0.5 to
 * 1.4 hours). A trial that times out takes the product's full five minutes.
 * The default repeat count is 1: each gating group's 20+ different scenarios
 * are the sample, and a repeat at the product's fixed temperature with no seed
 * is only weakly independent of the first.
 *
 * One model per invocation. Exit codes: 0 the run completed; 1 it stopped
 * (endpoint errors) and can be resumed; 2 it was refused before any trial.
 *
 * Every trial drives the SHIPPED collaborator (`harness/trial.ts`). Results go
 * to `probe/local-model-spike/runs/<run id>/` (gitignored). Then:
 *   npx tsx probe/local-model-spike/read.ts --run <run id>
 *   npx tsx probe/local-model-spike/report.ts --run <run id>
 */
import fs from "node:fs";
import path from "node:path";

import { parseArgs, tierArg } from "./harness/args.js";
import { captureProductLogs, gitState, isolateAppData, printable, say } from "./harness/entry-common.js";
import { isMain } from "./harness/main-guard.js";
import { isSafeRunId, makeRunId, RUNS_DIR, runDirFor } from "./harness/paths.js";
import { existingRunDir } from "./harness/run-store.js";

const USAGE =
  'usage: measure.ts --model <tag> --tier chat|editing --hardware "<description>" [--screen] [--repeats <n>] [--endpoint <url>] [--resume <run id>] [--include-extended] [--clear-stale-lock]';

export async function main(argv: readonly string[]): Promise<number> {
  const { values, flags } = parseArgs(argv);
  const modelTag = values.get("model");
  const tier = tierArg(values.get("tier"));
  const hardware = values.get("hardware");
  const runsDir = values.get("runs-dir") ?? RUNS_DIR;
  const resume = values.get("resume");
  const mode = flags.has("screen") ? "screen" : "full";
  const repeats = Number(values.get("repeats") ?? "1");

  if (!modelTag || !tier || !hardware) {
    say(USAGE);
    return 2;
  }
  if (!Number.isInteger(repeats) || repeats < 1) {
    say("--repeats must be a whole number of 1 or more");
    return 2;
  }
  if (resume !== undefined && !isSafeRunId(resume)) {
    say(`--resume takes a run id, not a path: ${printable(JSON.stringify(resume))}`);
    return 2;
  }

  const runId = resume ?? makeRunId({ date: new Date(), tier, mode, modelTag });
  let runDir: string;
  try {
    // A resumed run must be a real directory directly inside the runs
    // directory BEFORE anything is written into it.
    runDir = resume !== undefined ? existingRunDir(resume, runsDir) : runDirFor(runId, runsDir);
    if (resume === undefined) {
      // Claim a NEW run's directory exclusively: two starts in the same second
      // with the same tag, tier and mode get the same run id, and the one that
      // loses must neither share the directory nor delete it on refusal.
      fs.mkdirSync(path.dirname(runDir), { recursive: true });
      try {
        fs.mkdirSync(runDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          say(`Run ${runId} already exists (another start in the same second?); try again.`);
          return 2;
        }
        throw err;
      }
    }
  } catch (err) {
    say(printable(err instanceof Error ? err.message : String(err)));
    return 2;
  }

  // BEFORE the product is loaded: its app data goes inside the run directory.
  isolateAppData(runDir);
  captureProductLogs(path.join(runDir, "product-stderr.log"));

  const [{ runMeasurement }, { runTrial }, { preflight }, { computeFingerprint }, { harnessConfig }] =
    await Promise.all([
      import("./harness/runner.js"),
      import("./harness/trial.js"),
      import("./harness/preflight.js"),
      import("./harness/fingerprint.js"),
      import("./harness/model-config.js"),
    ]);

  const result = await runMeasurement(
    {
      modelTag,
      endpoint: values.get("endpoint") ?? "http://127.0.0.1:11434",
      tier,
      mode,
      repeats,
      hardware: hardware ?? "",
      includeExtended: flags.has("include-extended"),
      ...(resume !== undefined ? { resume } : { runId }),
      clearStaleLock: flags.has("clear-stale-lock"),
      runsDir,
    },
    {
      now: () => new Date(),
      commit: gitState,
      config: harnessConfig,
      preflight: (config) => preflight(config),
      fingerprint: async () => (await computeFingerprint()).fingerprint,
      runTrial,
      log: (line) => say(printable(line, 2000)),
    },
  );

  if (result.status === "refused") {
    say(`Not started: ${printable(result.reason ?? "", 4000)}`);
    // A refused NEW run leaves nothing behind. This process created the
    // directory itself (above), so it deletes only its own.
    if (resume === undefined && !fs.existsSync(path.join(runDir, "identity.json"))) {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
    return 2;
  }
  say("");
  say(
    `${result.status === "complete" ? "Run complete" : "Run STOPPED"}: ${result.scoredThisSession} trial(s) scored, ${result.infraThisSession} attempt(s) not scored (infrastructure).`,
  );
  if (result.reason) say(printable(result.reason, 2000));
  say(`Next: npx tsx probe/local-model-spike/read.ts --run ${result.runId}`);
  return result.status === "complete" ? 0 : 1;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      say(`measure failed: ${printable(err instanceof Error ? (err.stack ?? err.message) : String(err), 4000)}`);
      process.exit(2);
    },
  );
}
