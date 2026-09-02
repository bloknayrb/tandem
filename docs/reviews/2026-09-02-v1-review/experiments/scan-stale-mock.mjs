import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
const files = execSync("find tests -type f -name '*.test.ts'", {encoding:"utf8"}).trim().split("\n");
const resolveMod = (from, spec) => {
  let r = null;
  if (spec.startsWith("@shared/")) r = "src/shared/" + spec.slice(8);
  else if (spec.startsWith("@server/")) r = "src/server/" + spec.slice(8);
  else if (spec.startsWith("@client/")) r = "src/client/" + spec.slice(8);
  else if (spec.startsWith(".")) r = path.normalize(path.join(path.dirname(from), spec));
  if (!r) return null;
  r = r.replace(/\.js$/, "");
  for (const ext of ["", ".ts", ".svelte.ts", ".svelte", "/index.ts", ".mjs", ".d.ts"]) if (existsSync(r + ext) && !r.endsWith("/")) { try { if (readFileSync(r+ext)) return r + ext; } catch { } }
  return { missing: r };
};
const exportsOf = (file) => {
  const s = readFileSync(file, "utf8");
  const names = new Set();
  for (const m of s.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class|enum|type|interface)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of s.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const part of m[1].split(",")) { const n = part.trim().split(/\s+as\s+/).pop()?.trim(); if (n) names.add(n); }
  if (/^export\s+default/m.test(s)) names.add("default");
  return names;
};
const missing = [], staleKeys = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const re = /vi\.(?:mock|doMock)\(\s*["']([^"']+)["']\s*(?:,\s*(async\s*)?\(\s*\)\s*=>\s*(\{|\(\{))?/g;
  let m;
  while ((m = re.exec(src))) {
    const target = resolveMod(f, m[1]);
    if (!target) continue;
    if (typeof target === "object") { missing.push(`${f}  ->  ${m[1]}  (no file at ${target.missing})`); continue; }
    if (!m[3]) continue; // no inline object factory
    // grab factory object literal keys: scan forward to balanced close
    let i = re.lastIndex, depth = 1, body = "";
    while (i < src.length && depth > 0) { const ch = src[i]; if (ch === "{" || ch === "(") depth++; else if (ch === "}" || ch === ")") depth--; body += ch; i++; }
    const keys = [...body.matchAll(/^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?::|\(|,|$)/gm)].map(k => k[1]).filter(k => !["return","const","let","var","if","await","default","true","false","null","undefined"].includes(k));
    if (/\.\.\.\s*(actual|orig|original|real|mod)\b/.test(body) || /importActual|importOriginal/.test(body)) continue; // spreads real module
    const real = exportsOf(target);
    const bogus = [...new Set(keys)].filter(k => !real.has(k));
    if (bogus.length) staleKeys.push(`${f}  mocks ${m[1]}  keys not exported by real module: ${bogus.join(", ")}`);
  }
}
console.log("== vi.mock targets whose file does not exist (mock is a no-op unless the subject imports that exact id) ==");
console.log(missing.join("\n") || "(none)");
console.log("\n== inline factories exporting keys the real module does not export (possible stale shape; heuristic) ==");
console.log(staleKeys.join("\n") || "(none)");
