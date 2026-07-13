import * as fs from "node:fs";
import * as path from "node:path";
import type { Root } from "mdast";
import { visit } from "unist-util-visit";
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

/** True if parsing `input` produces any `mailto:` autolink (email) `link` node. */
function hasMailtoLink(input: string): boolean {
  let found = false;
  visit(mdParser.parse(input) as Root, "link", (node) => {
    if (typeof node.url === "string" && node.url.startsWith("mailto:")) found = true;
  });
  return found;
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

  // remark-gfm escapes a plain-text `@` to `\@` on stringify whenever a
  // word-ish local-part char precedes it, so that re-emitted prose doesn't
  // *appear* to invite an autolink-literal email. The serializer's step-5
  // reversal removes that escape noise only where the text after `@` is NOT
  // host-shaped (no dotted domain with a letter-bearing TLD); host-shaped
  // positions keep the escape, matching the chain's conservative posture.
  //
  // Subtlety this suite documents: a `\@` in a MARKDOWN SOURCE string is not a
  // load-bearing guard. CommonMark un-escapes `\@`→`@` at parse time, then the
  // GFM autolink extension forms the link from the bare `@`. So `user\@host.tld`
  // in source already parses to a `link` node — the serializer never sees it as
  // text. The escape the conditional controls is the one the serializer *emits*
  // for a plain-text node value, which is why group (b) below feeds the
  // serializer raw text-node values (no parse step) rather than markdown source.
  describe("#850: conditional `\\@` un-escape", () => {
    /** Serialize a single plain-text node value (bypasses the parser). */
    function serializeRawText(value: string): string {
      return serializeMdast({
        type: "root",
        children: [{ type: "paragraph", children: [{ type: "text", value }] }],
      } as Root);
    }

    // ---- (a) safe positions un-escape AND stay stable across a 2nd pass ----
    // These are real markdown sources: none parse to a `link` node, so the `@`
    // survives as a text node and the serializer's step-5 reversal applies.
    it.each([
      ["bare `@` token with no local part", "The @ symbol stands alone.\n"],
      ["social-style handle (no domain)", "Follow @jack on the site.\n"],
      ["handle with internal dot but no host", "Ping @bob.smith and continue.\n"],
      ["`@` flanked by spaces", "Seats cost 5 @ each today.\n"],
      ["local part but host has no dot", "Reach user@host on the intranet.\n"],
      ["host present but numeric-only TLD", "Build artifact ref@v2.0 is pinned.\n"],
    ])("un-escapes %s and is idempotent", (_why, input) => {
      // Guard the premise: these inputs are NOT emails, so no autolink forms.
      expect(hasMailtoLink(input)).toBe(false);
      const once = serializerRoundTrip(input);
      // No `\@` escape noise once the autolink risk is gone.
      expect(once).not.toMatch(/\\@/);
      // Second load→save is a no-op (stable fixed point) and no link sneaks in.
      expect(serializerRoundTrip(once)).toBe(once);
      expect(hasMailtoLink(once)).toBe(false);
      parseEqual(once, input);
    });

    it("un-escapes `\\@` round-tripping through the Y.Doc, stable on 2nd pass", () => {
      // Full editor path (parse → Y.Doc → serialize), not just serializeMdast.
      const input = "Reach user@host on the intranet.\n";
      const once = roundTrip(input);
      expect(once).not.toMatch(/\\@/);
      expect(roundTrip(once)).toBe(once);
      expect(hasMailtoLink(once)).toBe(false);
    });

    // ---- (b) host-shaped positions KEEP the `\@` escape on serialize ----
    // Fed as raw text-node values (see the suite comment): any markdown source
    // containing `user@host.tld` would parse to a `link`, never plain text. The
    // `why` column names the equivalence class so missing ones are visible.
    it.each([
      ["classic email", "Contact user@host.tld today."],
      ["single-char local + 2-char TLD", "Mail x@y.co now."],
      ["multi-label host", "See foo@bar.example.org for info."],
      ["hyphenated host", "Email user@my-host.com please."],
      ["digit-bearing local part", "Ping a1@b2.io quickly."],
      ["host followed by trailing dot", "Write user@host.tld. now."],
      ["leading-dot host (regression: must not under-keep)", "Mail user@.com today."],
      ["single-letter TLD", "Mail user@host.c now."],
      ["numeric labels but letter-bearing final", "Pin user@1.a here."],
    ])("keeps `\\@` escaped when serializing %s", (_why, value) => {
      const out = serializeRawText(value);
      // The conditional recognized the host shape and preserved the escape.
      expect(out).toMatch(/\\@/);
      // Safety gate proving the host shape is genuinely autolink-prone: the bare
      // (naively un-escaped) text DOES form an email autolink. This is the
      // condition that makes the un-escape unsafe and the escape worth keeping.
      expect(hasMailtoLink(value)).toBe(true);
      // The serializer chain converges to a stable fixed point. (For most hosts
      // the escape is cosmetic — reloading drops it and GFM re-forms the angle
      // autolink `<user@host.tld>`; for a few, e.g. the leading-dot host
      // `user\@.com`, the escape survives reload and the escaped form is itself
      // the fixed point. Either way, a further pass is a no-op.)
      const reloaded = serializerRoundTrip(out);
      expect(serializerRoundTrip(reloaded)).toBe(reloaded);
    });

    it("safe text-node values drop the `\\@` escape on serialize", () => {
      // Mirror of group (a) at the serializer-contract level: a plain-text node
      // value whose `@` is not host-shaped serializes WITHOUT the escape.
      expect(serializeRawText("Reach user@host now.")).not.toMatch(/\\@/);
      expect(serializeRawText("Pin ref@v2.0 build.")).not.toMatch(/\\@/);
      expect(serializeRawText("The @ stands alone.")).not.toMatch(/\\@/);
    });

    it("documents that `\\@` in markdown SOURCE is cosmetic, not load-bearing", () => {
      // The escape does not survive a parse: CommonMark turns `\@` into `@`,
      // then the GFM autolink extension forms the email link. This is why
      // group (b) tests the serializer contract directly, not a source string.
      const escapedSource = "Contact user\\@host.tld today.\n";
      const plainSource = "Contact user@host.tld today.\n";
      expect(hasMailtoLink(escapedSource)).toBe(true);
      expect(hasMailtoLink(plainSource)).toBe(true);
      // The serializer still EMITS the escape for the (autolinked) text — the
      // conditional preserves it as the canonical, escape-noise-free choice.
      expect(serializerRoundTrip(escapedSource)).toBe("Contact <user@host.tld> today.\n");
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

    it("`\\@` host pattern stays linear on many dotted labels with no TLD letter", () => {
      // Adversarial: a `@`-prefixed run of 16K dotted numeric labels (no
      // letter anywhere) is the worst case for HOST_AFTER_AT — the mandatory
      // trailing letter never matches, so the engine must reject. The classes
      // don't nest with overlapping quantifiers, so rejection is reached in
      // linear time rather than catastrophic backtrack.
      const value = "a@" + "1.".repeat(16_000) + "2";
      const start = Date.now();
      const out = serializeMdast({
        type: "root",
        children: [{ type: "paragraph", children: [{ type: "text", value }] }],
      } as Root);
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

  // A4 (smart typography, #<UX writing experience>): Tiptap's Typography
  // extension is input-rules-only — it rewrites keystrokes as the user
  // types (e.g. "--" -> "–"), but never touches already-serialized
  // characters. This golden test proves the *serializer* is a safe passthrough
  // for the resulting typographic characters — i.e. turning the setting on
  // cannot introduce escaping/alteration noise on save, independent of
  // whatever the input-rules produce client-side.
  describe("A4: smart typography characters round-trip byte-identically", () => {
    it("curly quotes, dashes, ellipsis, and misc symbols survive mdast-ydoc -> remark-stringify", () => {
      const input =
        "Typographic chars: “quoted” and ‘single’, an em—dash, " +
        "an en–dash, an ellipsis…, plus ½ © × symbols.\n";
      const out = roundTrip(input);
      expect(out).toBe(input);
      parseEqual(out, input);
    });

    it("is idempotent (a second pass through the Y.Doc round-trip is a no-op)", () => {
      const input = "Curly “quotes” and an em—dash — again.\n";
      const once = roundTrip(input);
      expect(roundTrip(once)).toBe(once);
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
