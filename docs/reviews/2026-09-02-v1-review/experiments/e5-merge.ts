import * as Y from "yjs";
import { loadMarkdown } from "../../../../src/server/file-io/markdown.ts";
import { extractText, replaceFlatRangeInElement, mergeInlineTail, getElementTextLength } from "../../../../src/server/mcp/document-model.ts";
import { resolveToTextblock, elementAtPath } from "../../../../src/shared/positions/ydoc.ts";
import { anchoredRange, refreshRange, validateRange } from "../../../../src/server/positions.ts";
import { toFlatOffset } from "../../../../src/shared/types.ts";
import { withMcp } from "../../../../src/shared/origins.ts";

const load = (md: string) => { const d = new Y.Doc(); d.transact(() => loadMarkdown(d, md), "internal"); return d; };

function crossBlockEdit(doc: Y.Doc, from: number, to: number, newText: string) {
  // Faithful replication of src/server/mcp/document.ts:702-740 (tandem_edit cross-element branch)
  const fragment = doc.getXmlFragment("default");
  const startPos = resolveToTextblock(fragment, toFlatOffset(from))!;
  const endPos = resolveToTextblock(fragment, toFlatOffset(to))!;
  const startNode = elementAtPath(fragment, startPos.path)!;
  const startIndex = startPos.path[0], endIndex = endPos.path[0];
  withMcp(doc, () => {
    replaceFlatRangeInElement(startNode, startPos.textOffset, getElementTextLength(startNode), "");
    const deleteCount = endIndex - startIndex - 1;
    if (deleteCount > 0) fragment.delete(startIndex + 1, deleteCount);
    const tailNode = fragment.get(startIndex + 1) as Y.XmlElement;
    replaceFlatRangeInElement(tailNode, 0, endPos.textOffset, "");
    if (newText.length > 0) {
      const joinAt = startPos.textOffset;
      replaceFlatRangeInElement(startNode, joinAt, joinAt, newText);
    }
    mergeInlineTail(startNode, tailNode);
    fragment.delete(startIndex + 1, 1);
  });
}

function scenario(label: string, md: string, annFrom: number, annTo: number, editFrom: number, editTo: number, newText: string) {
  const d = load(md);
  const flat0 = extractText(d);
  const snap = flat0.slice(annFrom, annTo);
  const ar: any = anchoredRange(d, toFlatOffset(annFrom), toFlatOffset(annTo), snap);
  console.log(`--- ${label}`);
  console.log("  flat before :", JSON.stringify(flat0));
  console.log("  annotation  :", JSON.stringify(snap), `[${annFrom},${annTo})`, "anchored:", ar.ok, "fullyAnchored:", ar.fullyAnchored);
  if (!ar.ok) return;
  const ann: any = { id: "a1", type: "comment", author: "claude", status: "pending", range: ar.range, relRange: ar.relRange, textSnapshot: snap };
  console.log("  edit        :", `[${editFrom},${editTo}) -> ${JSON.stringify(newText)}`, "validate:", JSON.stringify(validateRange(d, toFlatOffset(editFrom), toFlatOffset(editTo))));
  crossBlockEdit(d, editFrom, editTo, newText);
  const flat1 = extractText(d);
  const res: any = refreshRange(ann, d, d.getMap("annotations"));
  const rg = res.annotation.range;
  console.log("  flat after  :", JSON.stringify(flat1));
  console.log("  refresh kind:", res.kind, "range:", JSON.stringify(rg), "covers:", JSON.stringify(flat1.slice(rg.from, rg.to)), "status:", res.annotation.status);
  const expected = flat1.indexOf(snap);
  console.log("  expected    :", expected >= 0 ? `[${expected},${expected + snap.length}) = ${JSON.stringify(snap)}` : "(snapshot text no longer present)");
  console.log("  VERDICT     :", expected >= 0 && rg.from === expected && rg.to === expected + snap.length ? "OK" : rg.from === rg.to ? "COLLAPSED" : "WRONG/other");
}

// P1 "Alpha beta gamma" (0-15), sep 16, P2 "Delta epsilon zeta" starts 17
const md = "Alpha beta gamma\n\nDelta epsilon zeta\n";
const f = extractText(load(md));
console.log("flat:", JSON.stringify(f), "zeta at", f.indexOf("zeta"));
scenario("annotation on last word of P2 (survives the merge)", md, f.indexOf("zeta"), f.indexOf("zeta") + 4, 6, 23, "XX");
scenario("annotation spanning the join (partially deleted)", md, 11, 23, 6, 23, "XX");
scenario("annotation entirely inside the deleted region", md, 11, 22, 6, 23, "XX");
scenario("cross-block edit with EMPTY newText", md, f.indexOf("zeta"), f.indexOf("zeta") + 4, 6, 23, "");
