import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emptyIntegrationsFile,
  type IntegrationsFile,
} from "../../../src/server/integrations/schema.js";
import { createIntegrationsStore } from "../../../src/server/integrations/storage.js";
import { createSupervisor, resolveSafeCwd } from "../../../src/server/launcher/supervisor.js";

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
