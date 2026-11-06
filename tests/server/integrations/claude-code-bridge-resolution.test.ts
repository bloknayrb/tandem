import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2358 PR 2b — which Node Claude Code's bridge entry names, in production
 * (no `_setClaudeCodeBridgeForTests`): a system Node first, else the running
 * Node only where it is durable. The PATH walk and the running Node are mocked;
 * everything else is the real code.
 */

const mocks = vi.hoisted(() => ({
  systemNode: null as string | null,
  execPath: "/usr/local/bin/node",
  sidecar: false,
  /** Treat the temp-dir fixtures as non-scratch, so a case can isolate another rule. */
  fixturesAreNotScratch: false,
}));

vi.mock("../../../src/server/integrations/node-binary.js", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../../src/server/integrations/node-binary.js")>();
  return {
    ...real,
    findSystemNode: () => mocks.systemNode,
    resolveNodeBinary: () => mocks.execPath,
    isScratchPath: (p: string, d?: Parameters<typeof real.isScratchPath>[1]) =>
      mocks.fixturesAreNotScratch && p.startsWith(tmpdir()) ? false : real.isScratchPath(p, d),
  };
});
vi.mock("../../../src/server/platform.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../src/server/platform.js")>();
  return { ...real, isTauriSidecar: () => mocks.sidecar };
});

const { durableRunningNode, resolveClaudeCodeNode, claudeCodeBridgeVerdict } = await import(
  "../../../src/server/integrations/apply.js"
);

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tandem-cc-resolve-"));
  mocks.systemNode = null;
  mocks.sidecar = false;
  mocks.fixturesAreNotScratch = false;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("resolveClaudeCodeNode", () => {
  it("prefers a qualifying system Node over the running one", () => {
    mocks.systemNode = "/usr/bin/node";
    expect(resolveClaudeCodeNode()).toBe("/usr/bin/node");
  });
});

describe("durableRunningNode", () => {
  it.each([
    ["an AppImage mount", "/tmp/.mount_TandemAb12/usr/bin/node-sidecar-x86_64-unknown-linux-gnu"],
    [
      "a translocated app",
      "/private/var/folders/x/AppTranslocation/U/d/Tandem.app/Contents/MacOS/node-sidecar-aarch64-apple-darwin",
    ],
  ])("refuses %s", (_label, exec) => {
    mocks.sidecar = true;
    mocks.execPath = exec;
    expect(durableRunningNode({})).toBeNull();
  });

  it("refuses the desktop sidecar's Node inside a checkout, accepts it in an install", () => {
    mocks.sidecar = true;
    const repo = join(root, "repo");
    mkdirSync(join(repo, "src-tauri", "target", "debug"), { recursive: true });
    writeFileSync(join(repo, ".git"), "gitdir: x\n");
    mocks.execPath = join(
      repo,
      "src-tauri",
      "target",
      "debug",
      "node-sidecar-x86_64-unknown-linux-gnu",
    );
    expect(durableRunningNode({})).toBeNull();

    // An install has no `.git` above it. (The fixture sits under `os.tmpdir()`,
    // which the scratch rule refuses on its own; that rule has its own case.)
    mocks.fixturesAreNotScratch = true;
    const install = join(root, "opt", "tandem");
    mkdirSync(install, { recursive: true });
    mocks.execPath = join(install, "node-sidecar-x86_64-unknown-linux-gnu");
    expect(durableRunningNode({})).toBe(mocks.execPath);
  });

  it("refuses the desktop sidecar's Node on a mounted volume or under a scratch root", () => {
    mocks.sidecar = true;
    mocks.execPath = "/Volumes/Tandem/Tandem.app/Contents/MacOS/node-sidecar-aarch64-apple-darwin";
    expect(durableRunningNode({})).toBeNull();
    mocks.execPath = join(root, "extracted", "node-sidecar-x86_64-unknown-linux-gnu");
    expect(durableRunningNode({})).toBeNull();
  });

  it("refuses an npm-run Node under a scratch root", () => {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "node"), "");
    mocks.execPath = join(bin, "node");
    expect(durableRunningNode({})).toBeNull(); // the fixture lives under os.tmpdir()
  });
});

describe("claudeCodeBridgeVerdict", () => {
  it("answers not-installed from a checkout, without probing for a Node", async () => {
    mocks.systemNode = "/usr/bin/node";
    expect(await claudeCodeBridgeVerdict()).toBe("not-installed");
  });
});
