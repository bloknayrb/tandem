/**
 * No raw C0 control character may sit in a `src/` file.
 *
 * `docx-comments.ts` carried three raw NUL bytes as `importAnnotationId`'s hash
 * delimiter. Node read them fine, so every audit built on `SRC_FILES` saw the
 * real content and nothing was wrong at runtime — but `grep` and ripgrep
 * classify a NUL-bearing file as binary and print `Binary file … matches`
 * INSTEAD of the matching lines. Every static read of that file returned "there
 * is a match somewhere" rather than the code.
 *
 * The cost was not hypothetical. While Unit 8h was being planned, that opacity
 * hid a grep from the author and fed a review agent a file whose delimiter it
 * could not see; the agent reconstructed the separator as a space and reported
 * a confidently formatted `importAnnotationId` collision pair that does not
 * exist. A reviewer cannot check what the tools will not show it. The author
 * then re-introduced a NUL *while writing the comment explaining the fix* — an
 * escape typed as the character it names — which is the case for a guard rather
 * than a note in CONTRIBUTING.md.
 *
 * **Scope is `src/`, not the repo.** That is exactly what the motivating
 * grep-based PostToolUse hooks cover, and a guard should claim the scope it
 * has. Deliberately NOT covered, and a control character in one of these would
 * pass unnoticed: `tests/`, `scripts/`, `docs/`, `src-tauri/`, and
 * `skills/tandem/SKILL.md` — the copy shipped into user sessions.
 *
 * `\t`, `\n` and `\r` are permitted: they are ordinary whitespace and do not
 * trigger binary classification. Everything else in C0, plus DEL, is refused.
 * A future legitimate need (an ANSI escape in a CLI string, say) should write
 * the escape sequence — `\u001b` — which is what this guard is asking for in
 * the first place. Nothing in `src/` uses one today.
 */

import { describe, expect, it } from "vitest";
import { SRC_FILES } from "../helpers/src-tree.js";

/** C0 minus tab/LF/CR, plus DEL. */
const FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

describe("src/ carries no raw control characters", () => {
  it("finds every offender, rather than only the first", () => {
    // Control: an empty sweep satisfies "no file contains one" trivially. This
    // is the whole failure mode the guard exists to avoid, so it is asserted
    // before the sweep's own result is trusted.
    expect(SRC_FILES.size, "control: the sweep found source files").toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const [file, contents] of SRC_FILES) {
      // A FRESH regex per file, with no `g` flag. A shared `g`-flagged regex
      // carries `lastIndex` across `.test()` calls and silently skips every
      // other file — a guard that passes by not looking, which is this
      // project's signature hole.
      const match = new RegExp(FORBIDDEN.source).exec(contents);
      if (!match) continue;
      const codePoint = match[0].codePointAt(0) ?? 0;
      const line = contents.slice(0, match.index).split("\n").length;
      offenders.push(
        `${file}:${line} contains U+${codePoint.toString(16).toUpperCase().padStart(4, "0")} — ` +
          `write it as an escape (\\u${codePoint.toString(16).padStart(4, "0")}) instead`,
      );
    }

    expect(offenders).toStrictEqual([]);
  });

  it("would actually catch one (the guard can fail)", () => {
    // A green sweep over real files cannot distinguish "no offenders" from "the
    // pattern never matches anything". This runs the same predicate against
    // content that definitely offends.
    const withNul = 'const delimiter = "\u0000";';
    expect(new RegExp(FORBIDDEN.source).test(withNul)).toBe(true);

    // And does not fire on ordinary whitespace, or on an escape written as
    // text — which is the form the guard is steering people toward.
    expect(new RegExp(FORBIDDEN.source).test("a\tb\r\nc")).toBe(false);
    expect(new RegExp(FORBIDDEN.source).test(String.raw`const d = "\u0000";`)).toBe(false);
  });
});
