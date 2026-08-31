/**
 * ADR-035 Unit 8h: who may write an imported annotation.
 *
 * `.docx` ingest is the fourth annotation write family and the one that does
 * NOT go through `AnnotationLifecycle` — it writes into the Y.Doc directly,
 * inside a single `withInternal` batch. That exemption is deliberate (the unit
 * declines the migration, and `docs/decisions.md` ADR-035 records why), but
 * until now it lived only as a sentence in `addUserReply`'s docblock. A rule
 * about who may write a record is exactly the kind of claim that rots in prose,
 * which is what Units 8e and 8f replaced with censuses.
 *
 * `docx-comments.test.ts` pins what the import path DOES — including that every
 * stored record carries `author: "import"`, asserted off a real import in four
 * places. This file deliberately holds no behavioural spec of its own: an
 * earlier draft rebuilt a fixture to re-reach that same conclusion, and the
 * mutation battery showed it added no detection, since the stamp-removed
 * mutation is killed by the source-anchored spec below. What this file pins is
 * who is allowed to write, which no behavioural spec can see.
 *
 * Three directions, asserted separately because they fail separately:
 *
 * 1. **Every write funnels through the two writers.** Rev 1 of this guard
 *    censused the literal `author: "import"` instead — and three of the four
 *    annotation write sites SPREAD an existing record rather than restating the
 *    tag, so that census counted 2 of 4 and was wrong before anyone attacked
 *    it. Funnelling the write rather than the construction is what makes the
 *    set countable at all.
 * 2. **The writers stay module-private.** An exported one is reachable from a
 *    second module, which is the same hole one level out.
 * 3. **The writers stamp the author rather than trusting it.** Review supplied
 *    the defeat that motivated this: a call site builds its record with
 *    `author: "claude"` and hands it through the unmodified writer, leaving
 *    directions 1 and 2 green. Typing the parameter to a literal was the first
 *    answer and it is weaker — a cast satisfies a type. Overwriting the field
 *    means the wrong author is not expressible.
 *
 * Citations name symbols and test titles, never line numbers: nothing pins a
 * line number, so one inserted line desyncs it with nothing failing.
 */

import { describe, expect, it } from "vitest";
import { filesMentioning, SRC_FILES, stripComments } from "../helpers/src-tree.js";

const DOCX_COMMENTS = "src/server/file-io/docx-comments.ts";

const source = () => {
  const src = SRC_FILES.get(DOCX_COMMENTS);
  if (!src) throw new Error(`${DOCX_COMMENTS} is missing from the src sweep`);
  return src;
};

describe("ADR-035 Unit 8h: who may write an imported annotation", () => {
  it("routes every Y.Doc annotation and reply write through the two writers", () => {
    // Control first: a sweep that silently read nothing satisfies every
    // "no unexpected writes" assertion below it.
    expect(SRC_FILES.size, "control: the sweep found source files").toBeGreaterThan(100);

    const body = stripComments(source());

    // The two parse helpers used to hold their own `const map = new Map(...)`,
    // which made this scan unable to tell a parse-time local from a Y.Doc
    // write. They are `metaMap`/`threadMap` now precisely so this assertion can
    // be an absolute zero rather than a pinned count — a count is satisfied by
    // deleting one legitimate write and adding one illegitimate one.
    const directWrites = [...body.matchAll(/\b(?:map|repliesMap)\.set\(/g)];

    // Exactly two: the bodies of the writers themselves.
    expect(
      directWrites.length,
      "every import write goes through writeImportAnnotation/writeImportReply; " +
        "the only direct .set calls left are the two inside them",
    ).toBe(2);

    // And they really are inside the writers, not somewhere else that happens
    // to total two.
    expect(body).toMatch(/function writeImportAnnotation\([^)]*\)[^{]*\{\s*map\.set\(/);
    expect(body).toMatch(/function writeImportReply\([^)]*\)[^{]*\{\s*repliesMap\.set\(/);
  });

  it("keeps both writers module-private and unaliased", () => {
    const body = source();

    // Not exported: an exported writer is callable from a second module, which
    // is the same capability spread one level out.
    expect(body).not.toMatch(/export\s+(?:async\s+)?function\s+writeImportAnnotation\b/);
    expect(body).not.toMatch(/export\s+(?:async\s+)?function\s+writeImportReply\b/);

    // Nor re-exported under another name, which an export-scan alone misses.
    expect(body).not.toMatch(
      /export\s+(?:const|let|var)\s+\w+\s*=\s*writeImport(?:Annotation|Reply)\b/,
    );
    expect(body).not.toMatch(/export\s*\{[^}]*\bwriteImport(?:Annotation|Reply)\b/);

    // Keyed on the SYMBOL rather than the module specifier: a specifier scan is
    // beaten by a dropped extension, since `moduleResolution: "bundler"` makes
    // an extensionless import legal. Equality against a non-empty list, so an
    // empty result cannot pass.
    expect(filesMentioning("writeImportAnnotation")).toStrictEqual([DOCX_COMMENTS]);
    expect(filesMentioning("writeImportReply")).toStrictEqual([DOCX_COMMENTS]);
  });

  it("keeps the stamp in the writer, where a call site cannot opt out of it", () => {
    // The behavioural spec above passes whether the author is stamped by the
    // writer or merely set correctly at all four call sites today. This is the
    // half that distinguishes them: the stamp has to be in the writer, so a
    // fifth call site inherits it without anyone remembering.
    const body = stripComments(source());
    expect(body).toMatch(/function writeImportAnnotation[\s\S]{0,200}?author:\s*"import"/);
    expect(body).toMatch(/function writeImportReply[\s\S]{0,200}?author:\s*"import"/);
  });
});
