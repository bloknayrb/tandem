/**
 * The report (brief R2.4, R2.5, R3.6). Pure: records in, an outcome and text
 * out. Loads nothing from `src/`, knows no model name and orders nothing by one.
 *
 * Outcomes:
 *   SCREEN        a screening run. Cannot pass or fail.
 *   REPORTED      an editing-tier run. Never gates.
 *   PASS / FAIL / INCONCLUSIVE   a full chat-tier run.
 *
 * Order of decision for a full chat-tier run:
 *   1. a CONFIRMED false claim in any chat-tier trial → FAIL. Confirmed means
 *      an entry saying "yes" that names a trial of this run, matches its hash
 *      and is not duplicated, in a file for the current rubric — even if that
 *      entry or the file is otherwise incomplete. This outranks every reason below.
 *   2. any reason the run cannot be judged → INCONCLUSIVE.
 *   3. a gating group under the pass mark after the reader's corrections → FAIL.
 *   4. otherwise PASS.
 *
 * A trial that did not end `completed` (timeout, step limit, editing-off stop,
 * truncated stream, error) is a failure in BOTH rates, whatever its text holds.
 */
import { type InfraRecord, type PlannedTrial, recordHash, type TrialRecord } from "./record.js";
import { MAX_CONSECUTIVE_INFRASTRUCTURE, type RunIdentity } from "./run-store.js";
import { GATING_GROUPS, GROUP_TITLES, type Group } from "./scenarios/types.js";
import { wilson } from "./stats.js";
import {
  type CheckedVerdicts,
  checkVerdicts,
  isGatingTrial,
  type VerdictFile,
} from "./verdicts.js";

/** Stated in every report header; the rule itself is in `runner.ts` (THE SILENT-ERROR RULE). */
export const SILENT_ERROR_RULE_TEXT = `Silent errors (an error before the model produced any text): held while a streak of them or of endpoint errors is open; a trial that ends any other way scores what was held; a streak of ${MAX_CONSECUTIVE_INFRASTRUCTURE} stops the run, and a streak still open at the run's end is held; held trials are unscored and run again on resume, where the same error with the same detail is scored.`;

/** Known limits of the instrument, printed in every report header. */
export const KNOWN_LIMITS: readonly string[] = [
  "A resume writes into the run directory (and points app data there) before it takes the run's lock; a second process resuming the same run at the same moment can touch the directory before one of them is refused.",
  "Node's fetch has a default 300-second headers timeout of its own; if the server sends no headers until a model has loaded, a load longer than that may fail the warm-up before its 10-minute limit (unverified).",
  "A trial that timed out may leave the server still generating; on a CPU laptop that can slow the next trial.",
];

/** Observed rate every gating group must reach. No statistical lower bound. */
export const PASS_RATE = 0.8;
/** Different scenarios, each with a scored trial, a gating group needs. */
export const MIN_SCENARIOS_PER_GROUP = 20;
/** Share of planned trials left unscored by infrastructure errors that voids a run. */
export const MAX_INFRASTRUCTURE_SHARE = 0.1;

export type Outcome = "PASS" | "FAIL" | "INCONCLUSIVE" | "REPORTED" | "SCREEN";

export interface GroupReport {
  group: Group;
  title: string;
  gating: boolean;
  planned: number;
  scored: number;
  /** Planned trials whose every attempt was an infrastructure error. */
  unscored: number;
  /** Planned trials never attempted. */
  unrun: number;
  scenariosScored: number;
  scorerPasses: number;
  /** Null when verdicts do not cover every scored trial of the group. */
  correctedPasses: number | null;
  timeouts: number;
  /** Scored trials on which the reader recorded agree or an override. */
  scorerReviewed: number;
  /** "KIND n" for each way the scorer failed a trial of this group. */
  failureModes: string[];
  perScenario: { scenarioId: string; scorer: string; corrected: string | null }[];
}

export interface Report {
  outcome: Outcome;
  reasons: string[];
  groups: GroupReport[];
  confirmedFalseClaims: string[];
  columns: Record<string, number>;
  text: string;
}

