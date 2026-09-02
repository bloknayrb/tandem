import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * #1746 — the two macOS signing gates in `tauri-release.yml` ended with `exit 0`
 * when the Apple secrets were empty. The job continued, built an unsigned and
 * un-notarized `.dmg`, uploaded it, and the release went green, while the
 * Windows leg had always failed closed. Nothing downstream noticed:
 * `verify-release-manifest` checks the shape and updater signatures of the
 * manifest, not Apple signing.
 *
 * The escape was written before the certificate existed and stopped being
 * correct on 2026-05-15, when every `APPLE_*` secret was populated. It was dead
 * code that would have silently un-gated the macOS legs the moment a secret
 * rotated or expired.
 *
 * **Why this file exists at all.** `tauri-release.yml` runs only on `push:
 * tags: v*`. No required check has ever read it, so a re-softened gate would be
 * discovered by a broken release rather than by CI — the ADR-051 case exactly.
 *
 * Two things learned from what has defeated guards in this repo before, and
 * applied here:
 *
 *   - **Every finder throws.** A `find(...)` returning `undefined` combined with
 *     `step?.run` makes *deleting the step* the one reversion that passes.
 *   - **`not.toContain("exit 0")` is a denylist and does not hold.** A bare
 *     `exit` returns the previous command's status; wrapping the checks in
 *     `if [ -n "$APPLE_CERTIFICATE" ]; then … fi` restores the escape while
 *     keeping `exit 1` present, satisfying both halves of such an assertion.
 *     The gate bodies are therefore pinned by exact equality where they are
 *     short, and by an anchored fragment plus a structural sweep where the body
 *     is 69 lines and legitimately edited.
 */

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: unknown;
  shell?: unknown;
  "continue-on-error"?: unknown;
  env?: Record<string, unknown>;
};

type Defaults = { run?: { shell?: unknown } };

type Job = {
  needs?: unknown;
  if?: unknown;
  strategy?: { "fail-fast"?: unknown; matrix?: { include?: Array<Record<string, string>> } };
  "continue-on-error"?: unknown;
  defaults?: Defaults;
  environment?: unknown;
  steps: Step[];
};

const workflow = parse(
  readFileSync(path.join(ROOT, ".github/workflows/tauri-release.yml"), "utf-8"),
) as {
  on: { push?: { tags?: string[] } };
  defaults?: Defaults;
  jobs: Record<string, Job>;
};

const buildJob = workflow.jobs["build-tauri"];
if (!buildJob) {
  throw new Error("tauri-release.yml: no `build-tauri` job — #1746's gates live in it.");
}

/**
 * Locate a step by a marker comment inside its own `run` body, never by its
 * prose `name:` and never by a string this file also asserts about. A `name:`
 * rename blinds a name-based finder; an anchor that is itself one of the
 * assertions is self-satisfying.
 */
function stepByMarker(marker: string): Step {
  const found = buildJob.steps.filter((s) => typeof s.run === "string" && s.run.includes(marker));
  if (found.length !== 1) {
    throw new Error(
      `tauri-release.yml: expected exactly one step whose run body contains '${marker}', found ${found.length}. ` +
        `This is the #1746 fail-closed gate; if it was renamed, keep the marker.`,
    );
  }
  return found[0] as Step;
}

function stepIndex(step: Step): number {
  const i = buildJob.steps.indexOf(step);
  if (i < 0) throw new Error("step not present in build-tauri");
  return i;
}

/** The Windows counterpart, located structurally rather than by its `name:`. */
function windowsVerifyStep(): Step {
  const found = buildJob.steps.filter(
    (s) => typeof s.run === "string" && s.run.includes("Get-AuthenticodeSignature"),
  );
  if (found.length !== 1) {
    throw new Error(
      `tauri-release.yml: expected exactly one step running Get-AuthenticodeSignature, found ${found.length}. ` +
        `That step is the platform-parity half of #1746.`,
    );
  }
  return found[0] as Step;
}

const APPLE_GATE = stepByMarker("# gate:apple-signing");
const DECODE_GATE = stepByMarker("# gate:apple-decode");
const MACOS_VERIFY = (() => {
  const found = buildJob.steps.filter(
    (s) => typeof s.run === "string" && s.run.includes("xcrun stapler validate"),
  );
  if (found.length !== 1) {
    throw new Error(
      `tauri-release.yml: expected exactly one step running \`xcrun stapler validate\`, found ${found.length}.`,
    );
  }
  return found[0] as Step;
})();

