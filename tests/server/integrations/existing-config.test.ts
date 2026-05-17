import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hasExistingTandemEntry,
  readExistingTandemEntries,
} from "../../../src/server/integrations/existing-config.js";

describe("readExistingTandemEntries", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-existing-"));
  });

  afterEach(async () => {
    if (tmpHome) {
      await fs.promises.rm(tmpHome, { recursive: true, force: true });
    }
  });

  it("returns status: missing when ~/.claude.json does not exist (force-detected target)", async () => {
    const installs = await readExistingTandemEntries({ homeOverride: tmpHome, force: true });
    const cc = installs.find((i) => i.target.kind === "claude-code");
    expect(cc).toBeDefined();
    expect(cc?.status).toBe("missing");
    expect(cc?.tandemEntry).toBeUndefined();
  });

  it("returns status: malformed for invalid JSON", async () => {
    await fs.promises.writeFile(path.join(tmpHome, ".claude.json"), "{ not json", "utf-8");
    const installs = await readExistingTandemEntries({ homeOverride: tmpHome });
    const cc = installs.find((i) => i.target.kind === "claude-code");
    expect(cc?.status).toBe("malformed");
  });

  it("returns status: ok with no entry when mcpServers is absent", async () => {
    await fs.promises.writeFile(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({ otherKey: "value" }),
      "utf-8",
    );
    const installs = await readExistingTandemEntries({ homeOverride: tmpHome });
    const cc = installs.find((i) => i.target.kind === "claude-code");
    expect(cc?.status).toBe("ok");
    expect(cc?.tandemEntry).toBeUndefined();
    expect(cc?.channelEntry).toBeUndefined();
  });

  it("extracts an existing HTTP tandem entry", async () => {
    await fs.promises.writeFile(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          tandem: { type: "http", url: "http://127.0.0.1:3479/mcp" },
        },
      }),
      "utf-8",
    );
    const installs = await readExistingTandemEntries({ homeOverride: tmpHome });
    const cc = installs.find((i) => i.target.kind === "claude-code");
    expect(cc?.status).toBe("ok");
    expect(cc?.tandemEntry).toEqual({ type: "http", url: "http://127.0.0.1:3479/mcp" });
    expect(cc?.channelEntry).toBeUndefined();
  });

  it("extracts both tandem and tandem-channel entries", async () => {
    await fs.promises.writeFile(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          tandem: { type: "http", url: "http://127.0.0.1:3479/mcp" },
          "tandem-channel": {
            command: "node",
            args: ["/path/to/channel.js"],
            env: { TANDEM_URL: "http://127.0.0.1:3479" },
          },
        },
      }),
      "utf-8",
    );
    const installs = await readExistingTandemEntries({ homeOverride: tmpHome });
    const cc = installs.find((i) => i.target.kind === "claude-code");
    expect(cc?.tandemEntry).toBeDefined();
    expect(cc?.channelEntry).toBeDefined();
    expect(cc?.channelEntry?.command).toBe("node");
  });

  it("preserves unrelated mcpServers entries (does not surface them)", async () => {
    await fs.promises.writeFile(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          someOtherServer: { command: "other" },
          tandem: { type: "http", url: "http://127.0.0.1:3479/mcp" },
        },
      }),
      "utf-8",
    );
    const installs = await readExistingTandemEntries({ homeOverride: tmpHome });
    const cc = installs.find((i) => i.target.kind === "claude-code");
    expect(cc?.tandemEntry).toBeDefined();
    expect((cc as { someOtherServer?: unknown }).someOtherServer).toBeUndefined();
  });

  it("returns status: ok with no entry when mcpServers is non-object", async () => {
    await fs.promises.writeFile(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({ mcpServers: "not-an-object" }),
      "utf-8",
    );
    const installs = await readExistingTandemEntries({ homeOverride: tmpHome });
    const cc = installs.find((i) => i.target.kind === "claude-code");
    expect(cc?.status).toBe("ok");
    expect(cc?.tandemEntry).toBeUndefined();
  });

  it("returns no targets when no Claude install is detected (no .claude dir, no force)", async () => {
    const installs = await readExistingTandemEntries({ homeOverride: tmpHome });
    // No ~/.claude.json, no ~/.claude/, not forced — should be empty.
    expect(installs).toEqual([]);
  });

  it("extracts a tandem-channel entry even when no tandem entry is present", async () => {
    await fs.promises.writeFile(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "tandem-channel": {
            command: "node",
            args: ["/path/to/channel.js"],
          },
        },
      }),
      "utf-8",
    );
    const installs = await readExistingTandemEntries({ homeOverride: tmpHome });
    const cc = installs.find((i) => i.target.kind === "claude-code");
    expect(cc?.status).toBe("ok");
    expect(cc?.tandemEntry).toBeUndefined();
    expect(cc?.channelEntry).toBeDefined();
    expect(cc?.channelEntry?.command).toBe("node");
  });

  it("returns status: error with message on a non-ENOENT read failure (EACCES)", async () => {
    // Make ~/.claude.json unreadable. On Linux/macOS, chmod 000 denies even the
    // owner. Skipped on Windows where chmod is a no-op and on root (uid 0,
    // which our CI may run as) where the mode bit doesn't restrict.
    if (process.platform === "win32") return;
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const configPath = path.join(tmpHome, ".claude.json");
    await fs.promises.writeFile(configPath, "{}", "utf-8");
    await fs.promises.chmod(configPath, 0o000);
    try {
      const installs = await readExistingTandemEntries({ homeOverride: tmpHome });
      const cc = installs.find((i) => i.target.kind === "claude-code");
      expect(cc?.status).toBe("error");
      expect(cc?.errorMessage).toBeDefined();
      expect(cc?.errorMessage?.length).toBeGreaterThan(0);
    } finally {
      // Restore so rm -rf can clean up.
      await fs.promises.chmod(configPath, 0o600);
    }
  });
});

describe("hasExistingTandemEntry", () => {
  it("returns true when any install has a tandem entry", () => {
    const installs = [
      {
        target: {
          label: "Claude Code",
          configPath: "/path",
          kind: "claude-code" as const,
        },
        status: "ok" as const,
        tandemEntry: { type: "http" as const, url: "http://127.0.0.1:3479/mcp" },
      },
    ];
    expect(hasExistingTandemEntry(installs)).toBe(true);
  });

  it("returns false when no install has a tandem entry", () => {
    const installs = [
      {
        target: {
          label: "Claude Code",
          configPath: "/path",
          kind: "claude-code" as const,
        },
        status: "missing" as const,
      },
    ];
    expect(hasExistingTandemEntry(installs)).toBe(false);
  });

  it("returns false on an empty list", () => {
    expect(hasExistingTandemEntry([])).toBe(false);
  });
});
