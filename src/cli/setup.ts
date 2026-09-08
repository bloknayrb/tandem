import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  applyConfig,
  applyOpsForCli,
  buildMcpEntries,
  CHANNEL_DIST,
  ConfigRefusalError,
  type DetectedTarget,
  detectionRefusal,
  detectTargets,
  installSkill,
  PACKAGE_ROOT,
  resolveChannelShimIntent,
  type TargetKind,
  validateChannelShimPrereq,
} from "../server/integrations/apply.js";
import { CLAUDE_PLUGIN_INSTALL_COMMANDS } from "../shared/constants.js";
import {
  ERROR_CODE_CONFIG_MALFORMED,
  ERROR_CODE_CONFIG_TOO_LARGE,
  targetPushSupport,
} from "../shared/integrations/contract.js";

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

/**
 * Parse the channel-shim flags into an explicit three-way intent (#1760).
 *
 * `--with-channel-shim` → `true`, `--without-channel-shim` → `false`, neither →
 * `{}` (no opinion, which `resolveChannelShimIntent` reads as "preserve"). Both
 * at once is a `conflict` the caller refuses before any write, rather than
 * silently picking one — the two flags mean opposite things and the wrong guess
 * deletes a deliberate opt-in. Pure + side-effect-free for unit testing.
 */
