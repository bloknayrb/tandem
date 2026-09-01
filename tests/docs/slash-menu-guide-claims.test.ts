import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SLASH_COMMANDS } from "../../src/client/editor/slash-menu/commands";

/**
 * Pins the slash-menu enumeration in `docs/user-guide.md` against the actual
 * command array.
 *
 * That paragraph lists every command by name and every alias in backticks, and
 * until now nothing read it. It had drifted twice: `h2` and `h3` were missing
 * from the alias list at some point after the heading commands landed, and
 * adding Paragraph left both the name list and the alias list short. Neither
 * showed up anywhere — no type error, no test, no hook. This is the same shape
 * CLAUDE.md Critical Rule 7 calls out for the testid manifest ("a convenience
 * copy no test reads, so it drifts silently"), and it is user-facing prose, so
 * the drift ships as a wrong answer rather than as a stale internal note.
 *
 * DERIVED FROM SOURCE, never seeded from the prose — the rule this directory's
 * other claims tests follow. A set built from the names the doc already uses
 * would only confirm the doc against itself and could never fail when a NEW
 * command appears, which is the failure this exists to catch.
 *
 * The alias assertion is deliberately an equality on the full backticked list
 * rather than a per-alias `toContain`: a doc that lists an alias no command has
 * is wrong in the same way as one that omits a real alias, and only equality
 * catches the first. Order is pinned too, because the array order is itself
 * load-bearing (see the comment above SLASH_COMMANDS) and prose that lists the
 * commands out of menu order misdescribes what the user sees.
 *
 * Importing `commands.ts` directly, NOT the `slash-menu` barrel: this suite is
 * the `node` vitest project, and the barrel re-exports `extension.ts`, which
 * needs a DOM. `commands.ts` has one import and it is `import type`, so it is
 * DOM-free at runtime.
 */

const GUIDE = readFileSync(join(import.meta.dirname, "..", "..", "docs", "user-guide.md"), "utf-8");

/** The paragraph introducing the menu — the one that enumerates both sets. */
function slashParagraph(): string {
  const paragraph = GUIDE.split(/\n{2,}/).find(
    (block) => block.includes("to open a block menu") && block.includes("short alias"),
  );
  if (!paragraph) {
    throw new Error(
      "docs/user-guide.md no longer has a slash-menu paragraph matching 'to open a block menu' " +
        "and 'short alias'. If the section was rewritten, update this locator — do not delete " +
        "the test, or the enumeration goes unread again.",
    );
  }
  return paragraph;
}

describe("docs/user-guide.md slash-menu enumeration", () => {
  it("names every command in the menu", () => {
    const paragraph = slashParagraph();
    const missing = SLASH_COMMANDS.filter((c) => !paragraph.includes(c.label)).map((c) => c.label);
    expect(missing).toEqual([]);
  });

  it("lists exactly the aliases the commands carry, in menu order", () => {
    // The alias sentence only — the sentence before it also holds backticks
    // (`/`), and a future edit could add more elsewhere in the paragraph.
    const sentence = slashParagraph().match(/short alias \(([^)]*)\)/);
    expect(sentence).not.toBeNull();
    const listed = [...(sentence?.[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    expect(listed).toEqual(SLASH_COMMANDS.map((c) => c.hint));
  });
});
