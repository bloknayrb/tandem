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
// Usage: node classify.mjs <stream.jsonl> <inputs-dir>
// Env:   CLAUDE_CODE_OAUTH_TOKEN, REVIEW_OUTCOME (steps.review.outcome)

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SEVERITIES = ["important", "nit"];

// Result subtypes the CLI is known to emit, plus our own reasons. Anything
// else is reported as "other" so a model- or CLI-chosen string never reaches
// the public comment.
export const REASONS = [
  "error_max_turns",
  "error_during_execution",
  "error_max_structured_output_retries",
  "schema-invalid",
  "no-result",
  "step-failed",
  "other",
];

/** Length-gated so the scrubbing code and its tests (short literals) don't trip it. */
const TOKEN_SHAPE = /sk-ant-[a-z0-9]+-[A-Za-z0-9_-]{40,}/;

/**
 * Parse the CLI's stream-json output. A CLI killed by the step timeout leaves
 * a truncated last line, so unparseable lines are skipped, not fatal.
 * Returns the last `result` event, or null.
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

/** Validate the review schema: {summary, findings: [{path, line, severity, body}]}. */
export function isValidReview(output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  if (typeof output.summary !== "string") return false;
  if (!Array.isArray(output.findings)) return false;
  return output.findings.every(
    (f) =>
      f &&
      typeof f === "object" &&
      typeof f.path === "string" &&
      Number.isInteger(f.line) &&
      f.line >= 1 &&
      SEVERITIES.includes(f.severity) &&
      typeof f.body === "string",
  );
}

function reasonFor(subtype) {
  return REASONS.includes(subtype) ? subtype : "other";
}

/**
 * Pure decision. Returns { outcome: "posted"|"incomplete"|"withheld", reason?, matchKind?, review? }.
 * The secret scan runs over everything the model produced, before any other
 * verdict, so a leak inside an otherwise-incomplete run is still withheld.
 */
export function classify({ streamText, reviewOutcome, token }) {
  const result = lastResultEvent(streamText);
  const output = result ? result.structured_output : undefined;

  const scanned = scanForSecrets(
    JSON.stringify({ output: output ?? null, result: result?.result ?? null }),
    token,
  );
  if (scanned) return { outcome: "withheld", matchKind: scanned };

  if (!result) return { outcome: "incomplete", reason: "no-result" };
  if (result.is_error || result.subtype !== "success") {
    return { outcome: "incomplete", reason: reasonFor(result.subtype) };
  }
  if (!isValidReview(output)) return { outcome: "incomplete", reason: "schema-invalid" };
  if (reviewOutcome !== "success") return { outcome: "incomplete", reason: "step-failed" };
  return { outcome: "posted", review: output };
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
  const verdict = classify({
    streamText,
    reviewOutcome: process.env.REVIEW_OUTCOME ?? "",
    token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
  });
  const { review, ...summary } = verdict;
  writeFileSync(path.join(inputsDir, "outcome.json"), `${JSON.stringify(summary)}\n`);
  if (review) writeFileSync(path.join(inputsDir, "findings.json"), `${JSON.stringify(review)}\n`);
  // Only the verdict's own enum fields are printed, never content.
  console.log(`outcome=${summary.outcome} reason=${summary.reason ?? "-"} match=${summary.matchKind ?? "-"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
