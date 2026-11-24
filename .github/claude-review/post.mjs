#!/usr/bin/env node
// Posts the single PR item for one Claude review run (#1831).
//
// Two halves. The pure half (buildItem, bodyOnly, sanitize) is called by
// classify.mjs, which builds the exact bytes to post and secret-scans them.
// Everything the model wrote is sanitised before the header is prepended, so
// model text can neither forge a header nor ping people, link other issues,
// load images or smuggle raw HTML. The posting half (main) runs in its own
// step holding GH_TOKEN and never the subscription token, and sends
// inputs/item.json exactly as classify.mjs wrote it. No npm dependencies.
//
// Usage: node post.mjs <inputs-dir>
// Env:   GH_TOKEN, GITHUB_REPOSITORY

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const BODY_CAP = 60_000;
export const FINDING_CAP = 8_000;
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

/**
 * Sanitise one stretch of prose that is not inside a code span. Removed
 * constructs become a space, never nothing, so a removal can never splice two
 * halves of a string back together (the secret scan runs on this output, but
 * a splice-free rewrite keeps that true by construction too).
 */
function sanitizeProse(text) {
  return text
    .replace(/<!--[\s\S]*?(-->|$)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, " ")
    .replace(/</g, "&lt;")
    .replace(/`/g, "'") // a lone backtick here is unmatched: it must not open a span around what follows
    .replace(/(^|[^\w])@([A-Za-z0-9][\w-]*(?:\/[\w.-]+)?)/g, "$1`@$2`")
    .replace(/(^|[^\w`])((?:[\w.-]+\/[\w.-]+)?#\d+)/g, "$1`$2`");
}

/**
 * Neutralise model-written Markdown before it is posted. Code spans are kept
 * verbatim: GitHub renders them literally (no HTML, images or mentions), and
 * escaping inside them would show `&lt;` where a finding quotes `Map<K, V>`.
 * Outside them, `<` is escaped rather than tag-shaped text deleted, so
 * `a < b` and generics in prose survive while raw HTML cannot render.
 */
export function sanitize(text) {
  return String(text)
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 === 1 ? part : sanitizeProse(part)))
    .join("");
}

/**
 * Lines that can carry an inline comment: every right-hand (new-file) line
 * inside a hunk of the unified diff, context lines included.
 * Hunks are consumed by their header's line counts, so an added line whose
 * content begins "++ " (shown as "+++ ...") is never mistaken for a file header.
 * Returns Map<path, Set<line>>.
 */
export function commentableLines(diffText) {
  const map = new Map();
  let file = null;
  let line = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of diffText.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      const c = raw[0];
      if (c === "+" || c === " " || raw === "") {
        if (c === "+" || newLeft > 0) {
          if (file !== null) {
            if (!map.has(file)) map.set(file, new Set());
            map.get(file).add(line);
          }
          line++;
          newLeft--;
        }
        if (c !== "+") oldLeft--;
        continue;
      }
      if (c === "-") {
        oldLeft--;
        continue;
      }
      if (c === "\\") continue; // "\ No newline at end of file": no line of either side
      // Anything else means the counts were off: stop the hunk and parse this line as a header.
      oldLeft = 0;
      newLeft = 0;
    } else if (raw.startsWith("\\")) {
      continue; // a "\ No newline" after the hunk's last line
    }
    if (raw.startsWith("diff --git ")) {
      file = null;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4).replace(/\t.*$/, "").trim();
      file = target === "/dev/null" ? null : target.replace(/^b\//, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      line = Number(hunk[2]);
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
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
        `${head}\n\n${INCOMPLETE_MARK} (\`${outcome.reason}\`). ` +
        `Re-run: \`gh workflow run claude-code-review.yml -f pr=${pr}\``,
    };
  }
  const lines = commentableLines(diffText);
  const inline = [];
  const fallback = [];
  for (const f of findings.findings) {
    const filePath = sanitize(f.path).replace(/`/g, "");
    const body = cap(`**${f.severity}:** ${sanitize(f.body)}`, FINDING_CAP);
    if (lines.get(f.path)?.has(f.line)) {
      inline.push({ path: f.path, line: f.line, side: "RIGHT", body });
    } else {
      fallback.push(`- \`${filePath}:${f.line}\` ${body}`);
    }
  }
  const summary = sanitize(findings.summary).trim();
  const parts = [head, inlineCountLine(inline.length), summary || ""];
  if (findings.findings.length === 0) parts.push("No findings.");
  if (fallback.length) parts.push("**Findings outside the diff:**", fallback.join("\n"));
  const body = cap(parts.filter(Boolean).join("\n\n"), BODY_CAP);
  return { kind: "review", body, comments: inline, commit_id: sha };
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
  const allInBody = item.comments.map((c) => `- \`${c.path}:${c.line}\` ${c.body}`).join("\n");
  const body = cap(
    [item.body.replace(INLINE_COUNT_RE, inlineCountLine(0)), allInBody].filter(Boolean).join("\n\n"),
    BODY_CAP,
  );
  return { kind: "review", body, comments: [], commit_id: item.commit_id };
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
