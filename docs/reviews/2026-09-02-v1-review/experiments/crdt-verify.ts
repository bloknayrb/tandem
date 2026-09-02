import * as Y from "yjs";
import { loadMarkdown } from "../../../../src/server/file-io/markdown.ts";
import { extractText } from "../../../../src/server/mcp/document-model.ts";
import { validateRange, anchoredRange, refreshRange } from "../../../../src/server/positions.ts";

const mk = (md: string) => { const d = new Y.Doc(); d.transact(() => loadMarkdown(d, md), "internal"); return d; };
const ann = (d: Y.Doc, from: number, to: number, snap?: string) => {
  const r: any = anchoredRange(d, from, to, snap);
  if (!r.ok) { console.log("  anchoredRange refused:", r.code, r.message); return null; }
  return { id: "a1", type: "comment", author: "claude", status: "pending", range: r.range, relRange: r.relRange, textSnapshot: snap } as any;
};
const show = (label: string, d: Y.Doc, a: any) => {
  const map = d.getMap("annotations");
  const res: any = refreshRange(a, d, map);
  const flat = extractText(d);
  const rg = res.annotation.range;
  console.log(`  ${label}: kind=${res.kind} range=${JSON.stringify(rg)} covers=${JSON.stringify(flat.slice(rg.from, rg.to))} flat=${JSON.stringify(flat)}`);
};

console.log("== A: validateRange with from on separator before heading, to inside heading text");
{
  const d = mk("para\n\n## Head\n\nnext\n");
  console.log("  flat:", JSON.stringify(extractText(d)));
  console.log("  validateRange(4,9,reject):", JSON.stringify(validateRange(d, 4, 9, { rejectHeadingOverlap: true })));
  console.log("  validateRange(0,9,reject):", JSON.stringify(validateRange(d, 0, 9, { rejectHeadingOverlap: true })));
  console.log("== B: to on separator (4) vs to on first prefix char (5)");
  console.log("  validateRange(0,4,reject):", JSON.stringify(validateRange(d, 0, 4, { rejectHeadingOverlap: true })));
  console.log("  validateRange(0,5,reject):", JSON.stringify(validateRange(d, 0, 5, { rejectHeadingOverlap: true })));
  const a = ann(d, 4, 9, "\n## He");
  if (a) console.log("  anchoredRange(4,9) accepted, range", JSON.stringify(a.range), "relRange present", !!a.relRange);
}

console.log("== C: zero-length range then insert at that point");
{
  const d = mk("hello world\n");
  const a = ann(d, 5, 5);
  const xt = (d.getXmlFragment("default").get(0) as Y.XmlElement).get(0) as Y.XmlText;
  d.transact(() => xt.insert(5, "X"), "browser");
  show("after insert", d, a);
}

console.log("== F: from anchored on hardBreak offset");
{
  const d = mk("line one  \nline two\n");
  console.log("  flat:", JSON.stringify(extractText(d)));
  const a = ann(d, 8, 12);
  if (a) { console.log("  stored range", JSON.stringify(a.range)); show("no-edit refresh", d, a); }
}

console.log("== D: dead XmlText repaired from stale flat offsets");
{
  const d = mk("one\n\ntwo\n\nthree\n");
  const a = ann(d, 4, 7, "two");
  const frag = d.getXmlFragment("default");
  d.transact(() => {
    frag.delete(1, 1);
    const p = new Y.XmlElement("paragraph"); frag.insert(0, [p]);
    const t = new Y.XmlText(); p.insert(0, [t]); t.insert(0, "ZZZZ");
  }, "browser");
  show("after delete+insert", d, a);
}

console.log("== E: paragraph split before annotated text (y-prosemirror live editor if possible)");
{
  let live = false;
  try {
    const { Window } = await import("happy-dom");
    const w: any = new Window();
    for (const k of ["window","document","navigator","Node","Element","HTMLElement","Text","DocumentFragment","MutationObserver","getComputedStyle","requestAnimationFrame","cancelAnimationFrame","DOMParser","Range","Selection","Event","CustomEvent","KeyboardEvent","MouseEvent","InputEvent","HTMLDivElement","NodeFilter","XMLSerializer","ResizeObserver","IntersectionObserver","matchMedia","localStorage","CSSStyleDeclaration","HTMLCollection","NodeList"]) {
      if (!(k in globalThis) && w[k] !== undefined) (globalThis as any)[k] = k === "window" ? w : w[k];
    }
    const { Editor } = await import("@tiptap/core");
    const Collaboration = (await import("@tiptap/extension-collaboration")).default;
    const { buildSchemaExtensions } = await import("../../../../src/client/editor/editor-extensions.ts");
    const run = (label: string, splitAt: number, from: number, to: number) => {
      const d = mk("aaa bbb ccc\n");
      const a = ann(d, from, to, "bbb");
      const editor = new Editor({ extensions: [...buildSchemaExtensions(), Collaboration.configure({ document: d })] });
      editor.commands.setTextSelection(splitAt + 1);
      editor.commands.splitBlock();
      console.log("  pm text:", JSON.stringify(editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n")));
      show(label, d, a);
      editor.destroy();
    };
    run("split at ann start (after 'aaa ')", 4, 4, 7);
    run("split inside ann (after 'aaa b')", 5, 4, 7);
    run("split after ann (after 'aaa bbb')", 7, 4, 7);
    run("split before 'aaa' text, ann later (after 'a')", 1, 4, 7);
    live = true;
  } catch (e) { console.log("  live editor unavailable:", String(e).slice(0, 300)); }
  if (!live) {
    const d = mk("aaa bbb ccc\n");
    const a = ann(d, 4, 7, "bbb");
    const frag = d.getXmlFragment("default");
    const xt = (frag.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    d.transact(() => { xt.delete(4, 7); const p = new Y.XmlElement("paragraph"); frag.insert(1, [p]); const t = new Y.XmlText(); p.insert(0, [t]); t.insert(0, "bbb ccc"); }, "browser");
    show("simulated y-prosemirror split", d, a);
  }
}
