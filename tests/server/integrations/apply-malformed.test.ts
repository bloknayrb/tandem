/**
 * Matrix coverage for malformed / unusual `.claude.json` inputs. Companion
 * to `apply.test.ts` — that file pins the happy-path behaviours; this one
 * pins the bail-vs-accept contract for every input shape an attacker, a
 * legacy editor, or a corrupt-disk recovery might surface.
 *
 * Categories (issue #645):
 *  - Shape: empty / root-is-array / root-is-string / root-is-null /
 *    mcp-servers-is-string. Production gate at apply.ts rejects any
 *    non-object root and any non-object `mcpServers` — without this
 *    gate, the spread-and-rewrite path produces a corrupted file.
 *  - Path / IO: UNC paths (Windows), hardlink, symlink-to-self
 *    (POSIX). These exercise `assertPathSafe`.
 *  - Encoding: UTF-8 BOM-prefixed JSON. Production code strips the BOM
 *    before JSON.parse so a legitimate user file isn't pushed into
 *    `.broken-backups/`.
 *  - Concurrency: two `applyConfig` calls racing the same path. The
 *    atomic rename guarantees the final file is one of the two writes,
 *    never a half-merged blob.
 *
 * Assertion shape for the "bail" cases: the on-disk file is BYTE-
 * IDENTICAL after the throw. The original config survives untouched —
 * the contract on which #644's backup-or-prompt also relies.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyConfig } from "../../../src/server/integrations/apply.js";

const DEFAULT_OPS = {
  create: { tandem: { type: "http" as const, url: "http://127.0.0.1:3479/mcp" } },
  remove: [],
};

describe("applyConfig — malformed-input matrix (#645)", () => {
  let tmpDir: string;
  let configPath: string;
  let savedAppData: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-malformed-"));
    configPath = path.join(tmpDir, ".claude.json");
    savedAppData = process.env.TANDEM_APP_DATA_DIR;
    process.env.TANDEM_APP_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    if (savedAppData === undefined) delete process.env.TANDEM_APP_DATA_DIR;
    else process.env.TANDEM_APP_DATA_DIR = savedAppData;
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  // Helper: assert the on-disk bytes match what was there before applyConfig.
  function assertOriginalIntact(originalBytes: string): void {
    expect(fs.readFileSync(configPath, "utf-8")).toBe(originalBytes);
  }

  describe("shape: non-object root must bail", () => {
    const NON_OBJECT_ROOTS: Array<{ name: string; content: string }> = [
      { name: "root-is-array", content: "[]" },
      { name: "root-is-string", content: '"hello"' },
      { name: "root-is-null", content: "null" },
      { name: "root-is-number", content: "42" },
      { name: "root-is-boolean", content: "true" },
    ];

    for (const { name, content } of NON_OBJECT_ROOTS) {
      it(`${name}: throws and leaves original intact`, async () => {
        fs.writeFileSync(configPath, content);
        await expect(applyConfig(configPath, DEFAULT_OPS)).rejects.toThrow(
          /root is not a JSON object/,
        );
        assertOriginalIntact(content);
      });
    }
  });

  describe("shape: non-object mcpServers must bail", () => {
    const NON_OBJECT_SERVERS: Array<{ name: string; servers: unknown }> = [
      { name: "mcp-servers-is-string", servers: "bogus" },
      { name: "mcp-servers-is-array", servers: [] },
      { name: "mcp-servers-is-number", servers: 42 },
      { name: "mcp-servers-is-null", servers: null },
    ];

    for (const { name, servers } of NON_OBJECT_SERVERS) {
      it(`${name}: throws and leaves original intact`, async () => {
        const content = JSON.stringify({ mcpServers: servers });
        fs.writeFileSync(configPath, content);
        await expect(applyConfig(configPath, DEFAULT_OPS)).rejects.toThrow(
          /mcpServers is not an object/,
        );
        assertOriginalIntact(content);
      });
    }
  });

  describe("shape: empty file", () => {
    it("zero-byte config: pushed to .broken-backups and fresh config written", async () => {
      // `JSON.parse("")` throws SyntaxError → malformed-JSON-backup path.
      // The user's empty file is preserved (under .broken-backups/) and
      // the destination gets a fresh config — start-fresh is the right
      // semantic when there's nothing to preserve in the first place.
      fs.writeFileSync(configPath, "");
      await applyConfig(configPath, DEFAULT_OPS);
      const after = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      expect(after.mcpServers.tandem.url).toBe("http://127.0.0.1:3479/mcp");
      // The empty original landed in the broken-backups dir.
      const brokenDir = path.join(tmpDir, ".broken-backups");
      expect(fs.existsSync(brokenDir)).toBe(true);
      const brokenFiles = fs.readdirSync(brokenDir);
      expect(brokenFiles.length).toBe(1);
    });
  });

  describe("shape: parse-fail (genuine malformed JSON)", () => {
    it("incomplete object: backed up + fresh config written", async () => {
      const malformed = '{"mcpServers":{';
      fs.writeFileSync(configPath, malformed);
      await applyConfig(configPath, DEFAULT_OPS);
      const after = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      expect(after.mcpServers.tandem).toBeDefined();
      // Original survives in .broken-backups, byte-exact.
      const brokenDir = path.join(tmpDir, ".broken-backups");
      const brokenFiles = fs.readdirSync(brokenDir);
      expect(brokenFiles.length).toBe(1);
      const backupBytes = fs.readFileSync(path.join(brokenDir, brokenFiles[0]), "utf-8");
      expect(backupBytes).toBe(malformed);
    });
  });

  describe("encoding: UTF-8 BOM", () => {
    it("bom-prefixed valid JSON: NOT pushed to broken-backups", async () => {
      // The leading U+FEFF is the UTF-8 BOM. Without the strip,
      // `JSON.parse` throws and the file lands in .broken-backups —
      // wrong outcome for a perfectly-valid (if unusually-encoded)
      // user file.
      const bomPrefixedContent =
        "﻿" + JSON.stringify({ mcpServers: { other: { command: "node" } } });
      fs.writeFileSync(configPath, bomPrefixedContent);
      await applyConfig(configPath, DEFAULT_OPS);
      const after = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      // Other server preserved; tandem added.
      expect(after.mcpServers.other).toBeDefined();
      expect(after.mcpServers.tandem).toBeDefined();
      // No .broken-backups dir — BOM was stripped, parse succeeded.
      expect(fs.existsSync(path.join(tmpDir, ".broken-backups"))).toBe(false);
    });
  });

  describe("path / IO", () => {
    const POSIX_ONLY = process.platform !== "win32";
    const WIN_ONLY = process.platform === "win32";

    it.skipIf(!POSIX_ONLY)("symlink-to-self: rejected by assertPathSafe", async () => {
      // A symlink whose target is itself. `realpathSync` errors with
      // ELOOP, which `assertPathSafe` surfaces as an "unreadable"
      // PathRejectedError. The original (which is itself a symlink to
      // nowhere resolvable) is unchanged — but the assertion shape is
      // "throws", not byte-equality, because the file is unreadable
      // by the time we'd try to read it back.
      const selfLink = path.join(tmpDir, "self");
      fs.symlinkSync(selfLink, selfLink);
      await expect(applyConfig(selfLink, DEFAULT_OPS)).rejects.toThrow();
    });

    it.skipIf(!POSIX_ONLY)("hardlinked config: applyConfig still rewrites", async () => {
      // Hardlink threat model: an attacker pre-creates a hardlink from
      // `~/.claude.json` to `/tmp/attacker-owned`. Our `atomicWrite`
      // creates a tempfile and renames over the destination — the
      // tempfile gets a fresh inode, so the rename creates a NEW
      // hardlink chain; the attacker's other-name reference still
      // points at the OLD bytes. Net: our write doesn't leak into
      // the attacker's location.
      const attackerOwned = path.join(tmpDir, "attacker-owned");
      const originalContent = JSON.stringify({ mcpServers: {} });
      fs.writeFileSync(attackerOwned, originalContent);
      fs.linkSync(attackerOwned, configPath);

      await applyConfig(configPath, DEFAULT_OPS);

      // Destination has the new tandem entry.
      const after = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      expect(after.mcpServers.tandem.url).toBe("http://127.0.0.1:3479/mcp");
      // Attacker's name still points at the original bytes — the
      // rename split the hardlink chain (different inodes now).
      expect(fs.readFileSync(attackerOwned, "utf-8")).toBe(originalContent);
    });

    it.skipIf(!WIN_ONLY)("UNC path: rejected by assertPathSafe", async () => {
      // UNC paths are user-controllable via mapped drives / share
      // names. `assertPathSafe` rejects any path that doesn't realpath
      // under homedir/tmpdir; a UNC path normally won't. We can't
      // construct a guaranteed-rejecting UNC path on every CI runner
      // (the test would have to enumerate non-existent shares), so
      // assert the broader invariant: a bare UNC-form path that
      // doesn't resolve fails the safety gate cleanly.
      const uncPath = "\\\\unlikely-server\\share\\.claude.json";
      await expect(applyConfig(uncPath, DEFAULT_OPS)).rejects.toThrow();
    });
  });

  describe("concurrency: parallel applyConfig calls", () => {
    it("two callers racing: final file is parseable JSON with the tandem entry", async () => {
      // Atomic rename guarantees the final file is ONE of the two
      // writes, not a torn / half-merged blob. The test doesn't pin
      // which winner — that's race-dependent — only that the final
      // bytes parse cleanly and contain the tandem entry we just
      // wrote.
      fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
      const results = await Promise.allSettled([
        applyConfig(configPath, DEFAULT_OPS),
        applyConfig(configPath, DEFAULT_OPS),
      ]);

      // At least one must succeed — both could succeed if the
      // tempfile-then-rename windows don't overlap (common case
      // because each rename is atomic). The contract: the FILE is
      // consistent, not that both writers succeed.
      const succeeded = results.filter((r) => r.status === "fulfilled");
      expect(succeeded.length).toBeGreaterThanOrEqual(1);

      // Final file is parseable JSON with a sane mcpServers.tandem.
      const finalText = fs.readFileSync(configPath, "utf-8");
      const finalParsed = JSON.parse(finalText);
      expect(finalParsed.mcpServers.tandem.url).toBe("http://127.0.0.1:3479/mcp");
    });
  });
});
