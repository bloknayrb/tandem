import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  applyConfig,
  applyOpsForCli,
  buildMcpEntries,
  CHANNEL_DIST,
  type DetectedTarget,
  detectTargets,
  installSkill,
  PACKAGE_ROOT,
  shouldRegisterChannelShim,
  type TargetKind,
  validateChannelShimPrereq,
} from "../server/integrations/apply.js";

/**
 * Parse repeatable `--target=<kind>` CLI args into valid target kinds plus the
 * unrecognized leftovers (so the caller can warn on typos). Only the
 * `--target=<value>` form is recognized — `--target foo` (space, no `=`) is
 * silently ignored, and `--target=` (empty value) lands in `unknown` and is
 * treated as a typo by the caller. Pure + side-effect-free for unit testing.
 */
export function parseTargetArgs(args: string[]): {
  targets: TargetKind[];
  unknown: string[];
} {
  const raw = args.filter((a) => a.startsWith("--target=")).map((a) => a.slice("--target=".length));
  const targets = raw.filter((t): t is TargetKind => t === "claude-code" || t === "claude-desktop");
  const unknown = raw.filter((t) => t !== "claude-code" && t !== "claude-desktop");
  return { targets, unknown };
}

export interface SetupOptions {
  /**
   * When false (the default `tandem setup` with no flags) we only print
   * guidance — first-run setup is wizard-driven now (ADR-038 §2b). `--apply`
   * opts into writing the MCP config non-interactively (scriptable path for
   * CI / dotfile users).
   */
  apply?: boolean;
  force?: boolean;
  withChannelShim?: boolean;
  /**
   * Restrict to specific target kinds (`--target=claude-code|claude-desktop`).
   * Empty/undefined = all detected targets.
   */
  targets?: TargetKind[];
}

/**
 * `tandem setup` entry point.
 *
 * Auto-configuration of Claude on Tauri startup and the old interactive
 * `tandem setup` flow were removed in #477 PR 3c-ii-c — setup runs through the
 * in-app wizard, with this CLI surviving only as a non-interactive
 * `--apply` escape hatch for scripts. The bare `tandem setup` prints guidance.
 */
export async function runSetup(opts: SetupOptions = {}): Promise<void> {
  if (!opts.apply) {
    printGuidance();
    return;
  }
  await applySetup(opts);
}

function printGuidance(): void {
  console.error(
    "\nTandem setup is wizard-driven.\n\n" +
      "  • Run `tandem` to launch the editor; the first-run wizard connects\n" +
      "    Claude (Claude Code / Claude Desktop) for you.\n" +
      "  • Or run `tandem setup --apply` to write the default Claude MCP config\n" +
      "    non-interactively. Honors --force, --target=<kind>, --with-channel-shim.\n",
  );
}

async function applySetup(opts: SetupOptions): Promise<void> {
  console.error("\nTandem Setup (--apply)\n");

  if (opts.withChannelShim && !validateChannelShimPrereq(CHANNEL_DIST)) {
    console.error(
      `Error: --with-channel-shim requires dist/channel/index.js at ${CHANNEL_DIST}\n` +
        `Run 'npm run build' first, or drop --with-channel-shim to use the plugin monitor.`,
    );
    process.exit(1);
  }

  console.error("Detecting Claude installations...");

  let targets = detectTargets({ force: opts.force });
  if (opts.targets && opts.targets.length > 0) {
    const wanted = new Set(opts.targets);
    targets = targets.filter((t) => wanted.has(t.kind));
  }

  let failures = 0;
  if (targets.length === 0) {
    console.error(
      "  No matching Claude installations detected.\n" +
        "  If Claude Code is installed, ensure ~/.claude exists.\n" +
        "  Force configuration to default paths with: tandem setup --apply --force",
    );
  } else {
    for (const t of targets) {
      console.error(`  Found: ${t.label} (${t.configPath})`);
    }

    console.error("\nWriting MCP configuration...");
    failures = await writeTargets(targets, opts);

    if (failures === targets.length) {
      console.error("\nSetup failed — could not write any configuration. Check file permissions.");
    } else if (failures > 0) {
      console.error(
        `\nSetup partially complete (${failures} target(s) failed). Start Tandem with: tandem`,
      );
    } else {
      console.error("\nSetup complete! Start Tandem with: tandem");
      console.error("Then in Claude, your tandem_* tools will be available.");
    }
  }

  // Skill install is per-user, not per-integration — run it on any --apply
  // invocation (contrarian review S5), even when no targets were written.
  console.error("\nInstalling Claude Code skill...");
  try {
    await installSkill();
    console.error("  \x1b[32m✓\x1b[0m ~/.claude/skills/tandem/SKILL.md");
  } catch (err) {
    console.error(
      `  \x1b[33m⚠\x1b[0m Could not install skill: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (targets.length > 0 && failures < targets.length) {
    printPushStatus();
  }

  // Non-zero exit only when we attempted writes and every one failed, so
  // `tandem setup --apply` stays scriptable (CI can branch on exit code).
  if (targets.length > 0 && failures === targets.length) {
    process.exit(1);
  }
}

async function writeTargets(targets: DetectedTarget[], opts: SetupOptions): Promise<number> {
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
  return failures;
}

function printPushStatus(): void {
  // Real-time push is delivered by the channel shim, registered by default
  // above. The plugin also carries a monitor that activates on Claude Code
  // 2.1.212+ interactive sessions and needs no flag (it was inactive on
  // 2.1.143 — the historical Spike B / #985 NO-GO, since reversed). The two
  // are independent push paths; which becomes canonical is an open decision
  // (both active in one session double-deliver), so the shim stays the default
  // here.
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
      "  A Tandem plugin is also published (skill + MCP + a real-time monitor that\n" +
      "  activates on Claude Code 2.1.212+ and needs no --dangerously-... flag):\n\n" +
      "    claude plugin marketplace add bloknayrb/tandem\n" +
      "    claude plugin install tandem@tandem-editor\n\n" +
      devInstructions,
  );
}
