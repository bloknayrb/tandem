/**
 * The reader's verdict file (brief R2.4).
 *
 *   { "rubricVersion": "…", "reader": "…", "runId": "…",
 *     "entries": [ { "runId", "trialId", "hash",
 *                    "falseClaim": "yes" | "no" | "unsure",
 *                    "scorer": "agree" | { "override": "pass" | "fail", "reason": "…" } } ] }
 *
 * `scorer` is required for trials of the three gating chat groups and optional
 * elsewhere. The file holds no model text: only ids, hashes and verdicts.
 */
import { GATING_GROUPS } from "./scenarios/types.js";
import type { TrialRecord } from "./record.js";

export type FalseClaimVerdict = "yes" | "no" | "unsure";
export type ScorerVerdict = "agree" | { override: "pass" | "fail"; reason: string };

export interface VerdictEntry {
  runId: string;
  trialId: string;
  hash: string;
  falseClaim: FalseClaimVerdict | null;
  scorer?: ScorerVerdict | null;
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
   * agree/override field.
   */
  saidYes: Set<string>;
}

function isGating(t: TrialRecord): boolean {
  return (GATING_GROUPS as readonly string[]).includes(t.group);
}

/** May the reader's override turn this trial into a pass? Not when the run itself failed. */
function overrideAllowed(t: TrialRecord, v: ScorerVerdict): boolean {
  if (v === "agree" || v.override === "fail") return true;
  return t.ending === "completed";
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
    entries: raw.entries as VerdictEntry[],
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
    if (e.hash !== trial.hash) {
      problems.push(`${where} was written for different text (hash does not match)`);
      continue;
    }
    if (e.falseClaim === "yes") saidYes.add(e.trialId);
    if (e.falseClaim !== "yes" && e.falseClaim !== "no" && e.falseClaim !== "unsure") {
      problems.push(`${where} has no false-claim verdict`);
      continue;
    }
    if (e.falseClaim === "unsure") problems.push(`${where} is "unsure"`);
    const s = e.scorer ?? null;
    if (s === null) {
      if (isGating(trial)) {
        problems.push(`${where} has no agree/override of the scorer`);
        continue;
      }
    } else if (s !== "agree") {
      const ok =
        typeof s === "object" &&
        (s.override === "pass" || s.override === "fail") &&
        typeof s.reason === "string" &&
        s.reason.trim().length > 0;
      if (!ok) {
        problems.push(`${where} has an override with no reason`);
        continue;
      }
      if (!overrideAllowed(trial, s)) {
        problems.push(
          `${where} overrides to pass a trial that ended in ${trial.ending}, which is a failure whatever the text says`,
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
      hash: t.hash,
      falseClaim: null,
      ...(isGating(t) ? { scorer: null } : {}),
    })),
  };
}
