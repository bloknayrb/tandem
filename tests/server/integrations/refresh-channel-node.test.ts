import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refreshChannelNodeBinary } from "../../../src/server/integrations/apply.js";

/**
 * Boot-time repair of a stale `tandem-channel` Node path.
 *
 * Writing an absolute Node path fixes a shim the client could not resolve, but
 * it creates a second failure mode: the path can stop existing (deleted nvm
 * version, relocated sidecar, App Translocation, AppImage remount). A dead
 * absolute path can never recover on its own, whereas the bare name it replaced
 * might still have resolved — so without this repair the change would be a
 * trade, not a fix.
 *
 * The non-clobber guarantees matter as much as the repair: this file is
 * `~/.claude.json`, which holds other vendors' entries and bearer tokens.
 */
describe("refreshChannelNodeBinary", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tandem-chan-node-"));
    configPath = join(dir, ".claude.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(body: unknown): void {
    writeFileSync(configPath, JSON.stringify(body, null, 2));
  }
  function read(): Record<string, never> {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  }

  const GOOD = "/opt/node/bin/node";

  it("rewrites a recorded path that no longer exists", () => {
    write({
      mcpServers: {
        "tandem-channel": { command: "/gone/v20/bin/node", args: ["/x/channel.js"] },
      },
    });
    return refreshChannelNodeBinary(configPath, {
      probe: () => false,
      resolveBinary: () => GOOD,
    }).then((result) => {
      expect(result).toEqual({ status: "rewritten", from: "/gone/v20/bin/node", to: GOOD });
      expect(read().mcpServers["tandem-channel"].command).toBe(GOOD);
      // Untouched siblings of the repaired key.
      expect(read().mcpServers["tandem-channel"].args).toEqual(["/x/channel.js"]);
    });
  });

  it("leaves a path that still exists alone", async () => {
    write({ mcpServers: { "tandem-channel": { command: GOOD } } });
    const result = await refreshChannelNodeBinary(configPath, {
      probe: () => true,
      resolveBinary: () => "/somewhere/else/node",
    });
    expect(result).toEqual({ status: "no-op" });
    expect(read().mcpServers["tandem-channel"].command).toBe(GOOD);
  });

  it("never rewrites a bare name", async () => {
    // Bare `node` is the deliberate fallback when no absolute path could be
    // produced. Promoting it here would undo that decision behind the user.
    write({ mcpServers: { "tandem-channel": { command: "node" } } });
    const result = await refreshChannelNodeBinary(configPath, {
      probe: () => false,
      resolveBinary: () => GOOD,
    });
    expect(result).toEqual({ status: "no-op" });
    expect(read().mcpServers["tandem-channel"].command).toBe("node");
  });

  it("does not create a config that is not there", async () => {
    const result = await refreshChannelNodeBinary(configPath, { probe: () => false });
    expect(result).toEqual({ status: "missing" });
    expect(existsSync(configPath)).toBe(false);
  });

  it("refuses to touch malformed JSON, and leaks no parse detail", async () => {
    // V8 SyntaxError messages embed source snippets, and this file holds
    // bearer tokens — the reason must stay a fixed string.
    const original = '{ "mcpServers": { "tandem-channel": { "command": "/gone/node" } ';
    writeFileSync(configPath, original);
    const result = await refreshChannelNodeBinary(configPath, { probe: () => false });
    expect(result).toEqual({ status: "skipped", reason: "malformed-json" });
    expect(readFileSync(configPath, "utf-8")).toBe(original);
  });

  it("preserves unrelated servers and top-level keys when it does rewrite", async () => {
    write({
      mcpServers: {
        other: { command: "/usr/bin/other", env: { SECRET: "keep-me" } },
        "tandem-channel": { command: "/gone/node" },
      },
      someOtherVendorKey: { nested: true },
    });
    const result = await refreshChannelNodeBinary(configPath, {
      probe: () => false,
      resolveBinary: () => GOOD,
    });
    expect(result.status).toBe("rewritten");
    const after = read();
    expect(after.mcpServers.other).toEqual({
      command: "/usr/bin/other",
      env: { SECRET: "keep-me" },
    });
    expect(after.someOtherVendorKey).toEqual({ nested: true });
  });

  it("no-ops when there is no channel entry at all", async () => {
    write({ mcpServers: { tandem: { type: "http", url: "http://127.0.0.1:3479/mcp" } } });
    const result = await refreshChannelNodeBinary(configPath, { probe: () => false });
    expect(result).toEqual({ status: "no-op" });
  });

  it("leaves the config alone when the binary could not be probed", async () => {
    // `null` = EACCES / ELOOP / unreachable network share. Never rewrite a
    // user's config on the strength of a probe that could not run — the
    // polarity here is the opposite of `detect-claude-cli`'s `isFile`, where
    // "could not tell" safely collapses to `false`.
    write({ mcpServers: { "tandem-channel": { command: "/unreadable/bin/node" } } });
    const result = await refreshChannelNodeBinary(configPath, {
      probe: () => null,
      resolveBinary: () => GOOD,
    });
    expect(result).toEqual({ status: "no-op" });
    expect(read().mcpServers["tandem-channel"].command).toBe("/unreadable/bin/node");
  });

  it("rewrites when the path is a directory rather than a file", async () => {
    // `existsSync` would say true here; a directory is definitively not a
    // runnable binary, so this must repair.
    write({ mcpServers: { "tandem-channel": { command: "/some/dir" } } });
    const result = await refreshChannelNodeBinary(configPath, {
      probe: () => false,
      resolveBinary: () => GOOD,
    });
    expect(result.status).toBe("rewritten");
  });

  it("no-ops rather than rewriting to the same value", async () => {
    write({ mcpServers: { "tandem-channel": { command: GOOD } } });
    const result = await refreshChannelNodeBinary(configPath, {
      probe: () => false,
      resolveBinary: () => GOOD,
    });
    expect(result).toEqual({ status: "no-op" });
  });
});
