/**
 * Stub `claude` CLI that speaks the `stream-json` wire protocol.
 *
 * WHY THIS EXISTS: #1267 changed the launcher's spawn arguments and taught the
 * supervisor to write a JSON user turn into the child's stdin — a wire-protocol
 * change on the default-on auto-launcher, i.e. every user on every launch —
 * with zero test coverage. `supervisor.test.ts` could not cover it because the
 * only way to observe the protocol is to *be* the process on the other end.
 * This file is that process.
 *
 * HOW IT IS SPAWNED (the pid-name trick). `spawnOnce()` builds the reaper
 * argument vector as `[String(process.pid), claudeBin, ...claudeArgs]` and
 * execs the reaper directly — no shell. The only executable guaranteed to
 * exist cross-platform in a test run is `process.execPath` (node itself), and
 * Windows cannot exec a `.js`/`.cmd` without `shell: true`. So the test points
 * `TANDEM_REAPER_PATH` at node and copies this file into the spawn cwd under
 * the literal name `String(<supervisor pid>)`. Node then treats the reaper's
 * first argument — the parent pid — as its script path and runs us, leaving
 * `process.argv.slice(2)` equal to exactly `[claudeBin, ...claudeArgs]`.
 * Extensionless files load as CommonJS, hence `.cjs` here and `require` below.
 *
 * This collapses reaper and CLI into one process. That is deliberate: the real
 * reaper is a transparent stdio pass-through whose job (OS-level reaping) is
 * orthogonal to the wire protocol under test.
 *
 * Records are written into `TANDEM_STUB_CLAUDE_RECORD_DIR`:
 *   - `spawn-<pid>.json` — written immediately: the argument vector we were
 *     handed. One file per spawn, so a restart is observable as a second file.
 *   - `turn-<pid>.json`  — written when a user turn arrives on stdin, carrying
 *     the raw line plus a list of protocol violations (empty === well-formed).
 *
 * The process deliberately does NOT exit after answering: a real stream-json
 * session stays open, and exiting would trip the supervisor's restart backoff
 * mid-assertion. The test kills it via `supervisor.stop()`.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const recordDir = process.env.TANDEM_STUB_CLAUDE_RECORD_DIR;

/** Write-then-rename so a polling reader never observes a half-written file. */
function writeRecord(name, value) {
  if (!recordDir) return;
  const final = path.join(recordDir, name);
  const tmp = `${final}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, final);
}

const argv = process.argv.slice(2);
writeRecord(`spawn-${process.pid}.json`, {
  pid: process.pid,
  // Node consumed the reaper's first argument as our script path, so its
  // basename IS that argument — the supervisor's own pid.
  reaperFirstArg: path.basename(process.argv[1]),
  claudeBin: argv[0],
  claudeArgs: argv.slice(1),
  cwd: process.cwd(),
});

// --- stdout: the init handshake, split hostilely ---------------------------

// The line is written as two chunks 25 ms apart. A supervisor that parses raw
// `data` chunks instead of framing on newlines sees two JSON fragments, never
// recognises the init handshake, and never sends a turn — the test then times
// out. That is the regression signal this split produces.
//
// The split additionally lands INSIDE a multi-byte UTF-8 sequence, which
// exercises `setEncoding("utf8")` but does NOT detect its absence: per-chunk
// decoding yields U+FFFD, which is still valid JSON inside a string, and the
// supervisor dispatches only on ASCII fields. Measured, not assumed.
const initLine = `${JSON.stringify({
  type: "system",
  subtype: "init",
  cwd: "café — ✓ 日本語",
  tools: [],
})}\n`;
const initBytes = Buffer.from(initLine, "utf8");

/** First index that is a UTF-8 continuation byte (0b10xxxxxx). Splitting there
 * severs a multi-byte character. */
function firstContinuationByteIndex(buf) {
  for (let i = 1; i < buf.length; i++) {
    if ((buf[i] & 0xc0) === 0x80) return i;
  }
  return Math.floor(buf.length / 2);
}

const splitAt = firstContinuationByteIndex(initBytes);
process.stdout.write(initBytes.subarray(0, splitAt));
setTimeout(() => {
  process.stdout.write(initBytes.subarray(splitAt));
}, 25);

// --- stdin: assert the user turn -------------------------------------------

/** Returns the list of ways `line` fails to be a well-formed stream-json user
 * turn. Empty array === well-formed. */
function turnProblems(line) {
  const problems = [];
  let obj;
  try {
    obj = JSON.parse(line);
  } catch (err) {
    return { problems: [`stdin line is not JSON: ${err.message}`], text: null };
  }
  if (obj === null || typeof obj !== "object") {
    return { problems: ["stdin line is not a JSON object"], text: null };
  }
  if (obj.type !== "user") problems.push(`type is ${JSON.stringify(obj.type)}, expected "user"`);
  const message = obj.message;
  let text = null;
  if (message === null || typeof message !== "object") {
    problems.push("message is missing or not an object");
  } else {
    if (message.role !== "user") {
      problems.push(`message.role is ${JSON.stringify(message.role)}, expected "user"`);
    }
    if (!Array.isArray(message.content) || message.content.length === 0) {
      problems.push("message.content is not a non-empty array");
    } else {
      for (const block of message.content) {
        if (block === null || typeof block !== "object") {
          problems.push("message.content contains a non-object block");
        } else if (block.type !== "text") {
          problems.push(`content block type is ${JSON.stringify(block.type)}, expected "text"`);
        } else if (typeof block.text !== "string" || block.text.length === 0) {
          problems.push("content block has no non-empty text");
        } else if (text === null) {
          text = block.text;
        }
      }
    }
  }
  return { problems, text };
}

let stdinBuffer = "";
let answered = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  let newline = stdinBuffer.indexOf("\n");
  while (newline >= 0) {
    const line = stdinBuffer.slice(0, newline);
    stdinBuffer = stdinBuffer.slice(newline + 1);
    newline = stdinBuffer.indexOf("\n");
    if (!line.trim() || answered) continue;
    answered = true;
    const { problems, text } = turnProblems(line);
    writeRecord(`turn-${process.pid}.json`, { pid: process.pid, raw: line, problems, text });
    process.stdout.write(
      `${JSON.stringify({
        type: "result",
        subtype: problems.length === 0 ? "success" : "error_during_execution",
        is_error: problems.length > 0,
        result: problems.length === 0 ? "ok" : problems.join("; "),
      })}\n`,
    );
  }
});

// Hard stop so a crashed test run cannot leave this process behind. Well above
// the suite's 15 s per-test timeout; the happy path is killed by stop().
setTimeout(() => process.exit(0), 30_000);
