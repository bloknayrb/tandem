/**
 * The reader's verdict file (brief R2.4, as amended by the owner's review of
 * PR #2415: an explicit verdict on every gating trial; "agree" is retired).
 *
 *   { "rubricVersion": "…", "reader": "…", "runId": "…",
 *     "entries": [ { "runId", "trialId", "hash",
 *                    "falseClaim": "yes" | "no" | "unsure",
 *                    "verdict": "pass" | "fail",
 *                    "reason": "…" } ] }
 *
 * `verdict` is the reader's own pass or fail. It is REQUIRED for every trial
 * of the three gating chat groups and optional elsewhere. `reason` is required
 * whenever the verdict differs from the scorer's (a trial the scorer passed
 * marked wrong, or one it failed marked right). `hash` binds the entry to the
 * whole trial record (`recordHash`), recomputed from the record when the file
 * is checked. The file holds no model text: only ids, hashes and verdicts.
 */
import { recordHash, type TrialRecord } from "./record.js";
import { GATING_GROUPS } from "./scenarios/types.js";

export type FalseClaimVerdict = "yes" | "no" | "unsure";
export type ReaderVerdict = "pass" | "fail";

export interface VerdictEntry {
  runId: string;
  trialId: string;
  hash: string;
  falseClaim: FalseClaimVerdict | null;
  verdict?: ReaderVerdict | null;
  /** Required when `verdict` differs from the scorer's. */
  reason?: string;
  /** Optional: the sentence that earned a "yes", or anything else worth keeping. */
  note?: string;
}

export interface VerdictFile {
  rubricVersion: string;
  reader: string;
  runId: string;
  entries: VerdictEntry[];
}

export interface CheckedVerdicts {
  /** Usable verdicts by trial id: valid entries only, never a duplicated one. */
  byTrial: Map<string, VerdictEntry>;
  /** Everything wrong with the file; any item makes the report INCONCLUSIVE. */
  problems: string[];
  /** Trials of the run with no usable entry. */
  missing: string[];
  /** The file is for the current rubric. */
  rubricCurrent: boolean;
  /**
   * Trials with a "yes" in an entry that names this run's trial, matches its
   * hash and is not duplicated — whether or not the rest of that entry is
   * well-formed. A confirmed false claim must not be lost to a missing
   * verdict or reason.
   */
  saidYes: Set<string>;
}

export function isGatingTrial(t: Pick<TrialRecord, "group" | "tier">): boolean {
  return t.tier === "chat" && (GATING_GROUPS as readonly string[]).includes(t.group);
}

export function parseVerdictFile(text: string): VerdictFile {
  const raw = JSON.parse(text) as Partial<VerdictFile>;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.entries)) {
    throw new Error("verdict file has no entries array");
  }
  return {
    rubricVersion: String(raw.rubricVersion ?? ""),
    reader: String(raw.reader ?? ""),
    runId: String(raw.runId ?? ""),
    // Anything that is not an object is dropped here and shows up as a missing verdict.
    entries: (raw.entries as unknown[]).filter(
      (e): e is VerdictEntry => typeof e === "object" && e !== null && !Array.isArray(e),
    ),
  };
}

export function checkVerdicts(
  file: VerdictFile | null,
  runId: string,
  trials: TrialRecord[],
  rubricVersion: string,
): CheckedVerdicts {
  const byTrial = new Map<string, VerdictEntry>();
  const problems: string[] = [];
  if (file === null) {
    return {
      byTrial,
      problems: ["no verdict file"],
      missing: trials.map((t) => t.trialId),
      rubricCurrent: false,
      saidYes: new Set(),
    };
  }
  const rubricCurrent = file.rubricVersion === rubricVersion;
  if (!rubricCurrent) {
    problems.push(
      `verdict file is for rubric ${JSON.stringify(file.rubricVersion)}, the current rubric is ${JSON.stringify(rubricVersion)}`,
    );
  }
  if (file.reader.trim() === "") problems.push("verdict file names no reader");
  if (file.runId !== runId) {
    problems.push(`verdict file is for run ${JSON.stringify(file.runId)}, not ${runId}`);
  }

  const saidYes = new Set<string>();
  const known = new Map(trials.map((t) => [t.trialId, t]));
  const seen = new Map<string, number>();
  for (const e of file.entries) seen.set(e.trialId, (seen.get(e.trialId) ?? 0) + 1);

  for (const e of file.entries) {
    const where = `entry for ${JSON.stringify(e.trialId)}`;
    if ((seen.get(e.trialId) ?? 0) > 1) {
      if (!problems.includes(`duplicate ${where}`)) problems.push(`duplicate ${where}`);
      continue; // a duplicated trial has no usable verdict, in either direction
    }
    const trial = known.get(e.trialId);
    if (!trial || e.runId !== runId) {
      problems.push(`${where} names no trial of run ${runId}`);
      continue;
    }
    if (e.hash !== recordHash(trial)) {
      problems.push(`${where} was written for a different record (hash does not match)`);
      continue;
    }
    if (e.falseClaim === "yes") saidYes.add(e.trialId);
    if (e.falseClaim !== "yes" && e.falseClaim !== "no" && e.falseClaim !== "unsure") {
      problems.push(`${where} has no false-claim verdict`);
      continue;
    }
    if (e.falseClaim === "unsure") problems.push(`${where} is "unsure"`);
    const v = e.verdict ?? null;
    if (v === null) {
      if (isGatingTrial(trial)) {
        problems.push(`${where} has no verdict ("pass" or "fail"); every gating trial needs one`);
        continue;
      }
    } else {
      if (v !== "pass" && v !== "fail") {
        problems.push(`${where} has a verdict that is neither "pass" nor "fail"`);
        continue;
      }
      const disagrees = (v === "pass") !== trial.scorerPass;
      if (disagrees && (typeof e.reason !== "string" || e.reason.trim().length === 0)) {
        problems.push(`${where} differs from the scorer (${trial.scorerPass ? "pass" : "fail"}) and gives no reason`);
        continue;
      }
      if (v === "pass" && trial.ending !== "completed") {
        problems.push(
          `${where} passes a trial that ended in ${trial.ending}, which is a failure whatever the text says`,
        );
        continue;
      }
    }
    byTrial.set(e.trialId, e);
  }

  const missing = trials.filter((t) => !byTrial.has(t.trialId)).map((t) => t.trialId);
  return { byTrial, problems, missing, rubricCurrent, saidYes };
}

/** An empty verdict file for the reader to fill in. */
export function verdictTemplate(
  runId: string,
  trials: TrialRecord[],
  rubricVersion: string,
): VerdictFile {
  return {
    rubricVersion,
    reader: "",
    runId,
    entries: trials.map((t) => ({
      runId,
      trialId: t.trialId,
      hash: recordHash(t),
      falseClaim: null,
      ...(isGatingTrial(t) ? { verdict: null } : {}),
    })),
  };
}
