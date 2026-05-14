// Verify the spike .docx opens cleanly via mammoth (same library Tandem uses on
// the import side).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mammoth from "mammoth";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docxPath = path.resolve(__dirname, "fixtures", "sample-output.docx");

const buf = fs.readFileSync(docxPath);
const result = await mammoth.convertToHtml({ buffer: buf });
const html = result.value;

process.stderr.write(`[verify] mammoth roundtrip: ${html.length} chars of HTML\n`);
for (const m of result.messages) {
  process.stderr.write(`[verify] ${m.type}: ${m.message}\n`);
}
process.stdout.write(`${html.slice(0, 2000)}\n`);
