import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * #1910 — `.claude/settings.json`'s `check-token-violation.sh` entry carries
 * `"continueOnBlock": true`, and that flag has been silently DROPPED TWICE by
 * the harness's own normalization of hook commands to the
 * `"$CLAUDE_PROJECT_DIR/..."` path form: `0f8f983e` added it, a later harness
 * rewrite dropped it, `2e5854e9` restored it, and it was dropped a second time
 * (observed 2026-09-08, left unstaged, never committed). Each drop is silent —
 * nothing fails, no test notices; the only signal was a stray
 * `M .claude/settings.json` during unrelated work.
 *
 * **What the flag does, per the script's own header** (`check-token-violation.sh:4`):
 * "Exit 2 + continueOnBlock = Claude self-corrects the violation; exit 0 =
 * clean." The script exits `2` on a violation (`:40`); `continueOnBlock: true`
 * is what turns that exit-2 into an in-turn self-correction rather than a
 * halted turn. This is the documented EXCEPTION to the blanket
 * "`PostToolUse` hooks exit 0 (warn only)" line in `CLAUDE.md` and
 * `.claude/hooks/README.md`.
 *
 * This test pins the flag's PRESENCE — not a contested account of *why* it
 * matters (the repo's own two restoring commits frame that differently, and
 * nothing here adjudicates that disagreement).
 */

const SETTINGS_PATH = path.resolve(__dirname, "../../.claude/settings.json");

const HOOK_COMMAND_FRAGMENT = "check-token-violation.sh";

type HookEntry = { type: string; command?: string; continueOnBlock?: unknown };
type MatcherEntry = { matcher?: string; hooks?: HookEntry[] };
type Settings = { hooks?: Record<string, MatcherEntry[]> };

function loadSettings(): Settings {
  const raw = readFileSync(SETTINGS_PATH, "utf-8");
  return JSON.parse(raw) as Settings;
}

/**
 * Every hook entry anywhere under `hooks`, whatever lifecycle it is nested
 * under, whose `command` mentions the script — so a copy into `PreToolUse`
 * (which already blocks by exit code regardless of `continueOnBlock`) is
 * caught rather than leaving a `PostToolUse`-only count silently at one while
 * the hook's actual behavior changed underneath it.
 */
function findTokenViolationHooks(
  settings: Settings,
): Array<{ lifecycle: string; entry: HookEntry }> {
  const found: Array<{ lifecycle: string; entry: HookEntry }> = [];
  for (const [lifecycle, matcherEntries] of Object.entries(settings.hooks ?? {})) {
    for (const matcherEntry of matcherEntries ?? []) {
      for (const entry of matcherEntry.hooks ?? []) {
        if (typeof entry.command === "string" && entry.command.includes(HOOK_COMMAND_FRAGMENT)) {
          found.push({ lifecycle, entry });
        }
      }
    }
  }
  return found;
}

describe("check-token-violation.sh stays advisory (#1910)", () => {
  let hits: Array<{ lifecycle: string; entry: HookEntry }>;

  beforeAll(() => {
    hits = findTokenViolationHooks(loadSettings());
  });

  it("appears exactly once across every hook lifecycle", () => {
    expect(
      hits.length,
      `expected exactly one hook entry referencing ${HOOK_COMMAND_FRAGMENT}, found ${hits.length}`,
    ).toBe(1);
  });

  it("is registered under PostToolUse, not any other lifecycle", () => {
    const [hit] = hits;
    expect(hit, "no check-token-violation.sh hook entry found").toBeDefined();
    expect(hit?.lifecycle).toBe("PostToolUse");
  });

  it("carries continueOnBlock: true", () => {
    const [hit] = hits;
    expect(hit, "no check-token-violation.sh hook entry found").toBeDefined();
    expect(hit?.entry.continueOnBlock).toBe(true);
  });
});
