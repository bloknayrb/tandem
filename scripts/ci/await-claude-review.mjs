#!/usr/bin/env node
// Merge gate for the cloud Claude review (#1831). A Claude session runs this
// before merging a same-repo, non-bot PR (CLAUDE.md, Development Workflow).
//
// It decides from GitHub Actions run conclusions only, which PR content cannot
// forge, and reads the PR only to find the review text to act on. Exit codes:
//
//   0  a review (or a "did not complete" note) for the newest successful
//      attempt is on the PR; its text is printed. Act on it.
//   2  some attempt of some review run for this PR concluded with anything
//      other than success, cancelled or skipped. Stop: ask Bryan. A later
//      green re-run does not clear it.
//   3  nothing to wait for: no run, only skipped or cancelled runs, or a
//      green run that posted nothing (the re-check refused the PR).
//   1  the gate itself failed (gh auth, network, parse). Stop: ask Bryan.
//
// Usage: node scripts/ci/await-claude-review.mjs <pr-number>

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { HEADER_RE } from "../../.github/claude-review/post.mjs";

export const WORKFLOW = "claude-code-review.yml";
export const BOT = "github-actions[bot]";
export { HEADER_RE };

const OK_CONCLUSIONS = new Set(["success", "cancelled", "skipped"]);
const RUN_FIELDS = "databaseId,displayTitle,status,conclusion,attempt,createdAt,url";

export const DEFAULTS = {
  firstRunWaitMs: 10 * 60_000,
  watchCapMs: 60 * 60_000,
  pollMs: 20_000,
};

