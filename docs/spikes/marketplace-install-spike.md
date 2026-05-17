# Marketplace Install Spike (F2 — ADR-038 Phase 3 gate)

**Status:** Spike complete — **NO-GO on marketplace one-command monitor activation in v2.1.143.**
**Date:** 2026-05-17
**Claude Code version tested:** 2.1.143
**Refs:** [ADR-038](../decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration), [Plugin Monitor Viability Spike (Spike B)](./plugin-monitor-viability-spike.md), [#477](https://github.com/bloknayrb/tandem/issues/477).

**Scope of validation:** this is the F2 follow-up promoted by ADR-038 from Spike B's deferred-issue table to a v1.0 marketing-rewrite blocker. It validates the **Claude default integration** (specifically, whether the marketplace install path activates the plugin monitor) so the Phase 3 README rewrite knows which install path to lead with.

## Goal

Spike B's Result table left one configuration unresolved:

> `claude plugin marketplace add <github-url>` plus `claude plugin install <name>@<marketplace>` would be the production path. The path-source error confirms that **`--plugin-dir` is the *only* local-development path for Tandem in v2.1.143**, and that path does not activate `experimental.monitors[]`.

F2 asks: now that PR #722 has merged and `bloknayrb/tandem` is reachable as a GitHub-source marketplace, does the **production marketplace install path** activate `experimental.monitors[]`?

If **YES**: Phase 3 README leads non-developers with a single `claude plugin marketplace add bloknayrb/tandem && claude plugin install tandem@tandem-editor`. The Tauri desktop app remains the non-CLI option.

If **NO**: Phase 3 README leads non-developers with the Tauri desktop app (which auto-configures Claude Code with `--dangerously-load-development-channels` silently). The marketplace install is documented but does *not* deliver channel-push.

## Method

Performed against Claude Code v2.1.143 on Linux. The squash-merged head of `master` (commit `1cdcab9` from PR #722, with ADR-038-aligned `.claude-plugin/marketplace.json` + `plugin.json` description blurbs) was the resolution target.

```sh
# Pre-flight: no marketplaces, no plugins.
claude plugin marketplace list   # → "No marketplaces configured"
claude plugin list               # → "No plugins installed."

# Add marketplace.
claude plugin marketplace add bloknayrb/tandem
# → "√ Successfully added marketplace: tandem-editor (declared in user settings)"

# Install plugin.
claude plugin install tandem@tandem-editor
# → "√ Successfully installed plugin: tandem@tandem-editor (scope: user)"

# Inspect resolved state.
claude plugin details tandem
# → "Skills (1) tandem | Agents (0) | Hooks (0) | MCP servers (0) | LSP servers (0)"

# Run claude with debug logging.
cd /tmp && claude -p "hi" --debug-file /tmp/claude-debug.log
# Inspect the log for monitor activation and MCP-server activation.
grep -iE 'tandem|monitor|experimental' /tmp/claude-debug.log
```

### Surprise: source-form syntax

The plan's predicted command form `claude plugin marketplace add github:bloknayrb/tandem` was **rejected** by v2.1.143 with:

> × Invalid marketplace source format. Try: owner/repo, https://..., or ./path

The working form is the bare `owner/repo` (or a full HTTPS URL). The Phase 3 README must use `claude plugin marketplace add bloknayrb/tandem`, not the `github:` prefix.

## Findings

### F2.1 — Marketplace install activates `mcpServers` ✅

The debug log shows both MCP servers from `plugin.json` start automatically on session launch:

```
[DEBUG] MCP server "plugin:tandem:tandem":         Starting connection with timeout of 30000ms
[DEBUG] MCP server "plugin:tandem:tandem-channel": Starting connection with timeout of 30000ms
```

Both connections fail in this spike because the Tandem HTTP server at `:3479` is not running — that is a *runtime* prerequisite (the user must launch `tandem start` or the Tauri app), not an *install* defect. The activation itself works: Claude Code reads `mcpServers` from the installed plugin's `plugin.json` and spawns both servers.

### F2.2 — Marketplace install activates the skill ✅

```
[DEBUG] Loaded 1 skills from plugin tandem default directory
[DEBUG] Skill prompt: showing "tandem:tandem" (userFacingName="tandem")
```

The `skills/tandem/SKILL.md` resource ships and is registered. Non-Claude-Code clients are unaffected (skills are Claude-Code-specific resources).

### F2.3 — Marketplace install does NOT activate `experimental.monitors[]` ❌

The 157-line debug log contains **zero** mentions of `monitor`, `experimental`, or the `tandem-events` monitor name. Cross-checked with `--dangerously-load-development-channels`: same result (monitor still not activated).

`claude plugin details tandem` corroborates: the component inventory reports "MCP servers (0)" (which is itself misleading — the servers *do* activate at runtime; `details` reports `0` because the inventory only displays Claude-Code-managed component types, and `mcpServers` are surfaced via the MCP debug channel rather than the inventory) and makes no mention of monitors anywhere.

The `experimental.monitors[]` declaration in `.claude-plugin/plugin.json` is preserved on disk in the install cache (`/root/.claude/plugins/cache/tandem-editor/tandem/0.8.0/.claude-plugin/plugin.json`) but Claude Code v2.1.143 does not honor it for marketplace-installed plugins.

### F2.4 — `--dangerously-load-development-channels` is accepted but doesn't unlock monitor activation either

Re-ran with the flag set to `noop:none`. Same debug log shape; same zero mentions of `monitor` / `experimental`. The flag remains functional for the **channel shim** transport (Spike B confirmed this) but has no effect on `experimental.monitors[]` activation under the marketplace install path.

## Verdict

**NO-GO** on a one-command marketplace install delivering the channel-push experience.

The marketplace install delivers the MCP servers (`tandem`, `tandem-channel`) and the skill — which is the **non-channel-push baseline experience**. Annotations, edits, chat, and document operations all work through the MCP servers. What is *missing* is the real-time push of channel events from Tandem to Claude Code, which requires either:

- The **channel shim** (`tandem-channel` MCP server) running, which Spike B established works only with `--dangerously-load-development-channels server:tandem-channel`. Marketplace install spawns `tandem-channel` but Claude Code does not invoke the channels MCP notification on it without the flag.
- The **plugin monitor**, which marketplace install does not activate in v2.1.143.

## Implications for Phase 3 README rewrite

The plan's NO-GO branch is now active:

> **F5 fails:** the marketplace install behaves the same as `--plugin-dir` (no monitor activation). README Quick Start leads with the channel-shim install for power users; non-developer install is the Tauri desktop app (which already auto-configures Claude Code with the flag passed silently).

Concretely, Phase 3 README should structure the install paths as:

1. **Just want to use it (non-developer):** download the Tauri desktop installer. On first launch, the integration setup wizard configures Claude with `--dangerously-load-development-channels` silently. (Wizard prerequisite per ADR-038 §2b — still gated on #477 PR 3.)
2. **Power-user setup:**
   - npm install of `tandem-editor` + `tandem setup` + `tandem` (deprecated by the wizard; kept for the transition window).
   - Channel-shim install with `--dangerously-load-development-channels server:tandem-channel`.
3. **Marketplace install (limited):** `claude plugin marketplace add bloknayrb/tandem && claude plugin install tandem@tandem-editor`. Delivers the MCP servers + skill. **Does not deliver real-time channel push** until Claude Code activates `experimental.monitors[]` from marketplace-installed plugins or accepts an alternate flag.
4. **Connecting other MCP clients:** the `:3479` MCP HTTP endpoint and the `/api/events` SSE stream. Best-effort, not validated, no channel push, no cowork.

## What this spike did NOT validate

- **Interactive session monitor activation.** Same caveat as Spike B — the spike used `claude -p` (print mode). It is conceivable that monitors activate later in the interactive session lifecycle (e.g. after a `/plugin` slash command or workspace-trust prompt). The conservative reading is that Phase 3 cannot rely on marketplace install for channel push.
- **macOS / Windows parity.** Linux-only test (same as Spike B). The marketplace install path uses the same plugin loader code path on all platforms; cross-platform reverification is filed alongside Spike B's F4 follow-up.
- **Future Claude Code versions.** v2.1.143 is the current pinned target. If a later version activates `experimental.monitors[]` from marketplace plugins, the Phase 3 install hierarchy can be revisited.

## Follow-up issues

| # | Concern | Tracked |
|---|---|---|
| F2.a | Revisit Phase 3 README install hierarchy if/when Claude Code marketplace install activates `experimental.monitors[]` | Tied to Spike B's F1 |
| F2.b | Confirm whether `claude plugin marketplace add` requires `owner/repo` form on macOS / Windows (Linux rejects `github:` prefix) | Filed for the wizard PR — its in-app marketplace flow needs to match the working syntax |
| F2.c | Update `.claude-plugin/plugin.json:experimental.monitors[]` block — keep as forward-looking declaration (Spike B's recommendation) | No action; current state is correct |

## Artifacts

- This spike report.
- The plugin install was performed against squash-merged commit `1cdcab9` (ADR-038 Phase 2 head). The cache at `/root/.claude/plugins/cache/tandem-editor/tandem/0.8.0/` shows the install resolved correctly and `plugin.json` was preserved verbatim.
- Test state cleaned up after the spike: `claude plugin uninstall tandem@tandem-editor && claude plugin marketplace remove tandem-editor`.

## Appendix — debug log excerpt (redacted)

```
2026-05-17T17:16:14.581Z [DEBUG] Loaded 1 installed plugins from /root/.claude/plugins/installed_plugins.json
2026-05-17T17:16:14.587Z [DEBUG] Found 1 plugins (1 enabled, 0 disabled)
2026-05-17T17:16:14.588Z [DEBUG] getPluginSkills: Processing 1 enabled plugins
2026-05-17T17:16:14.588Z [DEBUG] Checking plugin tandem: skillsPath=exists, skillsPaths=0 paths
2026-05-17T17:16:14.588Z [DEBUG] Registered 0 hooks from 1 plugins
2026-05-17T17:16:14.610Z [DEBUG] Loaded 1 skills from plugin tandem default directory
2026-05-17T17:16:14.618Z [DEBUG] Initialized versioned plugins system with 1 plugins
2026-05-17T17:16:14.632Z [DEBUG] MCP server "plugin:tandem:tandem":         Starting connection with timeout of 30000ms
2026-05-17T17:16:14.636Z [DEBUG] MCP server "plugin:tandem:tandem-channel": Starting connection with timeout of 30000ms
# (no 'monitor' or 'experimental' entries anywhere in the 157-line log)
```
