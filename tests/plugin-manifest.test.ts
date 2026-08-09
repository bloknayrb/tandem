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
      monitors?: Array<{
        name?: string;
        command?: string;
        env?: Record<string, string>;
        when?: string;
      }>;
    };
    const monitors = experimental?.monitors ?? [];
    const version = pkg.version as string;
    expect(monitors.length).toBeGreaterThan(0);
    // EVERY entry, not `[0]`. There are two since #1354, and an index-0 check
    // would let the second one drift — different command, a stale pin, or an
    // `env` block — with CI still green.
    for (const monitor of monitors) {
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
    }
  });

  it("both arm triggers are declared, because one of them cannot catch both skill copies", () => {
    // #1354. The host matches `when === "on-skill-invoke:" + <published name>`
    // by plain string equality, and the published name is qualified iff the
    // dispatched skill came from a plugin. Tandem ships the `tandem` skill
    // TWICE — the plugin auto-loads `skills/tandem/`, and `tandem setup
    // --apply` writes `~/.claude/skills/tandem/SKILL.md`. With both installed
    // the picker offers `/tandem` and `/tandem:tandem`, and the bare one
    // resolves to the NON-plugin copy (spike F7, reproduced twice). Declaring
    // only the qualified form therefore arms for nobody who ran our own setup.
    //
    // Measured in spike F8: declaring both catches either copy. Losing either
    // entry is a silent failure — valid manifest, no error, monitor simply
    // never arms — which is exactly why it is pinned here.
    const experimental = plugin.experimental as {
      monitors?: Array<{ name?: string; when?: string }>;
    };
    const monitors = experimental?.monitors ?? [];
    const triggers = monitors.map((m) => m.when);
    expect(triggers).toContain("on-skill-invoke:tandem:tandem");
    expect(triggers).toContain("on-skill-invoke:tandem");
    // No entry may fall back to `always`: that is what armed the monitor in
    // sessions with nothing to do with Tandem, so a failing `npx` reported
    // `exit 127` in every one of them.
    expect(triggers).not.toContain("always");
    for (const m of monitors) expect(m.when).toBeDefined();
    // The host dedupes re-arming on `pluginName:monitorName`, so duplicate
    // names would silently collapse the second trigger into the first.
    const names = monitors.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("the arm triggers are derivable from the plugin name and the skill's own frontmatter", () => {
    // The test above pins the two literals. That is not enough on its own: the
    // string the host compares is assembled from THREE sources, and two of them
    // are nowhere near the manifest —
    //
    //   `on-skill-invoke:` + [plugin.json `name`] + `:` + [SKILL.md `name:`]
    //
    // so renaming the plugin, or editing the frontmatter of a skill file a
    // thousand lines long, leaves both the manifest and the literal assertion
    // untouched while the trigger stops matching anything. There is no error
    // for that: valid manifest, valid skill, monitor never arms.
    //
    // Spike F10 measures the live behaviour, but that probe is Windows-only and
    // hand-run. This is the part that can be checked on every commit.
    const skill = readText("../skills/tandem/SKILL.md");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill)?.[1];
    expect(frontmatter, "skills/tandem/SKILL.md has no frontmatter block").toBeDefined();
    // Tolerate a quoted value: `name: "tandem"` is valid YAML the host
    // resolves to `tandem`, and matching it as `"tandem"` would fail this test
    // for a manifest that is actually correct.
    const skillName = /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(frontmatter ?? "")?.[1];
    expect(skillName, "skills/tandem/SKILL.md declares no `name:`").toBeDefined();

    const pluginName = plugin.name as string;
    const experimental = plugin.experimental as { monitors?: Array<{ when?: string }> };
    const triggers = (experimental?.monitors ?? []).map((m) => m.when);

    // Qualified: what a dispatch of the PLUGIN's copy publishes.
    expect(triggers).toContain(`on-skill-invoke:${pluginName}:${skillName}`);
    // Bare: what a dispatch of the `tandem setup --apply` copy publishes, and
    // the one that actually fired in F10's double-install run.
    expect(triggers).toContain(`on-skill-invoke:${skillName}`);

    // …and that copy lives at a hardcoded path. F10 could not tell the
    // directory name apart from the frontmatter name because both are
    // `tandem`; rename the install directory alone and the bare trigger stops
    // matching, with every other assertion here still green.
    const apply = readText("../src/server/integrations/apply.ts");
    expect(
      apply,
      "the installed skill's directory no longer matches the bare arm trigger",
    ).toContain(`join(home, ".claude", "skills", "${skillName}", "SKILL.md")`);
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
