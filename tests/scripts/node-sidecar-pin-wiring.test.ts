import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  compareVersions,
  EXIT_BEHIND,
  EXIT_CANNOT_EVALUATE,
  EXIT_OK,
  evaluatePin,
  main,
} from "../../scripts/ci/node-sidecar-pin.mjs";
import { DEFAULT_NODE_VERSION, NODE_ARCHIVE_SHA256 } from "../../scripts/node-sidecar-version.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * #1747 — the bundled Node sidecar was pinned at 22.17.0 (2025-06-24) for
 * fourteen months, five security releases behind, and every desktop user ran it.
 * CI never noticed because its own jobs use `node-version: 22` (the latest), so
 * the suite never exercises the runtime that actually ships.
 *
 * The detection lives in an ADVISORY job, because it reaches the network and a
 * nodejs.org outage must not block merges. This is the ADR-051 half: the job
 * does the work, and this test — inside `check`, which IS required — pins the
 * job's shape and the constant it reads.
 *
 * **What this does not do, stated so the ADR row and the CHANGELOG do not
 * overclaim:** it pins the job's SHAPE, not the pin's CURRENCY. Nothing in
 * `check` can tell you the bundled Node is current; only the advisory job can,
 * and a red advisory job blocks nobody. What `check` CAN stop is the version
 * silently going backwards, which is why `DEFAULT_NODE_VERSION` is pinned below
 * as an exact literal rather than a `/^22\./` shape — under a shape assertion,
 * `"22.0.0"` passes every test here, passes every synthetic fixture, and reddens
 * only the job that cannot block.
 */

type Step = { uses?: string; run?: string; if?: unknown; "continue-on-error"?: unknown };
type Defaults = { run?: { shell?: unknown } };
type Job = {
  "runs-on"?: unknown;
  if?: unknown;
  "continue-on-error"?: unknown;
  defaults?: Defaults;
  steps: Step[];
};

const workflow = parse(readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf-8")) as {
  defaults?: Defaults;
  jobs: Record<string, Job>;
};

const RUNNER = "node scripts/ci/node-sidecar-pin.mjs";

function pinJob(): Job {
  const match = Object.entries(workflow.jobs).find(([, job]) =>
    (job.steps ?? []).some((s) => typeof s.run === "string" && s.run.trim() === RUNNER),
  );
  if (!match) {
    throw new Error(
      `.github/workflows/ci.yml: no job runs \`${RUNNER}\`. That job is #1747's drift ` +
        "detection; without it the bundled Node can go stale for months unnoticed.",
    );
  }
  return match[1];
}

function pinStepIndex(job: Job): number {
  const i = (job.steps ?? []).findIndex(
    (s) => typeof s.run === "string" && s.run.trim() === RUNNER,
  );
  if (i < 0) throw new Error("ci.yml: pin step vanished between lookups");
  return i;
}

/** A synthetic release index. Built from raw shapes, not from anything the code under test produces. */
function entry(version: string, date: string, security = false) {
  return { version, date, security, lts: "Jod" };
}

