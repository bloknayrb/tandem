#!/usr/bin/env node
/**
 * Turn a Vitest coverage run into a baseline artifact that states what it
 * measured, and refuse to produce one that cannot say.
 *
 * This exists because of what the measurement is FOR. Unit 13 of the
 * maintainability programme seeds per-module line/function/branch/statement
 * floors directly from these numbers, with at most a one-point rounding
 * allowance -- the baseline becomes the gate. Unit 13's own instruction names
 * exactly one omission class to look out for ("document platform or
 * Svelte-transform exclusions"), so any OTHER kind of partial baseline would be
 * inherited into an enforced floor with nothing anywhere noticing. A percentage
 * on its own cannot distinguish "this code is untested" from "this code was
 * never looked at", and those two demand opposite responses.
 *
 * So the artifact carries a machine-readable family manifest beside the totals,
 * and this script fails closed rather than emit one it cannot vouch for.
 *
 * **The level of coverage is deliberately NOT gated here** -- the unit's
 * instruction is explicit that repository-wide thresholds come later. What is
 * gated is whether the measurement HAPPENED. Those are different questions, and
 * conflating them is how you get a gate that reports success when it could not
 * evaluate (#1229, #1399, #1529).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SUMMARY = path.join(ROOT, "coverage", "coverage-summary.json");
const OUT = path.join(ROOT, "coverage", "baseline-manifest.json");

/**
 * The families this baseline claims to measure, each with the extension test
 * that decides membership from disk.
 *
 * Derived from disk rather than declared as constants on purpose: a family that
 * grows a file the coverage glob does not match should show up as a shortfall
 * here, not as a silently smaller denominator.
 */
const MEASURED_FAMILIES = [
  {
    id: "ts",
    label: "TypeScript modules",
    matches: (f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.endsWith(".svelte.ts"),
  },
  {
    id: "svelte-runes",
    label: "Svelte rune modules (.svelte.ts)",
    matches: (f) => f.endsWith(".svelte.ts"),
  },
  {
    id: "svelte-components",
    label: "Svelte components (.svelte)",
    matches: (f) => f.endsWith(".svelte"),
  },
];

/**
 * Families under `src/` that are deliberately NOT measured, with the reason.
 * Present in the artifact so a reader is told what is missing rather than left
 * to infer it from a denominator.
 */
const OMITTED_FAMILIES = [
  {
    id: "css",
    label: "Stylesheets (.css)",
    matches: (f) => f.endsWith(".css"),
    reason:
      "Not JavaScript. V8 coverage has nothing to instrument. The CSS pipeline " +
      "has its own contract tests under tests/design-system-impl/.",
  },
  {
    id: "dts",
    label: "Ambient declarations (.d.ts)",
    matches: (f) => f.endsWith(".d.ts"),
    reason: "Types only; emits no runtime code.",
  },
  {
    id: "rust",
    label: "Rust (src-tauri/, reaper/)",
    // Outside the walked tree entirely, so there is no count to take -- see the
    // `filesOnDisk: null` handling at the emit site.
    walkable: false,
    matches: () => false,
    reason:
      "Outside src/ and outside Vitest entirely. Covered by `cargo test` in the " +
      "rust-test CI matrix, which reports no line coverage.",
  },
];

/**
 * Wall-clock assertions that `expectWithinMs` suspends during the coverage run.
 *
 * Named here so the artifact states what the measurement run did NOT verify.
 * Instrumentation makes every one of these bounds measure the profiler rather
 * than the code, and before this they were riding on luck: on the first full
 * baseline run the 5s bound failed while the 3s and 500ms bounds passed, which
 * is not a difference in signal.
 *
 * `tests/scripts/coverage-manifest-wiring.test.ts` asserts this list is exactly
 * the set of files calling `expectWithinMs`, so a fourth site cannot be added
 * and silently go unmentioned here.
 */
const SUSPENDED_TIMING_SITES = [
  "tests/server/docx-size-gate.test.ts",
  "tests/cli/mcp-stdio.test.ts",
  "tests/server/platform.test.ts",
];

/**
 * The anti-partial-run check: every top-level area under `src/` must show at
 * least one COVERED statement, or be named below as known-untested.
 *
 * This is the check that catches the mistake this repo is most likely to make.
 * The two Vitest projects (`client`, `node`) split the suite, and running only
 * one of them still emits a complete-looking report in which the other
 * project's source sits at a uniform 0% -- which reads as "none of this is
 * tested" rather than "none of this was run".
 *
 * **Derived from disk, not enumerated**, and that is the load-bearing part. An
 * enumerated list guards the areas whoever wrote it thought of. This started as
 * `server` / `client` / `shared` and the independent review found the hole: a
 * regression scoped to `tests/cli/**` or `tests/channel/**` would leave those
 * directories at a uniform 0% while tripping nothing -- the `ts` family still
 * has 400-odd other files present, so the family check stays green, and an
 * unenumerated prefix cannot fail a check it is not in. That is the same
 * failure class this unit exists to catch, one level of granularity down.
 *
 * Deriving it means a new top-level directory is guarded the day it appears,
 * without anyone remembering to add it.
 */
const AREA_PROJECTS = {
  server: "vitest project: node",
  client: "vitest project: client",
  shared: "both projects",
  cli: "vitest project: node",
  channel: "vitest project: node",
  monitor: "vitest project: node",
  "stdio-bridge": "vitest project: node",
};

/**
 * Areas with genuinely zero covered statements, each with the reason.
 *
 * The distinction this whole artifact turns on applies to the exemption list
 * too: an area belongs here only when it is UNTESTED, never when a run failed
 * to reach it. Adding an entry to silence a failure is how the check becomes
 * decorative, so each one names what is actually uncovered.
 */
const KNOWN_UNTESTED_AREAS = {
  "stdio-bridge": {
    reason:
      "src/stdio-bridge/index.ts is a 3-statement process shim that execs the " +
      "CLI bridge. The bridge logic it hands off to (src/cli/mcp-stdio.ts) is " +
      "covered; the shim itself is entered only by a real spawn, which no unit " +
      "test performs. Measured, present in the report, and genuinely at 0/3 -- " +
      "not a run that failed to reach it.",
  },
};

function fail(message, detail) {
  console.error(`\ncoverage-manifest: ${message}`);
  if (detail) console.error(detail);
  console.error(
    "\nNo baseline artifact was written. This is deliberate: an artifact that " +
      "cannot say what it measured is worse than none, because the numbers in " +
      "it get seeded into enforced floors.\n",
  );
  process.exit(1);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(path.relative(ROOT, full).replace(/\\/g, "/"));
  }
  return out;
}

