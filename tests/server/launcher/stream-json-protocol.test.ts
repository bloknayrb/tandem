/**
 * End-to-end coverage for the launcher's `stream-json` wire protocol (#1267).
 *
 * The auto-launcher is default-on, so its spawn arguments and its stdin
 * bootstrap turn are exercised by every user on every launch — yet #1267
 * shipped both with no coverage, because the protocol is only observable from
 * the process on the *other* end of the pipe. These tests supply that process:
 * `stub-claude-cli.cjs` stands in for the `claude` binary, records the argument
 * vector it was handed, and validates the user turn the supervisor writes.
 *
 * There is deliberately no `spawn` mocking anywhere here — a mock would assert
 * that the supervisor calls a function we wrote, not that a real child process
 * receives a well-formed protocol.
 *
 * See the header of `stub-claude-cli.cjs` for how the stub gets exec'd
 * cross-platform (the "pid-name trick").
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IntegrationsFile } from "../../../src/server/integrations/schema.js";
import { createIntegrationsStore } from "../../../src/server/integrations/storage.js";
import { buildClaudeArgs, createSupervisor } from "../../../src/server/launcher/supervisor.js";
import {
  CLAUDE_STREAM_JSON_FLAGS,
  SUPERVISOR_INITIAL_PROMPT,
} from "../../../src/shared/launcher/contract.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB_SOURCE = path.join(HERE, "stub-claude-cli.cjs");
/** Sentinel for `TANDEM_CLAUDE_CMD`, so the recorded argv proves the binary the
 * supervisor chose actually reached the reaper's argument vector. */
const CLAUDE_BIN_SENTINEL = "tandem-stub-claude-sentinel";
const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

const ENV_KEYS = [
  "TANDEM_REAPER_PATH",
  "TANDEM_TAURI_SIDECAR",
  "NODE_ENV",
  "TANDEM_CLAUDE_CMD",
  "TANDEM_STUB_CLAUDE_RECORD_DIR",
] as const;

let tmpDir: string;
let spawnDir: string;
let recordDir: string;
const savedEnv: Record<string, string | undefined> = {};

interface SpawnRecord {
  pid: number;
  reaperFirstArg: string;
  claudeBin: string;
  claudeArgs: string[];
  cwd: string;
}

