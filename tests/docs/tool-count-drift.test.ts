import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Tool-count drift guard.
 *
 * The active-tool count has now gone stale twice — 27→28 (`docs/audit-v3-docs.md` F5) and
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
const MCP_DIR = join(REPO_ROOT, "src", "server", "mcp");

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

const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), "utf-8");

/**
 * Deprecated stubs return an MCP error instead of doing work, so they count toward the
 * total but not the active figure. Named explicitly (rather than inferred) because
 * un-stubbing one is a deliberate act that should force a look at this list — the
 * companion assertion below fails if a name here stops being a stub.
 */
const DEPRECATED_STUBS = ["tandem_highlight", "tandem_suggest", "tandem_flag"];

/**
 * `\s*` so a registration whose name sits on the following line is still matched. A Set
 * rather than a match count, so a duplicate registration can't inflate the total.
 */
function registeredToolNames(): Set<string> {
  return new Set(
    [...SRC.matchAll(/server\.(?:tool|registerTool)\(\s*"(tandem_\w+)"/g)].map((m) => m[1]),
  );
}

describe("MCP tool count stated in docs", () => {
  it("every named deprecated stub is registered and still returns DEPRECATED", () => {
    const registered = registeredToolNames();
    for (const name of DEPRECATED_STUBS) {
      expect(registered, `${name} is no longer registered`).toContain(name);
      // The stub body calls notifyDeprecatedTool with its own name; if it were un-stubbed
      // that call would go, and the active count below would be wrong by one.
      expect(SRC, `${name} no longer looks like a deprecated stub`).toContain(
        `notifyDeprecatedTool("${name}")`,
      );
    }
  });

  it("docs/mcp-tools.md states the counts that source actually registers", () => {
    const total = registeredToolNames().size;
    const active = total - DEPRECATED_STUBS.length;
    expect(read("docs/mcp-tools.md")).toContain(
      `Tandem exposes ${total} tools via MCP HTTP (${active} active, ${DEPRECATED_STUBS.length} deprecated stubs`,
    );
  });

  it("CLAUDE.md mirrors the same counts", () => {
    const total = registeredToolNames().size;
    const active = total - DEPRECATED_STUBS.length;
    const claudeMd = read("CLAUDE.md");
    expect(claudeMd).toContain(
      `All ${total} MCP tools (${active} active, ${DEPRECATED_STUBS.length} deprecated stubs)`,
    );
    expect(claudeMd).toContain(`${active} active MCP tools`);
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
 * Occurrences that are not drift, keyed by file. Both are statements about something other
 * than "how many tools Tandem has today", which is the only claim this guard protects:
 * a CI assertion threshold, and a roadmap entry recording the count at a past milestone.
 * Exempting the surrounding phrase rather than the bare number keeps the exemption narrow —
 * if the sentence changes, the guard speaks up again.
 */
const ALLOWED: Record<string, string[]> = {
  "docs/architecture.md": ["asserts ≥20 tools registered"],
  "docs/roadmap.md": ["(24 tools total)"],
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