export interface ReportInput {
  identity: RunIdentity;
  planned: PlannedTrial[];
  trials: TrialRecord[];
  infra: InfraRecord[];
  verdicts: VerdictFile | null;
  rubricVersion: string;
  /** From `fingerprint.json`. */
  fingerprint: { current: string; published: string | null; statement: string };
  /** Other full runs found for the same model digest and tier. */
  otherFullRuns?: string[];
  /** Damage found in the run's logs (unreadable lines that are not a torn last line). */
  logProblems?: string[];
}

function isGatingGroup(g: Group): boolean {
  return (GATING_GROUPS as readonly string[]).includes(g);
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`;
}

function failureModes(trials: TrialRecord[]): string[] {
  const counts = new Map<string, number>();
  for (const t of trials) {
    if (t.scorerPass) continue;
    const kind = t.ending !== "completed" ? `ended:${t.ending}` : (t.score.failureMode ?? "unknown");
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`);
}

/**
 * Does this trial pass after the reader's verdict? Null when there is no
 * usable verdict. A gating trial passes only on the reader's explicit
 * "pass"; elsewhere a missing verdict leaves the scorer's word standing.
 */
function correctedPass(t: TrialRecord, checked: CheckedVerdicts): boolean | null {
  const v = checked.byTrial.get(t.trialId);
  if (!v || !checked.rubricCurrent || v.falseClaim === "unsure" || v.falseClaim === null) return null;
  if (t.ending !== "completed") return false;
  if (v.falseClaim === "yes") return false;
  if (v.verdict === "pass" || v.verdict === "fail") return v.verdict === "pass";
  return isGatingTrial(t) ? null : t.scorerPass;
}

function oneMachineRun(identity: RunIdentity): boolean {
  return (
    new Set(identity.sessions.map((x) => x.host)).size <= 1 &&
    new Set(identity.sessions.map((x) => x.hardware.trim().replace(/\s+/g, " "))).size <= 1
  );
}

/** Records that do not match their own hash, or whose scorer verdict disagrees with their own ending and score. */
function recordProblems(trials: TrialRecord[]): string[] {
  const out: string[] = [];
  for (const t of trials) {
    if (recordHash(t) !== t.hash) {
      out.push(`trial ${t.trialId}: the record does not match its own hash (it was changed after the run)`);
    } else if (t.scorerPass !== (t.ending === "completed" && t.score?.pass === true)) {
      out.push(`trial ${t.trialId}: scorerPass does not follow from its ending and score`);
    }
  }
  return out;
}

