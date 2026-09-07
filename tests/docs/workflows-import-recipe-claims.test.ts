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

  /**
   * Review finding (annotation-model-reviewer-1): the closing sentence claimed
   * Bryan can "accept/dismiss both types using the same accept/dismiss
   * shortcuts". `promotedAnnotation()` (annotation-actions.ts) flips a
   * promoted import's `author` to "user", and `canAccept`/`canDismiss`
   * (annotation-context-menu.ts) both gate on `author !== "user"` — so the
   * promoted state this section requires strips accept/dismiss rather than
   * sharing it. The section must not restate that false claim, and must say
   * a promoted import loses accept/dismiss.
   */
  it("does not claim accept/dismiss applies to both filtered types", () => {
    const section = readSection();
    expect(section).not.toMatch(/accept\/dismiss both types/i);
  });

  /**
   * Review finding (cr-3): a prior version of this test used a single regex
   * with a bare `(not|no longer|instead of)` alternation, which matched the
   * substring "not" inside the word "note" — so it passed on both the
   * correct claim and its exact inversion. These two assertions instead
   * anchor on literal phrases lifted from the corrected sentence, so a
   * revert of either clause fails the matching assertion directly rather
   * than passing on an accidental substring.
   *
   * Review findings (annotation-model-reviewer-1, -2): the un-reverted
   * sentence must say (a) an UNPROMOTED import still gets accept/dismiss
   * and the review queue — `canAccept`/`canDismiss`/`isPendingReviewTarget`
   * all gate on `author !== "user"`, which an import satisfies before
   * promotion — and (b) promotion moves it OUT of the review queue and
   * replaces accept/dismiss with Edit/Remove/Reply, not the other way
   * around (`author` flips to "user", which both predicates exclude).
   */
  it("says accept/dismiss and the review queue apply to an unpromoted import", () => {
    const section = readSection();
    expect(section).toContain('an unpromoted import (both have `author !== "user"`)');
  });

  it("says promotion drops the review queue and switches to Edit/Remove/Reply", () => {
    const section = readSection();
    expect(section).toContain("drops out of the review queue");
    expect(section).toContain("switches from accept/dismiss to Edit/Remove/Reply");
  });

  it("does not claim promotion adds accept/dismiss or the review queue", () => {
    const section = readSection();
    expect(section).not.toMatch(/no accept\/dismiss action/i);
    expect(section).not.toMatch(/the review queue and Edit\/Remove\/Reply flow/i);
  });
});