export function parseChannelShimArgs(args: string[]): { intent?: boolean; conflict: boolean } {
  const on = args.includes("--with-channel-shim");
  const off = args.includes("--without-channel-shim");
  if (on && off) return { conflict: true };
  if (on) return { intent: true, conflict: false };
  if (off) return { intent: false, conflict: false };
  return { conflict: false };
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
      "    non-interactively. Honors --force, --target=<kind>,\n" +
      "    --with-channel-shim, --without-channel-shim.\n",
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

  // #1811 — the command that CREATES the duplication was the one surface that
  // never mentioned it. Gated on a `claude-code` target because the plugin is a
  // Claude Code plugin: `--target=claude-desktop` writes no Claude Code entry
  // and duplicates nothing, so the notice there would be a false statement
  // prescribing the uninstall of a working plugin. Dynamic import, mirroring
  // `src/cli/index.ts`, so other `tandem setup` paths do not pay for doctor's
  // dependency graph.
  //
  // The write still happens: `--apply` is the scriptable path whose contract is
  // "write the config", and silently skipping would strand a user who later
  // disables the plugin with no output saying why.
  if (targets.some((t) => t.kind === "claude-code")) {
    const pluginKey = (await import("./doctor.js")).detectEnabledTandemPluginKey();
    if (pluginKey !== null) {
      console.error(
        `\n  \x1b[33m⚠\x1b[0m The Tandem plugin (${pluginKey}) is installed and already provides ` +
          "the tandem_* tools.\n" +
          "    Writing this config too makes every tool appear twice — keep one:\n" +
          `    claude plugin uninstall ${pluginKey}`,
      );
    }
  }

  let outcome: WriteOutcome = { failures: 0, refusals: [], shimRegisteredFor: [] };
  if (targets.length === 0) {
    // `detectTargets` returns an empty list for two very different reasons, and
    // the generic hint is actively wrong for one of them: when the home
    // directory itself was refused (#1417 — a UNC or device-namespace
    // `%USERPROFILE%`), `--force` writes to paths derived from that same
    // rejected root, so it re-runs the refusal rather than working around it.
    // Say what was refused instead of sending the user down a dead end.
    const refusal = detectionRefusal({});
    if (refusal !== null) {
      console.error(
        `  Detection refused: your home directory is not a supported path.\n  ${refusal}\n` +
          "  --force will not help — it derives the same paths from the same root.",
      );
    } else {
      console.error(
        "  No matching Claude installations detected.\n" +
          "  If Claude Code is installed, ensure ~/.claude exists.\n" +
          "  Force configuration to default paths with: tandem setup --apply --force",
      );
    }
  } else {
    for (const t of targets) {
      console.error(`  Found: ${t.label} (${t.configPath})`);
    }

    console.error("\nWriting MCP configuration...");
    outcome = await writeTargets(targets, opts);

    if (outcome.failures === targets.length) {
      // "Check file permissions" is a dead end when the file was REFUSED rather
      // than unwritable (#1802): a malformed or oversize `~/.claude.json`
      // throws `ConfigRefusalError` out of `applyConfig`, lands here, and the
      // user goes and checks permissions that were fine all along. `doctor` and
      // the wizard both name the real remedy; this was the third surface.
      console.error(
        outcome.refusals.length === outcome.failures
          ? refusalSummary(outcome.refusals)
          : "\nSetup failed — could not write any configuration. Check file permissions.",
      );
    } else if (outcome.failures > 0) {
      console.error(
        `\nSetup partially complete (${outcome.failures} target(s) failed). Start Tandem with: tandem`,
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
    const result = await installSkill();
    if (!result.written) {
      // The remedy names DELETING the file, never "upgrade Tandem to move it":
      // no Tandem version moves a `version: 999` file, so that would be a
      // dead-end fix line.
      console.error(
        `  \x1b[33m⚠\x1b[0m kept the installed skill (v${result.onDiskVersion} on disk is newer ` +
          `than this install's v${result.bundledVersion}) — delete ` +
          "~/.claude/skills/tandem/SKILL.md and re-run to replace it",
      );
    } else {
      console.error("  \x1b[32m✓\x1b[0m ~/.claude/skills/tandem/SKILL.md");
    }
  } catch (err) {
    console.error(
      `  \x1b[33m⚠\x1b[0m Could not install skill: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (targets.length > 0 && outcome.failures < targets.length) {
    printPushStatus(outcome.shimRegisteredFor);
  }

  // Non-zero exit only when we attempted writes and every one failed, so
  // `tandem setup --apply` stays scriptable (CI can branch on exit code).
  if (targets.length > 0 && outcome.failures === targets.length) {
    process.exit(1);
  }
}

/**
 * The all-failed summary for a run where every failure was a refusal.
 *
 * Branches on the REASON, not merely on the count. `ConfigRefusalError` covers
 * two conditions with nothing in common but the decision to leave the file
 * alone, and a count-only branch printed the malformed remedy for both: a user
 * whose `~/.claude.json` has outgrown the cap — the routinely-multi-megabyte
 * population #1801 exists for — was told to fix JSON that parses perfectly and
 * to restore a backup they have no reason to have, then to re-run the identical
 * command. The wizard already branches on `err.reason`
 * (`IntegrationWizardModal#resultErrorText`); this is the CLI half of the same
 * fact.
 */
function refusalSummary(reasons: readonly ConfigRefusalError["reason"][]): string {
  const lead =
    "\nSetup failed — Tandem refused to rewrite the config file(s) above and left them\n" +
    "exactly as found.";
  const kinds = new Set(reasons);
  if (kinds.size === 1 && kinds.has(ERROR_CODE_CONFIG_TOO_LARGE)) {
    // No "fix the JSON" and no backup: nothing is broken. The per-target line
    // above already printed the size and the cap, so this only has to say what
    // to do about it — and honestly, which means naming the hand-registration
    // route rather than implying the file can simply be shrunk.
    return (
      `${lead} The file is larger than Tandem will rewrite safely — it is not\n` +
      "corrupt. Register Tandem by hand in that file, or reduce its size, then re-run:\n" +
      "  tandem setup --apply"
    );
  }
  if (kinds.size === 1 && kinds.has(ERROR_CODE_CONFIG_MALFORMED)) {
    // "must be a JSON object" rather than "fix the JSON": the same reason
    // covers a file that parses perfectly and is an array, a string or `null`
    // at its root, and telling that user to fix their JSON describes nothing
    // wrong with it. The per-target line above already said which of the two
    // it was.
    return (
      `${lead} It must be a JSON object — fix it, or restore the file from a\n` +
      "backup, then re-run:\n" +
      "  tandem setup --apply"
    );
  }
  // Mixed reasons across several targets: no single remedy is true of all of
  // them, so point at the per-target lines rather than guessing.
  return `${lead} Each line above says what its file needs.`;
}

interface WriteOutcome {
  failures: number;
  /** The `reason` of each failure that was a `ConfigRefusalError` — Tandem
   *  declining to rewrite a malformed or oversize config — rather than an I/O
   *  error. The summary branches on the reasons, so a refusal never sends the
   *  user to check permissions on a file whose permissions are fine, nor to fix
   *  JSON in a file that parses. */
  refusals: ConfigRefusalError["reason"][];
  /** Targets that actually got a channel-shim entry written. `printPushStatus`
   *  reports off THIS, not off a file-existence check — `shouldRegisterChannelShim`
   *  returns false for every Claude Desktop target, so a run that registered no
   *  shim anywhere was still announcing push as enabled. */
  shimRegisteredFor: string[];
}

async function writeTargets(targets: DetectedTarget[], opts: SetupOptions): Promise<WriteOutcome> {
  let failures = 0;
  const refusals: ConfigRefusalError["reason"][] = [];
  const shimRegisteredFor: string[] = [];
  for (const t of targets) {
    try {
      // Opt-in since Track E: absent the flag this writes the tandem HTTP entry
      // and nothing else. It was default-on for Claude Code from #985 until an
      // inert shim was found suppressing the very signal built to warn about it.
      // An explicit `--with-channel-shim` with a missing build artifact already
      // hard-errored above.
      //
      // `resolveChannelShimIntent`, NOT `shouldRegisterChannelShim`, and the
      // difference is data loss. `setup --apply` is a re-run/heal command in
      // practice — `tandem doctor` prescribes it for a malformed config, a
      // missing entry and a stale Node path — and it arrives with
      // `withChannelShim: undefined` whenever the flag is absent. Re-deriving
      // from that turns "no opinion" into `false`, which `applyOpsForCli`
      // turns into an explicit REMOVE: a user who had opted in with
      // `--with-channel-shim` lost it the next time doctor sent them here.
      // Absent a flag, preserve; `--with-channel-shim` turns it on and
      // `--without-channel-shim` is the one `tandem setup` flag that removes it
      // (#1760). `--uninstall-scrub` and a confirmed wizard diff remove it too,
      // by their own explicit routes — what #1760 fixed is that no IMPLICIT
      // path removes it any more.
      //
      // `preserveShim` answers "should the entry exist"; `writeShim` answers
      // "may we derive its body". They differ on a `targetPushSupport ===
      // "none"` kind holding a hand-registered entry: `buildMcpEntries` is not
      // target-gated, so deriving there would overwrite the user's own
      // `command`/`args` and re-arm #1299's false "Registered for: Claude
      // Desktop".
      const preserveShim = await resolveChannelShimIntent(
        t.kind,
        t.configPath,
        opts.withChannelShim,
      );
      const writeShim = preserveShim && targetPushSupport(t.kind) !== "none";
      const entries = buildMcpEntries(CHANNEL_DIST, {
        withChannelShim: writeShim,
        targetKind: t.kind,
      });
      await applyConfig(t.configPath, applyOpsForCli(entries, { withChannelShim: preserveShim }));
      console.error(`  \x1b[32m✓\x1b[0m ${t.label}`);
      // Recorded only on a SUCCESSFUL write — a target whose config failed to
      // save has no shim, whatever we intended for it.
      if (writeShim) shimRegisteredFor.push(t.label);
    } catch (err) {
      failures++;
      if (err instanceof ConfigRefusalError) refusals.push(err.reason);
      console.error(
        `  \x1b[31m✗\x1b[0m ${t.label}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { failures, refusals, shimRegisteredFor };
}

/**
 * Report the push path honestly.
 *
 * This previously printed "Enabled — the channel shim is registered; Claude
 * Code receives events in real time" whenever `dist/channel/index.js` existed
 * on disk. Two separate things were wrong with that, and users hit both:
 *
 *   - It reported a FILE, not a WRITE. `shouldRegisterChannelShim` returns
 *     false for every Claude Desktop target, so `setup --apply
 *     --target=claude-desktop` claimed a shim it had never registered.
 *   - Registration is not delivery. The shim only *delivers* into a session
 *     that activated the channel, which needs the dev-channels flag and an
 *     interactive session — which is what made "Enabled" read as a lie.
 *
 * A third thing was wrong and outlived the first fix: this used to add that
 * "sessions Tandem starts pass it automatically." They do not, and never did.
 * The flag is parsed only on Claude Code's interactive path, and the launcher
 * spawns with `-p`; #1266 measured the same outcome end to end. Sessions Tandem
 * starts are woken over the supervisor's stdin instead, so they need nothing
 * from this report. See `src/shared/launcher/contract.ts`.
 */
export function printPushStatus(shimRegisteredFor: string[]): void {
  const pluginManifest = join(PACKAGE_ROOT, ".claude-plugin", "plugin.json");
  // `--plugin-dir` DOES activate the monitor. The previous copy here said it
  // did not, citing a 2026-08-06 null on 2.1.223; that null was the print-mode
  // confound, and F1/F6/F8/F10 in `plugin-monitor-tty-activation.md` each
  // armed a manifest monitor through `--plugin-dir` on 2.1.226 in an
  // interactive session. (Not F7 — its whole result is a null: the bare
  // dispatch selected the non-plugin copy and no marker appeared. It is the
  // reason there are two entries, not evidence that one armed.) Claiming less
  // than the truth here is still a wrong claim: it told developers a working
  // path was dead.
  const devInstructions = existsSync(pluginManifest)
    ? `  For development you can load the package directly — skill, MCP entries\n` +
      `  and the monitor, in an interactive session:\n\n` +
      `    claude --plugin-dir ${PACKAGE_ROOT}\n\n`
    : "";

  let status: string;
  if (shimRegisteredFor.length > 0) {
    status =
      `  \x1b[32mRegistered\x1b[0m for: ${shimRegisteredFor.join(", ")}\n` +
      "  Registered is not delivering. To receive events, a session you start\n" +
      "  yourself needs the channel flag:\n\n" +
      "    claude --dangerously-load-development-channels server:tandem-channel\n\n" +
      "  Without it, your edits and comments still reach Claude — on its next\n" +
      "  tandem_checkInbox rather than immediately. Sessions Tandem launches for\n" +
      "  you are woken directly and need neither the flag nor this shim.\n\n";
  } else if (!validateChannelShimPrereq(CHANNEL_DIST)) {
    status =
      "  \x1b[33mUnavailable\x1b[0m — dist/channel/index.js not found; Claude will see your\n" +
      "  work on its next tandem_checkInbox. Run 'npm run build' and re-run setup.\n\n";
  } else {
    // The Claude-Desktop-only case the old file check papered over.
    status =
      "  \x1b[33mNot registered\x1b[0m — no target in this run takes the channel shim.\n" +
      "  Claude will see your work on its next tandem_checkInbox.\n\n";
  }

  console.error(
    "\n\x1b[1mReal-time push notifications:\x1b[0m\n" +
      // Lead with the path that needs no install. Every other shipped surface
      // (doctor's push-path fix string, the wizard, SKILL.md) puts the
      // self-armed watch first; this file used to open on the channel shim, so
      // a `tandem setup --apply` user heard about two paths that need
      // installing and nothing about the one that does not.
      "  Simplest first: ask Claude to watch for updates. It can arm a watch on\n" +
      "  Tandem's wake stream itself — nothing to install, no flag — where Claude\n" +
      "  Code offers a Monitor tool. That tool is enabled per account rather than\n" +
      "  per version, so upgrading may not add it, and on Windows it also needs Git\n" +
      "  Bash. If Claude says it has none, the channel shim below is the option that\n" +
      "  never needs it.\n\n" +
      status +
      "  A Tandem plugin is also published (skill + MCP + a real-time monitor that\n" +
      "  needs no flag on Claude Code 2.1.212+ interactive sessions). The monitor\n" +
      "  starts when Claude first uses the Tandem skill in a session, not at session\n" +
      "  start — so ask for Tandem by name rather than expecting it to be listening.\n" +
      "  It also needs Node on the PATH Claude Code itself started with (start\n" +
      "  `claude` from a terminal), and it shares the built-in Monitor tool's\n" +
      "  per-account gate — so it cannot stand in when that gate is off.\n" +
      "  Use one or the other — both active in one session deliver every event twice:\n\n" +
      CLAUDE_PLUGIN_INSTALL_COMMANDS.map((cmd) => `    ${cmd}\n`).join("") +
      "\n" +
      devInstructions,
  );
}
