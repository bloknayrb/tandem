import type { Root } from "mdast";
import * as fs from "node:fs";
import * as path from "node:path";
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
    const changelogPath = path.resolve(__dirname, "../../..", "CHANGELOG.md");
    let changelog: string;
    beforeAll(() => {
      changelog = fs.readFileSync(changelogPath, "utf-8");
    });

    it("round-trips byte-identically", () => {
      expect(roundTrip(changelog)).toBe(changelog);
    });

    it("is idempotent (a second pass is a no-op)", () => {
      const once = roundTrip(changelog);
      expect(roundTrip(once)).toBe(once);
    });
  });
});
