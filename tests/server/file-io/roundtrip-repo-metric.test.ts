/**
 * Repo-wide round-trip metric (#1448).
 *
 * The curated corpus in `roundtrip-corpus.test.ts` is the gate. This is the
 * breadth check that runs the same round trip over every tracked `.md` file in
 * the repository — a large, free, real-world corpus that no one had to write.
 *
 * It deliberately does NOT snapshot the list of failing filenames. That list
 * changes with every docs PR, so it would churn constantly, and a snapshot
 * people regenerate reflexively stops being a signal. Instead it classifies
 * each *render-affecting* difference by the kind of mdast change it causes and
 * asserts the set of KINDS, which is stable under ordinary prose edits and
 * fails by name the moment a construct starts breaking in a new way.
 *
 * The byte-level count is reported, not asserted: most of it is formatting
 * canonicalization that renders identically (marker style, table padding), and
 * pinning it would be pinning a number nobody should be optimizing.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadMarkdown, mdParser, saveMarkdown } from "../../../src/server/file-io/markdown.js";

/**
 * Kinds of render-affecting change we already know about, each tied to a defect
 * in #1448. Anything outside this set is a new defect.
 */
const KNOWN_KINDS = new Set([
  // The invisible tier, as of #1448 PR 4. Every kind here renders identically in
  // any viewer; what is left is mark ORDER and code-span STYLE, neither of which
  // mdast records. Recovering them needs a per-node source-marker layer, which
  // is a different and much larger project — see the plan's "Out of scope".
  //
  //   inline-marks       two marks covering the same run come back in a fixed
  //                      order (`~~**x**~~` -> `**~~x~~**`), and a degenerate
  //                      `strong > strong` from the source collapses to one.
  //   inline-code-fence  a code span wrapped across a source line comes back on
  //                      one line; CommonMark renders its newline as a space
  //                      either way.
  //   table-cells        a row's trailing empty cell is made explicit.
  //   listItem-child-count  a table nested in a list item; see #1448.
  //
  // The VISIBLE kinds are deliberately absent, and their absence is the
  // assertion: `list.spread` / `listItem.spread` (V2, 56 files) and the
  // code-span-forming escape bug (V7) both appeared here before PR 4.
  "inline-marks",
  "inline-code-fence",
  "table-cells",
  "listItem-child-count",
]);

/** mdast phrasing types — a difference in any of these is an inline defect. */
const PHRASING = new Set([
  "text",
  "emphasis",
  "strong",
  "delete",
  "inlineCode",
  "link",
  "image",
  "html",
  "break",
  "footnoteReference",
  "linkReference",
  "imageReference",
]);

/** Block types whose children are phrasing content. */
const PHRASING_PARENTS = new Set(["paragraph", "heading", "tableCell"]);

const sameNode = (a: unknown, b: unknown) => JSON.stringify(strip(a)) === JSON.stringify(strip(b));

interface Finding {
  file: string;
  kind: string;
}

const byteDifferent: string[] = [];
const renderDifferent: Finding[] = [];
let scanned = 0;

/** Structural comparison: `position` is source offsets, not meaning. */
function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(node as object).sort()) {
      if (key === "position") continue;
      out[key] = strip((node as Record<string, unknown>)[key]);
    }
    return out;
  }
  return node;
}

/** Every phrasing type appearing anywhere in a subtree. */
function phrasingTypes(node: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const child of node) phrasingTypes(child, into);
    return into;
  }
  if (node && typeof node === "object") {
    const type = (node as { type?: string }).type;
    if (type && PHRASING.has(type)) into.add(type);
    phrasingTypes((node as { children?: unknown[] }).children ?? [], into);
  }
  return into;
}

/**
 * True when one side carries a KIND of inline node the other does not.
 *
 * This is the line between the two inline families, and drawing it is what makes
 * this gate able to fail. `inline-marks` is allowlisted — it is the invisible
 * tier, marks that render identically in a different nesting order — and
 * `classify` used to return it for a bare `a.type !== b.type` as well. So a
 * `text` node coming back as a `delete` node scored `inline-marks` and passed:
 * the gate structurally could not fail on the escape-corruption class it exists
 * to catch, which is exactly how the `\~\~` defect survived to review.
 *
 * A SET difference, deliberately, not a multiset one. The known-benign cases
 * reorder marks or collapse a degenerate `strong > strong` into one `strong` —
 * both leave the set of kinds untouched. An escape turning into live syntax
 * always introduces a kind that was not in the source (or, in reverse, drops one
 * entirely), and there is no benign case that does that.
 */
function inlineTypesDiffer(a: unknown, b: unknown): boolean {
  const before = phrasingTypes(a);
  const after = phrasingTypes(b);
  if (before.size !== after.size) return true;
  for (const type of before) if (!after.has(type)) return true;
  return false;
}

