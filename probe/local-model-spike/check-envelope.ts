import { makeMarkdownDoc } from "../../tests/helpers/ydoc-factory.js";
import { extractText } from "../../src/server/mcp/document-model.js";
import { findOccurrence } from "../../src/server/mcp/navigation.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const md = readFileSync(join(HERE, "fixtures/envelope-50page.md"), "utf8");
const t = extractText(makeMarkdownDoc(md));
const checks: [string, number][] = [
  ["$73,400", 1],
  ["September 30, 2026", 1],
  ["the total budget for the year is $1,200,000", 1],
  ["the total budget for the year is $1,500,000", 1],
  ["The quarterly variance is $5,000 in this region, which warrants a closer look.", 2],
];
for (const [q, o] of checks) {
  const r = findOccurrence(t, q, o);
  console.log("error" in r ? `MISS ${q}` : `ok   @${r.from} (occ ${o}) ${q.slice(0, 50)}`);
}
console.log("total chars:", t.length, "~words:", Math.round(t.split(/\s+/).length), "~pages:", Math.round(t.split(/\s+/).length / 500));
