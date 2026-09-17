import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Static reads of the MCP registration surface, shared by every suite that
 * derives a tool set from source rather than from a booted server.
 *
 * There are two such derivations — `tests/docs/tool-count-drift.test.ts` and
 * `tests/server/license-gate-coverage.test.ts` — and each held its own copy of
 * both the walker and the registration regex. A comment saying the copies match
 * cannot keep them matching; one binding can.
 */

const MCP_DIR = join(import.meta.dirname, "..", "..", "src", "server", "mcp");

/** Concatenate every MCP source file so a tool is found regardless of its home. */
export function allMcpSource(): string {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        parts.push(readFileSync(full, "utf-8"));
      }
    }
  };
  walk(MCP_DIR);
  return parts.join("\n");
}

/**
 * Every `tandem_*` name registered in `src`, keyed on the REGISTRATION call
 * rather than on any wrapper around it.
 *
 * `\s*` so a registration whose name sits on the following line is still
 * matched. A Set rather than a match count, so a duplicate registration can't
 * inflate the total.
 */
export function registeredToolNames(src: string): Set<string> {
  return new Set(
    [...src.matchAll(/server\.(?:tool|registerTool)\(\s*"(tandem_\w+)"/g)].map((m) => m[1]),
  );
}

/**
 * Every `tandem_*` name that appears at a WRAPPER call — `gatedTool("…")` or
 * `withErrorBoundary("…")`.
 *
 * The companion to `registeredToolNames`, and neither subsumes the other. The
 * registration form is receiver-anchored (`server.tool(`), so a tool registered
 * on a differently-named receiver — `mcp.tool("tandem_foo", …)` — is invisible
 * to it; the wrapper form is receiver-agnostic but blind to a registration with
 * no wrapper at all. A completeness net that has to fail CLOSED on an unknown
 * tool takes the union of the two.
 *
 * `gatedTool`'s own internal `withErrorBoundary(toolName` passes a variable, not
 * a string literal, so it is not matched here.
 */
export function wrappedToolNames(src: string): Set<string> {
  return new Set(
    [...src.matchAll(/(?:gatedTool|withErrorBoundary)\(\s*"(tandem_\w+)"/g)].map((m) => m[1]),
  );
}
