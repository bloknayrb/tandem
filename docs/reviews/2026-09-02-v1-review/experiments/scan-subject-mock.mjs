import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
const files = execSync("find tests -type f -name '*.test.ts'", {encoding:"utf8"}).trim().split("\n");
const resolveMod = (from, spec) => {
  if (spec.startsWith("@shared/")) return "src/shared/" + spec.slice(8);
  if (spec.startsWith("@server/")) return "src/server/" + spec.slice(8);
  if (spec.startsWith("@client/")) return "src/client/" + spec.slice(8);
  if (spec.startsWith(".")) return path.normalize(path.join(path.dirname(from), spec));
  return null;
};
let totalMocks = 0, filesWithMocks = 0; const stemHits = [], srcMockCounts = new Map(), overlap = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const mocks = [...src.matchAll(/vi\.(?:mock|doMock)\(\s*["']([^"']+)["']/g)].map(m => m[1]);
  if (!mocks.length) continue;
  filesWithMocks++; totalMocks += mocks.length;
  const stem = path.basename(f).replace(/\.svelte\.test\.ts$|\.test\.ts$/, "");
  const imports = [...src.matchAll(/^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)].map(m => m[1]);
  for (const m of mocks) {
    const r = resolveMod(f, m);
    if (r && r.startsWith("src/")) srcMockCounts.set(r, (srcMockCounts.get(r)||0)+1);
    const mstem = path.basename(m).replace(/\.svelte$|\.ts$/, "");
    if (r && (mstem === stem || stem.includes(mstem) && mstem.length > 4)) stemHits.push(`${f}  mocks  ${m}`);
  }
  // mocks a module that the test also imports a non-vi.mocked symbol from, where that module is the only src import (subject)
  const srcImports = imports.map(i => resolveMod(f, i)).filter(x => x && x.startsWith("src/"));
  const mockedSrc = new Set(mocks.map(m => resolveMod(f, m)).filter(Boolean));
  const unmocked = srcImports.filter(x => !mockedSrc.has(x));
  if (unmocked.length === 0 && srcImports.length > 0) overlap.push(`${f}  (ALL src imports are mocked: ${[...new Set(srcImports)].join(", ")})`);
}
console.log(`vi.mock/doMock sites: ${totalMocks} across ${filesWithMocks} files`);
console.log("\n== test files whose stem matches a module they vi.mock (subject-mock suspects) ==");
console.log(stemHits.join("\n") || "(none)");
console.log("\n== test files where EVERY src import is also vi.mocked ==");
console.log(overlap.join("\n") || "(none)");
console.log("\n== most-mocked src modules ==");
console.log([...srcMockCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,25).map(([k,v])=>`${String(v).padStart(3)}  ${k}`).join("\n"));
