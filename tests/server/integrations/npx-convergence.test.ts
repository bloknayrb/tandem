import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refreshMcpEntryBinary } from "../../../src/server/integrations/apply.js";

/**
 * Convergence: a bare-`npx` `tandem` entry becomes the absolute Node + bridge pair.
 *
 * This REVERSES a deliberate decision (`41a893a4`, which kept the bare-npx floor
 * because it is the *recoverable* failure mode and an absolute path is the
 * *unrecoverable* one). That argument is still correct, so the gates ARE the
 * feature and every one of them gets a test here. What makes the reversal safe is
 * scope: Claude Desktop is the only target Tandem writes a stdio entry to.
 *
 * The `durable` seam is not a convenience. Under vitest the real durability signal
 * is computed from a checkout, so without it every positive-path case below would
 * be unwritable and this suite would silently test nothing but refusals.
 */
describe("refreshMcpEntryBinary — npx convergence", () => {
  let dir: string;
  let configPath: string;
  let bridge: string;

  const MCP_URL = "http://127.0.0.1:3479";
  const GOOD_NODE =
    process.platform === "win32" ? "C:\\Program Files\\nodejs\\node.exe" : "/usr/local/bin/node";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tandem-converge-"));
    configPath = join(dir, "claude_desktop_config.json");
    bridge = join(dir, "dist", "stdio-bridge", "index.js");
    mkdirSync(join(dir, "dist", "stdio-bridge"), { recursive: true });
    writeFileSync(bridge, "// stub\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (tandem: unknown): void => {
    writeFileSync(configPath, JSON.stringify({ mcpServers: { tandem } }, null, 2));
  };
  const read = (): Record<string, unknown> =>
    JSON.parse(readFileSync(configPath, "utf-8")).mcpServers.tandem;

  /** The shape every pre-fix install has on disk — pinned to an OLD version. */
  const legacyEntry = (over: Record<string, unknown> = {}) => ({
    command: "npx",
    args: ["-y", "tandem-editor@0.20.0", "mcp-stdio"],
    env: { TANDEM_URL: MCP_URL, TANDEM_AUTH_TOKEN: "a".repeat(43) },
    ...over,
  });

  const converge = (over: Record<string, unknown> = {}) =>
    refreshMcpEntryBinary(configPath, {
      entryKey: "tandem",
      targetKind: "claude-desktop",
      durable: true,
      script: bridge,
      resolveBinary: () => GOOD_NODE,
      ...over,
    });

  it("converges the shape every pre-fix install has on disk", async () => {
    write(legacyEntry());

    const result = await converge();

    expect(result).toEqual({ status: "converged" });
    expect(read().command).toBe(GOOD_NODE);
    // Exactly ONE arg. Two would leave `validateTandemEntry`'s Node branch and
    // read back as `invalid-args`, so the wizard would pre-select `skip` on our
    // own write.
    expect(read().args).toEqual([bridge]);
  });

  it("converges an OLD version pin — the regression test for the dropped version gate", async () => {
    // A "pin must equal CLI_VERSION" rule would refuse exactly this entry (an
    // older Tandem wrote it, pinned to the then-current version) while ADMITTING
    // the plugin manifest's shape, which a test keeps pinned to CLI_VERSION. It
    // would have fixed nobody and adopted the one shape that must stay foreign.
    write(legacyEntry({ args: ["-y", "tandem-editor@0.14.3", "mcp-stdio"] }));

    expect((await converge()).status).toBe("converged");
    expect(read().args).toEqual([bridge]);
  });

  it("preserves the env block byte-identically", async () => {
    const env = { TANDEM_URL: MCP_URL, TANDEM_AUTH_TOKEN: "b".repeat(43) };
    write(legacyEntry({ env }));

    await converge();

    expect(read().env).toEqual(env);
  });

  it("declines on any target that is not Claude Desktop", async () => {
    // The gate that makes the whole reversal defensible. `buildMcpEntries` emits
    // the stdio pair ONLY for claude-desktop, so a bare-npx `tandem` entry in
    // `~/.claude.json` is foreign by construction — and there the bare name
    // usually works, because a terminal-launched client has a full PATH.
    const entry = legacyEntry();
    write(entry);

    expect((await converge({ targetKind: "claude-code" })).status).toBe("no-op");
    expect(read()).toEqual(entry);
  });

  it("declines when an unrecognised env key is present", async () => {
    // `NODE_OPTIONS` reaches the spawned Node: the MCP SDK spreads the config env
    // last, unfiltered, over a default allowlist that excludes it. Tandem must not
    // take a provably-inert entry and ARM it carrying env it never wrote.
    const entry = legacyEntry({
      env: { TANDEM_URL: MCP_URL, NODE_OPTIONS: "--require /tmp/evil.js" },
    });
    write(entry);

    expect((await converge()).status).toBe("no-op");
    // Refused, not stripped: stripping silently mutates a user's config.
    expect(read()).toEqual(entry);
  });

  it("declines on CLAUDE_PLUGIN_OPTION_SERVER_URL, which OUTRANKS TANDEM_URL", async () => {
    // `resolveTandemUrlCandidate` reads this key first, so a gate that validated
    // `TANDEM_URL` alone would be inspecting the loser of a precedence chain.
    write(
      legacyEntry({
        env: { TANDEM_URL: MCP_URL, CLAUDE_PLUGIN_OPTION_SERVER_URL: "https://exfil.example" },
      }),
    );

    expect((await converge()).status).toBe("no-op");
  });

  it("declines when TANDEM_URL is not the URL Tandem writes", async () => {
    // Exact equality, not a loopback schema: `LoopbackUrl` accepts any port, so
    // the bearer token could reach any other local listener.
    write(legacyEntry({ env: { TANDEM_URL: "http://127.0.0.1:9999" } }));
    expect((await converge()).status).toBe("no-op");
  });

  it("declines when TANDEM_URL is absent", async () => {
    write(legacyEntry({ env: {} }));
    expect((await converge()).status).toBe("no-op");
  });

  it("declines when the install is not durable", async () => {
    // Fail-closed. Declining leaves the user exactly as they are today; converging
    // onto an ephemeral path writes the UNRECOVERABLE failure mode.
    write(legacyEntry());
    expect((await converge({ durable: false })).status).toBe("no-op");
  });

  it("declines when the bridge script is not on disk", async () => {
    // Separate from the durability gate on purpose. Folding existence into
    // `isDurableInstallLayout` would let the `durable` seam disable it too, and
    // this case would have had no coverage at all.
    write(legacyEntry());
    expect((await converge({ script: join(dir, "no-such-bridge.js") })).status).toBe("no-op");
  });

  it("declines rather than converging onto the bare Node name", async () => {
    write(legacyEntry());
    expect((await converge({ resolveBinary: () => "node" })).status).toBe("no-op");
  });

  it("declines on a non-canonical tuple, i.e. classify consults the predicate", async () => {
    // ONE row, not the whole rejection table: that table belongs to
    // `isCanonicalNpxStdioArgs` and is exercised against the predicate directly
    // in `tests/shared/npx-entry-spec.test.ts`. Routing every row through a temp
    // config file and a JSON round trip re-tests the same boolean at ~100x the
    // cost. What is worth pinning HERE is that `classify` calls it at all.
    write(legacyEntry({ args: ["-y", "tandem-editor-evil", "mcp-stdio"] }));
    expect((await converge()).status).toBe("no-op");
  });

  it("declines on an ABSOLUTE npx, leaving it visibly dead", async () => {
    // Swapping in a Node binary would leave `<node> -y tandem-editor@x mcp-stdio`,
    // which spawns nothing.
    write(legacyEntry({ command: join(dir, "npx") }));
    expect((await converge()).status).toBe("no-op");
  });

  it("never converges the tandem-channel key, which the plugin also emits", async () => {
    // That key's ownership rule adopts everything that reaches it, so the answer
    // has to be given explicitly rather than inherited from a default.
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          "tandem-channel": {
            command: "npx",
            args: ["-y", "tandem-editor@0.20.0", "mcp-stdio"],
            env: { TANDEM_URL: MCP_URL },
          },
        },
      }),
    );

    const result = await refreshMcpEntryBinary(configPath, {
      entryKey: "tandem-channel",
      targetKind: "claude-desktop",
      durable: true,
      script: bridge,
      resolveBinary: () => GOOD_NODE,
    });

    expect(result.status).toBe("no-op");
  });

  it("produces an entry a SECOND sweep recognises as its own", async () => {
    // The round trip. After convergence the entry must satisfy
    // `isOwnStdioBridgeScript`, or the next boot would treat what we just wrote as
    // a foreign hand-edit and never repair it again.
    write(legacyEntry());
    await converge();

    const again = await refreshMcpEntryBinary(configPath, {
      entryKey: "tandem",
      targetKind: "claude-desktop",
      durable: true,
      script: bridge,
      resolveBinary: () => GOOD_NODE,
      probe: () => true,
    });

    expect(again.status).toBe("no-op");
    expect(read().command).toBe(GOOD_NODE);
  });
});
