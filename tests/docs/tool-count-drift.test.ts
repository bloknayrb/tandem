import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allMcpSource, registeredToolNames } from "../helpers/mcp-source.js";

/**
 * Tool-count drift guard.
 *
 * The active-tool count has now gone stale twice — 27→28 (`docs/archive/audit-v3-docs.md` F5) and
 * 28→29 — each time across nine or more documentation files, because the number was
 * embedded in a paragraph that several docs quote verbatim. R7 of that same audit proposed
 * the structural fix: state the count in ONE reference file and say "the MCP tools"
 * everywhere else. This test enforces both halves of that.
 *
 * Positive half: the counts printed in `docs/mcp-tools.md` (the reference) and `CLAUDE.md`
 * (the contributor mirror) match what `src/server/mcp/` actually registers.
 *
 * Negative half — the load-bearing one: the files that were de-numbered must not silently
 * reacquire a count. Without it this guard would go green while eight other files drift,
 * which is worse than no guard because it reads as solved.
 *
 * Static source scanning rather than booting a server, matching the rationale in
 * `tests/server/license-gate-coverage.test.ts`: the regression class is "a doc says a
 * number that registration no longer supports", and a static read cannot be fooled by a
 * green run.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const SRC = allMcpSource();

const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), "utf-8");

/**
 * `.docx`-only tools that are not registered while `.docx` ships dark (ADR-053). The
 * source scan still sees them, so they count toward the total but not the active figure,
 * and a release exposes TOTAL − DARK. The companion assertion below fails if a name here
 * stops being gated, which is what should force a look at this list on the re-enable.
 */
const DARK_TOOLS = ["tandem_applyChanges", "tandem_convertToMarkdown"];

const REGISTERED = registeredToolNames(SRC);
const TOTAL = REGISTERED.size;
const ACTIVE = TOTAL - DARK_TOOLS.length;
// A release exposes every active tool; the docs state both figures.
const EXPOSED = ACTIVE;

describe("MCP tool count stated in docs", () => {
  it("every named dark tool is registered and gated on the .docx flag", () => {
    for (const name of DARK_TOOLS) {
      expect(REGISTERED, `${name} is no longer registered`).toContain(name);
      expect(SRC, `${name} is no longer gated on docxEnabled()`).toMatch(
        new RegExp(String.raw`if \(docxEnabled\(\)\)\s*server\.tool\(\s*"${name}"`),
      );
    }
  });

  it("docs/mcp-tools.md states the counts that source actually registers", () => {
    expect(read("docs/mcp-tools.md")).toContain(
      `Tandem registers ${TOTAL} tools in source (${ACTIVE} active, ${DARK_TOOLS.length} shipped dark); ` +
        `a release exposes ${EXPOSED} over MCP HTTP`,
    );
  });

  it("CLAUDE.md mirrors the same counts", () => {
    const claudeMd = read("CLAUDE.md");
    expect(claudeMd).toContain(
      `All ${TOTAL} MCP tools (${ACTIVE} active, ${DARK_TOOLS.length} shipped dark)`,
    );
    expect(claudeMd).toContain(`${ACTIVE} active MCP tools`);
  });
});

/**
 * Files deliberately de-numbered so the count lives in one place. `docs/decisions.md` is
 * excluded: its ADR-019 rationale and ADR-038 Context legitimately record counts that were
 * true when written, and rewriting history to match today's number is the opposite of what
 * an ADR is for.
 */
const DE_NUMBERED = [
  "README.md",
  "docs/architecture.md",
  "docs/positioning.md",
  "docs/roadmap.md",
  "docs/user-guide.md",
  "docs/workflows.md",
];

/**
 * Matches "28 tools", "29 active tools", "31 MCP tools", "28 active MCP tools" — the four
 * shapes the two historical drifts actually took. Deliberately broad: a false positive
 * here costs one line of prose, a false negative costs another cross-repo drift.
 */
const COUNT_PATTERN = /\b\d+\s+(?:active\s+)?(?:MCP\s+)?tools\b/g;

/**
 * Occurrences that are not drift, keyed by file. Each is a statement about something other
 * than "how many tools Tandem has today", which is the only claim this guard protects;
 * the one left is a CI assertion threshold. Exempting the surrounding phrase rather than
 * the bare number keeps the exemption narrow — if the sentence changes, the guard speaks up
 * again. (The roadmap's past-milestone count moved to the unscanned roadmap-history.md
 * snapshot on 2026-09-28.)
 */
const ALLOWED: Record<string, string[]> = {
  "docs/architecture.md": ["asserts ≥20 tools registered"],
};

describe("de-numbered docs do not reacquire a tool count", () => {
  it.each(DE_NUMBERED)("%s states no tool count", (relative) => {
    let text = read(relative);
    for (const phrase of ALLOWED[relative] ?? []) {
      expect(text, `stale exemption in ${relative}: "${phrase}" no longer appears`).toContain(
        phrase,
      );
      text = text.split(phrase).join("");
    }
    const offenders = [...text.matchAll(COUNT_PATTERN)].map((m) => m[0]);
    expect(
      offenders,
      `${relative} states a tool count (${offenders.join(", ")}). The count belongs in ` +
        `docs/mcp-tools.md only — say "the MCP tools" here. See ADR-038 and audit-v3-docs R7.`,
    ).toEqual([]);
  });
});

/**
 * Docs a model or contributor reads as the tool reference must name only tools that
 * exist. A removed tool left in prose is invisible to every count check above, and an
 * agent that follows it gets an unknown-tool error with nothing to explain it.
 */
const NAMES_ONLY_REAL_TOOLS = [
  "AGENTS.md",
  "README.md",
  "docs/mcp-tools.md",
  "docs/workflows.md",
  "skills/tandem/SKILL.md",
];

describe("tool reference docs name only registered tools", () => {
  it.each(NAMES_ONLY_REAL_TOOLS)("%s names no unregistered tandem_* tool", (relative) => {
    const named = new Set([...read(relative).matchAll(/\btandem_\w+\b/g)].map((m) => m[0]));
    const unknown = [...named].filter((name) => !REGISTERED.has(name));
    expect(unknown, `${relative} names tools that are not registered in src`).toEqual([]);
  });
});
