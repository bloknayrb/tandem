// One-shot cleanup script for issue #605 — re-serialize CHANGELOG.md through
// the (fixed) markdown serializer to strip historical backslash-escape noise
// (`\[0.11.0]` → `[0.11.0]`, `tandem\_status` → `tandem_status`, etc.) added
// by earlier round-trips when remark-stringify defaults over-escaped.
//
// Safe to delete after the v0.12.0 cleanup commit lands. Kept in scripts/
// only as a reference for similar one-shot cleanups on user files.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import { loadMarkdown, saveMarkdown } from "../src/server/file-io/markdown.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, "..", "CHANGELOG.md");
const input = fs.readFileSync(file, "utf-8");

const doc = new Y.Doc();
loadMarkdown(doc, input);
const output = saveMarkdown(doc);
fs.writeFileSync(file, output);
doc.destroy();

console.log(`Re-serialized CHANGELOG.md: ${input.length} → ${output.length} bytes`);
