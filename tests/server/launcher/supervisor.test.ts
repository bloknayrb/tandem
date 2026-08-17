import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyIntegrationsFile,
  type IntegrationsFile,
} from "../../../src/server/integrations/schema.js";
import { createIntegrationsStore } from "../../../src/server/integrations/storage.js";
import {
  buildClaudeArgs,
  createLineFramer,
  createSupervisor,
  homeCwd,
  RESUME_CONFIRM_MS,
  resolveRouteCwd,
  resolveSafeCwd,
  sessionCwdMatches,
  shouldClearSession,
} from "../../../src/server/launcher/supervisor.js";
import {
  CLAUDE_STREAM_JSON_FLAGS,
  REAPER_NOT_FOUND_MARKER,
  SUPERVISOR_INITIAL_PROMPT,
  serializeUserTurn,
} from "../../../src/shared/launcher/contract.js";
import { NETWORK_PATHS } from "../../helpers/unc-fixtures.js";

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
      schemaVersion: 3,
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

describe("sessionCwdMatches — a session is only resumable from its own directory", () => {
  it("treats a legacy session file (no recorded cwd) as a match", () => {
    // Assuming a mismatch would discard a live conversation on upgrade for
    // every user; assuming a match costs at most the one doomed resume that
    // was the unconditional behaviour before this gate existed.
    expect(sessionCwdMatches(undefined, "/home/u/project")).toBe(true);
  });

  it("matches an identical directory", () => {
    expect(sessionCwdMatches("/home/u/project", "/home/u/project")).toBe(true);
  });

  it("rejects a different directory", () => {
    // The case the whole gate exists for: `claude --resume <id>` here would
    // exit 1 with "No conversation found with session ID".
    expect(sessionCwdMatches("/home/u/project-a", "/home/u/project-b")).toBe(false);
  });

  it("rejects a parent or child of the saved directory", () => {
    expect(sessionCwdMatches("/home/u/project", "/home/u/project/docs")).toBe(false);
    expect(sessionCwdMatches("/home/u/project/docs", "/home/u/project")).toBe(false);
  });

  // Both branches run on every host. vitest runs on ubuntu-latest in CI, so a
  // `runIf(platform === "win32")` guard would leave the case-insensitive
  // compare — the branch that matters on the product's primary desktop
  // platform — verified nowhere but a maintainer's laptop.
  it("compares case-insensitively on win32", () => {
    expect(sessionCwdMatches("C:\\Users\\U\\Project", "c:\\users\\u\\project", "win32")).toBe(true);
  });

  it("compares case-sensitively off win32", () => {
    expect(sessionCwdMatches("/home/u/Project", "/home/u/project", "linux")).toBe(false);
    expect(sessionCwdMatches("/home/u/Project", "/home/u/project", "darwin")).toBe(false);
  });

  it("still rejects genuinely different directories on win32", () => {
    // The case-fold must not degrade into "always matches on Windows".
    expect(sessionCwdMatches("C:\\a\\project", "C:\\b\\project", "win32")).toBe(false);
  });
});

