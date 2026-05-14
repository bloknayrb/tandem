// TS runner invoked by run-docx-export.mjs via tsx. Spike-only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import * as Y from "yjs";

import { mdastToYDoc } from "../../src/server/file-io/mdast-ydoc.js";
import { exportYDocToDocx } from "../../src/server/file-io/spike-docx-export.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, "fixtures");
const inputPath = process.argv[2] ?? path.join(fixturesDir, "sample-input.md");
const outputPath = process.argv[3] ?? path.join(fixturesDir, "sample-output.docx");

const md = fs.readFileSync(inputPath, "utf8");
const tree = unified().use(remarkParse).use(remarkGfm).parse(md);

const doc = new Y.Doc();
mdastToYDoc(doc, tree as any);

const buf = await exportYDocToDocx(doc);
fs.writeFileSync(outputPath, buf);

process.stderr.write(
  `[spike-docx-export] wrote ${buf.byteLength} bytes -> ${path.relative(process.cwd(), outputPath)}\n`,
);
