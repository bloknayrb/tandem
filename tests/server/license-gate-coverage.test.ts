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
  // `tandem_open` stays on withErrorBoundary so PLAIN open is the read/export
  // escape hatch — but it carries an IN-HANDLER gate on the `force === true`
  // sub-path (which runs clearAndReload → wipes the durable annotation store).
  // The wrapper-based regex below can't see that sub-path gate; it's covered
  // behaviorally in license-force-open-gate.test.ts (#1116 H1).
  "tandem_open",
  "tandem_getAnnotations",
  "tandem_getTextContent",
  "tandem_getOutline",
  "tandem_exportAnnotations",
  // Navigation / inspection / chat / file-management tools. None mutate Y.Doc
  // *content*: reads, outline, and search are pure; tandem_convertToMarkdown writes
  // a separate export file; tandem_rename is a filesystem op (not a content write);
  // tandem_reply/checkInbox/getActivity touch CTRL_ROOM (chat/awareness), which
  // stays writable when restricted; close/switch/list are tab management. Enumerated
  // so the drift-guard ALSO catches a read tool being *accidentally gated* (which
  // would break the escape hatch), not just a mutator being left ungated.
  "tandem_status",
  "tandem_listDocuments",
  "tandem_switchDocument",
  "tandem_close",
  "tandem_rename",
  "tandem_convertToMarkdown",
  "tandem_search",
  "tandem_resolveRange",
  "tandem_getContext",
  "tandem_getActivity",
  "tandem_checkInbox",
  "tandem_reply",
  // Read-only boot/connection health (#1174 gap #2). Deliberately ungated: an
  // agent must be able to self-diagnose a broken connection even when the
  // license gate is restricted — diagnostics never mutate.
  "tandem_diagnostics",
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

  // Completeness: the two lists above only protect the tools they NAME. Without
  // this, a future mutator registered with `withErrorBoundary` and forgotten in
  // both lists would ship ungated AND green — exactly the fail-open class the
  // suite claims to prevent. Assert every wrapped `tandem_*` registration is
  // classified into exactly one list (catches a new ungated mutator AND a new
  // reader accidentally gated). `\s*` so multi-line registrations are captured;
  // gatedTool's internal `withErrorBoundary(toolName` uses a variable, not a
  // string literal, so it isn't matched.
  it("every registered tandem_* tool is classified as GATED or UNGATED", () => {
    const registered = new Set(
      [...SRC.matchAll(/(?:gatedTool|withErrorBoundary)\(\s*"(tandem_\w+)"/g)].map((m) => m[1]),
    );
    const classified = new Set([...GATED, ...UNGATED]);
    const unclassified = [...registered].filter((n) => !classified.has(n));
    const stale = [...classified].filter((n) => !registered.has(n));
    expect(
      unclassified,
      `registered but unclassified (license fail-open risk): ${unclassified}`,
    ).toEqual([]);
    expect(stale, `classified but no longer registered (stale list entry): ${stale}`).toEqual([]);
  });
});
