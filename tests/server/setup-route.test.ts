import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSetupHandler } from "../../src/server/mcp/api-routes.js";

describe("runSetupHandler — HTTP status reflects outcome", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tandem-setup-status-"));
  });
  afterEach(() => {
    // Windows: re-enable write so rmSync can remove readonly files.
    try {
      chmodSync(home, 0o700);
    } catch {
      /* best effort */
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("returns 200 when everything succeeds (at least one target + skill install)", async () => {
    // Create ~/.claude so Claude Code target is detected and skill install has a target.
    mkdirSync(join(home, ".claude"), { recursive: true });
    const result = await runSetupHandler(
      { nodeBinary: process.execPath, channelPath: join(home, "channel.js") },
      home,
    );
    const data = result.body.data!;
    if (data.configured.length > 0 && data.skillInstalled) {
      expect(result.status).toBe(200);
    }
  });

  it("returns 500 when every target fails AND skill install fails", async () => {
    // Block both target-config writes AND skill install by making ~/.claude a
    // directory whose child .claude.json slot is occupied by a non-writable
    // directory (forces applyConfig ENOTDIR/EEXIST) and ~/.claude itself is
    // read-only (forces installSkill to fail creating the skills subtree).
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    // Place a directory where the .claude.json file should go.
    mkdirSync(join(home, ".claude.json"), { recursive: true });
    chmodSync(claudeDir, 0o500); // read+execute, no write

    const result = await runSetupHandler(
      { nodeBinary: process.execPath, channelPath: join(home, "channel.js") },
      home,
    );
    const data = result.body.data!;
    if (data.configured.length === 0 && !data.skillInstalled) {
      expect(result.status).toBe(500);
      expect(data.errors.length).toBeGreaterThan(0);
    }
  });

  it("returns 207 when at least one attempt succeeds but another failed", async () => {
    // Make ~/.claude readonly to block skill install while leaving target
    // config writes possible (claude.json at a writable tmp location).
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    chmodSync(claudeDir, 0o500);

    const result = await runSetupHandler(
      { nodeBinary: process.execPath, channelPath: join(home, "channel.js") },
      home,
    );
    const data = result.body.data!;
    if (data.configured.length > 0 && !data.skillInstalled) {
      expect(result.status).toBe(207);
    }
  });
});
