#!/usr/bin/env node
// PreToolUse hook body for ExitPlanMode. Invoked by the bash wrapper.
// Reads the hook stdin envelope, scans the session transcript, and exits:
//   0  = allow (Agent review verified, or bypass token present in plan body)
//   2  = block (stderr explains how to unblock)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const BYPASS_TOKEN = "Agent feedback incorporated";
const PLANS_DIR = (() => {
  const raw = path.join(os.homedir(), ".claude", "plans");
  try { return fs.realpathSync(raw); } catch { return raw; }
})();
const TRANSCRIPT_BYTE_CAP = 50 * 1024 * 1024;
const PLAN_HEAD_BYTE_CAP = 4096;
const REVIEWER_TOOL_NAMES = new Set(["Agent", "Task"]);

function block(reason) {
  process.stderr.write(`Blocked (fail-closed): ${reason}.\n`);
  process.exit(2);
}

async function readEnvelope() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return JSON.parse(raw);
  } catch {
    block("could not parse hook stdin JSON");
  }
}

function isUserPlanPath(fp) {
  if (typeof fp !== "string" || !fp) return false;
  if (!/[\\/]\.claude[\\/]plans[\\/][^\\/]+\.md$/.test(fp)) return false;
  let resolved;
  try {
    resolved = fs.realpathSync(fp);
  } catch {
    resolved = path.resolve(fp);
  }
  const rel = path.relative(PLANS_DIR, resolved);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function scanTranscript(transcriptPath) {
  let stat;
  try {
    stat = fs.statSync(transcriptPath);
  } catch (e) {
    block(`could not stat transcript: ${e.message}`);
  }
  // A transcript over the cap is scanned from its last TRANSCRIPT_BYTE_CAP
  // bytes instead of being refused. Refusing left a long session with no way
  // to approve any plan: the bypass token is only read after a scan, and a
  // transcript never shrinks.
  //
  // The tail can only be STRICTER than a full scan. The answer depends on the
  // last plan write and on what followed it. If that write is in the tail, the
  // tail gives the full scan's answer. If it is not, the tail finds no plan
  // write and blocks, and re-saving the plan puts a write in the tail. The
  // line the cut lands in is a proper suffix of a JSON object, which never
  // parses, so it is skipped like any other unparseable line.
  const start = Math.max(0, stat.size - TRANSCRIPT_BYTE_CAP);

  let planPath = null;
  let agentAfterPlanWrite = false;

  const rl = readline.createInterface({
    input: fs.createReadStream(transcriptPath, { encoding: "utf8", start }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const content = msg?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item?.type !== "tool_use") continue;
      const name = item.name;
      if (name === "Write" || name === "Edit") {
        if (isUserPlanPath(item.input?.file_path)) {
          planPath = item.input.file_path;
          agentAfterPlanWrite = false;
        }
      } else if (REVIEWER_TOOL_NAMES.has(name) && planPath) {
        agentAfterPlanWrite = true;
      }
    }
  }
  return { planPath, agentAfterPlanWrite, truncated: start > 0 };
}

const envelope = await readEnvelope();
const transcriptPath = envelope.transcript_path;
if (!transcriptPath) block("hook stdin missing transcript_path");

const { planPath, agentAfterPlanWrite, truncated } = await scanTranscript(transcriptPath);
if (!planPath) {
  const scanned = truncated
    ? `the last ${TRANSCRIPT_BYTE_CAP / (1024 * 1024)} MB of this session's transcript (it is larger; only the tail is scanned) show`
    : `this session's transcript shows`;
  process.stderr.write(
    `Blocked (fail-closed): ${scanned} no Write or Edit of a plan file\n` +
      `directly under ~/.claude/plans/, so there is no plan revision to check a review against.\n` +
      `\n` +
      `To unblock: Write or Edit the plan into the plan file plan mode named (a .md file directly\n` +
      `under ~/.claude/plans/, not in a subfolder and not a project-level .claude/plans/), have at\n` +
      `least one Agent review it, then call ExitPlanMode again.\n`,
  );
  process.exit(2);
}
if (agentAfterPlanWrite) process.exit(0);

try {
  const resolved = fs.realpathSync(planPath);
  const rel = path.relative(PLANS_DIR, resolved);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    const fd = fs.openSync(resolved, "r");
    let head;
    try {
      const buf = Buffer.alloc(PLAN_HEAD_BYTE_CAP);
      const n = fs.readSync(fd, buf, 0, PLAN_HEAD_BYTE_CAP, 0);
      head = buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    if (head.replace(/^\s+/, "").startsWith(BYPASS_TOKEN)) process.exit(0);
  }
} catch {
  /* fall through to block */
}

const planBasename = path.basename(planPath);
process.stderr.write(
  `Blocked: ExitPlanMode requires Agent review of the current plan revision.\n` +
    `\n` +
    `Plan file: ~/.claude/plans/${planBasename}\n` +
    `\n` +
    `Unblock via EITHER:\n` +
    `  A. Spawn at least one Agent call (e.g. svelte-migration-reviewer,\n` +
    `     crdt-reviewer, annotation-model-reviewer, security-reviewer, or a\n` +
    `     general-purpose adversarial reviewer) AFTER the most recent edit to\n` +
    `     the plan file, then re-call ExitPlanMode. The hook detects the\n` +
    `     Agent tool_use in the session transcript.\n` +
    `\n` +
    `  B. Edit the plan file so its body begins with the exact literal prefix:\n` +
    `        ${BYPASS_TOKEN}\n` +
    `     Use this only when review actually happened out-of-band; the user\n` +
    `     will see this attestation when they review the plan.\n`
);
process.exit(2);
