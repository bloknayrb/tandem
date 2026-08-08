import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHANNEL_SHIM_PRUNE_MARKER,
  pruneLegacyChannelShimEntry,
} from "../../../src/server/integrations/prune-channel-shim.js";

/**
 * Track E's migration. The behaviour worth guarding is almost entirely about
 * what it must NOT do to a file Tandem does not own.
 */

let home: string;
let appData: string;

function configPath(): string {
  return join(home, ".claude.json");
}

function writeConfig(value: unknown): void {
  writeFileSync(configPath(), JSON.stringify(value, null, 2), "utf-8");
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(), "utf-8"));
}

function markerExists(): boolean {
  try {
    readFileSync(join(appData, CHANNEL_SHIM_PRUNE_MARKER), "utf-8");
    return true;
  } catch {
    return false;
  }
}

async function prune() {
  return pruneLegacyChannelShimEntry({ homeOverride: home, appDataDir: appData });
}

const SHIM_ENTRY = {
  command: "/usr/local/bin/node",
  args: ["/opt/tandem/dist/channel/index.js"],
  env: { TANDEM_URL: "http://127.0.0.1:3479" },
};

const HTTP_ENTRY = {
  type: "http" as const,
  url: "http://127.0.0.1:3479/mcp",
  headers: { Authorization: "Bearer the-users-real-token" },
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tandem-prune-home-"));
  appData = mkdtempSync(join(tmpdir(), "tandem-prune-data-"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(appData, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("pruneLegacyChannelShimEntry", () => {
  it("removes the legacy entry and records that it did", async () => {
    writeConfig({ mcpServers: { tandem: HTTP_ENTRY, "tandem-channel": SHIM_ENTRY } });

    expect(await prune()).toBe("pruned");
    expect(readConfig().mcpServers).toEqual({ tandem: HTTP_ENTRY });
    expect(markerExists()).toBe(true);
  });

  it("never touches the HTTP entry that carries the user's token", async () => {
    // The single worst outcome available to this code: a boot-time mutation
    // that drops the bearer token and silently disconnects the user's AI.
    writeConfig({ mcpServers: { tandem: HTTP_ENTRY, "tandem-channel": SHIM_ENTRY } });
    await prune();
    expect(readConfig().mcpServers).toHaveProperty("tandem", HTTP_ENTRY);
  });

  it("leaves other vendors' entries alone", async () => {
    const other = { command: "npx", args: ["-y", "@someone/else"] };
    writeConfig({ mcpServers: { "some-other-mcp": other, "tandem-channel": SHIM_ENTRY } });
    await prune();
    expect(readConfig().mcpServers).toEqual({ "some-other-mcp": other });
  });

  describe("runs exactly once", () => {
    it("is a no-op on the second boot", async () => {
      writeConfig({ mcpServers: { "tandem-channel": SHIM_ENTRY } });
      expect(await prune()).toBe("pruned");
      expect(await prune()).toBe("already-done");
    });

    it("does NOT undo a deliberate re-opt-in", async () => {
      // The whole reason this is marker-gated rather than a boot policy. An
      // entry written by `--with-channel-shim` is byte-identical to one written
      // by the old default — they came from the same code — so a prune that ran
      // every boot would delete the user's explicit choice, every boot, forever.
      writeConfig({ mcpServers: { "tandem-channel": SHIM_ENTRY } });
      await prune();
      expect(readConfig().mcpServers).toEqual({});

      writeConfig({ mcpServers: { "tandem-channel": SHIM_ENTRY } }); // user opts back in
      expect(await prune()).toBe("already-done");
      expect(readConfig().mcpServers).toEqual({ "tandem-channel": SHIM_ENTRY });
    });

    it("still records the decision when there was nothing to remove", async () => {
      // "We already asked this question" is the fact being stored, not "we
      // removed something" — otherwise a fresh install re-reads the config on
      // every boot forever, and the first time the user opts in, the NEXT boot
      // prunes it.
      writeConfig({ mcpServers: { tandem: HTTP_ENTRY } });
      expect(await prune()).toBe("nothing-to-prune");
      expect(markerExists()).toBe(true);

      writeConfig({ mcpServers: { tandem: HTTP_ENTRY, "tandem-channel": SHIM_ENTRY } });
      expect(await prune()).toBe("already-done");
      expect(readConfig().mcpServers).toHaveProperty("tandem-channel");
    });
  });

  describe("refusals burn no attempt", () => {
    it("retries on a later boot when the config does not exist yet", async () => {
      // A first run before Claude Code has ever written its config. Marking
      // this install done would leave the entry forever if setup ran later.
      expect(await prune()).toBe("failed");
      expect(markerExists()).toBe(false);

      writeConfig({ mcpServers: { "tandem-channel": SHIM_ENTRY } });
      expect(await prune()).toBe("pruned");
    });

    it("retries on a later boot when the config is malformed", async () => {
      writeFileSync(configPath(), "{ this is not json", "utf-8");
      expect(await prune()).toBe("failed");
      expect(markerExists()).toBe(false);
      // …and it did not "repair" the file by rewriting it.
      expect(readFileSync(configPath(), "utf-8")).toBe("{ this is not json");
    });
  });

  it("creates the app-data dir if it is not there yet", async () => {
    rmSync(appData, { recursive: true, force: true });
    writeConfig({ mcpServers: { "tandem-channel": SHIM_ENTRY } });
    expect(await prune()).toBe("pruned");
    expect(markerExists()).toBe(true);
  });

  it("does not rewrite the config when the key is absent", async () => {
    // No churn on a file other vendors' tokens live in — the mtime and bytes
    // must both be untouched when there is nothing to do.
    mkdirSync(appData, { recursive: true });
    const raw = '{\n  "mcpServers": {},\n  "somethingElse": true\n}';
    writeFileSync(configPath(), raw, "utf-8");
    await prune();
    expect(readFileSync(configPath(), "utf-8")).toBe(raw);
  });
});
