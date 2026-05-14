import * as fs from "node:fs";
import * as path from "node:path";
import type { Root } from "mdast";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { mdParser, saveMarkdown, serializeMdast } from "../../../src/server/file-io/markdown.js";
import { makeMarkdownDoc } from "../../helpers/ydoc-factory.js";

let doc: Y.Doc;
afterEach(() => doc?.destroy());

function roundTrip(input: string): string {
  doc = makeMarkdownDoc(input);
  return saveMarkdown(doc);
}

/**
 * Serializer-only round-trip: parse → serialize WITHOUT a Y.Doc detour.
 * Use this for cases where the Y.Doc adapter cannot represent a node type
 * (`definition`, `image`, etc.) but we still need to verify the serializer
 * itself behaves correctly.
 */
function serializerRoundTrip(input: string): string {
  return serializeMdast(mdParser.parse(input) as Root);
}

// Strip mdast `position` metadata so two trees compare semantically even when
// derived from inputs with different byte offsets.
function stripPositions(tree: unknown): unknown {
  if (Array.isArray(tree)) return tree.map(stripPositions);
  if (tree && typeof tree === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(tree as Record<string, unknown>)) {
      if (k === "position") continue;
      out[k] = stripPositions(v);
    }
    return out;
  }
  return tree;
}

function parseEqual(a: string, b: string): void {
  expect(stripPositions(mdParser.parse(a))).toEqual(stripPositions(mdParser.parse(b)));
}

