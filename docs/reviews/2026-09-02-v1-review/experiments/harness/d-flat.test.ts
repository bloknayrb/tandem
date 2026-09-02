// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { flatOffsetToPmPos, pmDocFlatText, pmPosToFlatOffset, relRangeToPmPositions } from "../../../../../src/client/positions";
import { loadMarkdown } from "../../../../../src/server/file-io/markdown";
import { extractText } from "../../../../../src/server/mcp/document-model";
import { flatOffsetToRelPos, resolveToTextblock } from "../../../../../src/shared/positions/ydoc";
import { toFlatOffset, toPmPos } from "../../../../../src/shared/positions/types";
import { productionSchema, yDocToPmNode } from "../../../../../tests/client/editor-roundtrip-harness";

const CORPUS: Record<string, string> = {
  "emoji in paragraph": "Hello 👋 world 🌍!\n\nSecond 🎉 line\n",
  "emoji in heading": "# Title 🚀 here\n\nbody\n",
  "emoji in list": "- one 😀\n- two 👍🏽 skin\n",
  "family emoji ZWJ": "a 👨‍👩‍👧‍👦 b\n\nc\n",
  "image block": "before\n\n![alt](pic.png)\n\nafter\n",
  "image in list": "- ![shot](a.png)\n- text\n",
  "image then text in list item": "- ![shot](a.png)\n  caption\n",
  "hr first": "---\n\ntext\n",
  "hr in list": "- a\n\n  ---\n\n- b\n",
  "nested list 3 deep": "- a\n  - b\n    - c\n  - d\n- e\n",
  "blockquote > list > code": "> - item\n>   ```\n>   code\n>   ```\n> - two\n",
  "table with empty cell": "| a |  |\n|---|---|\n|  | d |\n",
  "table with emoji": "| 🍎 | b |\n|---|---|\n| c | 🍌🍌 |\n",
  "consecutive empty paragraphs": "a\n\n&nbsp;\n\nb\n",
  "heading in list": "- # Section\n- text\n",
  "task list": "- [ ] todo\n- [x] done\n",
  "ordered list start": "3. three\n4. four\n",
  "code block with blank line": "```\nx\n\ny\n```\n\nafter\n",
  "hard break in list item": "- one\\\n  two\n- three\n",
  "link and code": "see [x](http://x) and `y`\n",
  "CRLF soft wrap": "line one\r\nline two\r\n\r\npara\r\n",
  "footnote ref": "text[^1]\n\n[^1]: note\n",
  "frontmatter": "---\ntitle: x\n---\n\nbody\n",
  "html block": "<div>raw</div>\n\ntext\n",
};

function walkTextPositions(doc: import("prosemirror-model").Node): number[] {
  // Every PM position that sits inside a textblock's content (inclusive of both ends).
  const out: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      for (let p = pos + 1; p <= pos + 1 + node.content.size; p++) out.push(p);
      return false;
    }
    return true;
  });
  return out;
}