// --- Read the summary, refusing every shape that cannot be vouched for -------

if (!existsSync(SUMMARY)) {
  fail(
    `no coverage summary at ${path.relative(ROOT, SUMMARY)}`,
    "Run `npm run test:coverage` first. If that command exited 0 and still " +
      "produced no summary, the `json-summary` reporter is not configured.",
  );
}

let summary;
try {
  summary = JSON.parse(readFileSync(SUMMARY, "utf-8"));
} catch (err) {
  fail("coverage summary is not valid JSON", String(err));
}

const total = summary.total;
if (!total || typeof total.statements?.total !== "number") {
  fail("coverage summary has no `total.statements.total`", JSON.stringify(total, null, 2));
}

// The failure this whole script was written after. A Vitest project whose
// `include` used a negated glob ran its 324 test files normally and collected
// no coverage at all; the run exited 0 and reported `Unknown% ( 0/0 )`.
if (total.statements.total === 0) {
  fail(
    "the coverage run measured ZERO statements",
    "Tests may have passed and the command may have exited 0 -- that is exactly " +
      "the failure mode. A Vitest project whose `test.include` contains a negated " +
      'pattern (e.g. "!tests/client/**") selects its files correctly but collects ' +
      "no V8 coverage for any of them. Use `exclude` instead. See the comment in " +
      "vitest.config.ts.",
  );
}

// --- Family accounting, derived from disk ------------------------------------

const onDisk = walk(path.join(ROOT, "src"));

// The summary keys are absolute paths with the host's separators. Normalize to
// repo-relative forward slashes ONCE, so every check below compares the same
// shape -- on Windows a stray backslash makes every lookup miss, and a miss here
// reads as "this file has no coverage" rather than as a bug in the comparison.
const byRepoPath = new Map(
  Object.entries(summary)
    .filter(([k]) => k !== "total")
    .map(([k, v]) => [path.relative(ROOT, k).replace(/\\/g, "/"), v]),
);
const reported = new Set(byRepoPath.keys());

const measured = [];
for (const family of MEASURED_FAMILIES) {
  const files = onDisk.filter(family.matches);
  const present = files.filter((f) => reported.has(f));
  measured.push({
    id: family.id,
    label: family.label,
    filesOnDisk: files.length,
    filesInReport: present.length,
  });
}

const emptyFamilies = measured.filter((f) => f.filesOnDisk > 0 && f.filesInReport === 0);
if (emptyFamilies.length > 0) {
  fail(
    `a family this baseline claims to measure has NO files in the report: ` +
      emptyFamilies.map((f) => `${f.id} (${f.filesOnDisk} on disk)`).join(", "),
    "Either the coverage `include` glob in vitest.config.ts stopped matching " +
      "that extension, or the family stopped being measurable. Absent-from-report " +
      "and measured-at-0% are indistinguishable in the numbers, which is why this " +
      "refuses rather than reporting a smaller denominator.",
  );
}

// --- Anti-partial-run check --------------------------------------------------

