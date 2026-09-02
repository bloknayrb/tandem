// Heuristic scan: find it()/test() blocks with zero expect/assert calls.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
const files = execSync("find tests -type f \\( -name '*.test.ts' -o -name '*.spec.ts' \\)", {encoding:"utf8"}).trim().split("\n");
const ASSERT = /\b(expect|assert|expectTypeOf|assertType|toMatchSnapshot|expect\.soft)\b|\.toBe|\.toEqual|\.toThrow|expect\(|assert\(|\bfail\(|throw new Error|expectSoft|softExpect|check\(|assertRail|assertNo|assertAt|assertHas|assertDoc/;
const OPEN = /^\s*(it|test)(\.(only|skip|todo|fails|concurrent|sequential|each|skipIf|runIf))*(\([^)]*\))?\s*\(\s*(["'`])/;
const zero = [];
for (const f of files) {
  const lines = readFileSync(f, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(OPEN);
    if (!m) continue;
    // Find block end by brace balance from this line
    let depth = 0, started = false, j = i, body = [];
    for (; j < lines.length; j++) {
      const l = lines[j];
      for (const ch of l) { if (ch === "{") { depth++; started = true; } else if (ch === "}") depth--; }
      body.push(l);
      if (started && depth <= 0) break;
      if (j - i > 400) break;
    }
    const text = body.join("\n");
    const title = lines[i].replace(/^\s*(it|test)[^(]*\(\s*["'`]/, "").split(/["'`]/)[0];
    // skip multi-line title blocks that OPEN didn't match; count assertions
    if (!ASSERT.test(text.slice(lines[i].length))) zero.push(`${f}:${i+1}  ${title}`);
  }
}
console.log("== it/test blocks with no recognisable assertion:", zero.length);
console.log(zero.join("\n"));
