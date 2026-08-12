import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  refreshAllMcpEntryBinaries,
  refreshMcpEntryBinary,
} from "../../../src/server/integrations/apply.js";

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
describe("refreshMcpEntryBinary", () => {
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
    return refreshMcpEntryBinary(configPath, {
      probe: () => false,
      resolveBinary: () => GOOD,
      // Explicit and non-existent so this case does not depend on whether
      // `dist/channel/index.js` happens to be built in the checkout: with no
      // replacement script available, `args` must be left exactly as found.
      script: join(dir, "no-such-channel.js"),
    }).then((result) => {
      expect(result).toEqual({
        status: "rewritten",
        from: "/gone/v20/bin/node",
        to: GOOD,
        scriptRefreshed: false,
      });
      expect(read().mcpServers["tandem-channel"].command).toBe(GOOD);
      // Untouched siblings of the repaired key.
      expect(read().mcpServers["tandem-channel"].args).toEqual(["/x/channel.js"]);
    });
  });

  it("leaves a path that still exists alone", async () => {
    write({ mcpServers: { "tandem-channel": { command: GOOD } } });
    const result = await refreshMcpEntryBinary(configPath, {
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
    const result = await refreshMcpEntryBinary(configPath, {
      probe: () => false,
      resolveBinary: () => GOOD,
    });
    expect(result).toEqual({ status: "no-op" });
    expect(read().mcpServers["tandem-channel"].command).toBe("node");
  });

  it("does not create a config that is not there", async () => {
    const result = await refreshMcpEntryBinary(configPath, { probe: () => false });
    expect(result).toEqual({ status: "missing" });
    expect(existsSync(configPath)).toBe(false);
  });

  it("refuses to touch malformed JSON, and leaks no parse detail", async () => {
    // V8 SyntaxError messages embed source snippets, and this file holds
    // bearer tokens — the reason must stay a fixed string.
    const original = '{ "mcpServers": { "tandem-channel": { "command": "/gone/node" } ';
    writeFileSync(configPath, original);
    const result = await refreshMcpEntryBinary(configPath, { probe: () => false });
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
    const result = await refreshMcpEntryBinary(configPath, {
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
    const result = await refreshMcpEntryBinary(configPath, { probe: () => false });
    expect(result).toEqual({ status: "no-op" });
  });

  it("leaves the config alone when the binary could not be probed", async () => {
    // `null` = EACCES / ELOOP / unreachable network share. Never rewrite a
    // user's config on the strength of a probe that could not run — the
    // polarity here is the opposite of `detect-claude-cli`'s `isFile`, where
    // "could not tell" safely collapses to `false`.
    write({ mcpServers: { "tandem-channel": { command: "/unreadable/bin/node" } } });
    const result = await refreshMcpEntryBinary(configPath, {
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
    const result = await refreshMcpEntryBinary(configPath, {
      probe: () => false,
      resolveBinary: () => GOOD,
    });
    expect(result.status).toBe("rewritten");
  });

  it("refuses to downgrade a dead absolute path to the bare name", async () => {
    // Rewriting to `node` would not be a repair — that is the value documented
    // as failing in the field — and it would BLIND the diagnostic, because bare
    // names are exempt from the staleness check. Leaving the dead path visible
    // is strictly better.
    write({ mcpServers: { "tandem-channel": { command: "/gone/node" } } });
    const result = await refreshMcpEntryBinary(configPath, {
      probe: () => false,
      resolveBinary: () => "node",
    });
    expect(result).toEqual({ status: "skipped", reason: "no-valid-replacement" });
    expect(read().mcpServers["tandem-channel"].command).toBe("/gone/node");
  });

  it("refreshes the channel script path alongside the binary", async () => {
    // `args[0]` is derived from the same PACKAGE_ROOT as the binary, so App
    // Translocation / an AppImage remount / a Tauri update invalidate both at
    // once. Repairing only `command` yields a working Node that dies on
    // `Cannot find module` — and doctor, which inspects `command` alone, would
    // call that healthy.
    write({
      mcpServers: {
        "tandem-channel": { command: "/gone/node", args: ["/gone/dist/channel/index.js"] },
      },
    });
    const result = await refreshMcpEntryBinary(configPath, {
      probe: () => false,
      resolveBinary: () => GOOD,
      script: configPath, // any path that exists
    });
    expect(result).toEqual({
      status: "rewritten",
      from: "/gone/node",
      to: GOOD,
      scriptRefreshed: true,
    });
    expect(read().mcpServers["tandem-channel"].args).toEqual([configPath]);
  });

  it("repairs a stale script path even when the Node binary is fine", async () => {
    // This was unreachable: the script block sat behind an early return on a
    // healthy `command`, justified by a docblock claiming the two go stale in
    // lockstep. They don't — `command` is `process.execPath`, `args[0]` derives
    // from `PACKAGE_ROOT`. A global npm reinstall to a new prefix, or a `dist/`
    // rebuilt under a relocated root, moves the script and leaves Node exactly
    // where it was. The entry then spawns a working Node that dies on `Cannot
    // find module`, and doctor — which inspects `command` alone — calls it
    // healthy.
    write({
      mcpServers: {
        "tandem-channel": { command: GOOD, args: ["/gone/dist/channel/index.js"] },
      },
    });
    const result = await refreshMcpEntryBinary(configPath, {
      probe: (p) => p !== "/gone/dist/channel/index.js",
      resolveBinary: () => GOOD,
      script: configPath,
    });
    // `from`/`to` are null: nothing about the BINARY changed, and reporting the
    // unchanged command as a rewrite would misname what was repaired.
    expect(result).toEqual({
      status: "rewritten",
      from: null,
      to: null,
      scriptRefreshed: true,
    });
    expect(read().mcpServers["tandem-channel"].args).toEqual([configPath]);
    expect(read().mcpServers["tandem-channel"].command).toBe(GOOD);
  });

  it("leaves a script path that still resolves alone", async () => {
    write({
      mcpServers: {
        "tandem-channel": { command: "/gone/node", args: ["/live/dist/channel/index.js"] },
      },
    });
    const result = await refreshMcpEntryBinary(configPath, {
      // Binary gone, script present.
      probe: (p) => (p === "/gone/node" ? false : true),
      resolveBinary: () => GOOD,
      script: configPath,
    });
    expect(result).toMatchObject({ status: "rewritten", scriptRefreshed: false });
    expect(read().mcpServers["tandem-channel"].args).toEqual(["/live/dist/channel/index.js"]);
  });

  it("no-ops rather than rewriting to the same value", async () => {
    write({ mcpServers: { "tandem-channel": { command: GOOD } } });
    const result = await refreshMcpEntryBinary(configPath, {
      probe: () => false,
      resolveBinary: () => GOOD,
    });
    expect(result).toEqual({ status: "no-op" });
  });
});

/**
 * The boot sweep.
 *
 * It is fired un-awaited from `server/index.ts`, where an escaping rejection
 * reaches the `unhandledRejection` handler and `process.exit(1)`s the server.
 * A best-effort config repair must never be able to do that, so "never
 * rejects" is a behavioural requirement, not a style preference.
 */
describe("refreshAllMcpEntryBinaries", () => {
  let home: string;
  let errSpy: ReturnType<typeof vi.spyOn>;
  const stderr = () => errSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tandem-sweep-home-"));
    // `detectTargets` includes Claude Code when either the config or ~/.claude
    // exists; create the dir so the target is always detected.
    mkdirSync(join(home, ".claude"), { recursive: true });
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    rmSync(home, { recursive: true, force: true });
  });

  it("resolves (never rejects) when a config is malformed, and says so", async () => {
    // Silence here would be the wrong call: if `~/.claude.json` does not parse,
    // EVERY MCP server the user has is broken and Tandem is the only process
    // that just found out.
    writeFileSync(join(home, ".claude.json"), "{ not json");

    await expect(refreshAllMcpEntryBinaries({ homeOverride: home })).resolves.toBeUndefined();

    const out = stderr();
    expect(out).toContain("malformed-json");
    expect(out).toContain("Claude Code"); // the target is named
  });

  it("resolves when there is no config at all", async () => {
    await expect(refreshAllMcpEntryBinaries({ homeOverride: home })).resolves.toBeUndefined();
    expect(stderr()).not.toContain("malformed-json");
  });

  it("repairs a stale entry and names the target it repaired", async () => {
    const configPath = join(home, ".claude.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: { "tandem-channel": { command: join(home, "gone", "node") } },
      }),
    );

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    const after = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(after.mcpServers["tandem-channel"].command).toBe(process.execPath);
    const out = stderr();
    // The sweep now visits both refreshable keys, so the message names which
    // one it repaired rather than saying "channel" unconditionally.
    expect(out).toContain("Repaired stale tandem-channel entry");
    expect(out).toContain("Claude Code");
  });

  it("stays silent when there is nothing to repair", async () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { "tandem-channel": { command: process.execPath } } }),
    );

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    expect(stderr()).not.toContain("Repaired");
  });
});

