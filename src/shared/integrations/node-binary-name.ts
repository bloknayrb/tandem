/**
 * Is this path allowed to be spawned as Node?
 *
 * A pure string predicate with no dependencies, deliberately. It used to live
 * in `server/mcp/routes/_shared.ts` next to the express `Handler` type, which
 * made every consumer drag express's types along — harmless for a route module,
 * but `integrations/node-binary.ts` and `cli/doctor.ts` need this rule and have
 * nothing to do with HTTP. Keeping it dependency-free is what lets the writer
 * (`buildMcpEntries`), the re-reader (`existing-config.ts`) and the diagnostic
 * (`tandem doctor`) share one definition instead of three.
 *
 * The rule is a basename allowlist, not a path check: an MCP `command` is
 * spawned verbatim by the client, so this is what stops a generated or
 * hand-edited config naming an arbitrary executable.
 */

import { crossBasename } from "../cross-basename.js";

/**
 * Reject UNC paths (both backslash and forward-slash variants) to prevent NTLM
 * hash leaks.
 *
 * Deliberately private, and deliberately weaker than
 * `server/file-io/windows-path-safety.ts#rejectUnsafeWindowsPrefix` — which
 * also covers the `\\?\` and `\\.\` device-namespace forms and is what server
 * callers should use. This copy exists only because this module is in
 * `src/shared/` and must not import from `src/server/`; it is the last line of
 * a basename allowlist, not the security boundary.
 */
function hasUncPrefix(p: string): boolean {
  return p.startsWith("\\\\") || p.startsWith("//");
}

/** `node-sidecar-<triple>` is the desktop app's bundled Node — accepted so the
 *  Tauri build can point the channel shim at its own runtime. */
const VALID_NODE_BASENAME_RE = /^node(-sidecar(-[a-z0-9_-]+)?)?(\.exe)?$/;

/** Validate that a nodeBinary path points to a Node.js binary, not an arbitrary executable. */
export function isValidNodeBinary(nodeBinary: string): boolean {
  if (!nodeBinary) return false;
  if (nodeBinary.includes("..")) return false;
  if (hasUncPrefix(nodeBinary)) return false;
  return VALID_NODE_BASENAME_RE.test(crossBasename(nodeBinary));
}

/**
 * Every filename `npx` ships under. Windows npm writes cmd-shim wrappers, so a
 * hand-edited config there can legitimately name `npx.cmd`. Tandem itself only
 * ever *writes* the absolute form on POSIX (see `buildStdioTandemEntry` for
 * why), but the re-reader must not reject a shape a user could reasonably have.
 */
const VALID_NPX_BASENAME_RE = /^npx(\.(exe|cmd|bat|ps1))?$/;

/**
 * Is this command the `npx` launcher — bare, or named by absolute path?
 *
 * Same basename-allowlist rule as {@link isValidNodeBinary}, for the `tandem`
 * entry's fallback tiers. An absolute `npx` is what `buildStdioTandemEntry`
 * emits when it cannot build the preferred absolute-Node shape but can still
 * find `npx` on this process's PATH; a bare `npx` is the floor tier. Both must
 * re-read as valid, or the wizard would flag Tandem's own freshly written entry
 * and pre-select `apply: "skip"`.
 */
export function isValidNpxCommand(command: string): boolean {
  if (!command) return false;
  if (command.includes("..")) return false;
  if (hasUncPrefix(command)) return false;
  return VALID_NPX_BASENAME_RE.test(crossBasename(command));
}
