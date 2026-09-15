/**
 * "Would relaunching here actually move Claude?" — the server half of the
 * working-directory drift nudge (#1282).
 *
 * Claude Code stores conversations per working directory, and a session started
 * in one folder cannot be resumed from another. So the folder Claude runs in is
 * not cosmetic: it decides which `CLAUDE.md` and `.claude/` it reads, which git
 * repository it sees, and which files its own file tools can reach. A user
 * editing `~/projects/api/README.md` while Claude sits in `~` gets a Claude that
 * can read the document (Tandem syncs it) and almost nothing else about it.
 *
 * This module answers one question and refuses to answer any other: given the
 * folder a relaunch WOULD target and the folder Claude is in now, are they
 * different in a way worth mentioning? Every "no" collapses to the same
 * `{ drifted: false }` — see `LauncherCwdPreview` for why the client must not be
 * able to tell the no-cases apart.
 *
 * Scope boundary, stated rather than implied: a **manually launched** Claude
 * (#1054) is invisible to the supervisor, which truthfully reports
 * `running: false`, so `claudeCwd` is null and the answer is always "no drift".
 * That user is the most drift-prone one there is and gets no signal — correctly,
 * because the only action this nudge offers would spawn a SECOND agent on the
 * same documents. A nudge that cannot be acted on safely is worse than silence.
 */

import os from "node:os";
import path from "node:path";

import type { LauncherCwdPreview } from "../../shared/launcher/contract.js";
import { resolveRouteCwdAsync, resolveSafeCwdAsync, samePath } from "./supervisor.js";

/** Cap on how many trailing segments a distinguishing label may carry before it
 * is elided. Three fits the status pill; beyond that the label stops being a
 * glance-able name and becomes a path the menu already shows in full. */
const MAX_LABEL_SEGMENTS = 3;

/** Split a path into non-empty segments, treating both separators as such.
 * Windows paths reach a Linux CI host as strings, where `path.sep` is "/" —
 * splitting on the platform separator alone would return one giant segment. */
function segments(p: string): string[] {
  return p.split(/[/\\]/).filter((s) => s.length > 0);
}

/**
 * The path flavour to render in, chosen by the `platform` seam rather than by
 * the host.
 *
 * Keying on the host would make `platform` a HALF-seam: it would select the
 * case-fold while `path.sep` and `path.relative` still came from wherever the
 * test happened to run. Every expectation would then be written with the same
 * host primitive the implementation uses, so an implementation that hardcoded
 * "/" would pass on Linux CI — and `tildeAbbreviate`, whose whole job is keeping
 * a real full name out of screenshots on Windows, could not be exercised with a
 * Windows-shaped path at all.
 */
