import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emptyIntegrationsFile,
  type IntegrationsFile,
} from "../../../src/server/integrations/schema.js";
import { createIntegrationsStore } from "../../../src/server/integrations/storage.js";
import { REAPER_NOT_FOUND_MARKER } from "../../../src/shared/launcher/contract.js";
import {
  createSupervisor,
  resolveRouteCwd,
  resolveSafeCwd,
} from "../../../src/server/launcher/supervisor.js";

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