// Every top-level directory under `src/` that the walk found, whether or not
// anyone thought to enumerate it. Taken from disk rather than from the report,
// so an area that vanishes from the report entirely is still listed here at
// zero files -- absent and uncovered are different, and the artifact should be
// able to say which.
const areaIds = [
  ...new Set(onDisk.map((f) => f.match(/^src\/([^/]+)\//)?.[1]).filter(Boolean)),
].sort();

const areas = areaIds.map((id) => {
  const prefix = `src/${id}/`;
  const files = [...byRepoPath.keys()].filter((f) => f.startsWith(prefix));
  const coveredStatements = files.reduce((n, f) => n + byRepoPath.get(f).statements.covered, 0);
  const totalStatements = files.reduce((n, f) => n + byRepoPath.get(f).statements.total, 0);
  const known = KNOWN_UNTESTED_AREAS[id];
  return {
    id,
    prefix,
    ranBy: AREA_PROJECTS[id] ?? "unknown -- not listed in AREA_PROJECTS",
    filesInReport: files.length,
    coveredStatements,
    totalStatements,
    ...(known ? { knownUntested: true, reason: known.reason } : {}),
  };
});

const dark = areas.filter(
  (a) => a.filesInReport > 0 && a.coveredStatements === 0 && !a.knownUntested,
);
if (dark.length > 0) {
  fail(
    `source areas present in the report with ZERO covered statements: ` +
      dark.map((a) => `${a.prefix} (${a.ranBy})`).join(", "),
    "That is what a partial run looks like: the unrun project's source is listed " +
      "at a uniform 0%, which reads as untested rather than unrun. Run the whole " +
      "suite (`npm run test:coverage`). If an area genuinely has no tests at all, " +
      "add it to KNOWN_UNTESTED_AREAS in this script with a reason -- and only if " +
      "it is untested, never to silence a run that failed to reach it.",
  );
}

// An exemption that stops being true is worse than no exemption: it holds the
// door open for the exact failure the check exists to catch. So the list has to
// shrink on its own when the area gets tested.
const staleExemptions = areas.filter((a) => a.knownUntested && a.coveredStatements > 0);
if (staleExemptions.length > 0) {
  fail(
    `KNOWN_UNTESTED_AREAS lists an area that now HAS coverage: ` +
      staleExemptions.map((a) => `${a.prefix} (${a.coveredStatements} covered)`).join(", "),
    "Good news, and it has to be removed from that list -- while it sits there, " +
      "the area is exempt from the zero-coverage check and could go dark again " +
      "without failing anything.",
  );
}

// --- Emit --------------------------------------------------------------------

const manifest = {
  $comment:
    "Machine-readable statement of what this coverage baseline measured. Read " +
    "`measured` and `omitted` before using any number in `totals` -- a percentage " +
    "alone cannot tell you which source families are behind it.",
  generatedFrom: path.relative(ROOT, SUMMARY).replace(/\\/g, "/"),
  coverageProvider: "v8",
  vitestProjects: ["client", "node"],
  measured,
  omitted: OMITTED_FAMILIES.map((f) => ({
    id: f.id,
    label: f.label,
    // `null`, not `0`, for a family that lives outside the walked tree. A zero
    // here is formatted identically to the genuinely-counted families and reads
    // as "there is none of this", when it means "we did not look". That is the
    // artifact's own central distinction; it should not violate it in its own
    // output.
    filesOnDisk: f.walkable === false ? null : onDisk.filter(f.matches).length,
    ...(f.walkable === false
      ? { notWalked: "lives outside src/; this script walks src/ only" }
      : {}),
    reason: f.reason,
  })),
  areas,
  totals: {
    statements: total.statements,
    branches: total.branches,
    functions: total.functions,
    lines: total.lines,
  },
  suspendedDuringMeasurement: {
    mechanism: "expectWithinMs() no-ops when TANDEM_COVERAGE=1 (tests/helpers/timing.ts)",
    why:
      "A wall-clock upper bound measures V8 instrumentation during a coverage " +
      "run, not the property it stands in for. These are enforced normally, " +
      "under `npm test`, the pre-push hook and the CI check job.",
    sites: SUSPENDED_TIMING_SITES,
  },
  thresholds: {
    enforced: false,
    note:
      "Unit 3 publishes a baseline only. Per-module floors are Unit 13's job and " +
      "are seeded from these numbers with at most a one-point rounding allowance.",
  },
};

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

const pct = (m) => `${m.pct}% (${m.covered}/${m.total})`;
console.log("\nCoverage baseline");
console.log(`  statements  ${pct(total.statements)}`);
console.log(`  branches    ${pct(total.branches)}`);
console.log(`  functions   ${pct(total.functions)}`);
console.log(`  lines       ${pct(total.lines)}`);
console.log("\nMeasured families");
for (const f of measured) {
  console.log(`  ${f.label.padEnd(34)} ${f.filesInReport}/${f.filesOnDisk} files in report`);
}
console.log("\nOmitted families");
for (const f of manifest.omitted) {
  const count = f.filesOnDisk === null ? "not walked" : `${f.filesOnDisk} files`;
  console.log(`  ${f.label.padEnd(34)} ${count} -- ${f.reason.split(".")[0]}.`);
}
console.log("\nAreas under src/");
for (const a of areas) {
  const note = a.knownUntested ? "  (known untested)" : "";
  console.log(
    `  ${a.prefix.padEnd(22)} ${String(a.coveredStatements).padStart(6)}/${a.totalStatements} statements${note}`,
  );
}
console.log(`\nWrote ${path.relative(ROOT, OUT).replace(/\\/g, "/")}\n`);
