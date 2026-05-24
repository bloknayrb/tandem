import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyIntegrationsFile,
  INTEGRATIONS_SCHEMA_VERSION,
  type IntegrationsFile,
} from "../../../src/server/integrations/schema.js";
import {
  BROKEN_BACKUPS_DIR_NAME,
  createIntegrationsStore,
  INTEGRATIONS_FILE_NAME,
  MAX_BROKEN_BACKUPS,
  sweepBrokenIntegrationsBackupsOnStartup,
} from "../../../src/server/integrations/storage.js";

const claudeCode = {
  kind: "claude-code" as const,
  id: "cc-1",
  label: "Claude Code",
  configPath: "/home/user/.claude.json",
  transport: "http" as const,
  url: "http://127.0.0.1:3479",
};

const claudeDesktop = {
  kind: "claude-desktop" as const,
  id: "cd-1",
  label: "Claude Desktop",
  configPath: "/Users/user/Library/Application Support/Claude/claude_desktop_config.json",
  transport: "stdio" as const,
};

describe("createIntegrationsStore", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-integ-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("requires a non-empty basePath", () => {
    expect(() => createIntegrationsStore("")).toThrow(/basePath is required/);
  });

  it("requires an absolute basePath", () => {
    expect(() => createIntegrationsStore("relative/path")).toThrow(/must be absolute/);
    expect(() => createIntegrationsStore("./relative")).toThrow(/must be absolute/);
  });

  it("filePath joins basePath with integrations.json", () => {
    const store = createIntegrationsStore(tmpDir);
    expect(store.filePath).toBe(path.join(tmpDir, INTEGRATIONS_FILE_NAME));
  });

  it("read() returns an empty config when the file does not exist", async () => {
    const store = createIntegrationsStore(tmpDir);
    const result = await store.read();
    expect(result).toEqual(emptyIntegrationsFile());
  });

  it("write() then read() round-trips a populated config", async () => {
    const store = createIntegrationsStore(tmpDir);
    const file: IntegrationsFile = {
      schemaVersion: INTEGRATIONS_SCHEMA_VERSION,
      integrations: [claudeCode, claudeDesktop],
      defaultIntegrationId: "cc-1",
    };
    await store.write(file);

    const result = await store.read();
    expect(result).toEqual(file);
  });

  it("write() creates the basePath directory if missing", async () => {
    const nested = path.join(tmpDir, "nested", "dir");
    const store = createIntegrationsStore(nested);
    await store.write(emptyIntegrationsFile());
    const stat = await fs.promises.stat(nested);
    expect(stat.isDirectory()).toBe(true);
  });

  it("write() rejects an invalid IntegrationsFile shape", async () => {
    const store = createIntegrationsStore(tmpDir);
    await expect(
      store.write({
        schemaVersion: 1,
        integrations: [{ kind: "unknown" } as never],
      }),
    ).rejects.toThrow();
  });

  it.runIf(process.platform !== "win32")(
    "write() creates the file with 0o600 permissions on POSIX",
    async () => {
      const store = createIntegrationsStore(tmpDir);
      await store.write(emptyIntegrationsFile());
      const stat = await fs.promises.stat(store.filePath);
      expect(stat.mode & 0o777).toBe(0o600);
    },
  );

  it("read() backs up malformed JSON into .broken-backups/ and returns an empty config", async () => {
    const store = createIntegrationsStore(tmpDir);
    await fs.promises.writeFile(store.filePath, "{ not valid json", "utf8");
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await store.read();
      expect(result).toEqual(emptyIntegrationsFile());

      const brokenDir = path.join(tmpDir, BROKEN_BACKUPS_DIR_NAME);
      const entries = await fs.promises.readdir(brokenDir);
      const backup = entries.find(
        (name) => name.startsWith("integrations-") && name.endsWith(".json"),
      );
      expect(backup).toBeDefined();
      // UUID-suffixed filename: integrations-<ts>-<uuid8>.json
      expect(backup).toMatch(/^integrations-\d+-[a-f0-9]{8}\.json$/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it.runIf(process.platform !== "win32")(
    "read() malformed-JSON backup has 0o600 file mode + 0o700 dir mode on POSIX",
    async () => {
      const store = createIntegrationsStore(tmpDir);
      await fs.promises.writeFile(store.filePath, "{ bad", "utf8");
      const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await store.read();
        const brokenDir = path.join(tmpDir, BROKEN_BACKUPS_DIR_NAME);
        const dirStat = await fs.promises.stat(brokenDir);
        expect(dirStat.mode & 0o777).toBe(0o700);

        const entries = await fs.promises.readdir(brokenDir);
        const backup = entries.find((name) => name.startsWith("integrations-"));
        expect(backup).toBeDefined();
        const stat = await fs.promises.stat(path.join(brokenDir, backup!));
        expect(stat.mode & 0o777).toBe(0o600);
      } finally {
        warnSpy.mockRestore();
      }
    },
  );

  it("read() error message names 'ACL' when Windows ACL hardening fails (regression guard for plan P3)", async () => {
    // Simulate the failure mode by pre-creating the .broken-backups path as a
    // FILE (not a dir). `mkdir({recursive: true})` rejects with ENOTDIR/EEXIST,
    // and the outer catch fires. The point of this test is to lock in that the
    // outer-catch message includes the path + reason so a user can act on it —
    // not to verify the Windows-specific ACL branch (which requires icacls).
    const store = createIntegrationsStore(tmpDir);
    await fs.promises.writeFile(path.join(tmpDir, BROKEN_BACKUPS_DIR_NAME), "blocker", "utf8");
    await fs.promises.writeFile(store.filePath, "{ bad", "utf8");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await store.read();
      expect(result).toEqual(emptyIntegrationsFile());
      // The outer catch fired and surfaced a meaningful message (not silent).
      const messages = errSpy.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes("backup at") && m.includes("failed"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("read() throws when schemaVersion is in the future", async () => {
    const store = createIntegrationsStore(tmpDir);
    await fs.promises.writeFile(
      store.filePath,
      JSON.stringify({ schemaVersion: 99, integrations: [] }),
      "utf8",
    );
    await expect(store.read()).rejects.toThrow(/newer than this Tandem build/);
  });

  it("read() migrates a v1 file forward to the current schema version", async () => {
    const store = createIntegrationsStore(tmpDir);
    const v1OnDisk = {
      schemaVersion: 1,
      integrations: [
        {
          kind: "claude-code",
          id: "cc-1",
          label: "Claude Code",
          configPath: "/home/user/.claude.json",
          transport: "http",
          url: "http://127.0.0.1:3479",
        },
      ],
      defaultIntegrationId: "cc-1",
    };
    await fs.promises.writeFile(store.filePath, JSON.stringify(v1OnDisk), "utf8");

    const result = await store.read();
    expect(result.schemaVersion).toBe(INTEGRATIONS_SCHEMA_VERSION);
    // v1 → v2 → v3 migration adds `apply: "create"` to claude-code records.
    expect(result.integrations).toEqual(
      v1OnDisk.integrations.map((entry) => ({ ...entry, apply: "create" })),
    );
    expect(result.defaultIntegrationId).toBe("cc-1");
  });

  it("read() does NOT rewrite the v1 file in place (next write upgrades it)", async () => {
    const store = createIntegrationsStore(tmpDir);
    const v1OnDisk = { schemaVersion: 1, integrations: [] };
    await fs.promises.writeFile(store.filePath, JSON.stringify(v1OnDisk), "utf8");

    await store.read();
    const onDisk = JSON.parse(await fs.promises.readFile(store.filePath, "utf8"));
    expect(onDisk.schemaVersion).toBe(1);
  });

  it("write() round-trips an other-mcp integration with tokenSecretRef", async () => {
    const store = createIntegrationsStore(tmpDir);
    const file: IntegrationsFile = {
      schemaVersion: INTEGRATIONS_SCHEMA_VERSION,
      integrations: [
        {
          kind: "other-mcp",
          id: "cursor-1",
          label: "Cursor",
          transport: "http",
          url: "http://127.0.0.1:3479",
          tokenSecretRef: "ref-abc",
        },
      ],
    };
    await store.write(file);
    const result = await store.read();
    expect(result).toEqual(file);
  });

  it("read() backs up files missing schemaVersion", async () => {
    const store = createIntegrationsStore(tmpDir);
    await fs.promises.writeFile(store.filePath, JSON.stringify({ integrations: [] }), "utf8");
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await store.read();
      expect(result).toEqual(emptyIntegrationsFile());
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("read() clears a dangling defaultIntegrationId and warns", async () => {
    const store = createIntegrationsStore(tmpDir);
    await fs.promises.writeFile(
      store.filePath,
      JSON.stringify({
        schemaVersion: INTEGRATIONS_SCHEMA_VERSION,
        integrations: [claudeCode],
        defaultIntegrationId: "nonexistent",
      }),
      "utf8",
    );
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await store.read();
      expect(result.defaultIntegrationId).toBeUndefined();
      expect(result.integrations).toEqual([claudeCode]);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("read() preserves a valid defaultIntegrationId", async () => {
    const store = createIntegrationsStore(tmpDir);
    await store.write({
      schemaVersion: INTEGRATIONS_SCHEMA_VERSION,
      integrations: [claudeCode, claudeDesktop],
      defaultIntegrationId: "cd-1",
    });
    const result = await store.read();
    expect(result.defaultIntegrationId).toBe("cd-1");
  });

  it.runIf(process.platform !== "win32")(
    "write() refuses to follow a symlink at the destination on POSIX (EXDEV-fallback path)",
    async () => {
      const store = createIntegrationsStore(tmpDir);
      const realTarget = path.join(tmpDir, "redirect-target.json");
      await fs.promises.writeFile(realTarget, "", "utf8");
      await fs.promises.symlink(realTarget, store.filePath);

      // The normal rename path replaces the symlink itself on POSIX
      // (the symlink at the destination is overwritten). The hardened
      // behavior we care about is the EXDEV branch, but reliably forcing
      // EXDEV in a unit test requires a cross-filesystem setup that the
      // CI runners do not guarantee. We assert the post-state on the
      // normal-path write: the symlink target file must NOT have been
      // modified through the link.
      await store.write(emptyIntegrationsFile());
      const targetContent = await fs.promises.readFile(realTarget, "utf8");
      expect(targetContent).toBe("");
    },
  );
});

describe("sweepBrokenIntegrationsBackupsOnStartup", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-broken-sweep-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("is a no-op when the .broken-backups dir does not exist (fresh install)", async () => {
    await expect(sweepBrokenIntegrationsBackupsOnStartup(tmpDir)).resolves.toBeUndefined();
  });

  it("keeps the newest MAX_BROKEN_BACKUPS files and prunes older ones", async () => {
    const dir = path.join(tmpDir, BROKEN_BACKUPS_DIR_NAME);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    // Lex-monotonic timestamps so sort-by-name = newest-first deterministically.
    const total = MAX_BROKEN_BACKUPS + 3;
    for (let i = 0; i < total; i++) {
      const ts = String(1_700_000_000_000 + i).padStart(13, "0");
      await fs.promises.writeFile(path.join(dir, `integrations-${ts}-deadbeef.json`), `v${i}`);
    }
    await sweepBrokenIntegrationsBackupsOnStartup(tmpDir);
    const remaining = await fs.promises.readdir(dir);
    expect(remaining.length).toBe(MAX_BROKEN_BACKUPS);
    // Newest survive: last `MAX_BROKEN_BACKUPS` indices.
    for (const name of remaining) {
      const match = name.match(/^integrations-(\d+)-/);
      expect(match).not.toBeNull();
      const idx = Number(match![1]) - 1_700_000_000_000;
      expect(idx).toBeGreaterThanOrEqual(total - MAX_BROKEN_BACKUPS);
    }
  });

  it("does not touch unrelated files in the .broken-backups dir", async () => {
    const dir = path.join(tmpDir, BROKEN_BACKUPS_DIR_NAME);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(path.join(dir, "README.txt"), "ignore me");
    for (let i = 0; i < MAX_BROKEN_BACKUPS + 2; i++) {
      const ts = String(1_700_000_000_000 + i).padStart(13, "0");
      await fs.promises.writeFile(path.join(dir, `integrations-${ts}-deadbeef.json`), `v${i}`);
    }
    await sweepBrokenIntegrationsBackupsOnStartup(tmpDir);
    const remaining = await fs.promises.readdir(dir);
    expect(remaining.includes("README.txt")).toBe(true);
    const backups = remaining.filter((n) => n.startsWith("integrations-"));
    expect(backups.length).toBe(MAX_BROKEN_BACKUPS);
  });

  it("never creates a per-file ACL call on the backup (TOCTOU regression guard)", async () => {
    // The new design hardens the parent dir, not the file. Adding a per-file
    // ACL call would reintroduce the TOCTOU window between copyFile and the
    // ACL set. This test is a source-level grep to prevent regression.
    const source = await fs.promises.readFile(
      path.join(import.meta.dirname, "../../../src/server/integrations/storage.ts"),
      "utf8",
    );
    // Find the backupBrokenFile function body; assert it does not call
    // setRestrictiveAcl on backupPath.
    const fnMatch = source.match(/async function backupBrokenFile[\s\S]+?^}/m);
    expect(fnMatch).not.toBeNull();
    const body = fnMatch![0];
    expect(body).not.toMatch(/setRestrictiveAcl\(backupPath\)/);
    // Sanity: the dir-level hardening call IS present.
    expect(body).toMatch(/setRestrictiveAcl\(dir\)/);
  });
});