describe("homeCwd — the last-resort cwd is canonicalized like every other", () => {
  // `plan.cwd` is written verbatim into `launcher-session.json` and then
  // compared by `sessionCwdMatches`, whose contract is "both sides are
  // realpath'd". A raw `os.homedir()` breaks that on any host where $HOME is
  // reached through a symlink: the bare-restart spelling and the override
  // spelling of the same folder compare unequal, discarding a live
  // conversation — and oscillating, since a crash-restart and an explicit
  // restart land on different spellings.
  it.skipIf(process.platform === "win32")(
    "resolves a symlinked $HOME to its canonical path",
    () => {
      const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "home-real-")));
      const link = path.join(tmpDir, "home-link");
      fs.symlinkSync(real, link, "dir");
      const prev = process.env.HOME;
      try {
        // Node's os.homedir() prefers $HOME on POSIX.
        process.env.HOME = link;
        expect(homeCwd()).toBe(real);
        expect(homeCwd()).not.toBe(link);
      } finally {
        if (prev === undefined) delete process.env.HOME;
        else process.env.HOME = prev;
        fs.rmSync(real, { recursive: true, force: true });
      }
    },
  );

  it("falls back to the raw home when it does not resolve to a directory", () => {
    // The fallback branch is platform-independent, but the env var that steers
    // os.homedir() is not: POSIX prefers $HOME, Windows reads %USERPROFILE%.
    // Setting only HOME here made this pass on Ubuntu CI and fail on every
    // Windows dev machine — where `.husky/pre-push` runs the same suite.
    const homeVar = process.platform === "win32" ? "USERPROFILE" : "HOME";
    const missing = path.join(tmpDir, "does-not-exist");
    const prev = process.env[homeVar];
    try {
      process.env[homeVar] = missing;
      expect(homeCwd()).toBe(missing);
    } finally {
      if (prev === undefined) delete process.env[homeVar];
      else process.env[homeVar] = prev;
    }
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

  // #1417. The forward-slash UNC form was the gap: the hand-rolled screen this
  // replaced named `\\`, `\\?\` and `\\.\` but not `//`, and
  // `path.win32.isAbsolute("//attacker/share")` is true — so it passed the
  // screen and reached `realpath`, performing the SMB handshake that leaks an
  // NTLM hash. Reachable with no precondition from an HTTP request body via
  // `launcher/api-routes.ts` (`body.cwd`, `workingDirectory`) and from
  // `cwd-preview.ts` at tab-switch frequency.
  //
  // These deliberately do NOT skip off win32. The old screen was gated on
  // `process.platform === "win32"`, which meant a Linux or macOS server
  // accepted a UNC string, stored it, and handed it back to a Windows client
  // later. The check is now cross-platform, so the test is too — and on posix
  // `//attacker/share` really does clear `isAbsolute`, making this the branch
  // that has to catch it.
  // Asserts the syscall, not the return value — see `tests/helpers/unc-fixtures.ts`.
  // Here `null` came out either way, because `realpath` throws on a host that
  // does not answer; the hash is gone before the throw.
  it.each(
    NETWORK_PATHS,
  )("rejects %s (%s) WITHOUT touching the filesystem, on every platform", (_label, candidate) => {
    const realpathSync = vi.spyOn(fs, "realpathSync");
    const statSync = vi.spyOn(fs, "statSync");
    try {
      expect(resolveSafeCwd(candidate)).toBeNull();
      expect(realpathSync).not.toHaveBeenCalled();
      expect(statSync).not.toHaveBeenCalled();
    } finally {
      realpathSync.mockRestore();
      statSync.mockRestore();
    }
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
   * sometimes does, POSIX never does). Mirrors the `refreshExistingSkillIfStale`
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

  it("never carries the dev-channels flag — it is inert under -p (#1266)", () => {
    // This is the only assertion in the suite that would fail if the flag came
    // back. Every other one here slices by CLAUDE_STREAM_JSON_FLAGS.length, so
    // they are green with it present *and* absent; the doc comment on the const
    // is prose, and prose is not a guard.
    //
    // Why it must stay gone: Claude Code parses the flag only inside an
    // `if (!isNonInteractiveSession)` branch, and `-p` is that mode — so it
    // registers nothing. Independently, #1266 measured that no turn results
    // under these flags even when the shim does receive the frame, which is why
    // the supervisor wakes the child over stdin instead.
    //
    // The flag remains correct for a hand-launched interactive session. This
    // pin is about the launcher's argv only.
    expect([...CLAUDE_STREAM_JSON_FLAGS]).not.toContain("--dangerously-load-development-channels");
    expect([...CLAUDE_STREAM_JSON_FLAGS]).not.toContain("server:tandem-channel");
    expect(buildClaudeArgs({ sessionId: SESSION, resuming: false })).not.toContain(
      "--dangerously-load-development-channels",
    );
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

describe("circuit breaker — trip-time CLI diagnosis (#1268 follow-up)", () => {
  /**
   * Drives the REAL restart loop to the trip. `TANDEM_REAPER_PATH` points at
   * the Node binary, which spawns successfully and then exits non-zero when
   * handed the reaper's argv — an ordinary process exit, which is the only
   * path that reaches `scheduleRestart` (a missing reaper is ENOENT and trips
   * the breaker directly, with `binary-not-found`, without ever going through
   * the branch under test). Zeroed backoffs collapse the 1s/5s/30s ladder.
   */
  async function tripBreaker(probeCliUsable: () => boolean): Promise<{
    lastError: string | undefined;
    stop: () => Promise<void>;
  }> {
    await writeIntegrations({
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
        },
      ],
    });
    const prev = process.env.TANDEM_REAPER_PATH;
    process.env.TANDEM_REAPER_PATH = process.execPath;
    const sup = createSupervisor({
      integrationsBase: tmpDir,
      probeCliUsable,
      restartBackoffsMs: [0],
    });
    try {
      await sup.start();
      // Poll rather than sleep a fixed span: each iteration is a real process
      // spawn, and eleven of them take as long as this machine takes.
      const deadline = Date.now() + 20_000;
      let status = sup.status();
      while (Date.now() < deadline) {
        status = sup.status();
        if (!status.running && status.lastError === "circuit-open") break;
        if (!status.running && status.lastError === "cli-unusable") break;
        await new Promise((r) => setTimeout(r, 25));
      }
      return {
        lastError: status.running ? undefined : status.lastError,
        stop: async () => {
          await sup.stop();
          if (prev === undefined) delete process.env.TANDEM_REAPER_PATH;
          else process.env.TANDEM_REAPER_PATH = prev;
        },
      };
    } catch (err) {
      await sup.stop();
      if (prev === undefined) delete process.env.TANDEM_REAPER_PATH;
      else process.env.TANDEM_REAPER_PATH = prev;
      throw err;
    }
  }

  it("reports circuit-open when the CLI probe says the CLI is fine", async () => {
    // The crash-loop-with-a-working-install case: a stale --resume session, an
    // auth failure, OOM. Routing this to the wizard (which cannot clear the
    // breaker) is the #1268 defect this whole branch exists to fix.
    const r = await tripBreaker(() => true);
    try {
      expect(r.lastError).toBe("circuit-open");
    } finally {
      await r.stop();
    }
  }, 30_000);

  it("reports cli-unusable when the CLI probe says the CLI is missing/unstartable", async () => {
    const r = await tripBreaker(() => false);
    try {
      expect(r.lastError).toBe("cli-unusable");
    } finally {
      await r.stop();
    }
  }, 30_000);

  it("survives a probe that THROWS, and reports a plain crash loop", async () => {
    // The probe runs inside the child's "error"/"exit" handlers, which Node
    // calls synchronously from emit() with no try/catch in supervisor.ts. An
    // escaping throw is therefore not a failed diagnosis — it is an
    // uncaughtException, and index.ts exits the process for anything that is
    // not a known Hocuspocus error. The whole editor would die at the moment
    // the launcher was trying to explain itself.
    //
    // `probeCliUsable` is an injection seam, so its totality cannot be assumed
    // from the default implementation even after making that one total.
    //
    // Fails OPEN: a probe that could not run is not evidence the CLI is
    // missing, and "go install Claude Code" is the more alarming and less
    // recoverable claim to make wrongly.
    const r = await tripBreaker(() => {
      throw new Error("EACCES: permission denied, stat 'Z:\\offline-share\\claude.exe'");
    });
    try {
      expect(r.lastError).toBe("circuit-open");
    } finally {
      await r.stop();
    }
  }, 30_000);

  it("probes once per trip, not once per restart attempt", async () => {
    // Pins the probe's POSITION: inside the trip branch, not in the body of
    // `scheduleRestart`. Hoisting it one level out makes this 12, verified by
    // running that mutation — a filesystem walk on every crash of a
    // restart-looping process is exactly the hot-path cost the design avoids.
    //
    // It does NOT pin `scheduleRestart`'s `if (breakerTripped) return` guard:
    // removing that guard leaves this test green, because a reaper that
    // spawns and then exits emits only "exit", never "error", so scheduleRestart
    // is entered once per crash here. That guard is defense-in-depth for the
    // case where both handlers fire for one spawn — which is what the file's
    // own `child === spawned` identity guards already anticipate — and it is
    // honestly untested rather than falsely claimed.
    let calls = 0;
    const r = await tripBreaker(() => {
      calls++;
      return true;
    });
    try {
      expect(r.lastError).toBe("circuit-open");
      expect(calls).toBe(1);
    } finally {
      await r.stop();
    }
  }, 30_000);
});