/** Name the first structural difference, coarsely enough to stay stable. */
function classify(before: unknown, after: unknown): string {
  const a = before as { type?: string; children?: unknown[]; spread?: boolean };
  const b = after as { type?: string; children?: unknown[]; spread?: boolean };

  // Inline defects manifest as a dozen different node-level symptoms (a `strong`
  // gaining children, a `text` value shifting, a `delete` becoming a `strong`).
  // Those that preserve the SET of node kinds are one family and get collapsed —
  // otherwise the known-kind set churns on prose edits and stops meaning
  // anything. Those that do not are a different family, and not allowlisted.
  const inline = PHRASING.has(a?.type ?? "") || PHRASING.has(b?.type ?? "");
  if (inline) {
    if (inlineTypesDiffer(before, after)) return "inline-type-change";
    return a?.type === "inlineCode" || b?.type === "inlineCode"
      ? "inline-code-fence"
      : "inline-marks";
  }

  if (a?.type !== b?.type) return "inline-type-change";
  if (a?.type === "list" && a.spread !== b.spread) return "list.spread";
  if (a?.type === "listItem" && a.spread !== b.spread) return "listItem.spread";

  const ca = a?.children ?? [];
  const cb = b?.children ?? [];
  if (ca.length !== cb.length) {
    if (a?.type === "tableRow" || a?.type === "table") return "table-cells";
    // A block whose children are phrasing. A changed child count means marks or
    // code spans split/merged, which is an inline defect rather than a
    // structural change to the block. Name it from the divergent TAIL — the
    // nodes past the common prefix — because a mis-fenced code span shows up as
    // two `text` nodes disagreeing with an extra `inlineCode` after them, and
    // reading only the first divergent pair would blame marks for V7.
    if (PHRASING_PARENTS.has(a?.type ?? "")) {
      // Checked over the WHOLE children arrays, not the divergent tail: a mark
      // that appears only in the output is new regardless of where the common
      // prefix ends, and the `\~\~` corruption lands here (one `text` child
      // becoming `[text, delete, text]`) rather than in the inline branch above.
      if (inlineTypesDiffer(ca, cb)) return "inline-type-change";
      let i = 0;
      while (i < ca.length && i < cb.length && sameNode(ca[i], cb[i])) i++;
      const tail = [...ca.slice(i), ...cb.slice(i)] as { type?: string }[];
      return tail.some((n) => n?.type === "inlineCode") ? "inline-code-fence" : "inline-marks";
    }
    return `${a?.type ?? "root"}-child-count`;
  }
  for (let i = 0; i < ca.length; i++) {
    if (JSON.stringify(strip(ca[i])) === JSON.stringify(strip(cb[i]))) continue;
    return classify(ca[i], cb[i]);
  }
  return `${a?.type ?? "root"}-scalar`;
}

// Hoisted out of the per-test budget: this walks the whole repo once. Doing it
// inside each `it` blew the 15s timeout on a comparable docs-scanning suite
// and surfaced as an unrelated-looking assertion failure (#1434).
beforeAll(() => {
  const files = execFileSync("git", ["ls-files", "--", "*.md"], { encoding: "utf-8" })
    .split("\n")
    .filter(Boolean);

  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, "utf-8");
    } catch {
      continue; // listed but absent (submodule, sparse checkout)
    }
    scanned++;

    const doc = new Y.Doc();
    let output: string;
    try {
      loadMarkdown(doc, source);
      output = saveMarkdown(doc);
    } catch {
      renderDifferent.push({ file, kind: "threw" });
      continue;
    } finally {
      doc.destroy();
    }

    if (output === source || output === `${source}\n` || `${output}\n` === source) continue;
    byteDifferent.push(file);

    const before = strip(mdParser.parse(source));
    const after = strip(mdParser.parse(output));
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    renderDifferent.push({ file, kind: classify(before, after) });
  }
}, 120_000);

describe("repo-wide round-trip metric", () => {
  it("scans a corpus worth scanning", () => {
    // A positive anchor. Without it, a broken `git ls-files` yields zero files,
    // every "count of bad things is zero" assertion below passes, and the suite
    // reports perfect health on an empty scan.
    expect(scanned).toBeGreaterThan(100);
  });

  it("every render-affecting difference is a known kind", () => {
    const unknown = renderDifferent.filter((f) => !KNOWN_KINDS.has(f.kind));
    expect(unknown).toEqual([]);
  });

  it("reports the current state", () => {
    const byKind = new Map<string, number>();
    for (const { kind } of renderDifferent) byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    const summary = [...byKind].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`);
    console.log(
      `round-trip: ${scanned} scanned, ${byteDifferent.length} differ in bytes, ` +
        `${renderDifferent.length} differ in rendering [${summary.join(" ")}]`,
    );
    // Not an assertion on the numbers — see the file header.
    expect(byteDifferent.length).toBeLessThanOrEqual(scanned);
  });
});
