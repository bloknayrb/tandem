/**
 * The run loop: preflight, identity, lock, then one trial after another with
 * every scored trial appended to the log as it finishes. Resumable: a scored
 * trial is never run twice and never skipped; an attempt that ended in an
 * infrastructure error is run again.
 *
 * All outside facts (the clock, the commit, the preflight, the trial runner,
 * the fingerprint) come in through `RunDeps`, so the dry run drives this exact
 * function with scripted ones.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LocalModelConfig } from "../../../src/server/local-model/index.js";
import { evaluateTrial } from "./evaluate.js";
import type { ModelFacts } from "./ollama-meta.js";
import { makeRunId, runDirFor, sha256Hex } from "./paths.js";
import type { PreflightResult } from "./preflight.js";
import { canonicalJson, type InfraRecord, type PlannedTrial, type TrialRecord } from "./record.js";
import {
  acquireLock,
  appendInfra,
  appendTrial,
  existingRunDir,
  MAX_CONSECUTIVE_INFRASTRUCTURE,
  storeFixture,
  identityPath,
  readIdentity,
  readInfra,
  readTrials,
  resumeRefusal,
  type RunIdentity,
  type RunIdentityKey,
  type RunMode,
  type RunSession,
  writeIdentity,
} from "./run-store.js";
import { fixtureFor, selectScenarios } from "./scenarios/index.js";
import type { Scenario, Tier } from "./scenarios/types.js";
import type { TrialInput, TrialObservation } from "./trial.js";
import { validateScenarios } from "./validate.js";

export { MAX_CONSECUTIVE_INFRASTRUCTURE };

/**
 * THE SILENT-ERROR RULE. A trial that ended in an error before the model
 * produced any text at all (an HTTP 500, an unreadable response) is, alone, the
 * model's failure and is scored (brief R2.6). Several in a row usually mean a
 * server that is down or out of memory, and a run that scored them would print
 * FAIL for an endpoint fault. One rule decides:
 *
 *  1. A silent-error trial is HELD, not scored, while its streak is open. A
 *     streak is consecutive trials that produced nothing scorable: held silent
 *     errors and plain endpoint errors.
 *  2. A trial that ends any other way closes the streak: the server answered,
 *     so what was held is the model's own failure and is scored as it stands.
 *  3. A streak that reaches MAX_CONSECUTIVE_INFRASTRUCTURE stops the run. A
 *     streak still open when the run reaches its last trial is NOT closed by
 *     the end: both are logged in `infra.jsonl` as `held-silent-error:<detail>`,
 *     not scored, reported as unscored, and run again on resume.
 *  4. On a resume, a trial with such a record is scored at once when it errors
 *     silently AGAIN WITH THE SAME DETAIL (the person who resumed has looked at
 *     the endpoint; the same error twice is the model's). That scored trial
 *     neither extends nor closes the streak around it. With a different detail
 *     it is held again under rule 1.
 */
function isSilentError(record: TrialRecord): boolean {
  return record.ending === "error" && record.turns.every((t) => t.text.length === 0);
}

export const HELD_SILENT_ERROR = "held-silent-error:";

/** The rule above is stated in every report header (`SILENT_ERROR_RULE_TEXT` in `report-core.ts`). */

export interface RunOptions {
  modelTag: string;
  endpoint: string;
  tier: Tier;
  mode: RunMode;
  repeats: number;
  hardware: string;
  includeExtended: boolean;
  /** Resume this run id instead of starting a new run. */
  resume?: string;
  /** The id of a NEW run, chosen by the caller before the product is loaded
   *  (the app-data directory is pointed inside the run directory first). */
  runId?: string;
  clearStaleLock: boolean;
  runsDir: string;
}

export interface RunDeps {
  now: () => Date;
  commit: () => { commit: string; dirty: boolean | "unknown" };
  config: (modelTag: string, endpoint: string) => LocalModelConfig;
  preflight: (config: LocalModelConfig) => Promise<PreflightResult>;
  fingerprint: () => Promise<string>;
  runTrial: (input: TrialInput) => Promise<TrialObservation>;
  log: (line: string) => void;
  /** The scenario bank to draw from. Defaults to the real one (test seam). */
  scenarios?: (opts: { tier: Tier; mode: RunMode; includeExtended: boolean }) => Scenario[];
  /** Called with the run directory once it is known, before any trial. */
  onRunDir?: (runDir: string) => void;
}

