#!/usr/bin/env node
// Posts the single PR item for one Claude review run (#1831).
//
// Two halves. The pure half (buildItem) is called by classify.mjs, which
// builds the exact bytes to post and secret-scans them. The review is the
// /code-review skill's own markdown, posted as rendered markdown (Bryan,
// 2026-11-25): a PR that steers the reviewer can get mentions, links, images
// or HTML comments into it, bounded as described in docs/security.md. The
// posting half (main) runs in its own step holding GH_TOKEN and never the
// subscription token, and sends inputs/item.json exactly as classify.mjs
// wrote it. No npm dependencies.
//
// Usage: node post.mjs <inputs-dir>
// Env:   GH_TOKEN, GITHUB_REPOSITORY

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The skill text is cut here (UTF-16 units), well under GitHub's 65,536 body limit. */
export const TEXT_CAP = 60_000;
export const TRUNCATION_NOTE = "*Review truncated at 60,000 characters.*";
const GH_TIMEOUT_MS = 120_000;

/** The visible first line of every item. The merge gate reads it back. */
export function header(sha, runId, attempt) {
  return `Claude review of \`${sha}\` (run ${runId}, attempt ${attempt})`;
}

/** Matches a header at the very start of a body; captures sha, run id, attempt. */
export const HEADER_RE = /^Claude review of `([0-9a-f]{7,40})` \(run (\d+), attempt (\d+)\)/;

/** The line after the header of an "incomplete" note; the merge gate tells it from a review by this. */
export const INCOMPLETE_MARK = "Claude review did not complete";

/** One phrase per reason, shown in the posted note. */
export const REASON_GLOSS = {
  error_max_turns: "the review hit its turn limit",
  error_during_execution: "the review stopped with an error",
  "no-result": "the review produced no result",
  "step-failed": "the review step failed or timed out",
  "api-error": "the API refused the request (token, usage limit or outage)",
  "no-token": "the subscription token is missing",
  "unrecognised-output": "the review returned text that isn't a review; check the run log",
  other: "the review ended for an unrecognised reason",
};

/**
 * Cut `text` to at most `limit` UTF-16 units without splitting a surrogate
 * pair: a lone high surrogate at the cut would post as U+FFFD.
 */
export function truncate(text, limit) {
  if (text.length <= limit) return { text, truncated: false };
  let cut = limit;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return { text: text.slice(0, cut), truncated: true };
}

/**
 * Build the request for the run's outcome. Pure.
 * `text` is the skill's markdown (posted outcome only). `workdir`, when set, is
 * removed where the model cited an absolute path inside the checkout, so the
 * runner's directory layout does not appear in the review.
 */
export function buildItem({ outcome, text, sha, runId, attempt, pr, workdir }) {
  const head = header(sha, runId, attempt);
  if (outcome.outcome === "withheld") {
    const what =
      outcome.matchKind === "exact"
        ? "the output contained this workflow's subscription token. Check the run and rotate `CLAUDE_CODE_OAUTH_TOKEN`."
        : "the output contained a token-shaped string. Check the run.";
    return { kind: "comment", body: `${head}\n\n**Review withheld:** ${what}` };
  }
  if (outcome.outcome === "incomplete") {
    const gloss = REASON_GLOSS[outcome.reason] ?? REASON_GLOSS.other;
    return {
      kind: "comment",
      body:
        `${head}\n\n${INCOMPLETE_MARK} (\`${outcome.reason}\`: ${gloss}). ` +
        `Re-run: \`gh workflow run claude-code-review.yml -f pr=${pr}\``,
    };
  }
  let review = String(text);
  if (workdir) review = review.split(`${workdir.replace(/\/+$/, "")}/`).join("");
  const cut = truncate(review, TEXT_CAP);
  const body = `${head}\n\n${cut.text}${cut.truncated ? `\n\n${TRUNCATION_NOTE}` : ""}`;
  // A PR review, never an issue comment: the merge gate tells a "did not
  // complete" note from a review by its being an issue comment.
  return { kind: "review", body, commit_id: sha };
}

function gh(args, input) {
  const res = spawnSync("gh", args, { input, encoding: "utf8", timeout: GH_TIMEOUT_MS });
  return { status: res.status ?? 1, stderr: res.stderr ?? "", error: res.error?.code };
}

/** The HTTP status gh reports in its error output, if any. Never the response body. */
export function httpStatus(stderr) {
  return /HTTP (\d{3})/.exec(stderr ?? "")?.[1] ?? null;
}

/** Post the prepared item. Any failure is returned as is. */
export function postItem({ item }, { repo, pr, run = gh }) {
  if (item.kind === "comment") {
    return run(["api", `repos/${repo}/issues/${pr}/comments`, "--input", "-"], JSON.stringify({ body: item.body }));
  }
  return run(
    ["api", `repos/${repo}/pulls/${pr}/reviews`, "--input", "-"],
    JSON.stringify({ commit_id: item.commit_id, event: "COMMENT", body: item.body }),
  );
}

function main() {
  const [inputsDir] = process.argv.slice(2);
  if (!inputsDir) {
    console.error("usage: post.mjs <inputs-dir>");
    process.exit(64);
  }
  // classify.mjs built and secret-scanned exactly these bytes; nothing here
  // rewrites them.
  const prepared = JSON.parse(readFileSync(path.join(inputsDir, "item.json"), "utf8"));
  const pr = JSON.parse(readFileSync(path.join(inputsDir, "pr.json"), "utf8"));
  const outcome = JSON.parse(readFileSync(path.join(inputsDir, "outcome.json"), "utf8"));
  const res = postItem(prepared, { repo: process.env.GITHUB_REPOSITORY, pr: pr.number });
  if (res.status !== 0) {
    // Status code and spawn error only: gh's stderr can echo the request body.
    console.error(`posting failed (gh exit ${res.status}, HTTP ${httpStatus(res.stderr) ?? "?"}, ${res.error ?? "no spawn error"})`);
    process.exit(1);
  }
  console.log(`posted ${prepared.item.kind} for outcome=${outcome.outcome}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
