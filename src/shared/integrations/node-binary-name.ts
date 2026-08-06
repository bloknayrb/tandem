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

/** Reject UNC paths (both backslash and forward-slash variants) to prevent NTLM hash leaks. */
function hasUncPrefix(p: string): boolean {
  return p.startsWith("\\\\") || p.startsWith("//");
}

/** basename() on Linux doesn't treat `\` as a separator, so Windows-style paths
 *  like `C:\Program Files\node.exe` return the whole string. Split on both. */
function crossBasename(p: string): string {
  return p.split(/[/\\]/).pop() || "";
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