describe("markdown escaping (#605)", () => {
  describe("un-escapes intra-text noise", () => {
    it("CHANGELOG-style bracketed heading", () => {
      const input = "## [0.11.0] - 2026-05-11\n\n### Added\n\n- A change.\n";
      const out = roundTrip(input);
      expect(out).not.toMatch(/\\\[/);
      expect(out).toBe(input);
      parseEqual(out, input);
    });

    it("intra-word underscores in prose", () => {
      const input = "See `src/server/file_io/markdown_handler.ts` and the `do_thing_now` helper.\n";
      const out = roundTrip(input);
      expect(out).not.toMatch(/(?<=\w)\\_(?=\w)/);
      expect(out).toBe(input);
    });

    it("bracketed prose that is not a link", () => {
      const input = "The token [anchor] is a literal marker, not a Markdown link.\n";
      const out = roundTrip(input);
      expect(out).not.toMatch(/\\\[/);
      expect(out).toBe(input);
      parseEqual(out, input);
    });

    it("genuine inline link round-trips via `link` handler", () => {
      const input = "Visit [Example](https://example.com) for details.\n";
      const out = roundTrip(input);
      expect(out).toBe(input);
    });

    it("backtick code spans round-trip via `inlineCode`", () => {
      const input = "Use `git status` and `npm test` to verify.\n";
      const out = roundTrip(input);
      expect(out).not.toMatch(/(?<![`\\])\\`(?!`)/);
      expect(out).toBe(input);
    });

    it("single tilde in prose un-escaped (GFM strikethrough needs `~~`)", () => {
      const input = "Approximately ~4500 tokens consumed ~50 LOC.\n";
      const out = roundTrip(input);
      expect(out).not.toMatch(/\\~(?!~)/);
      expect(out).toBe(input);
    });
  });

  describe("preserves escapes where un-escape would change semantics", () => {
    it("collapsed reference link: `[foo]` matching a `[foo]: url` definition stays escaped", () => {
      // Y.Doc cannot represent `definition` nodes, so test the serializer in
      // isolation. The parse-aware guard in markdown.ts is the last line of
      // defense if a future mdast-ydoc.ts adds ref-def support.
      const input = "See \\[foo] info.\n\n[foo]: https://example.com\n";
      const out = serializerRoundTrip(input);
      expect(out).toMatch(/\\\[foo]/);
      parseEqual(out, input);
    });

    it("ref-def label with multi-word identifier stays escaped (whitespace-collapsed match)", () => {
      // mdast normalizes `[Foo   Bar]` identifier to `foo bar` (whitespace
      // collapsed, lowercased). The captured label `Foo   Bar` must be
      // normalized the same way before comparison, or this would un-escape
      // and re-parse as a reference link.
      const input = "Hi \\[Foo   Bar].\n\n[Foo   Bar]: https://x.com\n";
      const out = serializerRoundTrip(input);
      expect(out).toMatch(/\\\[Foo {3}Bar]/);
      parseEqual(out, input);
    });

    it("adjacent bracket pair `\\[a\\][b]` is not un-escaped into a full reference link", () => {
      // `[a][b]` with `[b]: url` would parse as a full reference link. The
      // un-escape must keep at least the opening `\[` so the result is not
      // adjacent `[a][b]`. The serializer canonically emits `\[a]` here
      // (closing `]` is unambiguous after an already-escaped opener), which
      // is parse-equivalent to the input.
      const input = "Adj \\[a\\][b].\n\n[b]: https://x.com\n";
      const out = serializerRoundTrip(input);
      expect(out).toMatch(/\\\[a/);
      parseEqual(out, input);
    });

    it("parens-flanked underscores stay escaped (punctuation flanks ARE valid emphasis)", () => {
      const input = "Literal: (\\_foo\\_) and \\_bar\\_!\n";
      const out = roundTrip(input);
      // Underscores between `(` and a word char (or word and `)`) CAN form emphasis;
      // dropping the escapes would create `(_foo_)` which re-parses as emphasis.
      parseEqual(out, input);
    });

    it("line-leading list/heading markers stay escaped (block-context safety)", () => {
      const input = "\\- not actually a list item\n\n\\# also not a heading\n";
      const out = roundTrip(input);
      // Removing these escapes would create a real list item / heading.
      parseEqual(out, input);
    });
  });

  describe("ReDoS guard", () => {
    it("16K of `[` completes in linear time for our regex (upstream `state.safe()` has its own cost)", () => {
      // Regex 1's label class excludes `\` so it cannot backtrack across an
      // adjacent `\[` from `state.safe()`'s output. The upstream `state.safe()`
      // itself is non-linear on this kind of pathological input (independent
      // of #605); guard against catastrophic blowup with a generous budget.
      const input = "[".repeat(16_000) + "\n";
      const start = Date.now();
      const out = serializerRoundTrip(input);
      const elapsed = Date.now() - start;
      expect(out.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(2_000);
    });
  });

  describe("does not interfere with non-text handlers", () => {
    it("image syntax round-trips through `image` handler", () => {
      // Y.Doc representation drops `image` nodes; test the serializer directly.
      const input = "![Logo](logo.png)\n";
      const out = serializerRoundTrip(input);
      expect(out).toBe(input);
    });

    it("GFM autolinks are not escaped", () => {
      const input = "See https://example.com for details.\n";
      const out = roundTrip(input);
      expect(out).not.toMatch(/\\[.:@]/);
      parseEqual(out, input);
    });
  });

  describe("CHANGELOG.md golden file", () => {
    // Use the direct serializer path (parse → serializeMdast), NOT the Y.Doc
    // round-trip. The Y.Doc representation does not preserve some inline
    // structures (notably bold-wrapping-inline-code like `**`foo` bar**`),
    // which is a separate mdast-ydoc.ts limitation tracked outside this PR.
    // The serializer itself is what #605 fixes, and the golden file verifies
    // the serializer is a fixed point on canonical input.
    const changelogPath = path.resolve(__dirname, "../../..", "CHANGELOG.md");
    let changelog: string;
    beforeAll(() => {
      changelog = fs.readFileSync(changelogPath, "utf-8");
    });

    it("round-trips byte-identically through serializeMdast", () => {
      expect(serializerRoundTrip(changelog)).toBe(changelog);
    });

    it("is idempotent (a second pass is a no-op)", () => {
      const once = serializerRoundTrip(changelog);
      expect(serializerRoundTrip(once)).toBe(once);
    });
  });
});
