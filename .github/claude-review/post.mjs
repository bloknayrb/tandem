#!/usr/bin/env node
// Posts the single PR item for one Claude review run (#1831).
//
// Two halves. The pure half (buildItem, bodyOnly, fence) is called by
// classify.mjs, which builds the exact bytes to post and secret-scans them.
// Everything the model wrote, and every PR-chosen path, is placed inside a
// fenced code block whose fence is longer than any backtick run in it, so
// GitHub renders it literally: no mentions, issue links, images, HTML or
// escapes, and no way to close the block early. Only our own fixed text is
// Markdown. The posting half (main) runs in its own step holding GH_TOKEN and
// never the subscription token, and sends inputs/item.json exactly as
// classify.mjs wrote it. No npm dependencies.
//
// Usage: node post.mjs <inputs-dir>
// Env:   GH_TOKEN, GITHUB_REPOSITORY

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const BODY_CAP = 60_000;
export const FINDING_CAP = 8_000;
export const SUMMARY_CAP = 20_000;
export const FINDINGS_BLOCK_CAP = 35_000;
export const WRAP = 100;
const TRUNCATED = "\n\n…(truncated)";
const GH_TIMEOUT_MS = 120_000;

/** The visible first line of every item. The merge gate reads it back. */
export function header(sha, runId, attempt) {
  return `Claude review of \`${sha}\` (run ${runId}, attempt ${attempt})`;
}

/** Matches a header at the very start of a body; captures sha, run id, attempt. */
export const HEADER_RE = /^Claude review of `([0-9a-f]{7,40})` \(run (\d+), attempt (\d+)\)/;

/** The line after the header of an "incomplete" note; the merge gate tells it from a review by this. */
export const INCOMPLETE_MARK = "Claude review did not complete";

/** The line a review body carries so the gate can check it fetched every inline comment. */
export function inlineCountLine(n) {
  return `_${n} inline comment${n === 1 ? "" : "s"}._`;
}
export const INLINE_COUNT_RE = /^_(\d+) inline comments?\._$/m;

export function cap(text, limit) {
  return text.length <= limit ? text : text.slice(0, limit - TRUNCATED.length) + TRUNCATED;
}