interface TurnRecord {
  pid: number;
  raw: string;
  problems: string[];
  text: string | null;
}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stream-json-")));
  spawnDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stream-json-cwd-")));
  recordDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stream-json-rec-")));

  // The pid-name trick: the reaper's first argument is `String(process.pid)`,
  // and node treats its first argument as the script path. Copying the stub to
  // that exact name inside the spawn cwd makes node run it.
  fs.copyFileSync(STUB_SOURCE, path.join(spawnDir, String(process.pid)));

  // reaperPath()'s dev override only applies when NODE_ENV !== "production"
  // AND TANDEM_TAURI_SIDECAR !== "1".
  process.env.NODE_ENV = "test";
  delete process.env.TANDEM_TAURI_SIDECAR;
  process.env.TANDEM_REAPER_PATH = process.execPath;
  process.env.TANDEM_CLAUDE_CMD = CLAUDE_BIN_SENTINEL;
  process.env.TANDEM_STUB_CLAUDE_RECORD_DIR = recordDir;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const dir of [tmpDir, spawnDir, recordDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function writeClaudeIntegration(): Promise<void> {
  const file: IntegrationsFile = {
    schemaVersion: 3,
    integrations: [
      {
        kind: "claude-code",
        id: "active",
        label: "Active Claude",
        configPath:
          process.platform === "win32"
            ? "C:\\Users\\test\\.claude.json"
            : "/home/test/.claude.json",
        transport: "http",
        url: "http://127.0.0.1:3479/mcp",
        apply: "create",
        // Must be set, not just passed as a startFresh() override: a
        // supervisor-initiated restart rebuilds the plan with no override and
        // falls back to os.homedir(), where the stub does not exist.
        workingDirectory: spawnDir,
      },
    ],
  };
  await createIntegrationsStore(tmpDir).write(file);
}

function recordsWithPrefix<T>(prefix: string): T[] {
  return fs
    .readdirSync(recordDir)
    .filter((n) => n.startsWith(prefix) && n.endsWith(".json"))
    .map((n) => JSON.parse(fs.readFileSync(path.join(recordDir, n), "utf8")) as T);
}

/** Poll until `probe` returns a truthy value, or fail with `label`. */
async function waitFor<T>(
  probe: () => T | null | undefined,
  label: string,
  ms = 10_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("launcher stream-json protocol — fresh spawn (#1267)", () => {
  it("hands the CLI the stream-json flag vector and a fresh --session-id", async () => {
    await writeClaudeIntegration();
    const sup = createSupervisor({ integrationsBase: tmpDir });
    try {
      await sup.startFresh(spawnDir);
      const [spawnRec] = await waitFor(() => {
        const recs = recordsWithPrefix<SpawnRecord>("spawn-");
        return recs.length > 0 ? recs : null;
      }, "the stub CLI to record its argv");

      // The reaper contract: argv[0] is the supervisor's pid, argv[1] is the
      // Claude binary, the rest is buildClaudeArgs().
      expect(spawnRec.reaperFirstArg).toBe(String(process.pid));
      expect(spawnRec.claudeBin).toBe(CLAUDE_BIN_SENTINEL);
      expect(spawnRec.cwd).toBe(spawnDir);

      expect(spawnRec.claudeArgs.slice(0, CLAUDE_STREAM_JSON_FLAGS.length)).toEqual([
        ...CLAUDE_STREAM_JSON_FLAGS,
      ]);
      const tail = spawnRec.claudeArgs.slice(CLAUDE_STREAM_JSON_FLAGS.length);
      expect(tail[0]).toBe("--session-id");
      expect(tail).toHaveLength(2);
      expect(tail[1]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(spawnRec.claudeArgs).not.toContain("--resume");
      // The whole vector must be exactly what the exported builder produces.
      expect(spawnRec.claudeArgs).toEqual(buildClaudeArgs({ sessionId: tail[1], resuming: false }));
    } finally {
      await sup.stop();
    }
  });

  // This is also the deadlock regression test. The stub emits `init` only after
  // a turn arrives (as the real CLI does), so a supervisor that waits for `init`
  // before writing never writes at all and this test times out. Verified by
  // positive control on 2026-08-04: reintroducing the wait reds exactly this
  // test.
  it("writes a well-formed user turn on spawn, without waiting for the CLI's init line", async () => {
    await writeClaudeIntegration();
    const sup = createSupervisor({ integrationsBase: tmpDir });
    try {
      await sup.startFresh(spawnDir);
      const [turn] = await waitFor(() => {
        const recs = recordsWithPrefix<TurnRecord>("turn-");
        return recs.length > 0 ? recs : null;
      }, "the stub CLI to receive a user turn");

      // The stub is the judge of well-formedness — it lists every way the
      // envelope deviates from the stream-json user-turn shape.
      expect(turn.problems).toEqual([]);
      expect(turn.text).toBe(SUPERVISOR_INITIAL_PROMPT);
      // Exactly one JSON object, newline-framed — no pretty-printing.
      expect(turn.raw).not.toContain("\n");
      expect(JSON.parse(turn.raw)).toEqual({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: SUPERVISOR_INITIAL_PROMPT }] },
      });
    } finally {
      await sup.stop();
    }
  });

  // DELIBERATELY ABSENT: an integration-level test that the stdout framer
  // reassembles a split `init` line.
  //
  // One existed and asserted "a turn was received", on the reasoning that a
  // supervisor parsing raw chunks would never recognise `subtype: "init"` and
  // so would never send the turn. That reasoning died with the init deadlock
  // fix: the bootstrap turn is now written on spawn, before any stdout is read,
  // so the turn proves nothing about parsing. Confirmed by negative control —
  // suppressing the stub's `init` line ENTIRELY left the test green, i.e. it
  // would also have passed with the framer deleted.
  //
  // It is removed rather than reworded because after the fix the supervisor
  // does not act on any stdout line: what remains is the (still unconfirmed)
  // `result.errors` branch and pass-through logging. There is currently no
  // observable behaviour for a framing bug to break at this level.
  //
  // Framing and UTF-8 decoding ARE covered, as direct unit tests over
  // `createLineFramer` in supervisor.test.ts — including a negative control
  // showing `chunk.toString()` yields U+FFFD on a split multi-byte character.
  // Integration-level coverage becomes meaningful again in Group K, when
  // `result` messages start driving idle tracking; add it back there, with the
  // assertion keyed on idleness rather than on the turn.
});

