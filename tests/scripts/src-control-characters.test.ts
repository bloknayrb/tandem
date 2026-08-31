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
 * **Scope is `src/` and `tests/`.** `src/` is what the motivating grep-based
 * PostToolUse hooks cover. `tests/` was added after it earned itself the same
 * way the guard did: a raw NUL went into `docx-comments.test.ts` while its
 * delimiter specs were being edited, and this file — scoped to `src/` — watched
 * it happen. That tree holds the vectors, so it is the second-likeliest place
 * for the mistake, and it is read by exactly the greps that go blind on it.
 *
 * Still NOT covered, and a control character in one of these would pass
 * unnoticed: `scripts/`, `docs/`, `src-tauri/`, and `skills/tandem/SKILL.md` —
 * the copy shipped into user sessions.
 *
 * `\t`, `\n` and `\r` are permitted: they are ordinary whitespace and do not
 * trigger binary classification. Everything else in C0, plus DEL, is refused.
 * A future legitimate need (an ANSI escape in a CLI string, say) should write
 * the escape sequence — `\u001b` — which is what this guard is asking for in
 * the first place. Nothing in `src/` uses one today.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SRC_FILES } from "../helpers/src-tree.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * `tests/`, read here rather than by widening `SRC_FILES` — every other guard
 * in the repo reads that map and means "source" by it.
 */
function testFiles(dir = path.join(ROOT, "tests"), out = new Map<string, string>()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__snapshots__") continue;
      testFiles(full, out);
    } else if (/\.(ts|mts|cts|tsx|js|mjs)$/.test(entry.name)) {
      out.set(path.relative(ROOT, full).split(path.sep).join("/"), readFileSync(full, "utf8"));
    }
  }
  return out;
}

/** C0 minus tab/LF/CR, plus DEL. */
const FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** One offender line per file, so the report names every file rather than the first. */
function offendersIn(files: ReadonlyMap<string, string>): string[] {
  const offenders: string[] = [];
  for (const [file, contents] of files) {
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
  return offenders;
}

describe("src/ and tests/ carry no raw control characters", () => {
  it("finds every offender in src/, rather than only the first", () => {
    // Control: an empty sweep satisfies "no file contains one" trivially. This
    // is the whole failure mode the guard exists to avoid, so it is asserted
    // before the sweep's own result is trusted.
    expect(SRC_FILES.size, "control: the sweep found source files").toBeGreaterThan(100);
    expect(offendersIn(SRC_FILES)).toStrictEqual([]);
  });

  it("finds every offender in tests/, where the delimiter vectors live", () => {
    const files = testFiles();
    expect(files.size, "control: the sweep found test files").toBeGreaterThan(100);
    // The sweep must reach the file that motivated widening it, or it is
    // measuring a tree that happens to be clean somewhere else.
    expect(files.has("tests/server/docx-comments.test.ts")).toBe(true);
    expect(offendersIn(files)).toStrictEqual([]);
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
