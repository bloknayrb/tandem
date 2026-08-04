/**
 * The environment Tandem hands a Codex child process.
 *
 * Three call sites spawn something Codex-shaped, and all three had written the
 * same nine-key loop by hand: `server/integrations/codex-config.ts` (the
 * `codex mcp add/get` shell-out), `server/launcher/supervisor.ts` (the managed
 * worker, which layers its own `TANDEM_*` keys on top), and
 * `codex-agent/app-server-client.ts` (the `codex app-server` child). Three
 * copies of a security-relevant allowlist is three chances for one to drift
 * open — the point of an allowlist is that adding a key is a decision, and a
 * decision made in one copy silently isn't made in the others.
 *
 * **This is not the installers' allowlist.** `install-claude-cli.ts` passes a
 * deliberately smaller set plus a provider-specific base (`CI=1` for Claude,
 * `CODEX_NON_INTERACTIVE=1` for Codex) and omits `TEMP`/`TMP`/`CODEX_HOME`,
 * because a one-shot install script has no business reading the user's Codex
 * config home. Folding it in here would widen it. Keep them separate.
 */

/**
 * Why each key is here:
 *   PATH                      — resolve the `codex` binary and its own tooling
 *   HOME / USERPROFILE        — POSIX / Windows home, for `~`-relative config
 *   LOCALAPPDATA / APPDATA    — Windows config roots (Codex installs under
 *                               `%LOCALAPPDATA%\Programs\OpenAI\Codex`)
 *   SystemRoot                — Windows DLL resolution; spawn fails without it
 *   TEMP / TMP                — scratch space for the child's own writes
 *   CODEX_HOME                — explicit Codex config-dir override, when set
 *
 * Everything else — tokens, proxies, cloud credentials, the user's whole shell
 * environment — is deliberately withheld.
 */
export const CODEX_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "SystemRoot",
  "TEMP",
  "TMP",
  "CODEX_HOME",
] as const;

/**
 * Build a Codex child's environment: `extra` first, then the allowlisted keys
 * copied from this process.
 *
 * Order is deliberate — a caller's explicit `extra` value is what it meant to
 * set, but the allowlist is the security boundary, so a caller cannot smuggle
 * a `PATH` past it by passing one in `extra`. No current caller tries; the
 * ordering is what keeps that true.
 */
export function codexChildEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...extra };
  for (const key of CODEX_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
