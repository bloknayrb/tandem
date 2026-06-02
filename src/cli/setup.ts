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
  shouldRegisterChannelShim,
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
    // Default-on for Claude Code (channel shim is its push transport, #985);
    // `--with-channel-shim` is now an explicit override. The helper's
    // existence check degrades to "tandem HTTP entry only" when the build
    // artifact is absent (an explicit `--with-channel-shim` with a missing
    // file already hard-errored above).
    const withChannelShim = shouldRegisterChannelShim(t.kind, CHANNEL_DIST, opts.withChannelShim);
    const entries = buildMcpEntries(CHANNEL_DIST, {
      withChannelShim,
      targetKind: t.kind,
    });
    try {
      await applyConfig(t.configPath, applyOpsForCli(entries, { withChannelShim }));
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

  // Real-time push status (shown on all successful setups). Push is delivered
  // by the channel shim, registered by default above; the plugin monitor it
  // was meant to replace cannot activate via any path Claude Code exposes
  // today (Spike B / #985), so it's framed as forward-looking, not the path.
  if (failures < targets.length) {
    const channelRegistered = validateChannelShimPrereq(CHANNEL_DIST);
    const pluginManifest = join(PACKAGE_ROOT, ".claude-plugin", "plugin.json");
    const devInstructions = existsSync(pluginManifest)
      ? `  For development, you can also load the package directly:\n\n` +
        `    claude --plugin-dir ${PACKAGE_ROOT}\n\n`
      : "";

    console.error(
      "\n\x1b[1mReal-time push notifications:\x1b[0m\n" +
        (channelRegistered
          ? "  \x1b[32mEnabled\x1b[0m — the channel shim is registered; Claude Code receives events in real time.\n" +
            "  Relaunch any Claude Code session you started manually so it picks up the new server.\n\n"
          : "  \x1b[33mUnavailable\x1b[0m — dist/channel/index.js not found; Claude Code will poll via tandem_checkInbox.\n" +
            "  Run 'npm run build' and re-run setup to enable push.\n\n") +
        "  A Tandem plugin is also published (skill + MCP; the real-time monitor it carries is\n" +
        "  forward-looking, pending Claude Code support):\n\n" +
        "    claude plugin marketplace add bloknayrb/tandem\n" +
        "    claude plugin install tandem@tandem-editor\n\n" +
        devInstructions,
    );
  }
}