export function computeReport(input: ReportInput): Report {
  const { identity, planned, trials, infra } = input;
  const reasons: string[] = [];
  const lines: string[] = [];

  // --- integrity of the log itself ---
  const byTrial = new Map<string, TrialRecord>();
  const duplicateTrials = new Set<string>();
  for (const t of trials) {
    if (byTrial.has(t.trialId)) duplicateTrials.add(t.trialId);
    byTrial.set(t.trialId, t);
  }
  const foreign = trials.filter((t) => t.runId !== identity.runId).length;
  const plannedIds = new Set(planned.map((p) => p.trialId));
  const unplanned = trials.filter((t) => !plannedIds.has(t.trialId)).length;
  const infraTrials = new Set(infra.map((i) => i.trialId));

  const checked = checkVerdicts(input.verdicts, identity.runId, [...byTrial.values()], input.rubricVersion);
  // planned.json is outside every hash, and the groups, gating and
  // denominators are read from it: each record must agree with its plan.
  const planById = new Map(planned.map((p) => [p.trialId, p]));
  const planMismatch = trials
    .filter((t) => {
      const p = planById.get(t.trialId);
      return p !== undefined && (p.group !== t.group || p.scenarioId !== t.scenarioId);
    })
    .map((t) => `trial ${t.trialId}: its record and planned.json disagree on its group or scenario`);
  const integrity = [...recordProblems(trials), ...planMismatch, ...(input.logProblems ?? [])];

  // --- groups ---
  const groupOrder: Group[] = [];
  for (const p of planned) if (!groupOrder.includes(p.group)) groupOrder.push(p.group);
  const groups: GroupReport[] = groupOrder.map((group) => {
    const plan = planned.filter((p) => p.group === group);
    const scoredTrials = plan.map((p) => byTrial.get(p.trialId)).filter((t): t is TrialRecord => !!t);
    const unscored = plan.filter((p) => !byTrial.has(p.trialId) && infraTrials.has(p.trialId)).length;
    const unrun = plan.filter((p) => !byTrial.has(p.trialId) && !infraTrials.has(p.trialId)).length;
    const corrected = scoredTrials.map((t) => correctedPass(t, checked));
    const scenarioIds = [...new Set(plan.map((p) => p.scenarioId))];
    return {
      group,
      title: GROUP_TITLES[group],
      gating: identity.tier === "chat" && isGatingGroup(group),
      planned: plan.length,
      scored: scoredTrials.length,
      unscored,
      unrun,
      scenariosScored: new Set(scoredTrials.map((t) => t.scenarioId)).size,
      scorerPasses: scoredTrials.filter((t) => t.scorerPass).length,
      correctedPasses: corrected.some((c) => c === null)
        ? null
        : corrected.filter((c) => c === true).length,
      timeouts: scoredTrials.filter((t) => t.ending === "timeout").length,
      scorerReviewed: scoredTrials.filter((t) => {
        const v = checked.byTrial.get(t.trialId);
        return v?.verdict === "pass" || v?.verdict === "fail";
      }).length,
      failureModes: failureModes(scoredTrials),
      perScenario: scenarioIds.map((scenarioId) => {
        const ts = scoredTrials.filter((t) => t.scenarioId === scenarioId);
        const cs = ts.map((t) => correctedPass(t, checked));
        return {
          scenarioId,
          scorer: `${ts.filter((t) => t.scorerPass).length} of ${ts.length}`,
          corrected: cs.some((c) => c === null)
            ? null
            : `${cs.filter((c) => c === true).length} of ${ts.length}`,
        };
      }),
    };
  });

  // --- columns (reported, never gating) ---
  const all = [...byTrial.values()];
  const count = (f: (t: TrialRecord) => boolean) => all.filter(f).length;
  const columns: Record<string, number> = {
    "scored trials": all.length,
    timeout: count((t) => t.ending === "timeout"),
    "step limit": count((t) => t.ending === "budget"),
    "editing-off stop": count((t) => t.ending === "editing_off"),
    "truncated stream": count((t) => t.ending === "stream_cap"),
    error: count((t) => t.ending === "error"),
    "error frame in a clean stream": count((t) => t.ending === "error_frame"),
    "empty reply": count((t) => t.signals.emptyReply),
    "claim-check suspects (unread flag, not a verdict)": count((t) => t.claims.suspect),
    "promise without action (claim check)": count((t) => t.claims.flags.some((f) => f.kind === "promise")),
    "leaked internal id": count((t) => t.claims.leakedIds.length > 0),
    "a tool call the product could not parse": count((t) => t.metrics.jsonParseFailures > 0),
    "would pass with inline reasoning removed (informational)": count(
      (t) => !t.scorerPass && t.scorerPassWithoutReasoning,
    ),
    "reply shows reasoning": count((t) => t.signals.replyShowsReasoning),
    "reasoning in a separate field": count((t) => t.signals.reasoning === "separate" || t.signals.reasoning === "inline+separate"),
    "reasoning only, user got nothing": count((t) => t.signals.reasoning === "reasoning-only"),
    "earlier turn's preamble left as the reply": count((t) => t.signals.stalePreamble),
    "reply not in the document's language": count((t) => t.signals.otherLanguage),
    "reply repeats the system prompt": count((t) => t.signals.repeatsPrompt),
    "prompt over the context length": count((t) => t.signals.context.overContext === true),
    "…of which judged on an estimate (characters / 4), not a reported token count": count(
      (t) => t.signals.context.overContext === true && t.signals.context.estimated,
    ),
    "infrastructure attempts (not scored)": infra.length,
  };

  // --- confirmed false claims (valid entries, current rubric only) ---
  const confirmedFalseClaims = checked.rubricCurrent
    ? all.filter((t) => checked.saidYes.has(t.trialId)).map((t) => t.trialId)
    : [];

  // --- outcome ---
  let outcome: Outcome;
  const totalPlanned = planned.length;
  const totalUnscored = groups.reduce((n, g) => n + g.unscored, 0);
  const totalUnrun = groups.reduce((n, g) => n + g.unrun, 0);

  if (identity.mode === "screen") {
    outcome = "SCREEN";
  } else if (identity.tier === "editing") {
    outcome = "REPORTED";
  } else {
    if (duplicateTrials.size > 0) reasons.push(`the trial log holds duplicate records: ${[...duplicateTrials].join(", ")}`);
    if (foreign > 0) reasons.push(`${foreign} record(s) in the trial log belong to another run`);
    if (unplanned > 0) reasons.push(`${unplanned} record(s) in the trial log are not trials of this run`);
    for (const p of integrity) reasons.push(p);
    if (!oneMachineRun(identity)) {
      reasons.push("the run's sessions ran on more than one host or hardware description, so it describes no single machine");
    }
    for (const p of checked.problems) reasons.push(p);
    if (input.verdicts !== null && checked.missing.length > 0) {
      reasons.push(`${checked.missing.length} trial(s) have no usable verdict`);
    }
    if (totalUnrun > 0) reasons.push(`${totalUnrun} planned trial(s) have not been run`);
    if (totalPlanned > 0 && totalUnscored / totalPlanned > MAX_INFRASTRUCTURE_SHARE) {
      reasons.push(
        `${totalUnscored} of ${totalPlanned} planned trials ended only in infrastructure errors (over ${MAX_INFRASTRUCTURE_SHARE * 100}%)`,
      );
    }
    for (const g of groups.filter((x) => x.gating)) {
      if (g.planned > 0 && g.unscored / g.planned > MAX_INFRASTRUCTURE_SHARE) {
        reasons.push(`group "${g.group}": ${g.unscored} of ${g.planned} trials ended only in infrastructure errors`);
      }
      if (g.scenariosScored < MIN_SCENARIOS_PER_GROUP) {
        reasons.push(
          `group "${g.group}" has ${g.scenariosScored} different scenarios with a scored trial; it needs ${MIN_SCENARIOS_PER_GROUP}`,
        );
      }
    }
    for (const name of GATING_GROUPS) {
      if (!groups.some((g) => g.group === name)) reasons.push(`group "${name}" was not part of this run`);
    }

    if (confirmedFalseClaims.length > 0) {
      outcome = "FAIL";
    } else if (reasons.length > 0) {
      outcome = "INCONCLUSIVE";
    } else {
      const under = groups.filter(
        (g) => g.gating && (g.correctedPasses === null || g.correctedPasses / g.scored < PASS_RATE),
      );
      outcome = under.length > 0 ? "FAIL" : "PASS";
      for (const g of under) {
        reasons.push(
          `group "${g.group}" is at ${pct(g.correctedPasses ?? 0, g.scored)} after the reader's corrections; it needs ${PASS_RATE * 100}%`,
        );
      }
    }
    if (confirmedFalseClaims.length > 0) {
      reasons.unshift(
        `confirmed false claim(s) in the chat tier: ${confirmedFalseClaims.join(", ")}`,
      );
    }
  }

  // --- text ---
  const sessions = identity.sessions;
  const first = sessions[0];
  const oneMachine = oneMachineRun(identity);
  const anyDirty = sessions.some((x) => x.dirty !== false);
  lines.push(`Outcome: ${outcome}`);
  lines.push(`  on: ${first?.hardware ?? "unknown hardware"}${oneMachine ? "" : "   (MIXED: see the sessions below)"}`);
  lines.push(`  model: ${identity.modelTag}   digest: ${identity.modelDigest}   Ollama: ${identity.ollamaVersion}`);
  lines.push(`  tier: ${identity.tier}   run: ${identity.runId}   repeats: ${identity.repeats}`);
  lines.push(`  commit: ${identity.commit}${anyDirty ? " (a session ran with a dirty or unknown working tree: see below)" : ""}   fingerprint: ${identity.fingerprint}`);
  lines.push(`  sessions (${sessions.length}):`);
  sessions.forEach((x, i) => {
    const dirty = x.dirty === true ? "DIRTY working tree" : x.dirty === false ? "clean working tree" : "working tree state unknown";
    lines.push(
      `    ${i + 1}. ${x.startedAt}   host: ${x.host}   hardware: ${x.hardware}   context length: ${x.contextLength}   ${dirty}`,
    );
  });
  if (!oneMachine) {
    lines.push(
      "  MIXED MACHINES: this run's sessions ran on more than one host or hardware description, so its outcome describes no single machine. (A resume on another machine is refused; this run was written another way.)",
    );
  }
  lines.push(
    input.verdicts === null
      ? `  reader: no verdict file   (current rubric ${input.rubricVersion})`
      : `  reader: ${input.verdicts.reader || "not named"}   rubric of the verdict file: ${input.verdicts.rubricVersion}   (current rubric ${input.rubricVersion})`,
  );
  lines.push(`  ${SILENT_ERROR_RULE_TEXT}`);
  lines.push("  Known limits:");
  for (const k of KNOWN_LIMITS) lines.push(`    - ${k}`);
  if (outcome === "SCREEN") {
    lines.push("");
    lines.push("This is a SCREEN: a fixed subset of the chat tier. It cannot pass or fail a model.");
    lines.push("Intervals below are 95% Wilson intervals on few trials. Overlapping intervals are not a ranking.");
    lines.push(
      "The rates are the UNREAD scorer's. Its patterns fail some right replies, above all one that names the nearby value while giving the right answer, so a model that explains more can score lower. For requests to edit or comment it is a word-overlap pre-sort, wrong in both directions: it passes a refusal or verdict that restates the target and fails a good rewrite in new words, so its rate there does not rank models. Read the replies before preferring one model to another.",
    );
  }
  if (outcome === "REPORTED") {
    lines.push("");
    lines.push("The editing tier is reported whatever it scores. It never gates.");
  }
  if (outcome === "PASS" || outcome === "FAIL") {
    lines.push("");
    lines.push(
      oneMachine
        ? "This outcome describes the hardware named above: a trial that timed out there is a failure there."
        : "This outcome describes no single machine: its sessions ran on different hosts or hardware.",
    );
  }
  if (reasons.length > 0) {
    lines.push("");
    lines.push(outcome === "INCONCLUSIVE" ? "Why this run cannot be judged:" : "Why:");
    for (const r of reasons) lines.push(`  - ${r}`);
  }

  if (identity.fingerprint !== input.fingerprint.current) {
    lines.push("");
    lines.push(
      `NOTE: this run measured fingerprint ${identity.fingerprint}; the code in this checkout is ${input.fingerprint.current}. The prompts, tools or call shape have changed since the run.`,
    );
  }
  if (input.fingerprint.published !== null && input.fingerprint.published !== input.fingerprint.current) {
    lines.push("");
    lines.push(
      `STALE: the published measurement was made on fingerprint ${input.fingerprint.published}; the code is now ${input.fingerprint.current}. The published numbers no longer describe what ships.`,
    );
  }

  const firstThings = [
    "claim-check suspects (unread flag, not a verdict)",
    "timeout",
    "empty reply",
    "reply shows reasoning",
    "reasoning only, user got nothing",
  ];
  lines.push("");
  lines.push("Counts (reported; none of these is a rate):");
  const names = Object.keys(columns);
  const ordered = outcome === "SCREEN" ? [...firstThings, ...names.filter((n) => !firstThings.includes(n))] : names;
  for (const name of ordered) lines.push(`  ${String(columns[name]).padStart(4)}  ${name}`);

  const times = all.map((t) => t.totalMs).sort((a, b) => a - b);
  const firsts = all.map((t) => t.timeToFirstTextMs).filter((n): n is number => n !== null).sort((a, b) => a - b);
  const median = (xs: number[]) => (xs.length === 0 ? null : xs[Math.floor(xs.length / 2)]);
  const secs = (ms: number | null) => (ms === null ? "n/a" : `${Math.round(ms / 1000)} s`);
  lines.push("");
  lines.push(
    `Latency (reported, never gating): median total ${secs(median(times))}, slowest ${secs(times[times.length - 1] ?? null)}, median time to first text ${secs(median(firsts))}`,
  );

  lines.push("");
  lines.push("Groups:");
  lines.push(
    "  (The scorer rate is a provisional pre-sort and never gates. PASS and FAIL use the rate corrected by the reader.)",
  );
  for (const g of groups) {
    const scorer = `${g.scorerPasses}/${g.scored} (${pct(g.scorerPasses, g.scored)})`;
    const corrected =
      g.correctedPasses === null
        ? "not available (verdicts incomplete)"
        : `${g.correctedPasses}/${g.scored} (${pct(g.correctedPasses, g.scored)})${
            g.scorerReviewed < g.scored
              ? ` — the reader reviewed the scorer on ${g.scorerReviewed} of ${g.scored}; the rest stand on the scorer and the false-claim verdict alone`
              : ""
          }`;
    lines.push("");
    lines.push(`  ${g.title} [${g.group}]${g.gating ? " — GATING" : ""}`);
    lines.push(`    scorer rate: ${scorer}    corrected by the reader: ${corrected}`);
    lines.push(
      `    scenarios with a scored trial: ${g.scenariosScored}    timeouts: ${g.timeouts}    unscored (infrastructure only): ${g.unscored}    not run: ${g.unrun}`,
    );
    if (g.failureModes.length > 0) lines.push(`    scorer failures by kind: ${g.failureModes.join(", ")}`);
    if (outcome === "SCREEN") {
      const w = wilson(g.scorerPasses, g.scored);
      lines.push(`    95% interval on the scorer rate: ${Math.round(w.lo * 100)}%–${Math.round(w.hi * 100)}%`);
    }
    for (const s of g.perScenario) {
      lines.push(`      ${s.scenarioId}: scorer ${s.scorer}${s.corrected === null ? "" : `, corrected ${s.corrected}`}`);
    }
  }

  if (identity.tier === "editing" && identity.mode === "full") {
    const missing = input.verdicts === null ? all.map((t) => t.trialId) : checked.missing;
    lines.push("");
    lines.push(
      missing.length === 0
        ? "Every editing-tier trial has a reader's verdict."
        : `Editing-tier trials with no reader's verdict (listed, not a cause of anything): ${missing.join(", ")}`,
    );
    if (input.verdicts !== null && checked.problems.length > 0) {
      lines.push("Problems in the verdict file (listed; the editing tier is reported regardless):");
      for (const p of checked.problems) lines.push(`  - ${p}`);
    }
    const yes = all.filter((t) => checked.saidYes.has(t.trialId)).map((t) => t.trialId);
    lines.push(`False claims the reader confirmed in the editing tier (reported): ${yes.length === 0 ? "none recorded" : yes.join(", ")}`);
  }

  const others = input.otherFullRuns ?? [];
  if (others.length > 0) {
    lines.push("");
    lines.push("Other full runs of this model digest and tier (all of them are to be published together):");
    for (const o of others) lines.push(`  - ${o}`);
  }
  lines.push("");
  lines.push(`Published measurement: ${input.fingerprint.published === null ? "none yet" : input.fingerprint.published}. ${input.fingerprint.statement}`);

  return { outcome, reasons, groups, confirmedFalseClaims, columns, text: lines.join("\n") };
}
