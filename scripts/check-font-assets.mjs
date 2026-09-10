import fs from "fs";
import path from "path";

const FORBIDDEN = ["fonts.googleapis.com", "fonts.gstatic.com"];

// #1825: this inspected `dist/index.html`, a path the build never writes --
// vite.config.ts sets `outDir: "dist/client"` -- so the shipped artifact this
// check exists to inspect was never read. Fixing the path alone re-creates the
// bug: the old `.filter(existsSync)` plus a throw at `TARGETS.length === 0`
// cannot fire while the repo-root `index.html` (the client entry, present in
// every checkout) is in the list, so a future output-path move would silently
// degrade this back to a source-only check. The required-built check is
// unconditional for that reason.
const BUILT = path.join("dist", "client", "index.html");
if (!fs.existsSync(BUILT)) {
  throw new Error(`${BUILT} not found — run \`npm run build\` first.`);
}
const TARGETS = [BUILT, "index.html"];

const offenders = [];

for (const target of TARGETS) {
  const html = fs.readFileSync(target, "utf8");
  for (const token of FORBIDDEN) {
    if (html.includes(token)) {
      offenders.push(`${target} -> ${token}`);
    }
  }
}

if (offenders.length > 0) {
  throw new Error(
    `Remote font references are not allowed in shipped HTML:\n${offenders
      .map((line) => `- ${line}`)
      .join("\n")}`,
  );
}

console.log(`Font asset check passed for ${TARGETS.join(", ")}`);