export interface RunResult {
  status: "complete" | "stopped" | "refused";
  reason?: string;
  runId?: string;
  runDir?: string;
  scoredThisSession: number;
  infraThisSession: number;
}

export function planTrials(scenarios: Scenario[], repeats: number): PlannedTrial[] {
  const out: PlannedTrial[] = [];
  for (let r = 1; r <= repeats; r++) {
    for (const s of scenarios) {
      out.push({ trialId: `${s.id}#${r}`, scenarioId: s.id, group: s.group, repeat: r });
    }
  }
  return out;
}

/** A hash of exactly which scenarios, with which content, a run measures. */
export function scenarioSetHash(scenarios: Scenario[]): string {
  return sha256Hex(
    canonicalJson(scenarios.map((s) => ({ ...s, fixtureHash: sha256Hex(fixtureFor(s).markdown) }))),
  ).slice(0, 16);
}

function identityKey(
  opts: RunOptions,
  facts: ModelFacts,
  commit: string,
  fingerprint: string,
  setHash: string,
): RunIdentityKey {
  return {
    commit,
    modelDigest: facts.digest,
    ollamaVersion: facts.ollamaVersion,
    fingerprint,
    tier: opts.tier,
    mode: opts.mode,
    repeats: opts.repeats,
    scenarioSetHash: setHash,
    includeExtended: opts.includeExtended,
  };
}

function seconds(ms: number | null): string {
  return ms === null ? "–" : `${(ms / 1000).toFixed(0)}s`;
}

/**
 * A resume must run on the machine the run started on: the report's outcome
 * describes one machine (a deep-document trial that times out on a slow laptop
 * is a failure THERE). The host name and the hardware description given on
 * the command line must both match the first session's.
 */
export function machineRefusal(stored: RunIdentity, now: RunSession): string | null {
  const first = stored.sessions[0];
  if (first === undefined) return null;
  const changed: string[] = [];
  if (first.host !== now.host) changed.push(`host (was ${JSON.stringify(first.host)}, now ${JSON.stringify(now.host)})`);
  const norm = (h: string) => h.trim().replace(/\s+/g, " ");
  if (norm(first.hardware) !== norm(now.hardware)) {
    changed.push(`hardware (was ${JSON.stringify(first.hardware)}, now ${JSON.stringify(now.hardware)})`);
  }
  if (changed.length === 0) return null;
  return `a run is measured on one machine, and these differ from where it started: ${changed.join("; ")}. Pass the same --hardware text on the same computer, or start a new run`;
}