// The exact bodies of the two SHORT gates. Exact equality rather than a
// denylist, per ADR-051 rule 1: it subsumes the whole exit-code-masking family
// (`exit` bare, an `if [ -n ... ]` wrapper, a neutralized accumulator) in one
// assertion, and these bodies are small enough that the whole content IS the
// invariant.
const APPLE_GATE_RUN = `# gate:apple-signing
missing=""
[ -z "$APPLE_CERTIFICATE" ] && missing="$missing APPLE_CERTIFICATE"
[ -z "$APPLE_CERTIFICATE_PASSWORD" ] && missing="$missing APPLE_CERTIFICATE_PASSWORD"
[ -z "$APPLE_TEAM_ID" ] && missing="$missing APPLE_TEAM_ID"
[ -z "$APPLE_API_KEY_BASE64" ] && missing="$missing APPLE_API_KEY_BASE64"
[ -z "$APPLE_API_KEY_ID" ] && missing="$missing APPLE_API_KEY_ID"
[ -z "$APPLE_API_ISSUER_ID" ] && missing="$missing APPLE_API_ISSUER_ID"
[ -z "$APPLE_SIGNING_IDENTITY" ] && missing="$missing APPLE_SIGNING_IDENTITY"
if [ -n "$missing" ]; then
  echo "::error::Apple signing material missing:$missing. The macOS legs would build an unsigned, un-notarized bundle and the release would still go green (#1746). Populate these before tagging."
  exit 1
fi
echo "Apple signing material present."
`;

// The complete set of names the gate tests, derived below from the conditionals
// themselves. ADR-051 rule 3 — deriving it from `env:` keys instead would pass a
// name that is present in env but never actually tested.
const GATED_APPLE_NAMES = [
  "APPLE_API_ISSUER_ID",
  "APPLE_API_KEY_BASE64",
  "APPLE_API_KEY_ID",
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_TEAM_ID",
];

// Every platform this release actually builds. Pinned as a SET because deleting
// the two `macos-latest` rows — a plausible "macOS is flaky this cycle" edit —
// leaves every gate below present, still containing `exit 1`, still carrying the
// exact `if:`, and skips all of them. That is the defeat that touches none of
// the fields the other assertions read.
const MATRIX_TARGETS = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
];

