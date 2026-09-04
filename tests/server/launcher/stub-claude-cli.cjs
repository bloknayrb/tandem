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
 *   - `turn-<pid>-<seq>.json` — one per user turn arriving on stdin, carrying
 *     the raw line plus a list of protocol violations (empty === well-formed).
 *     Zero-padded seq so lexicographic order is arrival order.
 *
 * The process deliberately does NOT exit after answering: a real stream-json
 * session stays open, and exiting would trip the supervisor's restart backoff
 * mid-assertion. The test kills it via `supervisor.stop()`.
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
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

/** Emit the `init` line, deliberately split mid-UTF-8-character across two
 * chunks 25 ms apart so a byte-wise (rather than decoder-backed) reader would
 * corrupt it.
 *
 * Emitted only AFTER a turn arrives, because that is what the real CLI does.
 * An earlier version of this stub wrote `init` on startup, which made the
 * suite green while the shipped supervisor deadlocked against the real binary:
 * the supervisor waited for `init` before writing a turn, and the CLI waits for
 * a turn before writing `init`. The stub was modelling the supervisor's
 * assumption instead of the CLI's behaviour, so it could only ever confirm it.
 * Measured 2026-08-04 — see docs/spikes/channel-push-stream-json.md. */
function emitInit() {
  process.stdout.write(initBytes.subarray(0, splitAt));
  setTimeout(() => {
    process.stdout.write(initBytes.subarray(splitAt));
  }, 25);
}

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

/** Answered-turn counter. Every turn is recorded, not just the first: wake
 * coalescing is defined by how MANY turns arrive, so a one-shot stub could not
 * tell "coalesced into one" from "never sent at all". Zero-padded so readdir's
 * lexicographic order is arrival order. */
let turnSeq = 0;

/** How long a turn stays "in flight" before its `result` lands.
 *
 * The supervisor coalesces wake turns while a turn is in flight, so a test that
 * needs two events to land inside one window has to be able to widen it. The
 * default is short enough that ordinary tests don't pay for it. */
const turnDelayMs = Number(process.env.TANDEM_STUB_CLAUDE_TURN_DELAY_MS ?? 50);

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  let newline = stdinBuffer.indexOf("\n");
  while (newline >= 0) {
    const line = stdinBuffer.slice(0, newline);
    stdinBuffer = stdinBuffer.slice(newline + 1);
    newline = stdinBuffer.indexOf("\n");
    if (!line.trim()) continue;
    const seq = turnSeq++;
    const { problems, text } = turnProblems(line);
    writeRecord(`turn-${process.pid}-${String(seq).padStart(3, "0")}.json`, {
      pid: process.pid,
      seq,
      // Wall-clock arrival. `seq` restarts at 0 in every new process, so it
      // orders turns only WITHIN one spawn — across a restart two records can
      // share seq 0 and sorting by it alone is ambiguous.
      at: Date.now(),
      raw: line,
      problems,
      text,
    });
    // #1757 end-to-end trigger (POSIX only, default off). On the first stdin
    // line — the bootstrap turn on child #1, the owed wake on a respawned
    // child #2, which re-closing is harmless for — the stub closes its own fd
    // 0 and keeps lingering, so the supervisor's NEXT write fails with EPIPE.
    //
    // Windows measurement behind the recipe: after pause(); destroy() alone,
    // reopening os.devNull returned fd 3, not 0 — i.e. destroy() had NOT freed
    // fd 0, the pipe read end survived, and no error was ever produced. Hence
    // the explicit closeSync(0) as the very next statement in the same
    // synchronous block (nothing can interleave to steal the freed slot), and
    // the reopened devNull fd is RECORDED, not assumed. The test asserts
    // devNullFd === 0 on POSIX.
    if (process.env.TANDEM_STUB_CLAUDE_CLOSE_STDIN_AFTER_FIRST_TURN === "1" && seq === 0) {
      process.stdin.pause();
      process.stdin.destroy();
      try {
        fs.closeSync(0);
      } catch {
        /* destroy may already have closed it */
      }
      const devNullFd = fs.openSync(os.devNull, "r"); // 0 on POSIX — asserted, not assumed
      writeRecord(`closed-stdin-${process.pid}.json`, { at: Date.now() }); // written FIRST, before the block below
      writeRecord(`alive-${process.pid}.json`, { devNullFd, at: Date.now() }); // first record AFTER the close, synchronous
      setInterval(() => writeRecord(`alive-${process.pid}.json`, { devNullFd, at: Date.now() }), 250)
        .unref?.();
    }
    // Real ordering: the turn arrives, THEN `init`, then the result.
    emitInit();
    setTimeout(() => {
      process.stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: problems.length === 0 ? "success" : "error_during_execution",
          is_error: problems.length > 0,
          result: problems.length === 0 ? "ok" : problems.join("; "),
        })}\n`,
      );
    }, turnDelayMs);
  }
});

// Hard stop so a crashed test run cannot leave this process behind. Well above
// the suite's 15 s per-test timeout; the happy path is killed by stop().
setTimeout(() => process.exit(0), 30_000);
