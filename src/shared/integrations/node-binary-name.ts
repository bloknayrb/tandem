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
import { rejectUnsafeWindowsPrefix } from "../windows-path-safety.js";

/** `node-sidecar-<triple>` is the desktop app's bundled Node — accepted so the
 *  Tauri build can point the channel shim at its own runtime. */
const VALID_NODE_BASENAME_RE = /^node(-sidecar(-[a-z0-9_-]+)?)?(\.exe)?$/;

/** Validate that a nodeBinary path points to a Node.js binary, not an arbitrary executable. */
export function isValidNodeBinary(nodeBinary: string): boolean {
  if (!nodeBinary) return false;
  if (nodeBinary.includes("..")) return false;
  // UNC and device-namespace prefixes leak NTLM hashes on Windows. This is the
  // last line of a basename allowlist, not the security boundary — but it is
  // the same rule every other caller uses, so it stays the same code.
  if (rejectUnsafeWindowsPrefix(nodeBinary) !== null) return false;
  return VALID_NODE_BASENAME_RE.test(crossBasename(nodeBinary));
}
