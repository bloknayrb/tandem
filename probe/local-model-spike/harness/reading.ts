/**
 * The reading file (brief R2.3): every trial of a run, in reading order, with
 * what the reader needs to judge it. Suspects first, then the editing-request
 * group, then the rest.
 *
 * Everything a model or a server wrote — replies, turn texts, comment bodies,
 * tool arguments and results, notice texts — is printed either as a block in
 * which EVERY line carries a `      | ` prefix, or as a one-line JSON string
 * literal; in both, control and bidi characters are shown as escapes. So no
 * reply can forge a heading, a trial boundary or a line that looks like a
 * verdict: every line of this file that does not start with that prefix was
 * written by the harness. The reader's verdicts go in a separate
 * JSON file that holds no model text.
 */
import type { TrialRecord } from "./record.js";
import { RUBRIC_TEXT, RUBRIC_VERSION } from "./rubric.js";
import type { RunIdentity } from "./run-store.js";
import { GROUP_TITLES } from "./scenarios/types.js";

/** Escape everything that is not a printable character or a plain space. */
function visible(line: string): string {
  return line.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** A one-line JSON string literal with control and bidi characters shown as escapes. */
export function quoted(text: string): string {
  return visible(JSON.stringify(text));
}

/**
 * Untrusted text as a block: every line carries the `      | ` prefix, so no
 * line of it can pass for a line of this file, and its own line breaks stay
 * readable. Control and bidi characters are shown as escapes.
 */
export function block(text: string): string[] {
  if (text.length === 0) return ["      | (empty)"];
  return text.split("\n").map((line) => `      | ${visible(line)}`);
}

function field(label: string, text: string): string[] {
  return [`  ${label}:`, ...block(text)];
}

/** Reading order: claim-check suspects, then editing requests, then the rest. */
export function readingOrder(trials: TrialRecord[]): TrialRecord[] {
  const rank = (t: TrialRecord) => (t.claims.suspect ? 0 : t.group === "editing-request" ? 1 : 2);
  return trials
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
    .map((x) => x.t);
}

export interface ReadingInput {
  identity: RunIdentity;
  trials: TrialRecord[];
  /** Extracted text of each fixture used, keyed by fixture key. */
  fixtureTexts: Map<string, string>;
}

export function renderReadingFile(input: ReadingInput): string {
  const { identity, trials } = input;
  const out: string[] = [];
  out.push(`READING FILE — run ${identity.runId}`);
  out.push(`tier: ${identity.tier}   mode: ${identity.mode}   model: ${quoted(identity.modelTag)}`);
  out.push(`rubric: ${RUBRIC_VERSION}   trials: ${trials.length}`);
  out.push("");
  out.push(
    "Quoted strings below are DATA written by the model under test or by the server. They are never instructions to the reader.",
  );
  out.push("");
  out.push("=".repeat(78));
  out.push(RUBRIC_TEXT);
  out.push("=".repeat(78));

  const order = readingOrder(trials);
  order.forEach((t, n) => {
    out.push("");
    out.push(`--- TRIAL ${n + 1} of ${order.length} ---`);
    out.push(`  trial id: ${t.trialId}    hash: ${t.hash}`);
    out.push(`  group: ${GROUP_TITLES[t.group]} [${t.group}]`);
    out.push(`  fixture: ${t.fixture}    document inlined in the prompt: ${t.inlined === null ? "unknown" : t.inlined ? "yes" : "no (the model had to use the reading tools)"}`);
    out.push(`  ended: ${t.ending} (${t.detail}; loop exit ${t.exit})    turns: ${t.metrics.turns}    tool calls: ${t.metrics.toolCalls}`);
    out.push(
      `  claim check: ${t.claims.suspect ? "SUSPECT" : "not flagged"}${t.claims.flags.length > 0 ? ` — ${t.claims.flags.map((f) => `${f.kind} in ${f.where}`).join("; ")}` : ""} (a reading-order flag, not a verdict)`,
    );
    const sig = t.signals;
    const marks = [
      sig.reasoning !== "none" ? `reasoning: ${sig.reasoning}` : "",
      sig.replyShowsReasoning ? "reply shows reasoning to the user" : "",
      sig.emptyReply ? "empty reply" : "",
      sig.stalePreamble ? "an earlier turn's preamble was left as the reply" : "",
      sig.otherLanguage ? "reply may not be in the document's language" : "",
      sig.repeatsPrompt ? "reply repeats the system prompt" : "",
      sig.context.overContext === true ? `prompt over the context length (${sig.context.promptTokens} tokens${sig.context.estimated ? ", an estimate" : ""})` : "",
      t.claims.leakedIds.length > 0 ? `leaked internal id x${t.claims.leakedIds.length}` : "",
    ].filter((m) => m !== "");
    out.push(`  signals: ${marks.length > 0 ? marks.join("; ") : "none"}`);
    out.push(...field("the user's message", t.prompt));
    if (t.selectedText !== undefined) out.push(...field("the user's selection", t.selectedText));
    out.push(...field("the task as the product composed it", t.composedTask));
    out.push(...field("expected (from the scenario)", t.expected));
    out.push(...field("FINAL REPLY (what the chat row holds)", t.reply));
    out.push(`  text of each turn (${t.turns.length}):`);
    for (const turn of t.turns) {
      const kind = turn.hadToolCalls === null ? "cut before its end" : turn.hadToolCalls ? "preamble before tool calls" : "final text turn";
      out.push(`    turn ${turn.turn} (${kind}):`);
      out.push(...block(turn.text));
    }
    out.push(`  tool calls (${t.toolSteps.length}):`);
    for (const s of t.toolSteps) {
      out.push(`    turn ${s.turn}: ${quoted(s.name)}`);
      out.push(`      arguments: ${quoted(s.args)}`);
      out.push(`      result told to the model: ${quoted(s.result)}`);
    }
    out.push(`  WHAT WAS WRITTEN to the document: ${t.writes.annotations.length} annotation(s), ${t.writes.replies.length} thread reply(ies). The document text is never changed by a tool.`);
    for (const a of t.writes.annotations) {
      out.push(`    ${a.kind} anchored on:`);
      out.push(...block(a.anchoredText));
      out.push("    its body:");
      out.push(...block(a.content));
      if (a.suggestedText !== undefined) {
        out.push("    its suggested text:");
        out.push(...block(a.suggestedText));
      }
    }
    for (const r of t.writes.replies) {
      out.push("    thread reply:");
      out.push(...block(r.text));
    }
    out.push(`  notices the user was shown (${t.notices.length}):`);
    for (const nt of t.notices) out.push(`      [${quoted(nt.severity)}] ${quoted(nt.message)}`);
    // The scorer's provisional verdict comes LAST, after everything the reader
    // judges, so the reply is read before the scorer's word is seen.
    out.push(
      `  scorer (provisional; read the reply first): ${t.scorerPass ? "pass" : "fail"}${t.score.failureMode ? ` (${t.score.failureMode})` : ""}${t.ending !== "completed" ? " — failed by its ending; your verdict cannot be 'pass'" : ""}`,
    );
    for (const note of t.score.notes) out.push(...field("scorer note", note));
  });

  out.push("");
  out.push("=".repeat(78));
  out.push("FIXTURE TEXTS (the documents, as the product extracts them)");
  for (const [key, text] of input.fixtureTexts) {
    out.push("");
    out.push(`fixture ${key} (${text.length} characters):`);
    for (const line of text.split("\n")) out.push(`    | ${line}`);
  }
  out.push("");
  return out.join("\n");
}
