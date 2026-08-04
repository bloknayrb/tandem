import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emptyIntegrationsFile,
  INTEGRATIONS_SCHEMA_VERSION,
  type IntegrationsFile,
} from "../../../src/server/integrations/schema.js";
import { createIntegrationsStore } from "../../../src/server/integrations/storage.js";
import {
  buildClaudeArgs,
  createLineFramer,
  createSupervisor,
  RESUME_CONFIRM_MS,
  resolveRouteCwd,
  resolveSafeCwd,
  shouldClearSession,
} from "../../../src/server/launcher/supervisor.js";
import {
  CLAUDE_STREAM_JSON_FLAGS,
  REAPER_NOT_FOUND_MARKER,
  SUPERVISOR_INITIAL_PROMPT,
  serializeUserTurn,
} from "../../../src/shared/launcher/contract.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "supervisor-test-"));
});

afterEach(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

async function writeIntegrations(file: IntegrationsFile): Promise<void> {
  const store = createIntegrationsStore(tmpDir);
  await store.write(file);
}

describe("supervisor.start — gating", () => {
  it("is a no-op when integrations.json does not exist", async () => {
    const sup = createSupervisor({ integrationsBase: tmpDir });
    await sup.start();
    expect(sup.status().running).toBe(false);
    await sup.stop();
  });

  it("is a no-op when no claude-code integration is configured", async () => {
    await writeIntegrations(emptyIntegrationsFile());
    const sup = createSupervisor({ integrationsBase: tmpDir });
    await sup.start();
    expect(sup.status().running).toBe(false);
    await sup.stop();
  });

  it("is a no-op when the only claude-code integration is apply=skip", async () => {
    const file: IntegrationsFile = {
      schemaVersion: 4,
      integrations: [
        {
          kind: "claude-code",
          id: "skip-me",
          label: "Skipped Claude",
          configPath:
            process.platform === "win32"
              ? "C:\\Users\\test\\.claude.json"
              : "/home/test/.claude.json",
          transport: "http",
          url: "http://127.0.0.1:3479/mcp",
          apply: "skip",
        },
      ],
    };
    await writeIntegrations(file);
    const sup = createSupervisor({ integrationsBase: tmpDir });
    await sup.start();
    expect(sup.status().running).toBe(false);
    await sup.stop();
  });
});

describe("supervisor — session persistence", () => {
  it("writes the session id on first spawn-fresh (verified via post-startFresh state)", async () => {
    // We can't fully exercise spawn without a real binary, but we can verify
    // that startFresh clears any existing session file.
    const sessionFile = path.join(tmpDir, "launcher-session.json");
    fs.writeFileSync(sessionFile, JSON.stringify({ sessionId: "old-session" }), "utf8");
    expect(fs.existsSync(sessionFile)).toBe(true);

    const sup = createSupervisor({ integrationsBase: tmpDir });
    await sup.startFresh();
    // No integration → start() is a no-op, but the clearSavedSession side
    // effect must have fired.
    expect(fs.existsSync(sessionFile)).toBe(false);
    await sup.stop();
  });
});

describe("supervisor.stop — idempotency", () => {
  it("stop() is safe to call before start()", async () => {
    const sup = createSupervisor({ integrationsBase: tmpDir });
    await expect(sup.stop()).resolves.toBeUndefined();
  });

  it("stop() is safe to call twice", async () => {
    const sup = createSupervisor({ integrationsBase: tmpDir });
    await sup.stop();
    await expect(sup.stop()).resolves.toBeUndefined();
  });
});

describe("supervisor.status", () => {
  it("returns {running:false} before start", () => {
    const sup = createSupervisor({ integrationsBase: tmpDir });
    expect(sup.status()).toEqual({ running: false });
  });
});

describe("supervisor — session id UUID-shape gate (security C1)", () => {
  it("ignores non-UUID sessionId in launcher-session.json (post-tamper / corruption)", async () => {
    const sessionFile = path.join(tmpDir, "launcher-session.json");
    // Attacker-supplied or corrupted value that's NOT a valid UUID.
    fs.writeFileSync(sessionFile, JSON.stringify({ sessionId: "--config=/etc/evil" }), "utf8");

    // Without integration → start is a no-op, but exercising startFresh
    // verifies clearSavedSession runs and the bogus value is gone.
    const sup = createSupervisor({ integrationsBase: tmpDir });
    await sup.startFresh();
    expect(fs.existsSync(sessionFile)).toBe(false);
    await sup.stop();
  });

  it("accepts a properly-shaped UUID v4 sessionId", async () => {
    // Write a real UUID — should pass the shape gate. We can't observe its
    // consumption without a real spawn, but the file should survive a no-op
    // start() (no integration → start short-circuits without touching the
    // session file).
    const sessionFile = path.join(tmpDir, "launcher-session.json");
    const validUuid = "550e8400-e29b-41d4-a716-446655440000";
    fs.writeFileSync(sessionFile, JSON.stringify({ sessionId: validUuid }), "utf8");

    const sup = createSupervisor({ integrationsBase: tmpDir });
    await sup.start();
    expect(fs.existsSync(sessionFile)).toBe(true);
    const reread = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    expect(reread.sessionId).toBe(validUuid);
    await sup.stop();
  });
});

describe("resolveSafeCwd — path normalization (security I2)", () => {
  it("returns null for a non-absolute path", () => {
    expect(resolveSafeCwd("relative/path")).toBeNull();
    expect(resolveSafeCwd("./foo")).toBeNull();
    expect(resolveSafeCwd("..\\bar")).toBeNull();
  });

  it("returns null for a non-existent absolute path", () => {
    const fake = process.platform === "win32" ? "C:\\does\\not\\exist\\xyz" : "/does/not/exist/xyz";
    expect(resolveSafeCwd(fake)).toBeNull();
  });

  it("returns null when the path resolves to a file, not a directory", () => {
    const filePath = path.join(tmpDir, "regular-file.txt");
    fs.writeFileSync(filePath, "content");
    expect(resolveSafeCwd(filePath)).toBeNull();
  });

  it("returns the canonical path for a real directory", () => {
    const real = fs.realpathSync(tmpDir);
    expect(resolveSafeCwd(tmpDir)).toBe(real);
  });

  it.skipIf(process.platform !== "win32")("rejects Windows device namespace paths", () => {
    expect(resolveSafeCwd("\\\\?\\C:\\Windows")).toBeNull();
    expect(resolveSafeCwd("\\\\.\\C:\\")).toBeNull();
  });

  it.skipIf(process.platform !== "win32")("rejects UNC paths", () => {
    expect(resolveSafeCwd("\\\\server\\share\\folder")).toBeNull();
  });

  it("rejects non-string input", () => {
    expect(resolveSafeCwd(undefined as unknown as string)).toBeNull();
    expect(resolveSafeCwd(null as unknown as string)).toBeNull();
    expect(resolveSafeCwd(42 as unknown as string)).toBeNull();
  });
});

describe("resolveRouteCwd — home-confined HTTP variant (PR 4b sec I1)", () => {
  it("rejects everything resolveSafeCwd rejects", () => {
    expect(resolveRouteCwd("relative/path")).toBeNull();
    expect(resolveRouteCwd("/does/not/exist/xyz")).toBeNull();
  });

  it("accepts a real directory inside the user's home", () => {
    // os.homedir() is the test process's home — we create a tmpdir inside it
    // for the home-confined check. Using the existing tmpDir would fail on
    // many CI environments where tmpDir is outside $HOME.
    const homeReal = fs.realpathSync(os.homedir());
    const inside = fs.mkdtempSync(path.join(homeReal, "route-cwd-test-"));
    try {
      const resolved = resolveRouteCwd(inside);
      expect(resolved).toBe(fs.realpathSync(inside));
    } finally {
      fs.rmSync(inside, { recursive: true, force: true });
    }
  });

  it("accepts the home directory itself", () => {
    const home = fs.realpathSync(os.homedir());
    expect(resolveRouteCwd(home)).toBe(home);
  });
});

describe("resolveRouteCwd — homeOverride seam (cross-platform determinism, #803 T7)", () => {
  /** Treat a tmpdir as "$HOME" so the home-confinement check is exercised
   * deterministically on every platform — no dependency on whether the
   * process's real $HOME happens to encompass `os.tmpdir()` (Windows CI
   * sometimes does, POSIX never does). Mirrors the `refreshSkillIfStale`
   * homeOverride pattern in `src/server/integrations/apply.ts`. */
  let fakeHome: string;
  let outside: string;

  beforeEach(() => {
    fakeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fake-home-")));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "outside-home-")));
  });

  afterEach(() => {
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("accepts the override home itself", () => {
    expect(resolveRouteCwd(fakeHome, { homeOverride: fakeHome })).toBe(fakeHome);
  });

  it("accepts a real directory inside the override home", () => {
    const inside = fs.realpathSync(fs.mkdtempSync(path.join(fakeHome, "child-")));
    expect(resolveRouteCwd(inside, { homeOverride: fakeHome })).toBe(inside);
  });

  it("rejects a real directory outside the override home", () => {
    // `outside` and `fakeHome` are siblings under os.tmpdir() — path.relative
    // produces "..something" so the rejection fires on every platform.
    expect(resolveRouteCwd(outside, { homeOverride: fakeHome })).toBeNull();
  });

  it("rejects when the override home doesn't exist (realpathSync throws)", () => {
    const ghost = path.join(os.tmpdir(), "does-not-exist-home-xyz-#803");
    const inside = fs.realpathSync(fs.mkdtempSync(path.join(fakeHome, "child-")));
    expect(resolveRouteCwd(inside, { homeOverride: ghost })).toBeNull();
  });

  it("still rejects everything resolveSafeCwd rejects when override is set", () => {
    expect(resolveRouteCwd("relative/path", { homeOverride: fakeHome })).toBeNull();
    expect(resolveRouteCwd("/does/not/exist/xyz", { homeOverride: fakeHome })).toBeNull();
  });
});

describe("supervisor — concurrent operation safety (security I4)", () => {
  it("concurrent stop() calls don't reject", async () => {
    const sup = createSupervisor({ integrationsBase: tmpDir });
    const results = await Promise.allSettled([sup.stop(), sup.stop(), sup.stop()]);
    for (const r of results) {
      expect(r.status).toBe("fulfilled");
    }
  });

  it("interleaved start/stop/startFresh resolves cleanly", async () => {
    const sup = createSupervisor({ integrationsBase: tmpDir });
    const results = await Promise.allSettled([
      sup.start(),
      sup.stop(),
      sup.startFresh(),
      sup.stop(),
    ]);
    for (const r of results) {
      expect(r.status).toBe("fulfilled");
    }
  });
});

describe("supervisor — early spawn-failure surfacing (Fix A)", () => {
  // A reaper that exists at check time but cannot be exec'd must surface a
  // REAPER_NOT_FOUND-marked rejection to the caller (relaunch/startFresh)
  // instead of resolving silently — `spawn()` reports exec failures
  // asynchronously, so before this fix the route returned `{ ok: true }`.
  //
  // os.tmpdir() is a directory: it passes the `existsSync` gate in
  // reaperPath() but cannot be executed. spawning it yields ENOENT on Windows
  // (verified on Node 24) and EACCES on POSIX — BOTH are in the wrapped set
  // {ENOENT, EACCES, EISDIR}, so the marker assertion is deterministic
  // cross-platform regardless of which code the OS reports.
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ["TANDEM_REAPER_PATH", "TANDEM_TAURI_SIDECAR", "NODE_ENV", "TANDEM_CLAUDE_CMD"];

  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    // Dev-override gate in reaperPath() requires NODE_ENV !== "production" AND
    // TANDEM_TAURI_SIDECAR !== "1" before it honors TANDEM_REAPER_PATH.
    process.env.NODE_ENV = "test";
    delete process.env.TANDEM_TAURI_SIDECAR;
    process.env.TANDEM_REAPER_PATH = os.tmpdir(); // exists, not executable
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  async function makeRunnableSupervisor(): Promise<ReturnType<typeof createSupervisor>> {
    // apply !== "skip" so readIntegration() returns it and buildPlan() yields a
    // plan, driving execution into spawnOnce().
    const file: IntegrationsFile = {
      schemaVersion: 4,
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
        },
      ],
    };
    await writeIntegrations(file);
    return createSupervisor({ integrationsBase: tmpDir });
  }

  it("relaunch() rejects with the REAPER_NOT_FOUND marker when the reaper is unrunnable", async () => {
    const sup = await makeRunnableSupervisor();
    try {
      await expect(sup.relaunch(fs.realpathSync(os.homedir()))).rejects.toThrow(
        REAPER_NOT_FOUND_MARKER,
      );
    } finally {
      // stop() clears any restart timer the long-lived error handler scheduled
      // (EACCES path on POSIX) so no timer leaks past the test.
      await sup.stop();
    }
  });

  it("startFresh() also rejects with the REAPER_NOT_FOUND marker (sendUnexpected parity)", async () => {
    // breakerTripped is reset at the top of startFresh(), so a fresh supervisor
    // is not strictly required — but using one keeps the assertion isolated.
    const sup = await makeRunnableSupervisor();
    try {
      await expect(sup.startFresh(fs.realpathSync(os.homedir()))).rejects.toThrow(
        REAPER_NOT_FOUND_MARKER,
      );
    } finally {
      await sup.stop();
    }
  });
});

describe("supervisor — Codex plan preconditions", () => {
  // Same unrunnable-reaper trick as "early spawn-failure surfacing" above: a
  // REAPER_NOT_FOUND rejection proves execution reached spawnOnce, i.e. that a
  // plan WAS built. It is the only observable that distinguishes "buildPlan
  // declined" from "buildPlan succeeded" without a real reaper binary.
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ["TANDEM_REAPER_PATH", "TANDEM_TAURI_SIDECAR", "NODE_ENV"];

  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.NODE_ENV = "test";
    delete process.env.TANDEM_TAURI_SIDECAR;
    process.env.TANDEM_REAPER_PATH = os.tmpdir(); // exists, not executable
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  function codexFile(opts: {
    workingDirectory?: string;
    defaultIntegrationId?: string;
  }): IntegrationsFile {
    return {
      schemaVersion: INTEGRATIONS_SCHEMA_VERSION,
      integrations: [
        {
          kind: "codex",
          id: "codex-1",
          label: "Codex",
          configPath:
            process.platform === "win32"
              ? "C:\\Users\\test\\.codex\\config.toml"
              : "/home/test/.codex/config.toml",
          transport: "stdio",
          apply: "create",
          ...(opts.workingDirectory ? { workingDirectory: opts.workingDirectory } : {}),
        },
      ],
      ...(opts.defaultIntegrationId ? { defaultIntegrationId: opts.defaultIntegrationId } : {}),
    };
  }

  it("rejects startFresh and records workspace-required when Codex has no workingDirectory", async () => {
    await writeIntegrations(codexFile({ defaultIntegrationId: "codex-1" }));
    const sup = createSupervisor({ integrationsBase: tmpDir });
    try {
      await expect(sup.startFresh()).rejects.toThrow(/working directory/i);
      // The whole point: `POST /start-fresh` used to answer `{ ok: true }` here
      // while status reported a bare not-running, so the launch looked like it
      // had silently evaporated.
      expect(sup.status()).toMatchObject({ running: false, lastError: "workspace-required" });
    } finally {
      await sup.stop();
    }
  });

  it("relaunch rejects the same way (route parity)", async () => {
    await writeIntegrations(codexFile({ defaultIntegrationId: "codex-1" }));
    const sup = createSupervisor({ integrationsBase: tmpDir });
    try {
      // relaunch() passes its cwd as an override, but resolveCwd only accepts a
      // directory that survives resolveSafeCwd — an empty string does not, so
      // this exercises the same missing-workspace path.
      await expect(sup.relaunch("")).rejects.toThrow(/working directory/i);
    } finally {
      await sup.stop();
    }
  });

  // Positive control for both assertions above: the rejection must be about the
  // MISSING workspace, not about Codex being unlaunchable in general. With a
  // real directory the same fixture gets all the way to spawnOnce.
  it("builds a plan once Codex has a workingDirectory", async () => {
    const cwd = fs.realpathSync(os.homedir());
    await writeIntegrations(codexFile({ workingDirectory: cwd, defaultIntegrationId: "codex-1" }));
    const sup = createSupervisor({ integrationsBase: tmpDir });
    try {
      await expect(sup.startFresh()).rejects.toThrow(REAPER_NOT_FOUND_MARKER);
    } finally {
      await sup.stop();
    }
  });

  // The fallback used to match `kind === "claude-code"` only, so a Codex-only
  // install whose defaultIntegrationId had been cleared — which
  // enforceReferentialIntegrity does on its own — could never launch anything.
  it("falls back to a Codex integration when defaultIntegrationId is unset", async () => {
    const cwd = fs.realpathSync(os.homedir());
    await writeIntegrations(codexFile({ workingDirectory: cwd }));
    const sup = createSupervisor({ integrationsBase: tmpDir });
    try {
      await expect(sup.startFresh()).rejects.toThrow(REAPER_NOT_FOUND_MARKER);
    } finally {
      await sup.stop();
    }
  });
});

describe("shouldClearSession — resume-confirmation gate (issue #1169)", () => {
  it("clears on non-zero exit while resuming and unconfirmed", () => {
    expect(shouldClearSession({ resuming: true, code: 1, resumeConfirmed: false })).toBe(true);
  });

  it("does NOT clear on signal kill (code = null) while resuming and unconfirmed", () => {
    // SIGTERM / SIGKILL: code is null. Must not invalidate a session just
    // because the user stopped the supervisor before the confirm window elapsed.
    expect(shouldClearSession({ resuming: true, code: null, resumeConfirmed: false })).toBe(false);
  });

  it("does NOT clear when resumeConfirmed is true, even on non-zero exit", () => {
    // Claude ran long enough to confirm the session; a crash later should not
    // remove the session so the next restart can attempt another --resume.
    expect(shouldClearSession({ resuming: true, code: 1, resumeConfirmed: true })).toBe(false);
  });

  it("does NOT clear on non-zero exit when not resuming (fresh spawn)", () => {
    expect(shouldClearSession({ resuming: false, code: 1, resumeConfirmed: false })).toBe(false);
  });

  it("does NOT clear on clean exit (code = 0) while resuming and unconfirmed", () => {
    // User stopped Claude cleanly before the window elapsed — session is valid.
    expect(shouldClearSession({ resuming: true, code: 0, resumeConfirmed: false })).toBe(false);
  });
});

describe("buildClaudeArgs — CLI argument vector (#1267)", () => {
  const SESSION = "550e8400-e29b-41d4-a716-446655440000";

  it("leads with the shared stream-json flag prefix", () => {
    const args = buildClaudeArgs({ sessionId: SESSION, resuming: false });
    expect(args.slice(0, CLAUDE_STREAM_JSON_FLAGS.length)).toEqual([...CLAUDE_STREAM_JSON_FLAGS]);
  });

  it("keeps --verbose — it is what makes the CLI emit the init handshake line", () => {
    // Without the init line there is no signal that stdin is ready, so the
    // bootstrap turn is written into a process that never reads it.
    expect(buildClaudeArgs({ sessionId: SESSION, resuming: false })).toContain("--verbose");
  });

  it("appends --session-id for a fresh spawn and never --resume", () => {
    const args = buildClaudeArgs({ sessionId: SESSION, resuming: false });
    expect(args.slice(-2)).toEqual(["--session-id", SESSION]);
    expect(args).not.toContain("--resume");
  });

  it("appends --resume for a resumed spawn and never --session-id", () => {
    const args = buildClaudeArgs({ sessionId: SESSION, resuming: true });
    expect(args.slice(-2)).toEqual(["--resume", SESSION]);
    expect(args).not.toContain("--session-id");
  });

  it("returns a fresh array — mutating the result cannot corrupt the shared prefix", () => {
    const args = buildClaudeArgs({ sessionId: SESSION, resuming: false });
    args.push("--injected");
    expect(buildClaudeArgs({ sessionId: SESSION, resuming: false })).not.toContain("--injected");
    expect([...CLAUDE_STREAM_JSON_FLAGS]).not.toContain("--injected");
  });
});

describe("serializeUserTurn — stdin envelope (#1267)", () => {
  it("emits exactly one newline-terminated JSON object", () => {
    const line = serializeUserTurn(SUPERVISOR_INITIAL_PROMPT);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: SUPERVISOR_INITIAL_PROMPT }] },
    });
  });
});

