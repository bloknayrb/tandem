/**
 * Collapse user-identifying directory prefixes out of a string.
 *
 * The username is the leak: `/Users/bryan/...`, `C:\Users\bryan\...`,
 * `/home/bryan/...`. Callers that publish text a user did not individually
 * review — a prefilled public issue body, a crash report — need this.
 *
 * Two passes, because neither alone is sufficient:
 *
 *  1. **Literal roots.** `$HOME` is the common case, but not the only one:
 *     Tandem's app-data dir honours `TANDEM_APP_DATA_DIR`, `XDG_DATA_HOME` and
 *     `LOCALAPPDATA`, any of which can point outside home (redirected Windows
 *     profiles, a custom XDG root on another volume). A caller passes those in
 *     as extra roots.
 *  2. **Generic user segments**, for paths under no root we know — another
 *     account's directory, or a path that arrived inside a raw `fs` error
 *     message (`EACCES: permission denied, scandir '/home/bryan/…'`), which no
 *     prefix list can be relied on to cover.
 *
 * Each root match requires a separator or end-of-string after it, so a short
 * root like `/root` cannot swallow the prefix of an unrelated `/rootfs/...`.
 */

export interface RedactRoot {
  /** Absolute path to collapse. Ignored when empty or degenerate. */
  path: string;
  /** What to replace it with, e.g. `~` or `<app-data>`. */
  as: string;
}

/**
 * Escape a literal for embedding in a `RegExp` source.
 *
 * Exported because `scripts/screenshots/redact-account.ts` builds its own
 * patterns from `os.homedir()` segments and needs exactly this; that module
 * documents why it does not reuse `redactUserPaths` itself.
 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Reject roots so short that replacing them would corrupt unrelated paths. */
function isUsableRoot(path: string): boolean {
  return path.length > 1 && path !== "/" && !/^[A-Za-z]:[/\\]?$/.test(path);
}

function normalize(path: string): string {
  return path.replace(/[/\\]+$/, "");
}

/**
 * Replace `roots` and then any remaining user directory segment.
 *
 * A root nested inside another is dropped rather than applied: an app-data dir
 * that sits inside `$HOME` should read `~/.local/share/tandem`, which is both
 * safe and more useful than an opaque placeholder.
 */
export function redactUserPaths(input: string, roots: RedactRoot[]): string {
  const seen = new Set<string>();
  const usable: RedactRoot[] = [];

  for (const root of roots) {
    if (!root.path) continue;
    const path = normalize(root.path);
    if (!isUsableRoot(path) || seen.has(path)) continue;
    seen.add(path);
    usable.push({ path, as: root.as });
  }

  // Drop any root nested inside another: a default-located app-data dir should
  // render `~/.local/share/tandem`, which is both safe and more useful than an
  // opaque `<app-data>`. Only the outermost root survives.
  const outermost = usable.filter(
    (root) =>
      !usable.some(
        (other) =>
          other !== root &&
          (root.path.startsWith(`${other.path}/`) || root.path.startsWith(`${other.path}\\`)),
      ),
  );

  // Longest first among the survivors, which are now mutually disjoint; this
  // only matters for deterministic output.
  outermost.sort((a, b) => b.path.length - a.path.length);

  let out = input;
  for (const { path, as } of outermost) {
    const variants = [...new Set([path, path.replace(/\\/g, "/")])];
    // Windows paths are case-insensitive, and the drive letter's case varies by
    // which API produced the string.
    const flags = process.platform === "win32" ? "gi" : "g";
    const pattern = new RegExp(`(?:${variants.map(escapeRegExp).join("|")})(?![^/\\\\])`, flags);
    out = out.replace(pattern, as);
  }

  // Anything still carrying a user directory came from a path we were not told
  // about — most often the absolute path inside a raw `fs` error message.
  return out
    .replace(/(\/Users\/)[^/\\]+/g, "$1[user]")
    .replace(/(\/home\/)[^/\\]+/g, "$1[user]")
    .replace(/([A-Za-z]:\\Users\\)[^\\]+/g, "$1[user]");
}

/**
 * The roots worth redacting from a Tandem diagnostics report: every source
 * `resolveAppDataDir()` consults, plus both spellings of the home directory
 * (`os.homedir()` and `$HOME`/`%USERPROFILE%` can disagree under `sudo` or a
 * launcher that overrides the environment, and a mismatch would otherwise
 * defeat the whole pass).
 */
export function diagnosticsRedactRoots(homedir: string, env: NodeJS.ProcessEnv): RedactRoot[] {
  return [
    { path: homedir, as: "~" },
    { path: env.HOME ?? "", as: "~" },
    { path: env.USERPROFILE ?? "", as: "~" },
    { path: env.TANDEM_APP_DATA_DIR ?? "", as: "<app-data>" },
    { path: env.XDG_DATA_HOME ?? "", as: "<app-data>" },
    { path: env.LOCALAPPDATA ?? "", as: "<app-data>" },
  ];
}
