/**
 * Turn what a trial observed into the stored record: classify the ending, run
 * the scorer, the claim check and the signals, and bind it all with a hash.
 */
import { systemPromptFor } from "../../../src/server/local-model/index.js";
import { claimCheck } from "./claims.js";
import { type Classification, classifyTrial } from "./classify.js";
import { type ToolStep, type TrialRecord, trialHash } from "./record.js";
import { score } from "./score.js";
import type { Scenario } from "./scenarios/types.js";
import {
  contextUse,
  otherLanguage,
  reasoningShape,
  repeatsPrompt,
  stalePreamble,
  withoutInlineReasoning,
} from "./signals.js";
import type { TrialObservation } from "./trial.js";

const RESULT_TRIM = 1200;

export type Evaluated =
  | { scored: true; record: TrialRecord }
  | { scored: false; classification: Classification };

function toolSteps(obs: TrialObservation): ToolStep[] {
  const out: ToolStep[] = [];
  let i = 0;
  for (const step of obs.loop?.steps ?? []) {
    for (const call of step.toolCalls) {
      const result = obs.toolResults[i]?.content ?? "";
      i += 1;
      out.push({
        turn: step.turn,
        name: call.name,
        args: call.rawArgs || JSON.stringify(call.args ?? {}),
        result: result.length > RESULT_TRIM ? `${result.slice(0, RESULT_TRIM)}…[trimmed]` : result,
        effect: JSON.stringify(call.outcome),
      });
    }
  }
  return out;
}

export function evaluateTrial(input: {
  runId: string;
  trialId: string;
  repeat: number;
  scenario: Scenario;
  observation: TrialObservation;
  contextLength: number | "unknown";
}): Evaluated {
  const { scenario, observation: obs } = input;
  const classification = classifyTrial(obs);
  if (classification.ending === "infrastructure" || obs.loop === null) {
    return { scored: false, classification };
  }

  const scoreInput = {
    scenario,
    reply: obs.reply,
    writes: obs.writes,
    documentText: obs.documentText,
  };
  const scored = score(scoreInput);
  const scoredPlain = score({ ...scoreInput, reply: withoutInlineReasoning(obs.reply) });
  const completed = classification.ending === "completed";
  const reasoning = reasoningShape(obs);
  const actionRequested =
    scenario.group === "editing-request" ||
    scenario.group === "comment" ||
    scenario.group === "replacement" ||
    scenario.group === "thread" ||
    scenario.group === "sequence";

  const record: TrialRecord = {
    runId: input.runId,
    trialId: input.trialId,
    scenarioId: scenario.id,
    tier: scenario.tier,
    group: scenario.group,
    repeat: input.repeat,
    ending: classification.ending,
    detail: classification.detail,
    exit: obs.loop.metrics.exit,
    fixture: scenario.fixture,
    prompt: scenario.prompt,
    ...(scenario.selectedText !== undefined ? { selectedText: scenario.selectedText } : {}),
    composedTask: obs.turnOpts?.task ?? "",
    inlined: obs.turnOpts?.includeFullText ?? null,
    expected: scenario.answer,
    reply: obs.reply,
    turns: obs.turns,
    writes: obs.writes,
    toolSteps: toolSteps(obs),
    notices: obs.notices,
    score: scored,
    scorerPass: completed && scored.pass,
    scorerPassWithoutReasoning: completed && scoredPlain.pass,
    claims: claimCheck({
      tier: scenario.tier,
      reply: obs.reply,
      turnTexts: obs.turns.map((t) => t.text),
      writes: obs.writes,
      documentText: obs.documentText,
      actionRequested,
    }),
    signals: {
      reasoning: reasoning.shape,
      replyShowsReasoning: reasoning.replyShowsReasoning,
      emptyReply: obs.reply.trim().length === 0,
      stalePreamble: stalePreamble(obs),
      otherLanguage: otherLanguage(obs.reply),
      repeatsPrompt: repeatsPrompt(obs.reply, systemPromptFor(scenario.tier)),
      context: contextUse(obs.fetches, input.contextLength),
    },
    metrics: {
      turns: obs.loop.metrics.turns,
      toolCalls: obs.loop.metrics.toolCalls,
      jsonParseFailures: obs.loop.metrics.jsonParseFailures,
    },
    timeToFirstTextMs: obs.timeToFirstTextMs,
    totalMs: obs.totalMs,
    hash: trialHash({
      trialId: input.trialId,
      reply: obs.reply,
      turns: obs.turns,
      writes: obs.writes,
    }),
  };
  return { scored: true, record };
}
