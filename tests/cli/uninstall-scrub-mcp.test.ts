/**
 * Real-filesystem tests for the cross-platform uninstall-scrub steps:
 * `removeConfigEntries` (apply.ts), `scrubMcpConfigs`, and `removeSkillDir`.
 *
 * Fixtures live under `os.tmpdir()` — `assertPathSafe`'s default allowed
 * roots are `[homedir(), tmpdir()]`, so real paths exercise the real gate
 * (no fs mocking; the sibling uninstall-scrub.test.ts covers the mocked
 * Cowork paths).
 */

import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeSkillDir, scrubMcpConfigs } from "../../src/cli/uninstall-scrub";
import type { DetectedTarget } from "../../src/server/integrations/apply";
import { removeConfigEntries } from "../../src/server/integrations/apply";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tandem-scrub-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), close: async () => {} };
}

const FULL_CONFIG = {
  someTopLevel: "untouched",
  mcpServers: {
    tandem: { type: "http", url: "http://127.0.0.1:3479/mcp" },
    "tandem-channel": { command: "node", args: ["x.js"] },
    context7: { type: "http", url: "https://example.com", headers: { Authorization: "Bearer X" } },
  },
  projects: { "/some/proj": { mcpServers: { tandem: { type: "http" } } } },
};

describe("removeConfigEntries", () => {
  it("removes both tandem keys, preserves everything else (incl. per-project state)", async () => {
    const config = join(dir, ".claude.json");
    await writeFile(config, JSON.stringify(FULL_CONFIG), "utf-8");

    const result = await removeConfigEntries(config, ["tandem", "tandem-channel"]);
    expect(result).toEqual({ status: "removed", removed: ["tandem", "tandem-channel"] });

    const after = JSON.parse(await readFile(config, "utf-8"));
    expect(after.mcpServers).not.toHaveProperty("tandem");
    expect(after.mcpServers).not.toHaveProperty("tandem-channel");
    expect(after.mcpServers.context7).toEqual(FULL_CONFIG.mcpServers.context7);
    expect(after.someTopLevel).toBe("untouched");
    // Per-project mcpServers are Claude Code's own — never Tandem-written,
    // never scrubbed.
    expect(after.projects["/some/proj"].mcpServers).toHaveProperty("tandem");
  });

  it("missing file → status missing, and the file is NOT created", async () => {
    const config = join(dir, "absent.json");
    expect(await removeConfigEntries(config, ["tandem"])).toEqual({ status: "missing" });
    await expect(stat(config)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("no tandem keys → no-op, file bytes untouched", async () => {
    const config = join(dir, ".claude.json");
    const original = JSON.stringify({ mcpServers: { context7: {} } });
    await writeFile(config, original, "utf-8");

    expect(await removeConfigEntries(config, ["tandem", "tandem-channel"])).toEqual({
      status: "no-op",
    });
    expect(await readFile(config, "utf-8")).toBe(original);
  });

  it("missing mcpServers map → no-op", async () => {
    const config = join(dir, ".claude.json");
    await writeFile(config, JSON.stringify({ other: 1 }), "utf-8");
    expect(await removeConfigEntries(config, ["tandem"])).toEqual({ status: "no-op" });
  });

  it("malformed JSON → skipped, file untouched (never the applyConfig replace-with-fresh path)", async () => {
    const config = join(dir, ".claude.json");
    const original = '{"mcpServers": {"tandem": broken';
    await writeFile(config, original, "utf-8");

    expect(await removeConfigEntries(config, ["tandem"])).toEqual({
      status: "skipped",
      reason: "malformed-json",
    });
    expect(await readFile(config, "utf-8")).toBe(original);
  });

  it("non-object root → skipped, file untouched", async () => {
    const config = join(dir, ".claude.json");
    await writeFile(config, JSON.stringify(["array"]), "utf-8");
    expect(await removeConfigEntries(config, ["tandem"])).toEqual({
      status: "skipped",
      reason: "not-an-object",
    });
  });

  it("strips a UTF-8 BOM before parsing", async () => {
    const config = join(dir, ".claude.json");
    await writeFile(config, `﻿${JSON.stringify({ mcpServers: { tandem: {} } })}`, "utf-8");
    const result = await removeConfigEntries(config, ["tandem"]);
    expect(result.status).toBe("removed");
  });
});

describe("scrubMcpConfigs", () => {
  it("processes every target even when an earlier one fails (per-target isolation)", async () => {
    const good = join(dir, "good.json");
    await writeFile(good, JSON.stringify({ mcpServers: { tandem: {} } }), "utf-8");
    // A directory at the config path makes removeConfigEntries throw (EISDIR).
    const bad = join(dir, "bad.json");
    await mkdir(bad);

    const targets: DetectedTarget[] = [
      { label: "Bad", configPath: bad, kind: "claude-code" },
      { label: "Good", configPath: good, kind: "claude-code" },
    ];
    const logger = makeLogger();
    const failures = await scrubMcpConfigs(logger, () => targets);

    expect(failures).toBe(1);
    expect(logger.error).toHaveBeenCalledOnce();
    const after = JSON.parse(await readFile(good, "utf-8"));
    expect(after.mcpServers).not.toHaveProperty("tandem");
  });

  it("counts a detect() throw as one failure instead of propagating", async () => {
    const logger = makeLogger();
    const failures = await scrubMcpConfigs(logger, () => {
      throw new Error("detect blew up");
    });
    expect(failures).toBe(1);
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

describe("removeSkillDir", () => {
  it("removes the dir when it holds only SKILL.md", async () => {
    const skillDir = join(dir, ".claude", "skills", "tandem");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: tandem\n---\n", "utf-8");

    expect(await removeSkillDir(makeLogger(), dir)).toBe(0);
    await expect(stat(skillDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the dir when it also holds an orphaned atomic-write temp", async () => {
    const skillDir = join(dir, ".claude", "skills", "tandem");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "x", "utf-8");
    await writeFile(join(skillDir, ".tandem-setup-0a1b2c3d-e4f5-6789-abcd-ef0123456789.tmp"), "x");

    expect(await removeSkillDir(makeLogger(), dir)).toBe(0);
    await expect(stat(skillDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves the dir intact when it contains a file Tandem didn't install", async () => {
    const skillDir = join(dir, ".claude", "skills", "tandem");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "x", "utf-8");
    await writeFile(join(skillDir, "my-notes.md"), "user file", "utf-8");

    const logger = makeLogger();
    expect(await removeSkillDir(logger, dir)).toBe(0);
    expect(await readdir(skillDir)).toContain("my-notes.md");
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("leaving"));
  });

  it("leaves the dir intact when it contains a subdirectory", async () => {
    const skillDir = join(dir, ".claude", "skills", "tandem");
    await mkdir(join(skillDir, "nested"), { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "x", "utf-8");

    expect(await removeSkillDir(makeLogger(), dir)).toBe(0);
    expect(await readdir(skillDir)).toContain("nested");
  });

  it("missing dir is a clean no-op", async () => {
    const logger = makeLogger();
    expect(await removeSkillDir(logger, dir)).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
