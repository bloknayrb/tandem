#!/usr/bin/env node
/**
 * knip as a ratchet: fail on NEW dead code, without first deciding the fate of
 * everything knip already reports.
 *
 * When this landed, knip reported 113 findings (unused files, exports, types,
 * dependencies, unlisted dependencies and binaries; the baseline's length is
 * the current count). Some are false positives that need
 * config (a native module loaded through `esmRequire`), some are real dead code
 * whose removal is a product decision. Settling all of them in one change was
 * not reasonable, so they are frozen in `scripts/knip-baseline.json` instead:
 *
 *   node scripts/ci/knip-ratchet.mjs          check (CI `check` job)
 *   node scripts/ci/knip-ratchet.mjs --prune  drop fixed findings from the baseline
 *
 * The check fails on any finding not in the baseline, and on any baseline entry
 * knip no longer reports (so the file only ever shrinks: prune it). `--prune`
 * can only REMOVE entries; there is deliberately no mode that adds one. A new
 * finding is fixed in code, or configured away in `knip.json` with a comment.
 *
 * Findings are keyed `category|file|name`, without line numbers, so editing a
 * file elsewhere does not churn the baseline. A member finding carries its
 * parent (`enumMembers|file|Mode.Unused`), so two enums' same-named members
 * stay distinct.
 *
 * Two consequences of keying by file and of comparing against knip's output:
 *  - Moving or renaming a file with frozen findings shows them as fixed (old
 *    path) plus new (new path). Rename those keys in the baseline in the same
 *    change, so the move shows in the diff.
 *  - A knip upgrade that changes what knip reports fails `check` until someone
 *    prunes or fixes by hand; a Dependabot bump of knip cannot pass on its own.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const BASELINE_PATH = path.join(ROOT, "scripts", "knip-baseline.json");

/** Every category knip reports per file, flattened to stable keys. */
export function findingsFrom(report) {
  if (!report || !Array.isArray(report.issues)) {
    throw new Error("knip JSON report has no `issues` array — wrong reporter or knip failed");
  }
  const keys = new Set();
  for (const issue of report.issues) {
    for (const [category, items] of Object.entries(issue)) {
      if (category === "file") continue;
      if (!Array.isArray(items)) {
        // A category shape this script does not know would otherwise be
        // skipped silently, which is a hole, not a pass.
        if (items && typeof items === "object" && Object.keys(items).length > 0) {
          throw new Error(`knip category "${category}" in ${issue.file} is not an array`);
        }
        continue;
      }
      for (const item of items) {
        // `duplicates` entries are arrays of {name}; members carry the enum or
        // namespace they belong to; everything else is {name}.
        const name = Array.isArray(item)
          ? item
              .map((d) => d.name)
              .sort()
              .join("|")
          : item?.namespace
            ? `${item.namespace}.${item.name}`
            : String(item?.name ?? "");
        keys.add(`${category}|${issue.file}|${name}`);
      }
    }
  }
  return [...keys].sort();
}

/** New findings, and baseline entries knip no longer reports. */
export function compare(current, baseline) {
  const now = new Set(current);
  const then = new Set(baseline);
  return {
    added: current.filter((k) => !then.has(k)),
    fixed: baseline.filter((k) => !now.has(k)),
  };
}

function runKnip() {
  const r = spawnSync("npx", ["knip", "--no-progress", "--reporter", "json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  if (r.error) throw new Error(`could not run knip: ${r.error.message}`);
  // knip exits non-zero whenever it has findings; only unparseable output is an error.
  try {
    return JSON.parse(r.stdout);
  } catch {
    process.stderr.write(r.stderr ?? "");
    throw new Error(`knip produced no JSON report (exit ${r.status})`);
  }
}

function readBaseline() {
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  if (!Array.isArray(parsed.findings)) throw new Error(`${BASELINE_PATH} needs a findings array`);
  return parsed;
}

function main() {
  const prune = process.argv.includes("--prune");
  const baseline = readBaseline();
  const current = findingsFrom(runKnip());
  const { added, fixed } = compare(current, baseline.findings);

  if (prune) {
    const kept = baseline.findings.filter((k) => !fixed.includes(k));
    writeFileSync(BASELINE_PATH, `${JSON.stringify({ ...baseline, findings: kept }, null, 2)}\n`);
    console.log(`knip-ratchet: pruned ${fixed.length} fixed finding(s); ${kept.length} remain.`);
    if (added.length > 0) {
      console.error(`knip-ratchet: ${added.length} NEW finding(s) are not added by --prune:`);
      for (const k of added) console.error(`  ${k}`);
      process.exit(1);
    }
    return;
  }

  if (added.length > 0) {
    console.error(
      `knip-ratchet: ${added.length} new dead-code finding(s). Remove the dead code, or, if ` +
        "knip is wrong, configure it in knip.json with a comment saying why:",
    );
    for (const k of added) console.error(`  ${k}`);
  }
  if (fixed.length > 0) {
    console.error(
      `knip-ratchet: ${fixed.length} baseline finding(s) are gone — well done. Run ` +
        "`node scripts/ci/knip-ratchet.mjs --prune` to drop them from the baseline:",
    );
    for (const k of fixed) console.error(`  ${k}`);
  }
  if (added.length > 0 || fixed.length > 0) process.exit(1);
  console.log(`knip-ratchet: ok (${current.length} frozen finding(s), none new).`);
}

// Compare real paths on both sides: the ESM loader resolves symlinks for
// import.meta.url but process.argv[1] is as typed, so a checkout reached
// through a symlink would otherwise skip main() and exit 0 without checking.
function realpathOrNull(candidate) {
  if (!candidate) return null;
  try {
    return realpathSync(candidate);
  } catch {
    return null;
  }
}
const invokedPath = realpathOrNull(process.argv[1]);
if (invokedPath !== null && invokedPath === realpathOrNull(fileURLToPath(import.meta.url))) {
  main();
}