describe("D: client and server flat projections agree on every corpus shape", () => {
  for (const [name, md] of Object.entries(CORPUS)) {
    it(name, () => {
      const ydoc = new Y.Doc();
      loadMarkdown(ydoc, md);
      const pm = yDocToPmNode(ydoc, productionSchema());
      const serverFlat = extractText(ydoc);
      const clientFlat = pmDocFlatText(pm);
      if (serverFlat !== clientFlat) {
        console.log(`[${name}] MISMATCH\n server=${JSON.stringify(serverFlat)}\n client=${JSON.stringify(clientFlat)}`);
      }
      expect(clientFlat).toBe(serverFlat);

      // 1. pmPosToFlatOffset is monotonic and pmDocFlatText.length === pmPosToFlatOffset(content.size)
      let last = -1;
      for (let p = 0; p <= pm.content.size; p++) {
        const f = pmPosToFlatOffset(pm, toPmPos(p));
        expect(f).toBeGreaterThanOrEqual(last);
        last = f;
      }
      expect(pmPosToFlatOffset(pm, toPmPos(pm.content.size))).toBe(clientFlat.length);

      // 2. For every text position p, the flat char after flatOffset(p) equals the PM char after p.
      const mismatches: string[] = [];
      for (const p of walkTextPositions(pm)) {
        const f = pmPosToFlatOffset(pm, toPmPos(p));
        const $p = pm.resolve(p);
        const pmChar = $p.parentOffset < $p.parent.content.size ? pm.textBetween(p, p + 1, "", (n) => (n.type.name === "hardBreak" ? "\n" : "")) : null;
        const flatChar = f < serverFlat.length ? serverFlat[f] : null;
        // A heading's flattened newline is a space in flat text.
        const norm = (c: string | null) => (c === "\r" || c === "\n" ? "\n" : c);
        if (pmChar !== null && flatChar !== null && norm(pmChar) !== norm(flatChar) && !(flatChar === " " && pmChar === "\n")) {
          mismatches.push(`p=${p} f=${f} pm=${JSON.stringify(pmChar)} flat=${JSON.stringify(flatChar)}`);
        }
        // Round trip: flatOffsetToPmPos(f) should be p, unless p is a boundary that flat text cannot express.
        const back = flatOffsetToPmPos(pm, toFlatOffset(f));
        if (back !== p) {
          const $b = pm.resolve(back);
          // Accept only if both map to the same flat offset AND same textblock (block-boundary ambiguity)
          if (pmPosToFlatOffset(pm, toPmPos(back)) !== f) {
            mismatches.push(`roundtrip p=${p} -> f=${f} -> back=${back} (flat of back=${pmPosToFlatOffset(pm, toPmPos(back))})`);
          } else if ($b.parent !== $p.parent) {
            mismatches.push(`roundtrip-block p=${p} -> f=${f} -> back=${back} lands in ${$b.parent.type.name} not ${$p.parent.type.name}`);
          }
        }
      }
      if (mismatches.length) console.log(`[${name}]\n  ` + mismatches.join("\n  "));
      expect(mismatches).toEqual([]);

      // 3. Server-minted anchors resolve on the client to the position whose flat offset equals the original.
      const anchorMismatches: string[] = [];
      for (let f = 0; f <= serverFlat.length; f++) {
        const fromRel = flatOffsetToRelPos(ydoc, toFlatOffset(f), 0);
        const toRel = flatOffsetToRelPos(ydoc, toFlatOffset(f), -1);
        if (!fromRel || !toRel) continue;
        const r = relRangeToPmPositions(ydoc, pm, { fromRel, toRel });
        if (!r) {
          anchorMismatches.push(`f=${f} anchors minted but client resolves null`);
          continue;
        }
        const ff = pmPosToFlatOffset(pm, r.from);
        const ft = pmPosToFlatOffset(pm, r.to);
        if (ff !== f || ft !== f) anchorMismatches.push(`f=${f} -> pm ${r.from}/${r.to} -> flat ${ff}/${ft}`);
      }
      if (anchorMismatches.length) console.log(`[${name}] anchors\n  ` + anchorMismatches.join("\n  "));
      expect(anchorMismatches).toEqual([]);

      // 4. Server resolveToTextblock agrees with the client on WHICH textblock owns each flat offset.
      const tbMismatches: string[] = [];
      for (let f = 0; f < serverFlat.length; f++) {
        if (serverFlat[f] === "\n") continue;
        const srv = resolveToTextblock(ydoc.getXmlFragment("default"), toFlatOffset(f));
        const p = flatOffsetToPmPos(pm, toFlatOffset(f));
        const $p = pm.resolve(p);
        if (!srv) {
          tbMismatches.push(`f=${f} server null, client -> ${$p.parent.type.name}`);
          continue;
        }
        // Map the server path to the PM node.
        let node: import("prosemirror-model").Node = pm;
        for (const idx of srv.path) node = node.child(idx);
        if (node !== $p.parent && !(srv.clampedFromPrefix)) {
          tbMismatches.push(`f=${f} server path ${srv.path.join("/")} (${node.type.name}) vs client ${$p.parent.type.name} @${p}`);
        }
      }
      if (tbMismatches.length) console.log(`[${name}] textblock\n  ` + tbMismatches.join("\n  "));
      expect(tbMismatches).toEqual([]);
      ydoc.destroy();
    });
  }
});