/** Runs of this PR, from both the PR-branch query and the dispatch query. Pure. */
export function selectRuns(lists, pr) {
  const title = `Claude review PR #${pr}`;
  const byId = new Map();
  for (const list of lists)
    for (const run of list) if (run.displayTitle === title) byId.set(run.databaseId, run);
  return [...byId.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * Pure decision once every run is complete.
 * `attempts` is [{runId, attempt, conclusion, url}], `items` the bot's PR items [{body}].
 */
export function decide({ runs, attempts, items }) {
  const live = runs.filter((r) => r.conclusion !== "skipped");
  if (live.length === 0)
    return { exit: 3, why: runs.length ? "only skipped runs" : "no review run" };

  const bad = attempts.find((a) => !OK_CONCLUSIONS.has(a.conclusion));
  if (bad)
    return {
      exit: 2,
      why: `run ${bad.runId} attempt ${bad.attempt} concluded ${bad.conclusion}`,
      url: bad.url,
    };

  const order = new Map(live.map((r, i) => [r.databaseId, i]));
  const successes = attempts
    .filter((a) => a.conclusion === "success" && order.has(a.runId))
    .sort((a, b) => order.get(a.runId) - order.get(b.runId) || b.attempt - a.attempt);
  if (successes.length === 0) return { exit: 3, why: "only cancelled attempts" };

  const newest = successes[0];
  for (const item of items) {
    const m = HEADER_RE.exec(item.body ?? "");
    if (m && Number(m[2]) === newest.runId && Number(m[3]) === newest.attempt) {
      return {
        exit: 0,
        why: `review of run ${newest.runId} attempt ${newest.attempt}`,
        sha: m[1],
        body: item.body,
        reviewId: item.reviewId,
      };
    }
  }
  return {
    exit: 3,
    why: `run ${newest.runId} attempt ${newest.attempt} posted nothing (the re-check refused the PR)`,
  };
}

function realGh(args, { timeoutMs } = {}) {
  const res = spawnSync("gh", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error && res.error.code !== "ETIMEDOUT") throw res.error;
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    timedOut: res.error?.code === "ETIMEDOUT",
  };
}

function ghJson(gh, args) {
  const res = gh(args);
  if (res.status !== 0)
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${res.stderr.trim()}`);
  return JSON.parse(res.stdout);
}

/** One JSON object per line, as `--jq '.[] | ...'` prints with --paginate. */
function ghLines(gh, args) {
  const res = gh(args);
  if (res.status !== 0)
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${res.stderr.trim()}`);
  return res.stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

export async function run(pr, deps = {}) {
  const gh = deps.gh ?? realGh;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((s) => console.error(s));
  const opts = { ...DEFAULTS, ...deps.opts };

  const meta = ghJson(gh, ["pr", "view", String(pr), "--json", "headRefName,headRefOid"]);
  const repo = ghJson(gh, ["repo", "view", "--json", "nameWithOwner"]).nameWithOwner;
  const listRuns = () =>
    selectRuns(
      [
        ghJson(gh, [
          "run",
          "list",
          "--workflow",
          WORKFLOW,
          "--branch",
          meta.headRefName,
          "--limit",
          "200",
          "--json",
          RUN_FIELDS,
        ]),
        ghJson(gh, [
          "run",
          "list",
          "--workflow",
          WORKFLOW,
          "--event",
          "workflow_dispatch",
          "--limit",
          "200",
          "--json",
          RUN_FIELDS,
        ]),
      ],
      pr,
    );

  const started = now();
  let runs = listRuns();
  while (runs.length === 0 && now() - started < opts.firstRunWaitMs) {
    await sleep(opts.pollMs);
    runs = listRuns();
  }
  for (;;) {
    const pending = runs.find((r) => r.status !== "completed");
    if (!pending) break;
    const left = opts.watchCapMs - (now() - started);
    if (left <= 0) throw new Error("timed out waiting for the review run");
    log(`waiting for run ${pending.databaseId} (${pending.status})`);
    gh(["run", "watch", String(pending.databaseId), "--interval", "30"], { timeoutMs: left });
    runs = listRuns();
  }

  const attempts = [];
  for (const r of runs.filter((x) => x.conclusion !== "skipped")) {
    for (let k = 1; k <= (r.attempt ?? 1); k++) {
      const a = ghJson(gh, ["api", `repos/${repo}/actions/runs/${r.databaseId}/attempts/${k}`]);
      attempts.push({
        runId: r.databaseId,
        attempt: k,
        conclusion: a.conclusion,
        url: a.html_url ?? r.url,
      });
    }
  }

  const jq = `.[] | select(.user.login == "${BOT}") | {body: .body, id: .id}`;
  const items = [
    ...ghLines(gh, ["api", "--paginate", `repos/${repo}/pulls/${pr}/reviews`, "--jq", jq]).map(
      (i) => ({ body: i.body, reviewId: i.id }),
    ),
    ...ghLines(gh, ["api", "--paginate", `repos/${repo}/issues/${pr}/comments`, "--jq", jq]).map(
      (i) => ({ body: i.body }),
    ),
  ];

  const verdict = decide({ runs, attempts, items });
  if (verdict.exit === 0 && verdict.sha && !meta.headRefOid.startsWith(verdict.sha)) {
    const cmp = gh([
      "api",
      `repos/${repo}/compare/${verdict.sha}...${meta.headRefOid}`,
      "--jq",
      ".ahead_by",
    ]);
    if (cmp.status === 0) verdict.commitsSince = Number(cmp.stdout.trim());
  }
  return verdict;
}

async function main() {
  const pr = Number(process.argv[2]);
  if (!Number.isInteger(pr) || pr <= 0) {
    console.error("usage: await-claude-review.mjs <pr-number>");
    process.exit(64);
  }
  try {
    const v = await run(pr);
    console.log(`exit ${v.exit}: ${v.why}${v.url ? ` (${v.url})` : ""}`);
    if (v.commitsSince)
      console.log(`${v.commitsSince} commit(s) since the reviewed SHA (information only)`);
    if (v.body) console.log(`\n${v.body}`);
    if (v.reviewId) {
      const res = realGh([
        "api",
        "--paginate",
        `repos/{owner}/{repo}/pulls/${pr}/reviews/${v.reviewId}/comments`,
        "--jq",
        '.[] | "\\(.path):\\(.line) \\(.body)"',
      ]);
      if (res.status === 0 && res.stdout.trim())
        console.log(`\nInline comments:\n${res.stdout.trim()}`);
    }
    process.exit(v.exit);
  } catch (err) {
    console.error(`gate failed: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
