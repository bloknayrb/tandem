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
    expect(servers.tandem.args).toEqual(["-y", "tandem-editor", "mcp-stdio"]);
    expect(servers["tandem-channel"].args).toEqual(["-y", "tandem-editor", "channel"]);
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

  it("the experimental monitor points at its built output", () => {
    // The monitor command references a build artifact; if dist/monitor/index.js
    // is renamed the channel-push monitor silently fails to launch. Guard the
    // path coupling alongside the version drift guard.
    const experimental = plugin.experimental as { monitors?: Array<{ command?: string }> };
    const monitor = experimental?.monitors?.[0];
    expect(monitor?.command).toContain("dist/monitor/index.js");
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
