import { describe, expect, it } from "vitest";
import { allMcpSource, registeredToolNames, wrappedToolNames } from "../helpers/mcp-source.js";

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
 * read/save/export. (Accept/dismiss left that set in #1788 — see the
 * `tandem_resolveAnnotation` row.)
 *
 * Static rather than behavioural so it can't be fooled by a green run when a
 * tool is swapped back to `withErrorBoundary` (the regression class is "wrong
 * wrapper at registration"). The regexes tolerate the wrapper name and the tool
 * name being on separate lines (e.g. `tandem_edit`).
 */

const SRC = allMcpSource();

/** `\s*` so `gatedTool(\n  "tandem_edit"` matches as well as one-line forms. */
const gatedWith = (name: string): RegExp => new RegExp(`gatedTool\\(\\s*"${name}"`);
const boundaryWith = (name: string): RegExp => new RegExp(`withErrorBoundary\\(\\s*"${name}"`);

type ToolGate = { name: string; gate: "gated" | "ungated"; why: string };

/**
 * One list, one row per tool, so widening the gated set (decision F / #1788) is a
 * one-row edit rather than a move between two arrays with two comment blocks.
 *
 * List-scoped rationale, `gated`: each maps to a server-side Y.Doc mutation
 * reachable over MCP (which bypasses Surface A's connection.readOnly), so the MCP
 * side has to be gated alongside its /api twin. The deprecated stubs
 * (suggest/highlight/flag) are gated for consistency so un-stubbing them later
 * can't silently ship a hole.
 *
 * List-scoped rationale, `ungated`: read / escape-hatch tools that MUST stay
 * ungated so a restricted user can still read, save and export existing work.
 * Accept/dismiss is NOT in that set — see the `tandem_resolveAnnotation` row. Navigation / inspection / chat / file-management tools are here
 * too: none mutate Y.Doc *content* — reads, outline and search are pure;
 * tandem_convertToMarkdown writes a separate export file; tandem_rename is a
 * filesystem op (not a content write); tandem_reply/checkInbox/getActivity touch
 * CTRL_ROOM (chat/awareness), which stays writable when restricted;
 * close/switch/list are tab management. Enumerated so the drift-guard ALSO catches
 * a read tool being *accidentally gated* (which would break the escape hatch), not
 * just a mutator being left ungated.
 */
const TOOL_GATES: ToolGate[] = [
  { name: "tandem_edit", gate: "gated", why: "writes document content" },
  { name: "tandem_appendContent", gate: "gated", why: "writes document content" },
  { name: "tandem_editList", gate: "gated", why: "writes document content" },
  { name: "tandem_scratchpad", gate: "gated", why: "writes document content" },
  { name: "tandem_comment", gate: "gated", why: "writes the annotation store" },
  { name: "tandem_suggest", gate: "gated", why: "deprecated stub, gated for consistency" },
  { name: "tandem_highlight", gate: "gated", why: "deprecated stub, gated for consistency" },
  { name: "tandem_flag", gate: "gated", why: "deprecated stub, gated for consistency" },
  { name: "tandem_editAnnotation", gate: "gated", why: "writes the annotation store" },
  { name: "tandem_annotationReply", gate: "gated", why: "writes the annotation store" },
  { name: "tandem_removeAnnotation", gate: "gated", why: "writes the annotation store" },
  { name: "tandem_applyChanges", gate: "gated", why: "rewrites document content" },
  { name: "tandem_restoreBackup", gate: "gated", why: "replaces document content" },
  {
    name: "tandem_resolveAnnotation",
    gate: "gated",
    why: "decision F (#1788, #1827): restricted is SYMMETRIC read-only for annotation CONTENT and STATUS writes. Accept/dismiss is a write to the document room's annotation map, which Surface A already refuses from the browser when restricted — leaving the MCP twin ungated let Claude triage a document its own user cannot. Supersedes the earlier 'only flips annotation status, gating it would needlessly block triage', which weighed the write and not the asymmetry. The one recorded exception is POST /api/mode/release — see its row in license-gate-api-coverage.test.ts and the open question on #1788. No /api twin exists for resolve (api-paths.ts has reply + remove only), so Critical Rule 9's second half is satisfied by construction",
  },
  { name: "tandem_save", gate: "ungated", why: "escape hatch: writes the user's own file out" },
  {
    name: "tandem_open",
    gate: "ungated",
    why: "stays on withErrorBoundary so PLAIN open is the read/export escape hatch — but it carries an IN-HANDLER gate on the `force === true` sub-path (which runs clearAndReload → discards the in-memory annotation, awareness and content maps and rebuilds the document from disk). The wrapper-based regex below can't see that sub-path gate; it's covered behaviorally in license-force-open-gate.test.ts (#1116 H1)",
  },
  { name: "tandem_getAnnotations", gate: "ungated", why: "read" },
  { name: "tandem_getTextContent", gate: "ungated", why: "read" },
  { name: "tandem_getOutline", gate: "ungated", why: "read" },
  { name: "tandem_exportAnnotations", gate: "ungated", why: "escape hatch: export" },
  { name: "tandem_status", gate: "ungated", why: "inspection" },
  { name: "tandem_listDocuments", gate: "ungated", why: "tab management" },
  { name: "tandem_switchDocument", gate: "ungated", why: "tab management" },
  { name: "tandem_close", gate: "ungated", why: "tab management" },
  { name: "tandem_rename", gate: "ungated", why: "filesystem op, not a content write" },
  { name: "tandem_convertToMarkdown", gate: "ungated", why: "writes a separate export file" },
  { name: "tandem_search", gate: "ungated", why: "read" },
  { name: "tandem_resolveRange", gate: "ungated", why: "read" },
  { name: "tandem_getContext", gate: "ungated", why: "read" },
  { name: "tandem_getActivity", gate: "ungated", why: "CTRL_ROOM awareness read" },
  { name: "tandem_checkInbox", gate: "ungated", why: "CTRL_ROOM awareness read" },
  { name: "tandem_reply", gate: "ungated", why: "CTRL_ROOM chat, writable when restricted" },
  {
    name: "tandem_diagnostics",
    gate: "ungated",
    why: "read-only boot/connection health (#1174 gap #2). Deliberately ungated: an agent must be able to self-diagnose a broken connection even when the license gate is restricted — diagnostics never mutate",
  },
];

const GATED = TOOL_GATES.filter((r) => r.gate === "gated").map((r) => r.name);
const UNGATED = TOOL_GATES.filter((r) => r.gate === "ungated").map((r) => r.name);

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

  // Completeness: `TOOL_GATES` only protects the tools it NAMES. Without this, a
  // future mutator forgotten in the list would ship ungated AND green — exactly
  // the fail-open class the suite claims to prevent.
  //
  // The discovered set is the UNION of two derivations, because each is blind to
  // a shape the other sees and this net has to fail CLOSED on both (#1784):
  //   - REGISTRATION (`server.tool("tandem_…"`): sees a tool with no wrapper at
  //     all, which a wrapper-derived set reads as "not a tool" and lets ship
  //     ungated and green.
  //   - WRAPPER (`gatedTool("tandem_…"` / `withErrorBoundary("tandem_…"`):
  //     receiver-agnostic, so it sees `mcp.tool("tandem_…", …, withErrorBoundary(…))`
  //     — a registration on any receiver not named `server`, which the
  //     registration regex is anchored against.
  // Today the two sets are identical (all 33 names), so the union costs nothing
  // and closes both shapes; "no-op on current source" is not a bound on a drift
  // guard whose whole subject is future source.
  //
  // Two bounds remain on how wide a green run reads. The scan root is
  // `src/server/mcp/**` only, so a registration outside it is unseen; and both
  // derivations key on a string-literal `"tandem_…"` name, so a tool whose name
  // is a `const` at both its registration and its wrapper is unseen too
  // (measured absent — all 33 carry literals). The review inventory in
  // `docs/licensing-explained.md`, not these regexes, is what covers those shapes.
  it("every registered tandem_* tool is classified as GATED or UNGATED", () => {
    const registered = new Set([...registeredToolNames(SRC), ...wrappedToolNames(SRC)]);
    const classified = new Set(TOOL_GATES.map((r) => r.name));
    const unclassified = [...registered].filter((n) => !classified.has(n));
    const stale = [...classified].filter((n) => !registered.has(n));
    expect(
      unclassified,
      `registered but unclassified (license fail-open risk): ${unclassified}`,
    ).toEqual([]);
    expect(stale, `classified but no longer registered (stale list entry): ${stale}`).toEqual([]);
  });

  // Synthetic negatives for the two derivations the check above depends on. They
  // call the same helpers — re-spelling the patterns here would be a tautology
  // that passes while the check itself stayed half-blind.
  it("the derivation sees a registration with no wrapper", () => {
    const names = registeredToolNames(
      'server.tool("tandem_zzz", {}, async () => {});\nserver.registerTool("tandem_yyy", {}, h);',
    );
    expect([...names].sort()).toEqual(["tandem_yyy", "tandem_zzz"]);
  });

  it("the derivation sees a wrapped registration on a non-`server` receiver", () => {
    const src = 'mcp.tool("tandem_zzz", {}, withErrorBoundary("tandem_zzz", handler));';
    expect([...registeredToolNames(src)], "registration regex is receiver-anchored").toEqual([]);
    expect([...new Set([...registeredToolNames(src), ...wrappedToolNames(src)])]).toEqual([
      "tandem_zzz",
    ]);
  });
});
