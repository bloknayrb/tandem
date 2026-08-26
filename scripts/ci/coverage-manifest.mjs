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
 *
 * ## Shape: one pure function, a thin CLI around it
 *
 * `buildManifest()` takes the parsed summary and the file list and returns
 * either a refusal or a manifest. It touches no filesystem and exits no
 * process, so `tests/scripts/coverage-manifest.test.ts` drives every refusal
 * path with a synthetic input and asserts it actually refuses.
 *
 * That split is not tidiness. The first version of this file did all of its
 * work at module scope, and review found the consequence: the anti-partial-run
 * check -- by this file's own comment the most load-bearing thing in it -- had
 * no automated anchor at all. Deleting the whole block left the suite green.
 * The mutation proofs that "covered" it were run by hand and did not persist,
 * which is the same as not having them. A check whose own correctness rests on
 * someone having once run something manually is the shape this unit exists to
 * eliminate.
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
export const MEASURED_FAMILIES = [
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
export const OMITTED_FAMILIES = [
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
export const SUSPENDED_TIMING_SITES = [
  "tests/server/docx-size-gate.test.ts",
  "tests/cli/mcp-stdio.test.ts",
  "tests/server/platform.test.ts",
];

/**
 * Which Vitest project runs each area, for the failure message.
 *
 * This is a label map, NOT the guarded set -- the guarded set is derived from
 * disk (see `buildManifest`). But it is required to be complete: an area on
 * disk with no entry here is a refusal, not an "unknown" string in the
 * artifact. That is what makes a new top-level directory a one-line decision
 * someone has to make, rather than something that quietly publishes as
 * unlabelled.
 */
export const AREA_PROJECTS = {
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
 *
 * Two things bound the hatch, because "a reviewer will read the reason" is not
 * a mechanism:
 *
 *   - an exemption EXPIRES on its own once the area gains coverage; and
 *   - an exemption is only honoured for an area under
 *     `MAX_EXEMPT_STATEMENTS`. A large area reporting zero is far more likely
 *     to be a run that failed to reach it than something nobody ever tested,
 *     and that is exactly the case an exemption must not be able to silence.
 */
export const KNOWN_UNTESTED_AREAS = {
  "stdio-bridge": {
    reason:
      "src/stdio-bridge/index.ts is a 3-statement process shim that execs the " +
      "CLI bridge. The bridge logic it hands off to (src/cli/mcp-stdio.ts) is " +
      "covered; the shim itself is entered only by a real spawn, which no unit " +
      "test performs. Measured, present in the report, and genuinely at 0/3 -- " +
      "not a run that failed to reach it.",
  },
};

/** Ceiling on what an exemption may cover. See `KNOWN_UNTESTED_AREAS`. */
export const MAX_EXEMPT_STATEMENTS = 25;

/** The four metrics the artifact publishes. All must be present and numeric. */
const TOTAL_METRICS = ["statements", "branches", "functions", "lines"];

/**
 * Repo-relative, forward-slashed.
 *
 * On Windows a stray backslash makes every map lookup miss, and a miss reads as
 * "this file has no coverage" rather than as a bug in the comparison -- the one
 * confusion this artifact exists to prevent. One helper so there is one place
 * for that concern to live.
 */
const toRepoPath = (p) => path.relative(ROOT, p).replace(/\\/g, "/");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(toRepoPath(full));
  }
  return out;
}

/**
 * A refusal. `ok` is annotated to the literal `false` so callers can narrow on
 * it -- inferred as plain `boolean`, the union does not discriminate and every
 * `result.message` in the tests is a type error.
 */
const refuse = (message, detail) => ({ ok: /** @type {const} */ (false), message, detail });

const areaOf = (f) => f.match(/^src\/([^/]+)\//)?.[1];

/**
 * Validate a coverage summary and build the baseline manifest from it.
 *
 * Pure: no filesystem, no process exit, no logging. Returns
 * `{ ok: false, message, detail }` for every refusal and
 * `{ ok: true, manifest, areas, measured, total }` otherwise.
 *
 * @param summary parsed `coverage-summary.json` (istanbul json-summary shape),
 *   keyed by ABSOLUTE path with the host's separators, plus a `total` key.
 * @param onDisk  repo-relative forward-slashed paths under `src/`.
 * @param generatedFrom repo-relative path the summary came from, for the artifact.
 */
export function buildManifest({
  summary,
  onDisk,
  generatedFrom = "coverage/coverage-summary.json",
}) {
  // --- Refuse every summary shape that cannot be vouched for -----------------

  const total = summary?.total;
  if (!total) {
    return refuse("coverage summary has no `total` key", JSON.stringify(summary, null, 2));
  }

  // Every metric, not only `statements`. The artifact publishes all four, and a
  // provider version bump that drops or renames one would otherwise sail
  // through: `total.branches` comes out `undefined`, JSON.stringify drops the
  // key silently, and Unit 13 seeds a floor from a totals object that is
  // missing a metric. Wrong-but-plausible is the thing this file exists to not
  // produce.
  const malformed = TOTAL_METRICS.filter((m) => typeof total[m]?.total !== "number");
  if (malformed.length > 0) {
    return refuse(
      `coverage summary is missing or malformed for: ${malformed.join(", ")}`,
      JSON.stringify(total, null, 2),
    );
  }

  // The failure this whole script was written after. A Vitest project whose
  // `include` used a negated glob ran its 324 test files normally and collected
  // no coverage at all; the run exited 0 and reported `Unknown% ( 0/0 )`.
  if (total.statements.total === 0) {
    return refuse(
      "the coverage run measured ZERO statements",
      "Tests may have passed and the command may have exited 0 -- that is exactly " +
        "the failure mode. A Vitest project whose `test.include` contains a negated " +
        'pattern (e.g. "!tests/client/**") selects its files correctly but collects ' +
        "no V8 coverage for any of them. Use `exclude` instead. See the comment in " +
        "vitest.config.ts.",
    );
  }

  // --- Refuse an input that would make every check below vacuous -------------

  // A check over zero items passes. `onDisk` empty means the family accounting
  // and the area accounting both iterate nothing and report success -- the
  // literal shape of #1229. `walk()` throws on a missing `src/`, so this is not
  // reachable today; it is the floor under a derivation whose lower bound would
  // otherwise be zero.
  if (onDisk.length === 0) {
    return refuse(
      "no files found under src/",
      "Every family and area check below iterates this list, so an empty one " +
        "passes them all while measuring nothing. Refusing instead.",
    );
  }

  // --- Family accounting, derived from disk ----------------------------------

  // The summary keys are absolute paths with the host's separators. Normalize
  // once, so every check below compares the same shape.
  const byRepoPath = new Map(
    Object.entries(summary)
      .filter(([k]) => k !== "total")
      .map(([k, v]) => [toRepoPath(k), v]),
  );
  const reported = new Set(byRepoPath.keys());

  const measured = MEASURED_FAMILIES.map((family) => {
    const files = onDisk.filter(family.matches);
    return {
      id: family.id,
      label: family.label,
      filesOnDisk: files.length,
      filesInReport: files.filter((f) => reported.has(f)).length,
    };
  });

  const emptyFamilies = measured.filter((f) => f.filesOnDisk > 0 && f.filesInReport === 0);
  if (emptyFamilies.length > 0) {
    return refuse(
      `a family this baseline claims to measure has NO files in the report: ` +
        emptyFamilies.map((f) => `${f.id} (${f.filesOnDisk} on disk)`).join(", "),
      "Either the coverage `include` glob in vitest.config.ts stopped matching " +
        "that extension, or the family stopped being measurable. Absent-from-report " +
        "and measured-at-0% are indistinguishable in the numbers, which is why this " +
        "refuses rather than reporting a smaller denominator.",
    );
  }

  // --- Anti-partial-run check ------------------------------------------------

  // Every top-level directory under `src/` that the walk found, whether or not
  // anyone thought to enumerate it. Derived, NOT enumerated, and that is the
  // load-bearing part: an enumerated list guards the areas whoever wrote it
  // thought of. This started as server/client/shared and review found the hole
  // -- cli, channel, monitor and stdio-bridge were all outside it, two of them
  // near-dark at the time. A regression scoped to `tests/cli/**` would have
  // left that directory at a uniform 0% and failed nothing.
  const areaIds = [...new Set(onDisk.map(areaOf).filter(Boolean))].sort();

  // A file sitting directly in `src/` belongs to no area, so the derivation
  // would step straight over it. Nothing is loose there today, which is exactly
  // when it is cheap to refuse.
  const unassigned = onDisk.filter((f) => !areaOf(f));
  if (unassigned.length > 0) {
    return refuse(
      `files sit directly in src/ and belong to no area: ${unassigned.join(", ")}`,
      "The area check is keyed on the first path segment under src/, so a loose " +
        "file is guarded by nothing. Move it into an area directory, or teach this " +
        "script how to account for it.",
    );
  }

  // Symmetry in both directions, so neither list can quietly shrink past the
  // other. An area on disk with no label means a new directory arrived and
  // nobody decided what runs it; a label with no directory means the walk
  // returned less than the repo holds, which is the "reduced set" version of
  // the empty-input problem above and is otherwise indistinguishable from a
  // deleted directory.
  const unlabelled = areaIds.filter((id) => !AREA_PROJECTS[id]);
  if (unlabelled.length > 0) {
    return refuse(
      `areas exist under src/ with no entry in AREA_PROJECTS: ${unlabelled.join(", ")}`,
      "Add each one with the Vitest project that runs it. Publishing it as " +
        '"unknown" would put an unlabelled area in an artifact whose whole job is ' +
        "saying what was measured.",
    );
  }
  const vanished = Object.keys(AREA_PROJECTS).filter((id) => !areaIds.includes(id));
  if (vanished.length > 0) {
    return refuse(
      `AREA_PROJECTS names areas that are not on disk: ${vanished.join(", ")}`,
      "Either the directory was deleted -- remove it here too -- or the walk " +
        "returned less than the repo holds, which would silently shrink every " +
        "check below. The two look identical from here, so this refuses.",
    );
  }

  // Files V8 could instrument, as opposed to everything under `src/`. An area
  // holding nothing but `.css` is legitimately absent from the report; one
  // holding `.ts` is not.
  const measurable = onDisk.filter((f) => MEASURED_FAMILIES.some((fam) => fam.matches(f)));

  const areas = areaIds.map((id) => {
    const prefix = `src/${id}/`;
    const files = [...byRepoPath.keys()].filter((f) => f.startsWith(prefix));
    const sum = (pick) => files.reduce((n, f) => n + pick(byRepoPath.get(f).statements), 0);
    const known = KNOWN_UNTESTED_AREAS[id];
    return {
      id,
      prefix,
      ranBy: AREA_PROJECTS[id],
      measurableFilesOnDisk: measurable.filter((f) => f.startsWith(prefix)).length,
      filesInReport: files.length,
      coveredStatements: sum((s) => s.covered),
      totalStatements: sum((s) => s.total),
      ...(known ? { knownUntested: true, reason: known.reason } : {}),
    };
  });

  // ABSENT is not the same as zero, and the dark check below cannot see it: it
  // requires `filesInReport > 0`, so an area with no keys in the report at all
  // reports 0/0 and passes.
  //
  // Review found this by reproducing it: delete every node-project area's
  // entries from the summary and the old code returned ok:true. That is the
  // whole `node` project failing to run, published as a successful baseline --
  // the exact failure class this file's docstring claims to eliminate, hiding
  // inside the fix for it. The family check does not cover it either, because
  // the other areas' `.ts` files keep the `ts` family above zero; there was no
  // per-area analogue.
  //
  // A KNOWN_UNTESTED exemption deliberately does NOT excuse absence. An
  // exemption is a claim about coverage LEVEL -- "nothing tests this" -- not a
  // claim that the file should be missing from a report. `src/stdio-bridge/` is
  // exempt and is still present, at 0/3.
  const absent = areas.filter((a) => a.measurableFilesOnDisk > 0 && a.filesInReport === 0);
  if (absent.length > 0) {
    return refuse(
      `source areas have instrumentable files on disk but NOTHING in the report: ` +
        absent.map((a) => `${a.prefix} (${a.measurableFilesOnDisk} files, ${a.ranBy})`).join(", "),
      "Absent from the report and measured-at-zero are different failures and " +
        "look identical in a percentage. This is what a project that did not run " +
        "at all looks like -- not one that ran and covered nothing.",
    );
  }

  // An exemption that stops being true is worse than no exemption: it holds the
  // door open for the exact failure the check exists to catch. So the list has
  // to shrink on its own when the area gets tested.
  //
  // Checked BEFORE the size ceiling below, because an area can trip both and
  // only one of the two messages is useful then. "Too large to be plausibly
  // untested" is actively misleading about an area that turns out to BE tested;
  // "remove it, it has coverage" is the thing to do either way.
  const staleExemptions = areas.filter((a) => a.knownUntested && a.coveredStatements > 0);
  if (staleExemptions.length > 0) {
    return refuse(
      `KNOWN_UNTESTED_AREAS lists an area that now HAS coverage: ` +
        staleExemptions.map((a) => `${a.prefix} (${a.coveredStatements} covered)`).join(", "),
      "Good news, and it has to be removed from that list -- while it sits there, " +
        "the area is exempt from the zero-coverage check and could go dark again " +
        "without failing anything.",
    );
  }

  // An exemption is only honoured for a small area. A large one reporting zero
  // is far more likely a run that failed to reach it than something nobody ever
  // tested -- precisely the case an exemption must not be able to silence.
  const oversized = areas.filter(
    (a) => a.knownUntested && a.totalStatements > MAX_EXEMPT_STATEMENTS,
  );
  if (oversized.length > 0) {
    return refuse(
      `KNOWN_UNTESTED_AREAS exempts an area too large to be plausibly untested: ` +
        oversized.map((a) => `${a.prefix} (${a.totalStatements} statements)`).join(", "),
      `The exemption ceiling is ${MAX_EXEMPT_STATEMENTS} statements. Above it, zero ` +
        "coverage is more likely a run that did not reach the area than code nobody " +
        "ever tested, and that is the case the hatch must not be able to hide.",
    );
  }

  const dark = areas.filter(
    (a) => a.filesInReport > 0 && a.coveredStatements === 0 && !a.knownUntested,
  );
  if (dark.length > 0) {
    return refuse(
      `source areas present in the report with ZERO covered statements: ` +
        dark.map((a) => `${a.prefix} (${a.ranBy})`).join(", "),
      "That is what a partial run looks like: the unrun project's source is listed " +
        "at a uniform 0%, which reads as untested rather than unrun. Run the whole " +
        "suite (`npm run test:coverage`). If an area genuinely has no tests at all, " +
        "add it to KNOWN_UNTESTED_AREAS in this script with a reason -- and only if " +
        "it is untested, never to silence a run that failed to reach it.",
    );
  }

  // --- Emit ------------------------------------------------------------------

  const manifest = {
    $comment:
      "Machine-readable statement of what this coverage baseline measured. Read " +
      "`measured`, `omitted` and `areas` before using any number in `totals` -- a " +
      "percentage alone cannot tell you what is behind it.",
    generatedFrom,
    coverageProvider: "v8",
    vitestProjects: ["client", "node"],
    measured,
    omitted: OMITTED_FAMILIES.map((f) => ({
      id: f.id,
      label: f.label,
      // `null`, not `0`, for a family that lives outside the walked tree. A
      // zero here is formatted identically to the genuinely-counted families
      // and reads as "there is none of this", when it means "we did not look".
      // That is the artifact's own central distinction; it should not violate
      // it in its own output.
      filesOnDisk: f.walkable === false ? null : onDisk.filter(f.matches).length,
      ...(f.walkable === false
        ? { notWalked: "lives outside src/; this script walks src/ only" }
        : {}),
      reason: f.reason,
    })),
    areas,
    totals: Object.fromEntries(TOTAL_METRICS.map((m) => [m, total[m]])),
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

  return { ok: /** @type {const} */ (true), manifest, areas, measured, total };
}

// --- CLI ---------------------------------------------------------------------

/**
 * Only when run as a script. Importing this module for its checks (as the tests
 * do) must not read the repo's coverage directory or exit the process.
 */
const isEntry =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntry) {
  main();
}

function die(message, detail) {
  console.error(`\ncoverage-manifest: ${message}`);
  if (detail) console.error(detail);
  console.error(
    "\nNo baseline artifact was written. This is deliberate: an artifact that " +
      "cannot say what it measured is worse than none, because the numbers in " +
      "it get seeded into enforced floors.\n",
  );
  process.exit(1);
}

function main() {
  if (!existsSync(SUMMARY)) {
    die(
      `no coverage summary at ${toRepoPath(SUMMARY)}`,
      "Run `npm run test:coverage` first. If that command exited 0 and still " +
        "produced no summary, the `json-summary` reporter is not configured.",
    );
    return;
  }

  // Read and parse are separate on purpose. Folded together, an EACCES or an
  // EISDIR reports as "not valid JSON" and sends the next reader to the vitest
  // reporter config instead of the filesystem.
  let raw;
  try {
    raw = readFileSync(SUMMARY, "utf-8");
  } catch (err) {
    die(`coverage summary could not be read: ${toRepoPath(SUMMARY)}`, String(err));
    return;
  }

  let summary;
  try {
    summary = JSON.parse(raw);
  } catch (err) {
    die("coverage summary is not valid JSON", String(err));
    return;
  }

  const result = buildManifest({
    summary,
    onDisk: walk(path.join(ROOT, "src")),
    generatedFrom: toRepoPath(SUMMARY),
  });

  if (!result.ok) {
    die(result.message, result.detail);
    return;
  }

  const { manifest, areas, measured, total } = result;

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

  const pct = (m) => `${m.pct}% (${m.covered}/${m.total})`;
  console.log("\nCoverage baseline");
  for (const m of TOTAL_METRICS) {
    console.log(`  ${m.padEnd(11)} ${pct(total[m])}`);
  }
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
  console.log(`\nWrote ${toRepoPath(OUT)}\n`);
}
