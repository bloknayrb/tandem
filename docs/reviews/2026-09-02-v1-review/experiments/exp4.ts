import * as Y from "yjs";
import { htmlToYDoc } from "../../../../src/server/file-io/docx-html.ts";
import { extractText } from "../../../../src/server/mcp/document-model.ts";
import { sessionKey } from "../../../../src/server/session/manager.ts";
import { loadMarkdown, saveMarkdown } from "../../../../src/server/file-io/markdown.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// A. docx inline image inside a paragraph (what mammoth emits)
{
  const doc = new Y.Doc();
  doc.transact(() => htmlToYDoc(doc, '<p>Before <img src="data:image/png;base64,iVBORw0KGgo=" alt="pic" /> after</p><p><img src="data:image/png;base64,iVBORw0KGgo=" /></p>'), "internal");
  const frag = doc.getXmlFragment("default");
  const names: string[] = [];
  for (let i = 0; i < frag.length; i++) { const n = frag.get(i) as Y.XmlElement; names.push(n.nodeName + ":" + JSON.stringify(n.toString()).slice(0, 120)); }
  console.log("=== docx inline img ===\n" + names.join("\n"));
  console.log(JSON.stringify(extractText(doc)));
}

// B. Session filename length for a CJK path
{
  const p = "/Users/张伟/Documents/项目资料/2026年度产品路线图与市场分析报告草稿.md";
  const key = sessionKey(p);
  console.log("=== sessionKey ===", "path chars:", p.length, "key bytes:", Buffer.byteLength(key), key.slice(0, 60) + "...");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-review-sess-"));
  try { fs.writeFileSync(path.join(dir, `${key}.json`), "{}"); console.log("write OK"); } catch (e: any) { console.log("write FAILS:", e.code); }
  const p2 = "/home/bryan/Documents/Клиенты/Отчёт по маркетинговой стратегии 2026 года.md";
  const key2 = sessionKey(p2);
  console.log("cyrillic path chars:", p2.length, "key bytes:", Buffer.byteLength(key2));
  try { fs.writeFileSync(path.join(dir, `${key2}.json`), "{}"); console.log("write OK"); } catch (e: any) { console.log("write FAILS:", e.code); }
}

// C. Image with unsupported scheme in markdown -> replaced by alt text on save
{
  const md = "![Architecture diagram](file:///C:/Users/me/diagram.png)\n\n![svg](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)\n\n![rel](../img/a.png)\n\n![space](my image.png)\n\n![](x.png)\n";
  const doc = new Y.Doc(); doc.transact(() => loadMarkdown(doc, md), "internal");
  console.log("=== image src rejection ===");
  console.log(JSON.stringify(saveMarkdown(doc)));
}

// D. rawMarkdown mark inheritance on tandem_edit-style insert right after a footnote ref
{
  const { replaceFlatRangeInElement } = await import("../../../../src/server/mcp/document-model.ts");
  const md = "Text[^1] here.\n\n[^1]: note\n";
  const doc = new Y.Doc(); doc.transact(() => loadMarkdown(doc, md), "internal");
  const el = doc.getXmlFragment("default").get(0) as Y.XmlElement;
  doc.transact(() => replaceFlatRangeInElement(el, 8, 8, " *emph* <b>x</b>"), "mcp");
  console.log("=== raw mark inheritance ===", JSON.stringify(saveMarkdown(doc)));
}
