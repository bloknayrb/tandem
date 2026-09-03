import * as Y from "yjs";
import { htmlToYDoc } from "../../../../src/server/file-io/docx-html.ts";
import { extractText } from "../../../../src/server/mcp/document-model.ts";
import { legacySessionKey, sessionKey } from "../../../../src/server/session/manager.ts";
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

// B. Session filename length for a CJK path.
// #1750: `sessionKey` now hashes DISK paths (`docHash`, fixed 64 hex) and keeps
// the old `encodeURIComponent` form only for `upload://` paths. `legacySessionKey`
// is the pre-fix spelling, printed alongside so the before/after is one run.
{
  const paths = [
    "/Users/张伟/Documents/项目资料/2026年度产品路线图与市场分析报告草稿.md",
    "/home/bryan/Documents/Клиенты/Отчёт по маркетинговой стратегии 2026 года.md",
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-review-sess-"));
  console.log("=== sessionKey ===");
  for (const p of paths) {
    const oldKey = legacySessionKey(p);
    const newKey = sessionKey(p);
    console.log(
      "path chars:", p.length,
      "| OLD key bytes:", Buffer.byteLength(oldKey),
      "| NEW key bytes:", Buffer.byteLength(newKey),
      "|", newKey.slice(0, 16) + "...",
    );
    try { fs.writeFileSync(path.join(dir, `${oldKey}.json`), "{}"); console.log("  OLD write OK"); } catch (e: any) { console.log("  OLD write FAILS:", e.code); }
    try { fs.writeFileSync(path.join(dir, `${newKey}.json`), "{}"); console.log("  NEW write OK"); } catch (e: any) { console.log("  NEW write FAILS:", e.code); }
  }
  // Uploads deliberately keep the legacy key: `docHash` collapses every
  // scratchpad to `upload_scratchpad`, so two open scratchpads would clobber
  // one session file every 60s.
  const scratch = "upload://scratchpad/11111111-1111-1111-1111-111111111111/Scratchpad.md";
  console.log("scratchpad key is legacy:", sessionKey(scratch) === legacySessionKey(scratch));
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
