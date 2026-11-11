/**
 * #2358 PR 2b, review of e905578 (M2): the boot sweep's config rename, after a
 * prepared temp, retries Windows' transient refusals, and every retry re-runs
 * the pre-rename re-check first. A refusal can mean Claude Code has its config
 * open to write it; without the re-check, the retry would replace that write
 * with content built from the older read (review of 8c8d211, H1).
 *
 * Behavioural, end to end through `refreshAllMcpEntryBinaries`: the retry runs
 * only on win32, so `process.platform` reads "win32" for the sweep, and
 * `node:fs/promises`' `rename` refuses the config rename once (`setRestrictiveAcl`
 * is mocked for every test file since #2390, so no icacls runs). The backup's
 * own rename goes through `node:fs`'s `promises` and is not affected.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refusal = vi.hoisted(() => ({
  /** Refuse the next rename onto a file with this name, once. */
  armedFor: undefined as string | undefined,
  /** Runs while the rename is being refused: the competing writer. */
  during: undefined as (() => void) | undefined,
  refused: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const rename: typeof actual.rename = async (from, to) => {
    if (refusal.armedFor !== undefined && basename(String(to)) === refusal.armedFor) {
      refusal.armedFor = undefined;
      refusal.refused++;
      refusal.during?.();
      throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
    }
    return actual.rename(from, to);
  };
  return { ...actual, rename, default: { ...actual, rename } };
});

import {
  _setClaudeCodeBridgeForTests,
  refreshAllMcpEntryBinaries,
} from "../../../src/server/integrations/apply.js";

const MCP = "http://127.0.0.1:3479";

let home: string;
let node: string;
let script: string;
let errSpy: ReturnType<typeof vi.spyOn>;
const stderr = () => errSpy.mock.calls.map((c: unknown[]) => c.map(String).join(" ")).join("\n");
const claudeJson = () => join(home, ".claude.json");
const writeConfig = (root: unknown) =>
  writeFileSync(claudeJson(), `${JSON.stringify(root, null, 2)}\n`);
const readConfig = () => JSON.parse(readFileSync(claudeJson(), "utf-8"));

/** Run the sweep with `process.platform` reading "win32", restored after. */
async function sweepAsWindows(): Promise<void> {
  const real = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    await refreshAllMcpEntryBinaries({ homeOverride: home });
  } finally {
    Object.defineProperty(process, "platform", { value: real });
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tandem-rename-retry-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  node = join(home, "opt", "node");
  script = join(home, "install", "dist", "stdio-bridge", "index.js");
  mkdirSync(join(node, ".."), { recursive: true });
  mkdirSync(join(script, ".."), { recursive: true });
  writeFileSync(node, "#!/bin/sh\n");
  writeFileSync(script, "// bridge\n");
  _setClaudeCodeBridgeForTests({ command: node, script });
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  refusal.armedFor = undefined;
  refusal.during = undefined;
  refusal.refused = 0;
});

afterEach(() => {
  _setClaudeCodeBridgeForTests(undefined);
  errSpy.mockRestore();
  rmSync(home, { recursive: true, force: true });
});

describe("the config rename's Windows retry (#2358 PR 2b, review M2)", () => {
  it("never replaces a write that landed while the rename was refused (review H1)", async () => {
    writeConfig({ mcpServers: { tandem: { type: "http", url: `${MCP}/mcp` } }, n: 1 });
    refusal.armedFor = ".claude.json";
    refusal.during = () => {
      // Claude Code's write, landing while it held the file and Tandem's
      // rename was refused.
      writeConfig({ mcpServers: { tandem: { type: "http", url: `${MCP}/mcp` } }, n: 999 });
    };

    await sweepAsWindows();

    expect(refusal.refused).toBe(1);
    // The other writer's change survived: the retry's re-check saw it, the try
    // was abandoned, and the switch landed from a fresh read.
    expect(readConfig().n).toBe(999);
    expect(readConfig().mcpServers.tandem.command).toBe(node);
    expect(stderr()).toMatch(/: \d+ ms from reading it to finding it changed\./);
    expect(stderr()).toContain("trying again (2 of 3)");
    expect(stderr()).toMatch(/Removed backup \S+, taken for a write Tandem abandoned\./);
    expect(readdirSync(home).filter((n) => n.startsWith(".tandem-setup-"))).toEqual([]);
  });

  it("retries a refusal with no write behind it and lands on the same try", async () => {
    writeConfig({ mcpServers: { tandem: { type: "http", url: `${MCP}/mcp` } }, n: 1 });
    refusal.armedFor = ".claude.json";

    await sweepAsWindows();

    expect(refusal.refused).toBe(1);
    expect(readConfig().n).toBe(1);
    expect(readConfig().mcpServers.tandem.command).toBe(node);
    expect(stderr()).not.toContain("trying again");
    expect(stderr()).toMatch(/: \d+ ms from reading it to replacing it\./);
  });
});
