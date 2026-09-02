import * as Y from "yjs";
import { loadMarkdown } from "../../../../src/server/file-io/markdown.ts";
import { extractText, replaceFlatRangeInElement, mergeInlineTail } from "../../../../src/server/mcp/document-model.ts";
import { elementAtPath } from "../../../../src/shared/positions/ydoc.ts";
import { anchoredRange, refreshRange } from "../../../../src/server/positions.ts";
import { toFlatOffset } from "../../../../src/shared/types.ts";
import { withMcp } from "../../../../src/shared/origins.ts";
const load = (md: string) => { const d = new Y.Doc(); d.transact(() => loadMarkdown(d, md), "internal"); return d; };
// CONTROL: same-block edit earlier in the SAME paragraph as the annotation
{
  const d = load("Alpha beta gamma zeta\n");
  const f0 = extractText(d);
  const ar: any = anchoredRange(d, toFlatOffset(17), toFlatOffset(21), "zeta");
  const ann: any = { id: "c1", type: "comment", author: "claude", status: "pending", range: ar.range, relRange: ar.relRange, textSnapshot: "zeta" };
  const el = elementAtPath(d.getXmlFragment("default"), [0])!;
  withMcp(d, () => replaceFlatRangeInElement(el, 6, 10, "XX"));
  const f1 = extractText(d);
  const r: any = refreshRange(ann, d, d.getMap("annotations"));
  console.log("CONTROL same-block edit before annotation:", "before", JSON.stringify(f0), "after", JSON.stringify(f1));
  console.log("  kind:", r.kind, "range:", JSON.stringify(r.annotation.range), "covers:", JSON.stringify(f1.slice(r.annotation.range.from, r.annotation.range.to)));
}
// CONTROL 2: cross-block edit where the annotation is in a LATER, untouched paragraph
{
  const d = load("Alpha beta gamma\n\nDelta epsilon\n\nOmega final\n");
  const f0 = extractText(d);
  const idx = f0.indexOf("final");
  const ar: any = anchoredRange(d, toFlatOffset(idx), toFlatOffset(idx + 5), "final");
  const ann: any = { id: "c2", type: "comment", author: "claude", status: "pending", range: ar.range, relRange: ar.relRange, textSnapshot: "final" };
  const frag = d.getXmlFragment("default");
  const startNode = elementAtPath(frag, [0])!;
  withMcp(d, () => {
    replaceFlatRangeInElement(startNode, 6, 16, "");
    const tail = frag.get(1) as Y.XmlElement;
    replaceFlatRangeInElement(tail, 0, 6, "");
    replaceFlatRangeInElement(startNode, 6, 6, "XX");
    // mergeInlineTail + delete
    mergeInlineTail(startNode, tail);
    frag.delete(1, 1);
  });
  const f1 = extractText(d);
  const r: any = refreshRange(ann, d, d.getMap("annotations"));
  console.log("CONTROL 3rd-paragraph annotation, merge of p1+p2:", "before", JSON.stringify(f0), "after", JSON.stringify(f1));
  console.log("  kind:", r.kind, "range:", JSON.stringify(r.annotation.range), "covers:", JSON.stringify(f1.slice(r.annotation.range.from, r.annotation.range.to)));
}