export async function runMeasurement(opts: RunOptions, deps: RunDeps): Promise<RunResult> {
  const none = { scoredThisSession: 0, infraThisSession: 0 };
  let scenarios: Scenario[];
  try {
    scenarios = (deps.scenarios ?? selectScenarios)({
      tier: opts.tier,
      mode: opts.mode,
      includeExtended: opts.includeExtended,
    });
  } catch (err) {
    return { status: "refused", reason: err instanceof Error ? err.message : String(err), ...none };
  }

  // Every gold anchor, selection and target is checked through the product's
  // own dispatch before anything else. A bank that does not resolve measures nothing.
  const problems = validateScenarios(scenarios);
  if (problems.length > 0) {
    return {
      status: "refused",
      reason: `the scenario bank does not validate:\n  - ${problems.join("\n  - ")}`,
      ...none,
    };
  }

  // The run directory and its lock come BEFORE the preflight: the warm-up is a
  // real chat call to the same server, and a second process that sent one
  // into a live run would slow that run's trials into timeouts before the
  // lock turned it away.
  let runDir: string;
  let stored: RunIdentity | undefined;
  let newRunId: string | undefined;
  if (opts.resume !== undefined) {
    try {
      runDir = existingRunDir(opts.resume, opts.runsDir);
      stored = readIdentity(runDir);
    } catch (err) {
      return { status: "refused", reason: err instanceof Error ? err.message : String(err), ...none };
    }
  } else {
    newRunId =
      opts.runId ??
      makeRunId({ date: deps.now(), tier: opts.tier, mode: opts.mode, modelTag: opts.modelTag });
    runDir = runDirFor(newRunId, opts.runsDir);
    if (fs.existsSync(identityPath(runDir))) {
      return { status: "refused", reason: `run already exists: ${newRunId}`, ...none };
    }
    fs.mkdirSync(runDir, { recursive: true });
  }

  let release: () => void;
  try {
    release = acquireLock(runDir, { clearStale: opts.clearStaleLock });
  } catch (err) {
    return { status: "refused", reason: err instanceof Error ? err.message : String(err), ...none };
  }
  // A refused NEW run leaves nothing behind: its directory, lock and all, is
  // removed rather than unlocked first. (The recursive removal is not atomic;
  // two processes given the same explicit run id at the same moment could
  // still race. A run id from the clock is claimed exclusively by measure.ts.)
  // A refused resume only gives its lock back. Called at most once.
  let refused = false;
  const refuse = (reason: string): RunResult => {
    if (!refused) {
      refused = true;
      try {
        if (stored === undefined) fs.rmSync(runDir, { recursive: true, force: true });
        else release();
      } catch {
        // Best effort: the refusal, or the error that caused it, is what matters.
      }
    }
    return { status: "refused", reason, ...none };
  };

  // Everything between taking the lock and the trial loop, so that a throw
  // here gives the lock back too.
  let config: LocalModelConfig;
  let fingerprint: string;
  let planned: ReturnType<typeof planTrials>;
  let session: RunSession;
  let identity: RunIdentity;
  try {
    config = deps.config(opts.modelTag, opts.endpoint);
    const pre = await deps.preflight(config);
    for (const line of pre.notes) deps.log(line);
    if (!pre.ok) return refuse(pre.stop ?? "the preflight refused");
    const { commit, dirty } = deps.commit();
    fingerprint = await deps.fingerprint();
    const key = identityKey(opts, pre.facts, commit, fingerprint, scenarioSetHash(scenarios));
    planned = planTrials(scenarios, opts.repeats);
    session = {
      startedAt: deps.now().toISOString(),
      dirty,
      hardware: opts.hardware,
      contextLength: pre.facts.contextLength,
      serverSettings: pre.facts.serverSettings,
      toolSupport: pre.facts.toolSupport === true ? "yes" : "unknown",
      host: os.hostname(),
    };
    if (stored !== undefined) {
      const refusal = resumeRefusal(stored, key) ?? machineRefusal(stored, session);
      if (refusal) return refuse(`cannot resume ${opts.resume}: ${refusal}`);
      identity = stored;
    } else {
      identity = {
        ...key,
        runId: newRunId as string,
        modelTag: opts.modelTag,
        endpoint: opts.endpoint,
        sessions: [],
      };
    }
  } catch (err) {
    refuse("");
    throw err;
  }

  let scored = 0;
  let infra = 0;
  try {
    identity.sessions.push(session);
    writeIdentity(runDir, identity);
    fs.writeFileSync(path.join(runDir, "planned.json"), `${JSON.stringify(planned, null, 2)}\n`, "utf8");
    deps.onRunDir?.(runDir);
    deps.log(`Run ${identity.runId}`);
    deps.log(`  directory: ${runDir}`);
    deps.log(`  fingerprint: ${fingerprint}   scenarios: ${scenarios.length}   repeats: ${opts.repeats}`);

    const done = new Set(readTrials<TrialRecord>(runDir).map((t) => t.trialId));
    const todo = planned.filter((p) => !done.has(p.trialId));
    const byId = new Map(scenarios.map((s) => [s.id, s]));
    // Rule 4: trials held before, with the detail of their latest hold.
    const heldBefore = new Map<string, string>();
    for (const r of readInfra<InfraRecord>(runDir)) {
      if (r.detail.startsWith(HELD_SILENT_ERROR)) heldBefore.set(r.trialId, r.detail.slice(HELD_SILENT_ERROR.length));
    }
    /** Consecutive trials that produced nothing scorable: endpoint errors and held silent errors. */
    let streak = 0;
    const held: TrialRecord[] = [];
    const durations: number[] = [];

    const scoreNow = (r: TrialRecord, documentText: string) => {
      storeFixture(runDir, r.fixture, documentText);
      appendTrial(runDir, r);
      scored += 1;
    };
    const heldTexts = new Map<string, string>();
    const logHeld = () => {
      for (const h of held.splice(0)) {
        appendInfra(runDir, {
          runId: identity.runId,
          trialId: h.trialId,
          scenarioId: h.scenarioId,
          group: h.group,
          detail: `${HELD_SILENT_ERROR}${h.detail}`,
          at: deps.now().toISOString(),
        } satisfies InfraRecord);
        infra += 1;
      }
    };
    const stop = (why: string): RunResult => {
      logHeld();
      return {
        status: "stopped",
        reason: `${why} Nothing was scored for them. Check the endpoint, then resume with --resume ${identity.runId}`,
        runId: identity.runId,
        runDir,
        scoredThisSession: scored,
        infraThisSession: infra,
      };
    };

    for (let i = 0; i < todo.length; i++) {
      const plan = todo[i];
      const scenario = byId.get(plan.scenarioId) as Scenario;
      const observation = await deps.runTrial({
        markdown: fixtureFor(scenario).markdown,
        prompt: scenario.prompt,
        selectedText: scenario.selectedText,
        tier: opts.tier,
        config,
      });
      const evaluated = evaluateTrial({
        runId: identity.runId,
        trialId: plan.trialId,
        repeat: plan.repeat,
        scenario,
        observation,
        contextLength: session.contextLength,
      });
      const position = `[${done.size + i + 1}/${planned.length}]`;

      if (!evaluated.scored) {
        const rec: InfraRecord = {
          runId: identity.runId,
          trialId: plan.trialId,
          scenarioId: plan.scenarioId,
          group: plan.group,
          detail: evaluated.classification.detail,
          at: deps.now().toISOString(),
        };
        appendInfra(runDir, rec);
        infra += 1;
        streak += 1;
        deps.log(`${position} ${plan.trialId}  NOT SCORED (infrastructure: ${rec.detail})`);
        if (streak >= MAX_CONSECUTIVE_INFRASTRUCTURE) {
          return stop(`${streak} trials in a row ended in endpoint errors.`);
        }
        continue;
      }

      const r = evaluated.record;
      if (isSilentError(r)) {
        if (heldBefore.get(r.trialId) === r.detail) {
          // Rule 4: the same silent error again, after a resume.
          scoreNow(r, observation.documentText);
          deps.log(`${position} ${plan.trialId}  ERROR before any text (${r.detail}) again, as when it was held — scored`);
          continue;
        }
        held.push(r);
        heldTexts.set(r.trialId, observation.documentText);
        streak += 1;
        deps.log(`${position} ${plan.trialId}  ERROR before any text (${r.detail}) — held`);
        if (streak >= MAX_CONSECUTIVE_INFRASTRUCTURE) {
          return stop(
            `${streak} trials in a row failed before the model produced any text (${r.detail}): that looks like the server, not the model.`,
          );
        }
        continue;
      }

      // Rule 2: the streak is over; what was held is the model's own failure.
      for (const h of held.splice(0)) scoreNow(h, heldTexts.get(h.trialId) ?? "");
      streak = 0;
      scoreNow(r, observation.documentText);
      durations.push(observation.totalMs);
      const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
      const left = todo.length - i - 1;
      const outcome =
        r.ending !== "completed"
          ? r.ending.toUpperCase()
          : r.scorerPass
            ? "pass"
            : `fail (${r.score.failureMode ?? "?"})`;
      deps.log(
        `${position} ${plan.trialId}  ${outcome}${r.claims.suspect ? "  [suspect]" : ""}  first text ${seconds(r.timeToFirstTextMs)}  total ${seconds(r.totalMs)}  about ${Math.round((mean * left) / 60_000)} min left`,
      );
    }
    // Rule 3: the end of the run does not close a streak. What is held stays
    // unscored and is run again on resume.
    if (held.length > 0) {
      const n = held.length;
      logHeld();
      return {
        status: "stopped",
        reason: `the run reached its end with ${n} trial(s) held: they failed before any text, and no later trial showed the server answering. They are not scored. Check the endpoint, then resume with --resume ${identity.runId} to run them again`,
        runId: identity.runId,
        runDir,
        scoredThisSession: scored,
        infraThisSession: infra,
      };
    }
    return { status: "complete", runId: identity.runId, runDir, scoredThisSession: scored, infraThisSession: infra };
  } finally {
    release();
  }
}
