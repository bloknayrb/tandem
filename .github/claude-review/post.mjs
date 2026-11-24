#!/usr/bin/env node
// Posts the single PR item for one Claude review run (#1831).
//
// It holds GH_TOKEN and never the subscription token, and it reads only the
// inputs/ directory that classify.mjs wrote. Everything the model wrote is
// sanitised before the header is prepended, so model text can neither forge a
// header nor ping people, load images, or smuggle raw HTML. Node built-ins only.
//
// Usage: node post.mjs <inputs-dir>
// Env:   GH_TOKEN, GITHUB_REPOSITORY, RUN_ID, RUN_ATTEMPT

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const BODY_CAP = 60_000;
export const FINDING_CAP = 8_000;
const TRUNCATED = "\n\n…(truncated)";

/** The visible first line of every item. The merge gate reads it back. */
export function header(sha, runId, attempt) {
  return `Claude review of \`${sha}\` (run ${runId}, attempt ${attempt})`;
}

/** Matches a header at the very start of a body; captures sha, run id, attempt. */
export const HEADER_RE = /^Claude review of `([0-9a-f]{7,40})` \(run (\d+), attempt (\d+)\)/;

export function cap(text, limit) {
  return text.length <= limit ? text : text.slice(0, limit - TRUNCATED.length) + TRUNCATED;
}

/** Neutralise model-written Markdown before it is posted. */
export function sanitize(text) {
  return String(text)
    .replace(/<!--[\s\S]*?(-->|$)/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, "")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/(^|[^\w`])@([A-Za-z0-9][\w-]*(?:\/[\w.-]+)?)/g, "$1`@$2`");
}

/**
 * Lines that can carry an inline comment: every right-hand (new-file) line
 * inside a hunk of the unified diff, context lines included.
 * Returns Map<path, Set<line>>.
 */
export function commentableLines(diffText) {
  const map = new Map();
  let file = null;
  let line = 0;
  let inHunk = false;
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      file = null;
      inHunk = false;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4).trim();
      file = target === "/dev/null" ? null : target.replace(/^b\//, "");
      inHunk = false;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || file === null) continue;
    if (raw.startsWith("+") || raw.startsWith(" ")) {
      if (!map.has(file)) map.set(file, new Set());
      map.get(file).add(line);
      line++;
    } else if (raw.startsWith("-") || raw.startsWith("\\")) {
      // removed line or "\ No newline": no right-hand line
    } else {
      inHunk = false;
    }
  }
  return map;
}

/** Build the request for the run's outcome. Pure. */
export function buildItem({ outcome, findings, diffText, sha, runId, attempt, pr }) {
  const head = header(sha, runId, attempt);
  if (outcome.outcome === "withheld") {
    const what =
      outcome.matchKind === "exact"
        ? "the output contained this workflow's subscription token. Check the run and rotate `CLAUDE_CODE_OAUTH_TOKEN`."
        : "the output contained a token-shaped string. Check the run.";
    return { kind: "comment", body: `${head}\n\n**Review withheld:** ${what}` };
  }
  if (outcome.outcome === "incomplete") {
    return {
      kind: "comment",
      body:
        `${head}\n\nClaude review did not complete (\`${outcome.reason}\`). ` +
        `Re-run: \`gh workflow run claude-code-review.yml -f pr=${pr}\``,
    };
  }
  const lines = commentableLines(diffText);
  const inline = [];
  const fallback = [];
  for (const f of findings.findings) {
    const filePath = sanitize(f.path);
    const body = cap(`**${f.severity}:** ${sanitize(f.body)}`, FINDING_CAP);
    if (lines.get(f.path)?.has(f.line)) {
      inline.push({ path: f.path, line: f.line, side: "RIGHT", body });
    } else {
      fallback.push(`- \`${filePath.replace(/`/g, "")}:${f.line}\` ${body}`);
    }
  }
  const summary = sanitize(findings.summary).trim();
  const parts = [head, summary || ""];
  if (findings.findings.length === 0) parts.push("No findings.");
  if (fallback.length) parts.push("**Findings outside the diff:**", fallback.join("\n"));
  const body = cap(parts.filter(Boolean).join("\n\n"), BODY_CAP);
  return { kind: "review", body, comments: inline, commit_id: sha };
}

function gh(args, input) {
  const res = spawnSync("gh", args, { input, encoding: "utf8" });
  return { status: res.status ?? 1, stderr: res.stderr ?? "" };
}

/** Post the item; a review that GitHub refuses (422) is retried body-only. */
export function postItem(item, { repo, pr, run = gh }) {
  if (item.kind === "comment") {
    return run(["api", `repos/${repo}/issues/${pr}/comments`, "--input", "-"], JSON.stringify({ body: item.body }));
  }
  const request = { commit_id: item.commit_id, event: "COMMENT", body: item.body, comments: item.comments };
  const first = run(["api", `repos/${repo}/pulls/${pr}/reviews`, "--input", "-"], JSON.stringify(request));
  if (first.status === 0) return first;
  const allInBody = item.comments.map((c) => `- \`${c.path}:${c.line}\` ${c.body}`).join("\n");
  const body = cap([item.body, allInBody].filter(Boolean).join("\n\n"), BODY_CAP);
  return run(
    ["api", `repos/${repo}/pulls/${pr}/reviews`, "--input", "-"],
    JSON.stringify({ commit_id: item.commit_id, event: "COMMENT", body, comments: [] }),
  );
}

function main() {
  const [inputsDir] = process.argv.slice(2);
  if (!inputsDir) {
    console.error("usage: post.mjs <inputs-dir>");
    process.exit(64);
  }
  const read = (name) => readFileSync(path.join(inputsDir, name), "utf8");
  const outcome = JSON.parse(read("outcome.json"));
  const pr = JSON.parse(read("pr.json"));
  const findings = outcome.outcome === "posted" ? JSON.parse(read("findings.json")) : null;
  const item = buildItem({
    outcome,
    findings,
    diffText: outcome.outcome === "posted" ? read("pr.diff") : "",
    sha: pr.headRefOid,
    runId: process.env.RUN_ID,
    attempt: process.env.RUN_ATTEMPT,
    pr: pr.number,
  });
  const res = postItem(item, { repo: process.env.GITHUB_REPOSITORY, pr: pr.number });
  if (res.status !== 0) {
    console.error(`posting failed (gh exit ${res.status})`);
    process.exit(1);
  }
  console.log(`posted ${item.kind} for outcome=${outcome.outcome}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
