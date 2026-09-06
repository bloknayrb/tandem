import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #1771: `tandem_getAnnotations({ author: "import" })` can never return a
 * `type: "comment"` record — imports land as private notes (ADR-027) until
 * the user promotes them, and a promoted record's author flips to "user".
 * `docs/workflows.md`'s "Reviewing a .docx with Imported Word Comments"
 * section previously showed a worked example returning `type: "comment"`
 * records straight off the `author: "import"` filter — a shape that call
 * never produces. This is the single home for every claim about that
 * recipe in this doc, so it doesn't drift against a duplicate check in
 * `tests/skill-instruction-contract.test.ts`.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");

function readSection(): string {
  const doc = readFileSync(join(REPO_ROOT, "docs/workflows.md"), "utf-8");
  const section = /^## Reviewing a \.docx with Imported Word Comments\r?\n([\s\S]*?)(?=^## )/m.exec(
    doc,
  )?.[1];
  expect(section, "docs/workflows.md has no Imported Word Comments section").toBeDefined();
  return section ?? "";
}

describe("docs/workflows.md Word-comment import recipe (#1771)", () => {
  it("no single fenced code block shows author:import alongside a type:comment record", () => {
    const section = readSection();
    // Split on triple-backtick fences: odd indices are the fenced code blocks, even
    // indices are prose. Prose is exempt — the corrected section's opening paragraph
    // legitimately names `author: "import"` while describing how comments are imported,
    // in the same section as later `type: "comment"` prose about the promoted state.
    const chunks = section.split(/```/);
    const codeBlocks = chunks.filter((_, i) => i % 2 === 1);

    expect(codeBlocks.length, "expected at least one fenced code block").toBeGreaterThan(0);

    for (const block of codeBlocks) {
      const hasImportFilter = block.includes('author: "import"');
      const hasCommentShape = /type:\s*"comment"/.test(block);
      expect(
        hasImportFilter && hasCommentShape,
        `a single code block must not show both the author:"import" filter and a type:"comment" record:\n${block}`,
      ).toBe(false);
    }
  });

  it("names notesExcluded and importSource as the real signals", () => {
    const section = readSection();
    expect(section).toContain("notesExcluded");
    expect(section).toContain("importSource");
  });
});
