#!/usr/bin/env node
// Decides the outcome of one Claude review run (#1831) and scans the model's
// output for the subscription token before anything can be posted.
//
// This is the only step besides the review itself that holds
// CLAUDE_CODE_OAUTH_TOKEN, and it holds it only to look for it. It never posts
// and never prints a matched string or any excerpt of its input: the repo is
// public, so the job log is too. Node built-ins only, because it runs from a
// sparse checkout of master that has no node_modules.
//
// It scans twice: the raw result text first, then the exact item post.mjs will
// send, because building rewrites the text (a path prefix removed, a header
// added, a cut at the cap). post.mjs sends inputs/item.json as is.
//
// Usage: node classify.mjs <stream.jsonl> <inputs-dir>
// Env:   CLAUDE_CODE_OAUTH_TOKEN, REVIEW_OUTCOME (steps.review.outcome), RUN_ID,
//        RUN_ATTEMPT, REVIEW_WORKDIR (the checkout the review ran in)

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildItem } from "./post.mjs";

// Result subtypes the CLI is known to emit, plus our own reasons. Anything
// else is reported as "other" so a model- or CLI-chosen string never reaches
// the public comment.
export const REASONS = [
  "error_max_turns",
  "error_during_execution",
  "no-result",
  "step-failed",
  "api-error",
  "no-token",
  "unrecognised-output",
  "other",
];

/**
 * Reasons that mean a person should look rather than that one PR was too much
 * for the review: an expired or missing token, a usage limit, an API outage,
 * or text that isn't a review (which is how an auth or usage failure inside
 * the skill arrives: as prose with subtype "success"). The note is still
 * posted, but the workflow's last step turns the run red so the merge gate
 * stops instead of proceeding. That step's shell condition is what acts; this
 * list documents it, and a wiring test keeps the two equal.
 */
export const SYSTEMIC_REASONS = ["api-error", "no-token", "unrecognised-output"];

/**
 * What a /code-review result looks like once the CLI has formatted the skill's
 * findings (it does so under --output-format stream-json): at least one
 * numbered item with a severity marker, or the CLI's own line for an empty
 * list. The `m` flag matters: the text opens with a summary, never an item.
 */
export const REVIEW_ITEM_RE = /^\s*\d+\.\s+(🔴|🟡|🟣)/mu;
export const NO_ISSUES_RE = /^Code review found no issues\.$/m;

export function isRecognisedReview(text) {
  return typeof text === "string" && (REVIEW_ITEM_RE.test(text) || NO_ISSUES_RE.test(text));
}

/** Length-gated so the scrubbing code and its tests (short literals) don't trip it. */
const TOKEN_SHAPE = /sk-ant-[a-z0-9]+-[A-Za-z0-9_-]{40,}/;

/**
 * Parse the CLI's stream-json output. A CLI killed by the step timeout leaves
 * a truncated last line, so unparseable lines are skipped, not fatal.
 * Returns the last top-level `result` event, or null.
 */
export function lastResultEvent(streamText) {
  let result = null;
  for (const line of streamText.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event && event.type === "result") result = event;
  }
  return result;
}

