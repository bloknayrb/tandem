import { statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Generic PATH-lookup primitives, pure built-ins only.
 *
 * Extracted from `detect-claude-cli.ts` when a second question needed the same
 * machinery: "can this machine resolve `npx`/`node` at all?", asked by
 * `tandem doctor`. (It was also once asked by `buildMcpEntries`, to embed an
 * absolute `npx` — that caller is gone: an absolute `npx` still resolves `node`
 * through the client's PATH, so it fails exactly where the bare name does.)
 * The pieces shared are the two rules that are genuinely universal — how
 * to decide a candidate is a real file, and what filenames a program can be
 * installed under on Windows.
 *
 * The two PATH *walks* in `detect-claude-cli.ts` deliberately stay there. They
 * are not "find the binary" loops: `detectClaudeCli` returns a three-state
 * presence enum with a `~/.local/bin` fallback, and `isBareNameLaunchable`
 * walks the WHOLE path tracking whether it saw a shim, because
 * `CreateProcessW` skips directories lacking a `.exe` and keeps searching.
 * Collapsing either into {@link resolveOnPath}'s first-hit semantics would
 * change its answer, and both answers are load-bearing.
 */

/**
 * Does this path name a FILE?
 *
 * Not `existsSync`, which is also true for a directory — and several probed
 * names are extensionless, so a PATH entry holding an ordinary `node/` folder
 * would otherwise read as an installed binary. `statSync` follows symlinks, so
 * a link to a real binary still counts; `throwIfNoEntry: false` keeps a
 * dangling one from throwing.
 *
 * Total by construction — it answers `false` rather than throwing when it
 * cannot tell. `throwIfNoEntry: false` suppresses only the "no entry" case;
 * `EACCES` on a locked-down directory, `ELOOP` on a symlink cycle, and a
 * disconnected network share named in `PATH` (routine on Windows) all still
 * throw. Every caller walks each `PATH` entry, so one unreadable directory
 * would otherwise abort the whole walk — and these run inside `tandem doctor`,
 * a LAN-reachable status route, and the launcher's crash handler, where an
 * exception is respectively a crashed CLI, a 500, and a dead server process.
 * "I could not read it" is not evidence of an install, so `false` is the
 * honest answer as well as the safe one.
 */
export function isFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

/**
 * Every filename `stem` can be installed under, in the order a shell would
 * find them.
 *
 * On Windows a native installer drops `<stem>.exe`, while an npm global writes
 * cmd-shim wrappers (`<stem>.cmd` / `<stem>.ps1`) plus a bare bash shim.
 * Probing `.exe` alone reports a perfectly usable npm-global install as absent
 * — the exact false negative this list exists to avoid. POSIX only ever has
 * the bare name.
 */
export function binNamesFor(platform: NodeJS.Platform, stem: string): string[] {
  return platform === "win32"
    ? [`${stem}.exe`, `${stem}.cmd`, `${stem}.bat`, `${stem}.ps1`, stem]
    : [stem];
}

export interface ResolveOnPathOptions {
  /** Override `process.env.PATH` — tests inject a controlled PATH. */
  pathOverride?: string;
  /** Override `process.platform` — tests exercise the win32 candidate set. */
  platformOverride?: NodeJS.Platform;
}

/**
 * First absolute path on PATH naming an existing file for `stem`, or `null`.
 *
 * First-hit semantics, matching what a shell would run. Pure filesystem probe —
 * deliberately no `execFile`/spawn, so there is no shell-injection surface and
 * no hang on a wedged binary.
 *
 * **This answers a question about THIS process's PATH, and callers must not
 * over-read it.** A GUI-launched MCP client does not inherit the PATH a
 * terminal-launched Tandem has, so a non-null result here is a necessary
 * condition for that client being able to spawn the name — never a sufficient
 * one. Both callers say so in their user-facing text.
 */
export function resolveOnPath(stem: string, opts: ResolveOnPathOptions = {}): string | null {
  return resolveManyOnPath([stem], opts)[stem] ?? null;
}

/**
 * {@link resolveOnPath} for several programs in ONE walk of PATH.
 *
 * Asking separately is the obvious shape and the wasteful one: programs that
 * travel together (`node` and `npx`, say) live in the same directory, so each
 * extra `resolveOnPath` re-`stat`s the very directories the previous call
 * already visited to find a sibling. On Windows that is 5 candidate names per
 * directory per program. Callers that ask about more than one program are on a
 * request path (`GET /api/diagnostics` runs the whole doctor with no caching),
 * so the difference is not academic.
 *
 * Same first-hit semantics and the same caveat as {@link resolveOnPath}: this
 * answers a question about THIS process's PATH.
 */
export function resolveManyOnPath(
  stems: string[],
  opts: ResolveOnPathOptions = {},
): Record<string, string | null> {
  const platform = opts.platformOverride ?? process.platform;
  const found: Record<string, string | null> = {};
  for (const stem of stems) found[stem] = null;
  let remaining = stems.length;

  // `delimiter` is the host's, not the override's. A platformOverride is a test
  // ergonomic; real callers never pass one, and tests pass a matching PATH.
  const pathVar = opts.pathOverride ?? process.env.PATH ?? "";
  for (const dir of pathVar.split(delimiter)) {
    if (dir.length === 0) continue;
    for (const stem of stems) {
      if (found[stem] !== null) continue;
      for (const name of binNamesFor(platform, stem)) {
        const candidate = join(dir, name);
        if (isFile(candidate)) {
          found[stem] = candidate;
          remaining--;
          break;
        }
      }
    }
    if (remaining === 0) break;
  }
  return found;
}

/** Convenience predicate over {@link resolveOnPath}. Same caveat applies. */
export function isOnPath(stem: string, opts: ResolveOnPathOptions = {}): boolean {
  return resolveOnPath(stem, opts) !== null;
}
