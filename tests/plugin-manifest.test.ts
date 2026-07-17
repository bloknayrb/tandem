import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Guards against the published Claude Code plugin manifest drifting out of
// sync with the npm package — historically `plugin.json` was left at 0.8.0
// while the package shipped 0.14.x. There is no automated version-bump step
// (releases are manual `chore(release)` commits), so this test is the
// enforcement: bump `package.json` and `.claude-plugin/plugin.json` together
// or CI fails here.

function readJson(relPath: string): Record<string, unknown> {
  const url = new URL(relPath, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}

function readText(relPath: string): string {
  return readFileSync(new URL(relPath, import.meta.url), "utf8");
}

const pkg = readJson("../package.json");
const plugin = readJson("../.claude-plugin/plugin.json");
const marketplace = readJson("../.claude-plugin/marketplace.json");

describe("published Claude Code plugin manifest", () => {
  it("plugin.json version tracks package.json version", () => {
    expect(plugin.version).toBe(pkg.version);
  });

  it("declares the host MCP servers over loopback (correct for Claude Code on the host)", () => {
    // The host marketplace plugin connects over loopback with no auth token —
    // that is correct here. The Cowork VM path is configured separately by the
    // Rust installer with host.docker.internal + a per-machine token, which a
    // published manifest cannot carry. Do not "fix" this URL to a VM address.
    const servers = plugin.mcpServers as Record<
      string,
      { command?: string; args?: string[]; env?: Record<string, string> }
    >;
    // Both servers must use npx — a change to bunx or node would silently
    // break installations.
    expect(servers.tandem.command).toBe("npx");
    expect(servers["tandem-channel"].command).toBe("npx");
    // Both servers must point at loopback — do NOT "fix" these to a VM address.
    // The Cowork VM path is written separately by the Rust installer with
    // host.docker.internal + a per-machine token that a published manifest
    // cannot carry.
    expect(servers.tandem.env?.TANDEM_URL).toBe("http://127.0.0.1:3479");
    expect(servers["tandem-channel"].env?.TANDEM_URL).toBe("http://127.0.0.1:3479");
    // The npx spec is pinned to this exact package version (not bare, not
    // @latest) so `npm exec` can't be shadowed by a stale global `tandem-editor`
    // predating a subcommand — see tests/plugin/plugin-version-pin.test.ts for
    // the dedicated drift guard. Derive the expected value from pkg.version
    // rather than hardcoding it, so a release bump doesn't rot this assertion.
    const version = pkg.version as string;
    expect(servers.tandem.args).toEqual(["-y", `tandem-editor@${version}`, "mcp-stdio"]);
    expect(servers["tandem-channel"].args).toEqual(["-y", `tandem-editor@${version}`, "channel"]);
  });

  it("marketplace install identity is tandem@tandem-editor from bloknayrb/tandem", () => {
    // `claude plugin install <plugin>@<marketplace>` → plugin name `tandem`,
    // marketplace name `tandem-editor`. The README documents
    // `claude plugin marketplace add bloknayrb/tandem`, so the source repo must
    // match that slug or the documented install breaks. Pin all three.
    expect(marketplace.name).toBe("tandem-editor");
    expect(plugin.name).toBe("tandem");
    const plugins = marketplace.plugins as Array<{ name: string; source?: unknown }>;
    const tandem = plugins.find((p) => p.name === "tandem");
    expect(tandem).toBeDefined();
    expect(tandem?.source).toEqual({ source: "github", repo: "bloknayrb/tandem" });
  });

  it("the experimental monitor runs via the pinned npx subcommand", () => {
    // The monitor ships as `npx -y tandem-editor@<version> monitor`, NOT
    // `node ${CLAUDE_PLUGIN_ROOT}/dist/monitor/index.js` — dist/ is gitignored,
    // so a github plugin-clone install (the marketplace path) carries no built
    // monitor binary. npm ships dist (files:["dist/"]), so npx delivers it,
    // matching the tandem / tandem-channel mcpServers entries. The version pin
    // is guarded in tests/plugin/plugin-version-pin.test.ts.
    const experimental = plugin.experimental as {
      monitors?: Array<{ command?: string; env?: Record<string, string> }>;
    };
    const monitor = experimental?.monitors?.[0];
    const version = pkg.version as string;
    expect(monitor?.command).toBe(`npx -y tandem-editor@${version} monitor`);
    // The monitor entry carries NO `env` block, unlike the mcpServers entries.
    // Two reasons: (1) ADR-028 records that the monitors[] manifest schema
    // rejected `env` blocks (CLI 2.1.126) — until that's re-verified lifted,
    // an `env` block risks making the whole entry uninstallable, which would
    // regress the activation the B1 spike proved. (2) It's redundant anyway:
    // resolveTandemUrl() (src/shared/cli-runtime.ts) already defaults to
    // http://127.0.0.1:3479, and in Cowork the plugin host's
    // CLAUDE_PLUGIN_OPTION_SERVER_URL takes precedence over TANDEM_URL. So the
    // env would only ever match the default where it's harmless and be wrong
    // where it matters. Guard that it stays absent.
    expect(monitor?.env).toBeUndefined();
  });

  it("the README #cowork anchor the dialogs link to exists", () => {
    // CoworkSettings, CoworkOnboardingStep and CoworkAdminDeclinedModal all link
    // to `${TANDEM_REPO_URL}#cowork`. GitHub derives that anchor from a heading
    // whose text is exactly "Cowork" — guard it so a future README rename
    // doesn't silently break every "Learn more" link.
    const readme = readText("../README.md");
    expect(readme).toMatch(/^#{1,6} Cowork$/m);
  });
});