function flavour(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * The fewest trailing segments of `target` that distinguish it from `other`.
 *
 * The client cannot compute this, which is the whole reason it is returned over
 * the wire: `basename` alone collides on every `src`, `docs`, and `tests` in a
 * developer's home directory, and — worse — on two worktrees of one repository,
 * where the basenames are identical and only the parent differs. A label that
 * names both folders the same thing is not a smaller label, it is a wrong one.
 *
 * When the divergence is deeper than `MAX_LABEL_SEGMENTS` the label elides the
 * MIDDLE — `alpha…z`, not `…x/y/z`. Eliding the front would drop the only
 * segment that differs, so both folders would come back named `…/x/y/z`: the
 * exact "names both folders the same thing" failure this function exists to
 * avoid, reintroduced by the fallback.
 *
 * Falls back to the plain last segment when one path is a trailing sub-path of
 * the other (nothing distinguishes them at any depth).
 */
export function distinguishingLabel(
  target: string,
  other: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const sep = flavour(platform).sep;
  const a = segments(target);
  const b = segments(other);
  if (a.length === 0) return target; // filesystem root — nothing to name
  const depth = Math.min(a.length, b.length);
  for (let k = 1; k <= depth; k++) {
    const aTail = a.slice(-k);
    const bTail = b.slice(-k);
    if (samePath(aTail.join("/"), bTail.join("/"), platform)) continue;
    if (k <= MAX_LABEL_SEGMENTS) return aTail.join(sep);
    // Keep the diverging segment AND the leaf; elide what's between them.
    return `${aTail[0]}${sep}…${sep}${a[a.length - 1]}`;
  }
  // One is a trailing sub-path of the other (or they are equal, which the
  // caller has already excluded). Nothing distinguishes them by suffix, so name
  // the folder plainly.
  return a[a.length - 1] as string;
}

/**
 * Replace a leading home directory with `~`.
 *
 * Two reasons, and the second is not decorative: it shortens the path, and it
 * keeps the user's account name off screen. These paths land in a status-bar
 * tooltip and an `aria-label`, which is exactly the surface that ends up in
 * screenshots, screen recordings, and live demos.
 *
 * `~` is a POSIX idiom applied on Windows too — deliberately. The alternative is
 * rendering `C:\Users\<name>\…` verbatim on the one platform where the account
 * name is most often a person's real full name.
 */
export function tildeAbbreviate(
  p: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const fp = flavour(platform);
  if (samePath(p, home, platform)) return "~";
  const rel = fp.relative(home, p);
  if (rel === "" || rel.startsWith("..") || fp.isAbsolute(rel)) return p;
  return `~${fp.sep}${rel}`;
}

export interface CwdPreviewDeps {
  /** The folder a relaunch would target, as the client derived it. Unvalidated. */
  candidate: string;
  /** Where the supervised Claude is running, or `null` when nothing is running
   * (stopped, crashed, or manually launched — see the module header). */
  claudeCwd: string | null;
  /**
   * Directories holding Tandem's OWN bundled documents (`sample/welcome.md`,
   * `CHANGELOG.md`), already canonical.
   *
   * Excluded because validity is not desirability. Both open automatically —
   * `welcome.md` on first run, `CHANGELOG.md` after every upgrade — and on
   * Windows they live INSIDE the user's home directory: `tauri.conf.json` sets
   * no NSIS `installMode`, so the installer defaults to `currentUser`, which
   * puts the app under `%LOCALAPPDATA%`. That makes `dirname(welcome.md)` a
   * perfectly valid, home-confined, drifting folder — so without this exclusion
   * every Windows first run and every upgrade would greet the user by suggesting
   * they restart Claude inside Tandem's install directory.
   *
   * Matched EXACTLY, not as a prefix. In a development checkout `CHANGELOG.md`
   * resolves to the repository ROOT (`welcome.md` to `<repo>/sample`), and
   * prefix-matching that root would silence the nudge for anyone using Tandem to
   * work on Tandem.
   */
  bundledDocDirs: readonly string[];
  /** Test seam, mirroring `resolveRouteCwd`'s. Production leaves it unset. */
  homeOverride?: string;
  /** Test seam so both case-fold branches run on a single-platform CI host. */
  platform?: NodeJS.Platform;
}

/**
 * One-shot report of an unresolvable home directory.
 *
 * This is the failure that turns the whole feature off for one machine, and it
 * is the one the route's `catch` cannot see. `resolveRouteCwdAsync` home-confines
 * by realpath'ing `os.homedir()`; when THAT throws it returns null for every
 * candidate, so `previewCwdDrift` returns `{ drifted: false }` normally, forever,
 * having thrown nothing. Reachable via an unmounted roaming profile, a redirected
 * Windows home on a disconnected share, or `HOME` pointing at a deleted
 * directory.
 *
 * Latched at module scope: the condition is machine-level, not per-candidate, so
 * one line is the whole signal. Costs one extra `realpath` per process, on a
 * path that has already failed.
 */
let homeFailureReported = false;
async function noteIfHomeUnresolvable(homeOverride: string | undefined): Promise<void> {
  if (homeFailureReported) return;
  const home = homeOverride ?? os.homedir();
  if ((await resolveSafeCwdAsync(home)) !== null) return;
  homeFailureReported = true;
  console.error(
    `[Launcher] Home directory ${home} does not resolve — the working-folder nudge is ` +
      "disabled for this session (every candidate folder will be rejected).",
  );
}

/** Test-only reset of the one-shot home-failure latch. */
export function _resetHomeFailureLatchForTests(): void {
  homeFailureReported = false;
}

/**
 * Compute the drift verdict. Never throws: every failure is a `drifted: false`,
 * because a nudge is a suggestion and a suggestion built on a failed check is
 * worth less than nothing.
 */
export async function previewCwdDrift(deps: CwdPreviewDeps): Promise<LauncherCwdPreview> {
  const platform = deps.platform ?? process.platform;
  const noDrift: LauncherCwdPreview = { drifted: false };

  if (deps.claudeCwd === null) return noDrift;

  // Home-confined, canonicalized, non-UNC, must exist and be a directory. This
  // is the SAME predicate the relaunch route applies, which is what keeps the
  // nudge from offering an action the action itself would reject.
  const suggested = await resolveRouteCwdAsync(deps.candidate, {
    homeOverride: deps.homeOverride,
  });
  if (suggested === null) {
    await noteIfHomeUnresolvable(deps.homeOverride);
    return noDrift;
  }

  // Normalize Claude's side too, so both sides of the comparison are canonical.
  //
  // `resolveCwd` already realpaths both its branches — `homeCwd()` is
  // `resolveSafeCwd(os.homedir()) ?? os.homedir()` — so a merely symlinked home
  // is NOT the case this guards; realpath is exactly what resolves that. What is
  // left is `homeCwd()`'s own fallback (home unresolvable at spawn time, raw
  // string kept) and a cwd that reached the supervisor from a hand-edited
  // `integrations.json`. Falling back to the raw value keeps a since-deleted cwd
  // comparable rather than silently reporting "no drift".
  const claude = (await resolveSafeCwdAsync(deps.claudeCwd)) ?? deps.claudeCwd;

  if (samePath(suggested, claude, platform)) return noDrift;
  if (deps.bundledDocDirs.some((dir) => samePath(suggested, dir, platform))) return noDrift;

  // Canonicalize home the same way both paths above were, or `tildeAbbreviate`
  // silently stops matching wherever home contains a symlink. An unresolvable
  // home falls back to the raw value: a missed `~` is cosmetic.
  //
  // No local catch. `resolveSafeCwdAsync` swallows its own failures and returns
  // null, and the only line here that can throw is `os.homedir()` — which a
  // catch could not usefully handle anyway, since the fallback would have to
  // call it again. The route's own try/catch answers that with `drifted: false`.
  const homeRaw = deps.homeOverride ?? os.homedir();
  const home = (await resolveSafeCwdAsync(homeRaw)) ?? homeRaw;

  const suggestedCwd = tildeAbbreviate(suggested, home, platform);
  const claudeCwd = tildeAbbreviate(claude, home, platform);

  // Labels come from the ABBREVIATED paths, not the raw ones. Otherwise the
  // account name lands in the status pill in the default configuration: the
  // launcher's fallback cwd IS home (`resolveCwd` → `homeCwd()`, taken whenever
  // no `workingDirectory` is configured), and `distinguishingLabel` of a home
  // path against a subfolder returns home's basename — so a fresh install with a
  // document open anywhere renders "Claude in bryan.kolbeck". Abbreviating
  // first makes that same case read "Claude in ~", and changes nothing else:
  // paths outside home abbreviate to themselves, and two sibling worktrees still
  // yield `alpha/src` and `beta/src`.
  //
  // This is precisely the harm `tildeAbbreviate` was written for, arriving
  // through the one field it was not applied to.
  return {
    drifted: true,
    suggestedCwd,
    claudeCwd,
    label: distinguishingLabel(suggestedCwd, claudeCwd, platform),
    claudeLabel: distinguishingLabel(claudeCwd, suggestedCwd, platform),
  };
}