describe("the bundled Node pin is checked for drift (#1747)", () => {
  describe("the constant", () => {
    it("is pinned by exact equality, so it cannot silently go backwards", () => {
      // Not `/^22\.\d+\.\d+$/`: under a shape assertion, "22.0.0" — fourteen
      // months of security releases behind — passes everything in `check` and
      // reddens only an advisory job. A bump edits this line, deliberately.
      expect(DEFAULT_NODE_VERSION).toBe("22.23.2");
    });

    it("carries a committed hash for every triple the downloader can build", () => {
      // The realistic bump mistake is a dropped or garbled entry, which would
      // otherwise surface on someone's first real download of that target.
      const source = readFileSync(path.join(ROOT, "scripts/download-node-sidecar.mjs"), "utf-8");
      const tripleBlock = source.slice(source.indexOf("const TRIPLE_MAP"));
      const triples = [...tripleBlock.matchAll(/"([a-z0-9_]+-[a-z0-9-]+)":\s*\{/g)].map(
        (m) => m[1],
      );
      expect(triples.length).toBeGreaterThan(0);
      expect(Object.keys(NODE_ARCHIVE_SHA256).sort()).toEqual([...triples].sort());
      for (const [triple, hash] of Object.entries(NODE_ARCHIVE_SHA256)) {
        expect(hash, `${triple}: not a SHA-256`).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it("is what the downloader actually uses", () => {
      // `toContain("DEFAULT_NODE_VERSION")` would pass on a file that imports the
      // constant and then falls back to a literal anyway, which is the exact
      // shape of the bug being fixed. So the binding is pinned, and so is the
      // absence of a dotted version literal anywhere in the file.
      const source = readFileSync(path.join(ROOT, "scripts/download-node-sidecar.mjs"), "utf-8");
      expect(source).toContain(
        'const nodeVersion = getArg("--node-version") || DEFAULT_NODE_VERSION;',
      );
      const literals = [...source.matchAll(/\b(\d{2}\.\d+\.\d+)\b/g)].map((m) => m[1]);
      expect(literals, "a hardcoded Node version literal is back in the downloader").toEqual([]);
    });

    it("routes every consumer through that one binding, not a shadow of it", () => {
      // Adversarial review defeated the two assertions above together. Both are
      // about the DECLARATION, and neither says the declaration is what gets
      // USED. Add this after it and everything above stays green:
      //
      //   let effectiveNodeVersion = nodeVersion;
      //   if (!process.env.CI) effectiveNodeVersion = ["22", "17", "0"].join(".");
      //
      // then thread `effectiveNodeVersion` into the download and verify calls.
      // The required line is still present verbatim, and the literal sweep finds
      // nothing because "22", "17" and "0" are never contiguous in the source —
      // reinstating the stale-version fallback #1747 removed, off CI, where it
      // would be found by a user rather than a test.
      //
      // Scanning harder for split literals is the wrong repair: any scan for a
      // TEXT SHAPE loses to a different spelling. Key on the structural fact
      // instead — every site that consumes a version takes `nodeVersion`, and
      // `nodeVersion` is assigned exactly once.
      const source = readFileSync(path.join(ROOT, "scripts/download-node-sidecar.mjs"), "utf-8");

      for (const consumer of [
        "const url = `https://nodejs.org/dist/v${nodeVersion}/${archiveName}`;",
        "verifyCommittedChecksum(archivePath, archiveName, nodeVersion, targetTriple);",
        "await verifyChecksum(archivePath, archiveName, nodeVersion);",
        "extractZip(archivePath, nodeVersion, info, outputPath);",
        "extractTarGz(archivePath, nodeVersion, info, outputPath);",
        "recorded === nodeVersion",
      ]) {
        expect(source, `a version consumer no longer reads \`nodeVersion\`: ${consumer}`).toContain(
          consumer,
        );
      }

      // Exactly one assignment, so the binding above cannot be reassigned later
      // and cannot be a `let` that something rewrites. Declaration only — the
      // matches inside function signatures are parameters, not assignments.
      const assignments = [
        ...source.matchAll(/^\s*(?:const |let |var )?nodeVersion\s*=(?!=)/gm),
      ].map((m) => m[0].trim());
      expect(assignments, "nodeVersion is assigned more than once").toEqual([
        "const nodeVersion =",
      ]);
    });

    it("re-downloads when the on-disk sidecar is a different version, or unmarked", () => {
      // The old check was size-only and exited 0 before the version was ever
      // read, so a bump was a no-op in any tree that already had a sidecar. A
      // MISSING marker has to count as stale too — that is the state every
      // existing checkout is in the first time this runs.
      const source = readFileSync(path.join(ROOT, "scripts/download-node-sidecar.mjs"), "utf-8");
      expect(source).toContain("const versionMarkerPath = `${outputPath}.version`;");
      expect(source).toContain("recorded === nodeVersion");
      expect(source).toContain("writeFileSync(versionMarkerPath, `${nodeVersion}\\n`);");
    });
  });

  describe("the evaluator", () => {
    const today = new Date("2026-09-02T00:00:00Z");

    it("reports BEHIND, naming every security release it is behind", () => {
      const index = [
        entry("v22.23.2", "2026-07-28", true),
        entry("v22.23.0", "2026-06-17", true),
        entry("v22.18.0", "2026-02-01"),
        entry("v22.17.0", "2025-06-24"),
      ];
      const result = evaluatePin({ pinned: "22.17.0", index, now: today });
      expect(result.code).toBe(EXIT_BEHIND);
      expect(result.message).toContain("22.23.0");
      expect(result.message).toContain("22.23.2");
    });

    it("reports OK when the pin is at the newest security release", () => {
      const index = [entry("v22.23.2", "2026-07-28", true), entry("v22.17.0", "2025-06-24")];
      expect(evaluatePin({ pinned: "22.23.2", index, now: today }).code).toBe(EXIT_OK);
    });

    it("compares numerically, not lexically", () => {
      // The fixture that matters: `localeCompare` puts "22.9.0" above "22.23.2",
      // so a string-comparing implementation calls a badly stale pin current.
      // Same-width fixtures pass under both implementations and prove nothing.
      expect(compareVersions("22.9.0", "22.23.2")).toBeLessThan(0);
      const index = [entry("v22.23.2", "2026-07-28", true), entry("v22.9.0", "2025-09-01")];
      expect(evaluatePin({ pinned: "22.9.0", index, now: today }).code).toBe(EXIT_BEHIND);
    });

    it("cannot evaluate a payload that is not the release index", () => {
      expect(evaluatePin({ pinned: "22.23.2", index: { error: "nope" }, now: today }).code).toBe(
        EXIT_CANNOT_EVALUATE,
      );
      expect(evaluatePin({ pinned: "22.23.2", index: [], now: today }).code).toBe(
        EXIT_CANNOT_EVALUATE,
      );
    });

    it("cannot evaluate once the line has gone quiet past its end of life", () => {
      // Node 22 leaves maintenance in April 2027. After that, "no newer security
      // release" stops meaning "up to date" and a two-outcome gate would report
      // 0 forever against an unsupported runtime — the quietest form of #1229.
      const index = [entry("v22.23.2", "2026-07-28", true)];
      const result = evaluatePin({
        pinned: "22.23.2",
        index,
        now: new Date("2027-09-01T00:00:00Z"),
      });
      expect(result.code).toBe(EXIT_CANNOT_EVALUATE);
      expect(result.message).toContain("end-of-life");
    });
  });

  describe("the CLI, not just the evaluator", () => {
    // Without these, the whole script could be reduced to `process.exit(0)` with
    // every assertion above still green, because they only ever call the pure
    // function. windows-acl-proof-wiring.test.ts carries the same pair for the
    // same reason.
    it("returns CANNOT_EVALUATE when the index cannot be read", async () => {
      const code = await main({
        pinned: "22.23.2",
        load: async () => {
          throw new Error("simulated network failure");
        },
      });
      expect(code).toBe(EXIT_CANNOT_EVALUATE);
    });

    it("defaults to the pinned constant rather than some other version", async () => {
      let seen: unknown;
      await main({
        load: async () => {
          seen = true;
          return [entry("v22.23.2", "2026-07-28", true)];
        },
      });
      expect(seen).toBe(true);
      // Drive it against an index that is AHEAD of the pin: this can only come
      // back BEHIND if main() really passed DEFAULT_NODE_VERSION through.
      const code = await main({
        load: async () => [
          entry("v22.99.0", "2026-08-01", true),
          entry("v22.23.2", "2026-07-28", true),
        ],
      });
      expect(code).toBe(EXIT_BEHIND);
    });

    it("exits 0 as a real process against a current index", () => {
      const result = spawnSync(process.execPath, ["scripts/ci/node-sidecar-pin.mjs"], {
        cwd: ROOT,
        encoding: "utf-8",
        timeout: 60_000,
      });
      // Network-dependent: an offline runner legitimately reports 3. Both are
      // acceptable here; what must never happen is a 0 that came from a crash
      // or a masked failure, so assert the message matches the code.
      expect([EXIT_OK, EXIT_CANNOT_EVALUATE]).toContain(result.status);
      if (result.status === EXIT_OK) {
        expect(result.stdout).toContain(`Bundled Node ${DEFAULT_NODE_VERSION} is current`);
      } else {
        expect(result.stderr).toContain("::warning::");
      }
    });
  });

  describe("the CI job that runs it", () => {
    it("runs the checker, pinned by exact equality", () => {
      const job = pinJob();
      expect(job.steps[pinStepIndex(job)]?.run?.trim()).toBe(RUNNER);
    });

    it("is unconditional and blocking within its own job", () => {
      // ADR-051 rule 4 — assert the parsed field is absent, never `?? default`.
      // The job is advisory by virtue of not being a required check; that is a
      // repo setting. Nothing INSIDE the file may weaken it further.
      const job = pinJob();
      expect(job.if).toBeUndefined();
      expect(job["continue-on-error"]).toBeUndefined();
      const step = job.steps[pinStepIndex(job)];
      expect(step?.if).toBeUndefined();
      expect(step?.["continue-on-error"]).toBeUndefined();
      // Workflow-level `defaults` is owned by windows-acl-proof-wiring.test.ts
      // (ADR-051 rule 5); not re-asserted here.
      expect(job.defaults?.run?.shell).toBeUndefined();
    });

    it("checks out the repo before running the checker", () => {
      const job = pinJob();
      const checkout = job.steps.findIndex((s) => (s.uses ?? "").startsWith("actions/checkout@"));
      expect(checkout).toBeGreaterThanOrEqual(0);
      expect(checkout).toBeLessThan(pinStepIndex(job));
    });
  });
});