/** The base64 encodings of `secret` at all three byte alignments, standard and URL-safe. */
export function base64Forms(secret) {
  const forms = new Set();
  const bytes = Buffer.from(secret, "utf8");
  for (let offset = 0; offset < 3; offset++) {
    const padded = Buffer.concat([Buffer.alloc(offset), bytes]);
    let encoded = padded.toString("base64");
    // The first 4 chars carry the prefix bytes when offset > 0, and the last 4
    // may carry padding or a partial group: keep only the stable middle.
    encoded = encoded.slice(offset > 0 ? 4 : 0, encoded.length - 4);
    if (encoded.length >= 16) {
      forms.add(encoded);
      forms.add(encoded.replace(/\+/g, "-").replace(/\//g, "_"));
    }
  }
  return [...forms];
}

/**
 * Scan serialized output for the token. Returns "exact" (the token itself or
 * a base64 form of it), "pattern" (only a token-shaped string), or null.
 */
export function scanForSecrets(serialized, token) {
  if (token && token.length >= 16) {
    if (serialized.includes(token)) return "exact";
    for (const form of base64Forms(token)) {
      if (serialized.includes(form)) return "exact";
    }
  }
  if (TOKEN_SHAPE.test(serialized)) return "pattern";
  return null;
}

function reasonFor(subtype) {
  return REASONS.includes(subtype) ? subtype : "other";
}

/**
 * Pure decision. Returns { outcome: "posted"|"incomplete"|"withheld", reason?, matchKind?, text? }.
 * The secret scan runs over everything the model produced, before any other
 * verdict, so a leak inside an otherwise-incomplete run is still withheld.
 */
export function classify({ streamText, reviewOutcome, token }) {
  const result = lastResultEvent(streamText);
  const text = result?.result;

  const scanned = scanForSecrets(JSON.stringify({ result: text ?? null }), token);
  if (scanned) return { outcome: "withheld", matchKind: scanned };

  if (!token) return { outcome: "incomplete", reason: "no-token" };
  if (!result) return { outcome: "incomplete", reason: "no-result" };
  // An API failure (auth, usage limit, outage) reports is_error with subtype
  // "success" or an api_error_status, not one of the run-limit subtypes.
  if (result.is_error && (result.subtype === "success" || result.api_error_status != null)) {
    return { outcome: "incomplete", reason: "api-error" };
  }
  if (result.is_error || result.subtype !== "success") {
    return { outcome: "incomplete", reason: reasonFor(result.subtype) };
  }
  if (!isRecognisedReview(text)) return { outcome: "incomplete", reason: "unrecognised-output" };
  if (reviewOutcome !== "success") return { outcome: "incomplete", reason: "step-failed" };
  return { outcome: "posted", text };
}

/**
 * Build the exact item post.mjs will send for a verdict, then scan those
 * bytes. A hit turns the verdict into "withheld", whose item is fixed text.
 * Returns { outcome, item }. Pure.
 */
export function prepare({ verdict, sha, runId, attempt, pr, token, workdir }) {
  const { text, ...outcome } = verdict;
  const build = (o) => buildItem({ outcome: o, text, sha, runId, attempt, pr, workdir });
  const item = build(outcome);
  if (outcome.outcome !== "posted") return { outcome, item };
  const hit = scanForSecrets(JSON.stringify(item), token);
  if (!hit) return { outcome, item };
  const withheld = { outcome: "withheld", matchKind: hit };
  return { outcome: withheld, item: build(withheld) };
}

function main() {
  const [streamPath, inputsDir] = process.argv.slice(2);
  if (!streamPath || !inputsDir) {
    console.error("usage: classify.mjs <stream.jsonl> <inputs-dir>");
    process.exit(64);
  }
  let streamText = "";
  try {
    streamText = readFileSync(streamPath, "utf8");
  } catch {
    // No stream at all (the CLI never started): treated as no result.
  }
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
  const verdict = classify({ streamText, reviewOutcome: process.env.REVIEW_OUTCOME ?? "", token });
  const pr = JSON.parse(readFileSync(path.join(inputsDir, "pr.json"), "utf8"));
  const prepared = prepare({
    verdict,
    sha: pr.headRefOid,
    runId: process.env.RUN_ID,
    attempt: process.env.RUN_ATTEMPT,
    pr: pr.number,
    token,
    workdir: process.env.REVIEW_WORKDIR || undefined,
  });
  writeFileSync(path.join(inputsDir, "outcome.json"), `${JSON.stringify(prepared.outcome)}\n`);
  writeFileSync(path.join(inputsDir, "item.json"), `${JSON.stringify({ item: prepared.item })}\n`);
  // Only the verdict's own enum fields are printed, never content.
  const o = prepared.outcome;
  console.log(`outcome=${o.outcome} reason=${o.reason ?? "-"} match=${o.matchKind ?? "-"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