describe("launcher stream-json protocol — resumed spawn (#1267)", () => {
  it("passes --resume and sends NO bootstrap turn", async () => {
    await writeClaudeIntegration();
    fs.writeFileSync(
      path.join(tmpDir, "launcher-session.json"),
      JSON.stringify({ sessionId: VALID_UUID }),
      "utf8",
    );
    const sup = createSupervisor({ integrationsBase: tmpDir });
    try {
      // start() (not startFresh) so the saved session survives into the plan.
      await sup.start();
      const [spawnRec] = await waitFor(() => {
        const recs = recordsWithPrefix<SpawnRecord>("spawn-");
        return recs.length > 0 ? recs : null;
      }, "the stub CLI to record its argv");

      expect(spawnRec.claudeArgs.slice(-2)).toEqual(["--resume", VALID_UUID]);
      expect(spawnRec.claudeArgs).not.toContain("--session-id");

      // A resumed conversation already contains the bootstrap prompt; sending
      // it again would inject a duplicate turn. The stub records a turn the
      // instant one arrives, so a stable absence over a window that comfortably
      // exceeds the observed init→turn latency is the check available to us.
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(recordsWithPrefix<TurnRecord>("turn-")).toHaveLength(0);
    } finally {
      await sup.stop();
    }
  });
});

describe("supervisor lastError lifecycle (#1267)", () => {
  it("clears a previous fatal error once a spawn succeeds, and stays clear after stop", async () => {
    await writeClaudeIntegration();
    const sup = createSupervisor({ integrationsBase: tmpDir });
    try {
      // 1. Unrunnable reaper (a directory: passes existsSync, cannot exec) →
      //    ENOENT on Windows / EACCES on POSIX. Either sets lastError.
      process.env.TANDEM_REAPER_PATH = os.tmpdir();
      await expect(sup.startFresh(spawnDir)).rejects.toThrow();
      const failed = sup.status();
      expect(failed.running).toBe(false);
      expect(failed.lastError).toBeTruthy();

      // 2. A working spawn must retire it. Before #1267's fix there were four
      //    assignment sites and zero clears.
      process.env.TANDEM_REAPER_PATH = process.execPath;
      await sup.startFresh(spawnDir);
      const running = sup.status();
      expect(running.running).toBe(true);
      expect(running.lastError).toBeUndefined();

      // 3. …and it must not resurface on the next clean stop.
      await sup.stop();
      expect(sup.status()).toEqual({ running: false });
    } finally {
      await sup.stop();
    }
  });
});

describe("supervisor restart lifecycle after relaunch/startFresh (#1267)", () => {
  it("startFresh() lowers stopRequested so an unexpected exit still auto-restarts", async () => {
    await writeClaudeIntegration();
    const sup = createSupervisor({ integrationsBase: tmpDir });
    try {
      // startFresh() routes through stopInternal(), which raises stopRequested.
      // If it is never lowered, the exit handler below reads the crash as a
      // deliberate stop and the supervisor stays dead forever.
      await sup.startFresh(spawnDir);
      const first = await waitFor(() => {
        const recs = recordsWithPrefix<SpawnRecord>("spawn-");
        return recs.length > 0 ? recs[0] : null;
      }, "the first stub spawn");

      process.kill(first.pid);

      const recs = await waitFor(
        () => {
          const all = recordsWithPrefix<SpawnRecord>("spawn-");
          return all.length >= 2 ? all : null;
        },
        "the supervisor to auto-restart after an unexpected exit",
        12_000,
      );
      expect(recs.map((r) => r.pid)).not.toContain(undefined);
      expect(new Set(recs.map((r) => r.pid)).size).toBeGreaterThanOrEqual(2);
    } finally {
      await sup.stop();
    }
  }, 20_000);

  it("startFresh() twice in a row does not throw 'Supervisor already running'", async () => {
    // stopInternal()'s early-return-on-already-killed used to leave `child`
    // set, which #1267's new `if (child) throw` in spawnOnce() turned into a
    // user-visible relaunch failure.
    await writeClaudeIntegration();
    const sup = createSupervisor({ integrationsBase: tmpDir });
    try {
      await sup.startFresh(spawnDir);
      await expect(sup.startFresh(spawnDir)).resolves.toBeUndefined();
      await expect(sup.relaunch(spawnDir)).resolves.toBeUndefined();
      expect(sup.status().running).toBe(true);
    } finally {
      await sup.stop();
    }
  }, 20_000);
});
