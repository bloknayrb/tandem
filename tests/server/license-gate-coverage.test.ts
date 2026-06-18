import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Surface-B registration-coverage gate (#1116, ADR-040, spec §8/§155).
 *
 * The `gatedTool` wrapper exists so a mutation tool can't silently ship
 * ungated — but that only holds if every mutation tool is actually wrapped.
 * Reviews of the initial implementation found two real fail-open gaps
 * (`tandem_removeAnnotation` and `tandem_scratchpad` left on `withErrorBoundary`
 * while their `/api` twins were gated). This test is the safety net that would
 * have caught them: it statically asserts each mutation tool is registered with
 * `gatedTool(...)` and NOT `withErrorBoundary(...)`, and — equally important —
 * that the read/escape-hatch tools stay UNgated so restricted users keep
 * read/save/export/accept-dismiss.
 *
 * Static rather than behavioural so it can't be fooled by a green run when a
 * tool is swapped back to `withErrorBoundary` (the regression class is "wrong
 * wrapper at registration"). The regexes tolerate the wrapper name and the tool
 * name being on separate lines (e.g. `tandem_edit`).
 */

const MCP_DIR = join(import.meta.dirname, "..", "..", "src", "server", "mcp");

/** Concatenate every MCP source file so a tool is found regardless of its home. */
function allMcpSource(): string {
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

const SRC = allMcpSource();

/** `\s*` so `gatedTool(\n  "tandem_edit"` matches as well as one-line forms. */
const gatedWith = (name: string): RegExp => new RegExp(`gatedTool\\(\\s*"${name}"`);
const boundaryWith = (name: string): RegExp => new RegExp(`withErrorBoundary\\(\\s*"${name}"`);

// Mutation tools that MUST be license-gated. Each maps to a server-side Y.Doc
// mutation reachable over MCP (which bypasses Surface A's connection.readOnly),
// so the MCP side has to be gated alongside its /api twin. The deprecated stubs
// (suggest/highlight/flag) are gated for consistency so un-stubbing them later
// can't silently ship a hole.
const GATED = [
  "tandem_edit",
  "tandem_appendContent",
  "tandem_scratchpad",
  "tandem_comment",
  "tandem_suggest",
  "tandem_highlight",
  "tandem_flag",
  "tandem_editAnnotation",
  "tandem_annotationReply",
  "tandem_removeAnnotation",
  "tandem_applyChanges",
  "tandem_restoreBackup",
];

// Read / escape-hatch tools that MUST stay ungated so a restricted user can
// still read, save, export, and accept/dismiss existing work. `resolveAnnotation`
// is the subtle one: accept/dismiss only flips annotation status, it never
// writes document content, so gating it would needlessly block triage.
const UNGATED = [
  "tandem_resolveAnnotation",
  "tandem_save",
  "tandem_open",
  "tandem_getAnnotations",
  "tandem_getTextContent",
  "tandem_getOutline",
  "tandem_exportAnnotations",
];

describe("Surface B gated-tool registration coverage", () => {
  it.each(GATED)("%s is wrapped in gatedTool, not withErrorBoundary", (name) => {
    expect(gatedWith(name).test(SRC), `${name} should be registered with gatedTool`).toBe(true);
    expect(
      boundaryWith(name).test(SRC),
      `${name} must NOT be registered with withErrorBoundary (license fail-open)`,
    ).toBe(false);
  });

  it.each(UNGATED)("%s stays ungated (read/escape-hatch)", (name) => {
    expect(
      boundaryWith(name).test(SRC),
      `${name} should stay on withErrorBoundary (escape hatch)`,
    ).toBe(true);
    expect(
      gatedWith(name).test(SRC),
      `${name} must NOT be gated — it would break the read-only escape hatch`,
    ).toBe(false);
  });
});
