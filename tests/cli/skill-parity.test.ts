import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SKILL_CONTENT } from "../../src/cli/skill-content.js";

/**
 * The plugin ships `skills/tandem/SKILL.md` for Claude Code plugin discovery
 * (see `.claude-plugin/plugin.json`), while `SKILL_CONTENT` is written to
 * `~/.claude/skills/tandem/SKILL.md` by `tandem setup` for non-plugin users.
 *
 * Both paths must deliver byte-identical content or Claude will see different
 * guidance depending on the install method.
 */
describe("skill content parity", () => {
  it("skills/tandem/SKILL.md matches SKILL_CONTENT exactly", () => {
    const plugin = readFileSync(
      resolve(import.meta.dirname, "../../skills/tandem/SKILL.md"),
      "utf-8",
    );
    expect(plugin).toBe(SKILL_CONTENT);
  });
});