describe("createLineFramer — child stdout/stderr framing (#1267)", () => {
  function collect() {
    const lines: string[] = [];
    return { lines, framer: createLineFramer((l) => lines.push(l)) };
  }

  it("emits complete lines and withholds a trailing partial", () => {
    const { lines, framer } = collect();
    framer.push("alpha\nbeta\npar");
    expect(lines).toEqual(["alpha", "beta"]);
  });

  it("reassembles a line split across pushes", () => {
    const { lines, framer } = collect();
    framer.push('{"type":"sys');
    expect(lines).toEqual([]);
    framer.push('tem"}\n');
    expect(lines).toEqual(['{"type":"system"}']);
  });

  it("splits multiple lines glued into one push", () => {
    const { lines, framer } = collect();
    framer.push("a\nb\nc\n");
    expect(lines).toEqual(["a", "b", "c"]);
  });

  it("flush() emits a trailing line that never got its newline", () => {
    const { lines, framer } = collect();
    framer.push("no-terminator");
    expect(lines).toEqual([]);
    framer.flush();
    expect(lines).toEqual(["no-terminator"]);
  });

  it("flush() is a no-op when the buffer is empty, and does not re-emit", () => {
    const { lines, framer } = collect();
    framer.push("done\n");
    framer.flush();
    framer.flush();
    expect(lines).toEqual(["done"]);
  });

  it("preserves empty lines between messages (callers decide to skip them)", () => {
    const { lines, framer } = collect();
    framer.push("a\n\nb\n");
    expect(lines).toEqual(["a", "", "b"]);
  });

  it("round-trips a multi-byte character split across chunks when fed a setEncoding stream", async () => {
    // The framer takes strings, so the decoding half of the contract lives on
    // the stream. This pins BOTH halves against a real stream: `setEncoding`
    // holds the partial sequence back, the framer joins the halves, and the
    // original text survives. The negative control below is what makes this a
    // measurement rather than a restatement.
    const payload = `${JSON.stringify({ type: "system", subtype: "init", cwd: "café ✓" })}\n`;
    const bytes = Buffer.from(payload, "utf8");
    const splitAt = bytes.indexOf(0xc3); // lead byte of "é" — split after it
    expect(splitAt).toBeGreaterThan(0);

    const decoded = new PassThrough();
    decoded.setEncoding("utf8");
    const { lines, framer } = collect();
    decoded.on("data", (text: string) => framer.push(text));
    decoded.write(bytes.subarray(0, splitAt + 1));
    decoded.write(bytes.subarray(splitAt + 1));
    decoded.end();
    await once(decoded, "end");

    expect(lines).toEqual([payload.slice(0, -1)]);
    expect(JSON.parse(lines[0]).cwd).toBe("café ✓");
  });

  it("NEGATIVE CONTROL: per-chunk chunk.toString() corrupts the same input", async () => {
    // Documents exactly what `setEncoding("utf8")` buys, and proves the test
    // above is not vacuous. Note the corruption is U+FFFD inside a JSON string
    // — still parseable — which is precisely why no end-to-end supervisor test
    // can catch a `chunk.toString()` regression.
    const payload = `${JSON.stringify({ cwd: "café ✓" })}\n`;
    const bytes = Buffer.from(payload, "utf8");
    const splitAt = bytes.indexOf(0xc3);

    const raw = new PassThrough(); // no setEncoding
    const { lines, framer } = collect();
    raw.on("data", (chunk: Buffer) => framer.push(chunk.toString()));
    raw.write(bytes.subarray(0, splitAt + 1));
    raw.write(bytes.subarray(splitAt + 1));
    raw.end();
    await once(raw, "end");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("�");
    expect(JSON.parse(lines[0]).cwd).not.toBe("café ✓");
  });
});

describe("RESUME_CONFIRM_MS threshold constraint (issue #1169)", () => {
  it("is at least 30_000 ms — must safely exceed the longest observed --resume probe time (~6 s)", () => {
    // The old RESUME_GRACE_MS was 5_000, which was shorter than the ~6 s probe
    // time. Any value <= 6_000 would recreate the bug. We require >= 30_000 ms
    // (5× the observed probe time) as a meaningful safety margin. If you need
    // to reduce this constant, update the bound here with justification.
    expect(RESUME_CONFIRM_MS).toBeGreaterThanOrEqual(30_000);
  });
});