/** Soft-wrap long lines at a space (code blocks do not wrap on GitHub). */
export function wrap(text, width = WRAP) {
  const out = [];
  for (let line of text.split("\n")) {
    while (line.length > width) {
      let at = line.lastIndexOf(" ", width);
      if (at <= 0) at = width;
      out.push(line.slice(0, at));
      line = line.slice(at).replace(/^ /, "");
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Put untrusted text in a fenced code block that it cannot close: the fence is
 * one backtick longer than the longest backtick run in the text (at least
 * three), and a closing fence must be at least as long as the opening one.
 * GitHub renders code blocks literally, so nothing inside becomes a mention,
 * an issue reference, an image, HTML or an entity/escape.
 */
export function fence(text) {
  // Measured after wrapping, which splits any run longer than a line: the
  // fence is then at most WRAP + 1 long, so a body of backticks cannot grow
  // the post past GitHub's size limit.
  const wrapped = wrap(String(text).replace(/\r/g, ""));
  const longest = Math.max(0, ...[...wrapped.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(Math.max(3, longest + 1));
  return `${f}text\n${wrapped}\n${f}`;
}

const findingText = (f) => `[${f.severity}] ${f.path}:${f.line}\n${f.body}`;

/**
 * Walk a unified diff line by line. Each line is classified as "new" (an added
 * or context line, which has a line number in the new file), "old" (a removed
 * line) or "meta" (headers, hunk markers, "\ No newline"). Hunks are consumed
 * by their header's line counts, so an added line whose content begins "++ "
 * (shown as "+++ ...") is never mistaken for a file header.
 * Returns [{ raw, kind, file, line }] where line is set for "new" lines.
 */
export function walkDiff(diffText) {
  const out = [];
  let file = null;
  let line = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of diffText.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      const c = raw[0];
      if (c === "+" || c === " " || raw === "") {
        if (c === "+" || newLeft > 0) {
          out.push({ raw, kind: "new", file, line });
          line++;
          newLeft--;
        } else {
          out.push({ raw, kind: "meta", file });
        }
        if (c !== "+") oldLeft--;
        continue;
      }
      if (c === "-") {
        oldLeft--;
        out.push({ raw, kind: "old", file });
        continue;
      }
      if (c === "\\") {
        out.push({ raw, kind: "meta", file }); // "\ No newline at end of file": no line of either side
        continue;
      }
      // Anything else means the counts were off: stop the hunk and parse this line as a header.
      oldLeft = 0;
      newLeft = 0;
    }
    if (raw.startsWith("diff --git ")) {
      file = null;
    } else if (raw.startsWith("+++ ")) {
      const target = raw.slice(4).replace(/\t.*$/, "").trim();
      file = target === "/dev/null" ? null : target.replace(/^b\//, "");
    } else {
      const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      if (hunk) {
        oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
        line = Number(hunk[2]);
        newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
      }
    }
    out.push({ raw, kind: "meta", file });
  }
  return out;
}

/**
 * Lines that can carry an inline comment: every right-hand (new-file) line
 * inside a hunk of the unified diff, context lines included.
 * Returns Map<path, Set<line>>.
 */
export function commentableLines(diffText) {
  const map = new Map();
  for (const { kind, file, line } of walkDiff(diffText)) {
    if (kind !== "new" || file === null) continue;
    if (!map.has(file)) map.set(file, new Set());
    map.get(file).add(line);
  }
  return map;
}

export const NUMBER_WIDTH = 6;

/**
 * The diff the model reads: every added or context line is prefixed with its
 * line number in the new file, every removed line with blanks, so the model
 * can cite real file lines. The live probe (#2557) showed that, given a raw
 * diff, the model cites positions in the diff file instead, and every finding
 * then misses the diff and falls out of the inline comments.
 */
export function numberDiff(diffText) {
  const pad = " ".repeat(NUMBER_WIDTH);
  return walkDiff(diffText)
    .map(({ raw, kind, line }) => {
      if (kind === "new") return `${String(line).padStart(NUMBER_WIDTH)} ${raw}`;
      if (kind === "old") return `${pad} ${raw}`;
      return raw;
    })
    .join("\n");
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
        `${head}\n\n${INCOMPLETE_MARK} (\`${outcome.reason}\`). ` +
        `Re-run: \`gh workflow run claude-code-review.yml -f pr=${pr}\``,
    };
  }
  const lines = commentableLines(diffText);
  const inline = [];
  const outside = [];
  for (const f of findings.findings) {
    if (lines.get(f.path)?.has(f.line)) {
      // The path is a real path from the diff (it matched commentableLines);
      // it goes to the API as a field, never into Markdown.
      inline.push({ path: f.path, line: f.line, side: "RIGHT", body: fence(cap(`[${f.severity}] ${f.body}`, FINDING_CAP)) });
    } else {
      outside.push(f);
    }
  }
  const summary = findings.summary.trim();
  const assemble = (count, listed, heading) => {
    const parts = [head, inlineCountLine(count)];
    if (summary) parts.push(fence(cap(summary, SUMMARY_CAP)));
    if (findings.findings.length === 0) parts.push("No findings.");
    if (listed.length) parts.push(heading, fence(cap(listed.map(findingText).join("\n\n"), FINDINGS_BLOCK_CAP)));
    return parts.join("\n\n");
  };
  return {
    kind: "review",
    body: assemble(inline.length, outside, "**Findings outside the diff:**"),
    comments: inline,
    commit_id: sha,
    // The 422 fallback (see bodyOnly), built here from the raw findings so it
    // is fenced the same way and scanned with everything else.
    bodyOnlyBody: assemble(0, findings.findings, "**Findings:**"),
  };
}

function gh(args, input) {
  const res = spawnSync("gh", args, { input, encoding: "utf8", timeout: GH_TIMEOUT_MS });
  return { status: res.status ?? 1, stderr: res.stderr ?? "", error: res.error?.code };
}

/** The HTTP status gh reports in its error output, if any. Never the response body. */
export function httpStatus(stderr) {
  return /HTTP (\d{3})/.exec(stderr ?? "")?.[1] ?? null;
}

/**
 * The body-only form of a review, used when GitHub refuses the review as
 * unprocessable (422, e.g. a line it will not anchor): the inline findings
 * move into the body and the inline count becomes 0. Pure, so classify.mjs can
 * build it ahead of time and scan it with everything else that may be posted.
 */
export function bodyOnly(item) {
  if (item.kind !== "review") return null;
  return { kind: "review", body: item.bodyOnlyBody, comments: [], commit_id: item.commit_id };
}

/**
 * Post the prepared item; on a 422 for a review, post its prepared body-only
 * form instead. Any other failure is returned as is.
 */
export function postItem({ item, fallback }, { repo, pr, run = gh }) {
  if (item.kind === "comment") {
    return run(["api", `repos/${repo}/issues/${pr}/comments`, "--input", "-"], JSON.stringify({ body: item.body }));
  }
  const send = (it) =>
    run(
      ["api", `repos/${repo}/pulls/${pr}/reviews`, "--input", "-"],
      JSON.stringify({ commit_id: it.commit_id, event: "COMMENT", body: it.body, comments: it.comments }),
    );
  const first = send(item);
  if (first.status === 0 || httpStatus(first.stderr) !== "422" || !fallback) return first;
  return send(fallback);
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
  const item = prepared.item;
  const res = postItem(prepared, { repo: process.env.GITHUB_REPOSITORY, pr: pr.number });
  if (res.status !== 0) {
    // Status code and spawn error only: gh's stderr can echo the request body.
    console.error(`posting failed (gh exit ${res.status}, HTTP ${httpStatus(res.stderr) ?? "?"}, ${res.error ?? "no spawn error"})`);
    process.exit(1);
  }
  console.log(`posted ${item.kind} for outcome=${outcome.outcome}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