/**
 * The `tandem` key joined the sweep when its stdio entry started carrying an
 * absolute Node path, and it is far less forgiving than `tandem-channel`.
 *
 * `tandem-channel` has only ever been written by Tandem, so any stale absolute
 * path in it is ours to repair. `tandem` is shared ground: the same key holds
 * HTTP entries for Claude Code, npx fallbacks, legacy sidecar invocations from
 * older Tauri builds, and hand-edits — and the legacy shape is
 * ARITY-IDENTICAL to the one we emit. Every test below pins a shape the sweep
 * must refuse to touch; each one is a config-clobbering bug if it regresses.
 */
describe("refreshMcpEntryBinary — the `tandem` key", () => {
  let dir: string;
  let configPath: string;

  const BRIDGE_TAIL = join("dist", "stdio-bridge", "index.js");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tandem-entry-refresh-"));
    configPath = join(dir, ".claude.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (tandem: unknown): void => {
    writeFileSync(configPath, JSON.stringify({ mcpServers: { tandem } }, null, 2));
  };
  const read = (): Record<string, unknown> =>
    JSON.parse(readFileSync(configPath, "utf-8")).mcpServers.tandem;

  it("repairs a stale Node path when the entry is ours", async () => {
    const bridge = join(dir, "live", BRIDGE_TAIL);
    mkdirSync(join(bridge, ".."), { recursive: true });
    writeFileSync(bridge, "// stub\n");
    write({ command: join(dir, "gone", "node"), args: [bridge], env: {} });

    const result = await refreshMcpEntryBinary(configPath, {
      entryKey: "tandem",
      script: bridge,
    });

    expect(result.status).toBe("rewritten");
    expect(read().command).toBe(process.execPath);
    // The subcommand-free single arg survives: two args would leave
    // `validateTandemEntry`'s Node branch and read back as `invalid-args`.
    expect(read().args).toEqual([bridge]);
  });

  it("leaves an HTTP entry alone (Claude Code has no command to repair)", async () => {
    const entry = { type: "http", url: "http://127.0.0.1:3479/mcp" };
    write(entry);

    const result = await refreshMcpEntryBinary(configPath, { entryKey: "tandem" });

    expect(result.status).toBe("no-op");
    expect(read()).toEqual(entry);
  });

  it("leaves a deliberate bare-npx fallback alone", async () => {
    // Rewriting this would undo a choice `buildStdioTandemEntry` made on
    // purpose on a host where no absolute pair could be built.
    const entry = { command: "npx", args: ["-y", "tandem-editor@0.21.0", "mcp-stdio"], env: {} };
    write(entry);

    const result = await refreshMcpEntryBinary(configPath, { entryKey: "tandem" });

    expect(result.status).toBe("no-op");
    expect(read()).toEqual(entry);
  });

  it("leaves an absolute-npx fallback alone rather than substituting the bridge", async () => {
    // An absolute npx IS probed (it is a real path), but its command is not
    // Node-shaped and its args are the npx tuple — swapping in a Node binary
    // would leave `<node> -y tandem-editor@x mcp-stdio`, which spawns nothing.
    const entry = {
      command: join(dir, "gone", "npx"),
      args: ["-y", "tandem-editor@0.21.0", "mcp-stdio"],
      env: {},
    };
    write(entry);

    const result = await refreshMcpEntryBinary(configPath, { entryKey: "tandem" });

    expect(result.status).toBe("no-op");
    expect(read()).toEqual(entry);
  });

  it("leaves a legacy 1-arg sidecar entry alone even though its path is gone", async () => {
    // Arity-identical to ours, so only the script identity separates them. This
    // is the case that made the ownership gate necessary.
    const entry = { command: join(dir, "gone", "node"), args: [join(dir, "gone", "server.js")] };
    write(entry);

    const result = await refreshMcpEntryBinary(configPath, { entryKey: "tandem" });

    expect(result.status).toBe("no-op");
    expect(read()).toEqual(entry);
  });

  it("leaves a hand-edited entry alone", async () => {
    const entry = {
      command: join(dir, "gone", "node"),
      args: [join(dir, "my-own", "bridge.js")],
      env: { TANDEM_URL: "http://127.0.0.1:3479" },
    };
    write(entry);

    const result = await refreshMcpEntryBinary(configPath, { entryKey: "tandem" });

    expect(result.status).toBe("no-op");
    expect(read()).toEqual(entry);
  });

  it("refuses to repair into a bare name, leaving the dead path visible", async () => {
    const bridge = join(dir, "live", BRIDGE_TAIL);
    mkdirSync(join(bridge, ".."), { recursive: true });
    writeFileSync(bridge, "// stub\n");
    const dead = join(dir, "gone", "node");
    write({ command: dead, args: [bridge] });

    const result = await refreshMcpEntryBinary(configPath, {
      entryKey: "tandem",
      script: bridge,
      resolveBinary: () => "node", // BARE_NODE
    });

    // `isRecordedPathGone` exempts bare names, so writing one here would make
    // every later diagnostic go quiet about an entry that is still broken.
    expect(result).toEqual({ status: "skipped", reason: "no-valid-replacement" });
    expect(read().command).toBe(dead);
  });

  it("refreshes a moved bridge path while the Node binary stays put", async () => {
    const oldBridge = join(dir, "old-install", BRIDGE_TAIL);
    const newBridge = join(dir, "new-install", BRIDGE_TAIL);
    mkdirSync(join(newBridge, ".."), { recursive: true });
    writeFileSync(newBridge, "// stub\n");
    write({ command: process.execPath, args: [oldBridge] });

    const result = await refreshMcpEntryBinary(configPath, {
      entryKey: "tandem",
      script: newBridge,
    });

    expect(result.status).toBe("rewritten");
    expect(read().args).toEqual([newBridge]);
    expect(read().command).toBe(process.execPath);
  });
});
