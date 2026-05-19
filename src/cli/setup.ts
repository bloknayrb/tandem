import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  applyConfig,
  applyOpsForCli,
  buildMcpEntries,
  CHANNEL_DIST,
  detectTargets,
  installSkill,
  PACKAGE_ROOT,
  validateChannelShimPrereq,
} from "../server/integrations/apply.js";

/**
 * Back-compat re-exports.
 *
 * The helpers below now live in `src/server/integrations/apply.ts`
 * (#477 PR 3c-ii-a — server library factor). External consumers
 * (`tandem rotate-token`, tests, anything that bundles against the
 * CLI surface) keep importing from `src/cli/setup.js` for now. The
 * re-export goes away in PR 3c-ii-c when `runSetup` is rewritten as
 * a non-interactive `--apply` wrapper and the CLI surface is reduced.
 */
export {
  type ApplyOps,
  applyConfig,
  applyConfigWithToken,
  applyOpsForCli,
  type BuildMcpEntriesOptions,
  buildMcpEntries,
  type DetectedTarget,
  type DetectOptions,
  detectTargets,
  installSkill,
  type McpEntries,
  type McpEntry,
  PathRejectedError,
  type RemovableEntry,
  type TargetKind,
  validateChannelShimPrereq,
} from "../server/integrations/apply.js";

/** Run the setup command. Writes MCP config to all detected Claude installs. */
export async function runSetup(
  opts: { force?: boolean; withChannelShim?: boolean } = {},
): Promise<void> {
  console.error("\nTandem Setup\n");

  if (opts.withChannelShim && !validateChannelShimPrereq(CHANNEL_DIST)) {
    console.error(
      `Error: --with-channel-shim requires dist/channel/index.js at ${CHANNEL_DIST}\n` +
        `Run 'npm run build' first, or drop --with-channel-shim to use the plugin monitor.`,
    );
    process.exit(1);
  }

  console.error("Detecting Claude installations...");

  const targets = detectTargets({ force: opts.force });

  if (targets.length === 0) {
    console.error(
      "  No Claude installations detected.\n" +
        "  If Claude Code is installed, ensure ~/.claude exists.\n" +
        "  You can force configuration to default paths with: tandem setup --force",
    );
    return;
  }

  for (const t of targets) {
    console.error(`  Found: ${t.label} (${t.configPath})`);
  }

  console.error("\nWriting MCP configuration...");

  let failures = 0;
  for (const t of targets) {
    const entries = buildMcpEntries(CHANNEL_DIST, {
      withChannelShim: opts.withChannelShim,
      targetKind: t.kind,
    });
    try {
      await applyConfig(t.configPath, applyOpsForCli(entries, !!opts.withChannelShim));
      console.error(`  \x1b[32m✓\x1b[0m ${t.label}`);
    } catch (err) {
      failures++;
      console.error(
        `  \x1b[31m✗\x1b[0m ${t.label}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (failures === targets.length) {
    console.error("\nSetup failed — could not write any configuration. Check file permissions.");
    process.exit(1);
  } else if (failures > 0) {
    console.error(
      `\nSetup partially complete (${failures} target(s) failed). Start Tandem with: tandem`,
    );
  } else {
    console.error("\nSetup complete! Start Tandem with: tandem");
    console.error("Then in Claude, your tandem_* tools will be available.");
  }

  // Install Claude Code skill (best-effort — doesn't block MCP setup)
  console.error("\nInstalling Claude Code skill...");
  try {
    await installSkill();
    console.error("  \x1b[32m✓\x1b[0m ~/.claude/skills/tandem/SKILL.md");
  } catch (err) {
    console.error(
      `  \x1b[33m⚠\x1b[0m Could not install skill: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Plugin install instructions (shown on all successful setups)
  if (failures < targets.length) {
    const pluginManifest = join(PACKAGE_ROOT, ".claude-plugin", "plugin.json");
    const devInstructions = existsSync(pluginManifest)
      ? `  Or for development, load directly from this package:\n\n` +
        `    claude --plugin-dir ${PACKAGE_ROOT}\n\n`
      : `  (Development plugin dir not found at ${pluginManifest}; skipping local-plugin instructions.)\n\n`;

    console.error(
      "\n\x1b[1mReal-time push notifications (recommended):\x1b[0m\n" +
        "  Install the Tandem plugin for instant events (one-time):\n\n" +
        "    claude plugin marketplace add bloknayrb/tandem\n" +
        "    claude plugin install tandem@tandem-editor\n\n" +
        devInstructions +
        "  Without the plugin, Claude still works but relies on tandem_checkInbox polling.\n",
    );
  }
}