describe("the macOS release legs fail closed on missing signing material (#1746)", () => {
  it("still builds every platform, so the gates below can actually run", () => {
    const include = buildJob.strategy?.matrix?.include;
    if (!include) throw new Error("tauri-release.yml: build-tauri has no matrix.include");
    expect(include.map((row) => row["node-target"]).sort()).toEqual([...MATRIX_TARGETS].sort());
    expect(include.filter((row) => row.platform === "macos-latest")).toHaveLength(2);
  });

  it("still fires: the workflow triggers on v* tags and build-tauri needs create-release", () => {
    // A gate that never runs is the cheapest possible disable — narrowing the
    // tag pattern, or putting an `if:` on the parent job that build-tauri
    // `needs`, skips everything below without touching any of it.
    expect(workflow.on.push?.tags).toEqual(["v*"]);
    expect(buildJob.needs).toBe("create-release");
    expect(workflow.jobs["create-release"]?.if).toBeUndefined();
  });

  it("the Apple signing-material gate is pinned by exact equality", () => {
    expect(APPLE_GATE.run).toBe(APPLE_GATE_RUN);
  });

  it("the gate tests every Apple secret, derived from its own conditionals", () => {
    // Matches both `$NAME` and `${NAME}`: a one-character edit to the brace form
    // would otherwise shrink the derived set silently, which is precisely the
    // defeat this derivation exists to prevent.
    const tested = [...(APPLE_GATE.run ?? "").matchAll(/-z\s+"\$\{?(APPLE_[A-Z0-9_]+)\}?"/g)].map(
      (m) => m[1],
    );
    expect([...new Set(tested)].sort()).toEqual(GATED_APPLE_NAMES);
  });

  it("the decode step fails closed on its own, not on step order", () => {
    // It used to `exit 0` on an empty key. Deleting that in favour of "the
    // validate step runs first" would be a claim about ORDER, which nothing here
    // asserts and a reordering edit would break silently.
    expect(DECODE_GATE.run).toContain('echo "::error::APPLE_API_KEY_BASE64 is empty');
    expect(DECODE_GATE.run).toMatch(/^\s*exit 1$/m);
    expect(DECODE_GATE.run).not.toMatch(/^\s*exit 0\b/m);
  });

  it("the macOS verify step refuses an unsigned bundle instead of skipping", () => {
    // The body is 69 lines and gets legitimately edited, so pinning it whole
    // would break on re-indentation, on a CRLF renormalize, and on any real
    // change — and the cheapest repair for that (paste in whatever it says now)
    // is indistinguishable from the attack. Pin the branch that matters, and
    // sweep structurally for the family.
    const run = MACOS_VERIFY.run ?? "";
    expect(run).toContain('if [ -z "$APPLE_CERTIFICATE" ]; then');
    expect(run).toContain(
      'echo "::error::APPLE_CERTIFICATE is empty — this bundle is unsigned and un-notarized, and Gatekeeper will refuse it on every Mac (#1746)."',
    );
    expect(run.match(/^\s*exit 0\b/m)).toBeNull();
    // The artifact-level checks are what actually prove signing; assert they are
    // still the ones being run.
    expect(run).toContain("codesign --verify --deep --strict");
    expect(run).toContain("xcrun stapler validate");
  });

  it("the verify step checks the .dmg users download, not only the staged .app", () => {
    const run = MACOS_VERIFY.run ?? "";
    expect(run).toContain("bundle/dmg/*.dmg");
    expect(run).toContain('codesign --verify --strict --verbose=2 "$dmg"');
  });

  it("the Windows leg still has no secret-presence escape", () => {
    // Positive assertions, not "contains no escape": a negative substring check
    // over PowerShell is defeated by `if (-not $env:X) { return }` or by
    // `$ErrorActionPreference = 'SilentlyContinue'`. This is the parity half of
    // #1746 — the two platforms disagreeing is the whole finding.
    const run = windowsVerifyStep().run ?? "";
    expect(run).toContain("Get-AuthenticodeSignature");
    expect(run).toContain("TimeStamperCertificate");
    expect(run).toMatch(/\$errors\.Count -gt 0/);
    expect(run).toMatch(/exit 1/);
  });

  describe("nothing swallows a failure", () => {
    const gates: Array<[string, Step]> = [
      ["Apple signing material", APPLE_GATE],
      ["Decode App Store Connect API key", DECODE_GATE],
      ["Verify macOS signature + notarization", MACOS_VERIFY],
      ["Verify Windows signatures", windowsVerifyStep()],
    ];

    for (const [label, step] of gates) {
      it(`${label}: no continue-on-error, and an explicit shell`, () => {
        expect(step["continue-on-error"]).toBeUndefined();
        // `shell: bash` expands to `bash --noexit -e {0}`. Writing
        // `shell: bash {0}` drops the `-e`, so a mid-script codesign failure
        // stops aborting — while the pinned `run` text stays byte-identical.
        expect(step.shell === "bash" || step.shell === "pwsh").toBe(true);
      });
    }

    it("not at the job or workflow level either", () => {
      expect(buildJob["continue-on-error"]).toBeUndefined();
      expect(buildJob.defaults?.run?.shell).toBeUndefined();
      expect(workflow.defaults).toBeUndefined();
    });

    it("the macOS verify step still runs after a failed build", () => {
      // ADR-051 rule 4: assert the value, never `?? "always()"` — absent is the
      // regression. `always()` is what makes the step observe a build that
      // failed *because* signing failed.
      expect(MACOS_VERIFY.if).toBe("always() && matrix.platform == 'macos-latest'");
    });
  });

  it("the gates run before the build they gate", () => {
    const tauriAction = buildJob.steps.findIndex((s) =>
      (s.uses ?? "").startsWith("tauri-apps/tauri-action@"),
    );
    if (tauriAction < 0) throw new Error("tauri-release.yml: tauri-action step not found");
    expect(stepIndex(APPLE_GATE)).toBeLessThan(stepIndex(DECODE_GATE));
    expect(stepIndex(DECODE_GATE)).toBeLessThan(tauriAction);
  });
});
