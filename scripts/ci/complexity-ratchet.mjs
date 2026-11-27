#!/usr/bin/env node
/**
 * Cyclomatic complexity as a per-function ratchet.
 *
 * The cap is MAX (15) for `src/**\/*.ts`. When this landed, 186 functions were
 * over it; each is frozen in `scripts/complexity-baseline.json` at its current
 * complexity, which is its CEILING:
 *
 *   node scripts/ci/complexity-ratchet.mjs          check (CI `check` job)
 *   node scripts/ci/complexity-ratchet.mjs --prune  lower/drop ceilings after simplifying
 *
 * The check fails when a function not in the baseline is over the cap, when a
 * frozen function's complexity rises above its ceiling, and when a frozen
 * function has dropped (below its ceiling, or under the cap) without the
 * baseline being lowered — so the baseline only ever goes down. `--prune` only
 * lowers or removes entries; there is no mode that adds or raises one.
 *
 * Why a script rather than ESLint's `complexity` rule plus bulk suppressions:
 * suppressions count violations per FILE, so a frozen function could grow
 * without limit, a fixed one could be swapped for a new one in the same file,
 * and a later config block or an inline `eslint-disable` could switch the rule
 * off. This script owns its rule config (nothing in eslint.config.js can loosen
 * it), ignores inline directives, and pins every function's own number.
 *
 * Keys are `file|label`, where label is ESLint's own name for the function
 * ("Function 'x'", "Method 'y'", "Arrow function", …), plus `#n` for the n-th
 * repeat of the same label in a file. No line numbers, so unrelated edits do not
 * churn the baseline. Moving a frozen function to another file changes its key:
 * rename the entry in the same change, at the same number, so the move shows in
 * the diff.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAX = 15;
export const SCOPE = ["src/**/*.ts"];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const BASELINE_PATH = path.join(ROOT, "scripts", "complexity-baseline.json");

/**
 * `{ key: complexity }` for every function ESLint reports over the cap.
 * `results` is ESLint's LintResult[]; a fatal (unparsable) file throws, because
 * a file the scan cannot read is a file the ratchet silently stops covering.
 */
export function collect(results, root = ROOT) {
  const out = {};
  for (const result of results) {
    const file = path.relative(root, result.filePath).replace(/\\/g, "/");
    const seen = new Map();
    for (const m of result.messages) {
      if (m.fatal) throw new Error(`complexity-ratchet: cannot parse ${file}: ${m.message}`);
      if (m.ruleId !== "complexity") continue;
      const hit = /^(.*) has a complexity of (\d+)\./.exec(m.message);
      if (!hit) throw new Error(`complexity-ratchet: unexpected message in ${file}: ${m.message}`);
      const label = hit[1];
      const n = (seen.get(label) ?? 0) + 1;
      seen.set(label, n);
      out[`${file}|${n === 1 ? label : `${label}#${n}`}`] = Number(hit[2]);
    }
  }
  return out;
}

/** Classify the difference between the current scan and the baseline. */
export function compare(current, baseline) {
  const added = [];
  const grew = [];
  const lowered = [];
  const fixed = [];
  for (const [key, n] of Object.entries(current)) {
    if (!(key in baseline)) added.push(`${key} = ${n}`);
    else if (n > baseline[key]) grew.push(`${key}: ${n} > ceiling ${baseline[key]}`);
    else if (n < baseline[key]) lowered.push(`${key}: ${baseline[key]} -> ${n}`);
  }
  for (const key of Object.keys(baseline)) if (!(key in current)) fixed.push(key);
  return { added, grew, lowered, fixed };
}

async function scan() {
  const { ESLint } = await import("eslint");
  const tseslint = (await import("typescript-eslint")).default;
  const eslint = new ESLint({
    cwd: ROOT,
    // Owns its config: nothing in eslint.config.js, and no inline directive,
    // can loosen the cap this script enforces.
    overrideConfigFile: true,
    allowInlineConfig: false,
    overrideConfig: [
      {
        files: SCOPE,
        languageOptions: { parser: tseslint.parser },
        rules: { complexity: ["error", MAX] },
      },
    ],
  });
  return collect(await eslint.lintFiles(SCOPE));
}

function readBaseline() {
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  if (typeof parsed.functions !== "object" || parsed.functions === null) {
    throw new Error(`${BASELINE_PATH} needs a "functions" object`);
  }
  return parsed;
}

async function main() {
  const prune = process.argv.includes("--prune");
  const baseline = readBaseline();
  const current = await scan();
  const { added, grew, lowered, fixed } = compare(current, baseline.functions);

  if (prune) {
    const functions = {};
    for (const [key, ceiling] of Object.entries(baseline.functions)) {
      if (key in current) functions[key] = Math.min(ceiling, current[key]);
    }
    writeFileSync(BASELINE_PATH, `${JSON.stringify({ ...baseline, functions }, null, 2)}\n`);
    console.log(
      `complexity-ratchet: lowered ${lowered.length}, dropped ${fixed.length}; ` +
        `${Object.keys(functions).length} frozen function(s) remain.`,
    );
    if (added.length + grew.length > 0) {
      console.error("complexity-ratchet: --prune never adds or raises entries. Still failing:");
      for (const line of [...added, ...grew]) console.error(`  ${line}`);
      process.exit(1);
    }
    return;
  }

  const report = (lines, heading) => {
    if (lines.length === 0) return;
    console.error(`complexity-ratchet: ${heading}`);
    for (const line of lines) console.error(`  ${line}`);
  };
  report(
    added,
    `${added.length} function(s) over complexity ${MAX} that are not frozen. Split them. ` +
      "(If you MOVED a frozen function, rename its baseline key in the same change.)",
  );
  report(grew, `${grew.length} frozen function(s) grew past their ceiling. Simplify them.`);
  report(
    [...lowered, ...fixed],
    `${lowered.length + fixed.length} frozen function(s) got simpler — well done. Run ` +
      "`node scripts/ci/complexity-ratchet.mjs --prune` to lower the baseline:",
  );
  if (added.length + grew.length + lowered.length + fixed.length > 0) process.exit(1);
  console.log(
    `complexity-ratchet: ok (${Object.keys(current).length} frozen function(s), none new or grown).`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
