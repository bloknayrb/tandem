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

/**
 * The EXECUTABLE lines of a `run:` body — everything that is not blank, not a
 * comment, and not a message (`echo` / `Write-Host`), indentation kept. A
 * message that REDIRECTS is a state write, not a message, and stays.
 *
 * This exists because of a defeat found in adversarial review, and one defeat
 * beat three separate assertions in this file at once. Every check here that was
 * not exact equality asserted that some TEXT WAS PRESENT, and no text check can
 * see whether the text it matched is still REACHABLE. All three of these leave
 * every scanned literal physically in the file, and all three ship an unsigned
 * or unverified artifact:
 *
 *   if false && [ -z "$APPLE_API_KEY_BASE64" ]; then              (decode, dead)
 *   if ! { codesign --verify --deep --strict ... || true; }; then (always true)
 *   if ($errors.Count -gt 0 -and $false) {                        (Windows, dead)
 *
 * The fix is not three more assertions naming those three shapes. Fixing the
 * named instances is not enumerating the category, and the next neutralizer has
 * a shape nobody listed. It is to pin the executable body by exact equality, so
 * that any edit to a line that RUNS must also edit this file.
 *
 * **This corrects an argument made when the guard was first written.** Exact
 * equality was rejected for the long bodies because they are ~69 lines, get
 * legitimately edited, break on a CRLF renormalize, and carry eight em-dashes —
 * so the cheapest repair (paste in whatever the workflow says now) would be
 * indistinguishable from the attack. Every one of those objections is about the
 * PROSE: the comments, the error text, the em-dashes. Excluding prose removes
 * the objection and keeps the strength. What remains churns only when a CHECK
 * changes, and a diff to it is legible — a reviewer who sees
 * `+ "if false && [ -z ..."` land in a test file knows what they are looking at,
 * which is not true inside a 69-line literal.
 *
 * Residuals, stated rather than papered over. A neutralizer that adds no
 * executable line and edits none would still pass; nothing found so far has that
 * shape, since shadowing a command with a shell function is itself an executable
 * line. And this says nothing about the step's `shell:`, `if:` or `env:` — those
 * are asserted separately below, which is why they are separate assertions.
 */
function executableLines(run: string | undefined): string[] {
  return (run ?? "").split("\n").filter((line) => {
    const t = line.trim();
    if (t === "") return false;
    if (t.startsWith("#")) return false;
    const isMessage = t.startsWith("echo ") || t.startsWith("Write-Host ");
    if (isMessage && !/>>?\s/.test(t)) return false;
    return true;
  });
}

// Generated from the workflow at the time this guard was written, not typed by
// hand. Updating one is a deliberate act: read the diff as a claim about what
// the gate now does.
const DECODE_EXEC: string[] = [
  'if [ -z "$APPLE_API_KEY_BASE64" ]; then',
  "  exit 1",
  "fi",
  "umask 077",
  'mkdir -p "$RUNNER_TEMP/private_keys"',
  'KEY_PATH="$RUNNER_TEMP/private_keys/AuthKey_${APPLE_API_KEY_ID}.p8"',
  'printf \'%s\' "$APPLE_API_KEY_BASE64" | base64 -d > "$KEY_PATH"',
  'chmod 600 "$KEY_PATH"',
  'echo "APPLE_API_KEY_PATH=$KEY_PATH" >> "$GITHUB_ENV"',
];

const MACOS_VERIFY_EXEC: string[] = [
  'if [ -z "$APPLE_CERTIFICATE" ]; then',
  "  exit 1",
  "fi",
  "shopt -s nullglob",
  "apps=(src-tauri/target/*/release/bundle/macos/*.app src-tauri/target/release/bundle/macos/*.app)",
  "if [ ${#apps[@]} -eq 0 ]; then",
  "  exit 1",
  "fi",
  "errors=0",
  'for app in "${apps[@]}"; do',
  '  if ! codesign --verify --deep --strict --verbose=2 "$app"; then',
  "    errors=1",
  "    continue",
  "  fi",
  '  if ! xcrun stapler validate "$app"; then',
  "    errors=1",
  "    continue",
  "  fi",
  '  sidecar="$app/Contents/MacOS/node-sidecar"',
  '  if [ ! -e "$sidecar" ]; then',
  "    errors=1",
  "    continue",
  "  fi",
  '  if ! codesign -d --entitlements - "$sidecar" 2>&1 | strings | grep -q "com.apple.security.cs.allow-jit"; then',
  "    errors=1",
  "    continue",
  "  fi",
  '  reaper="$app/Contents/MacOS/tandem-reaper"',
  '  if [ ! -e "$reaper" ]; then',
  "    errors=1",
  "    continue",
  "  fi",
  "done",
  "dmg_count=0",
  "for dmg in src-tauri/target/*/release/bundle/dmg/*.dmg src-tauri/target/release/bundle/dmg/*.dmg; do",
  '  [ -e "$dmg" ] || continue',
  "  dmg_count=$((dmg_count + 1))",
  '  if ! codesign --verify --strict --verbose=2 "$dmg"; then',
  "    errors=1",
  "  fi",
  '  if xcrun stapler validate "$dmg" >/dev/null 2>&1; then',
  "  else",
  "  fi",
  "done",
  'if [ "$dmg_count" -eq 0 ]; then',
  "fi",
  'if [ "$errors" -ne 0 ]; then exit 1; fi',
];

const WINDOWS_VERIFY_EXEC: string[] = [
  "$bundleFiles = @()",
  "$bundleFiles += Get-ChildItem -Path 'src-tauri/target/release/bundle/nsis' -Filter '*.exe' -ErrorAction SilentlyContinue",
  "$bundleFiles += Get-ChildItem -Path 'src-tauri/target/release/bundle/msi'  -Filter '*.msi' -ErrorAction SilentlyContinue",
  "if ($bundleFiles.Count -eq 0) {",
  "  exit 1",
  "}",
  "$errors = @()",
  "foreach ($f in $bundleFiles) {",
  "  $sig = Get-AuthenticodeSignature -FilePath $f.FullName",
  "  if ($sig.Status -ne 'Valid') {",
  '    $errors += "$($f.FullName): Status=$($sig.Status) StatusMessage=$($sig.StatusMessage)"',
  "  } elseif (-not $sig.TimeStamperCertificate) {",
  '    $errors += "$($f.FullName): signature missing RFC 3161 timestamp"',
  "  } else {",
  "    $tsSubject = if ($sig.TimeStamperCertificate) { $sig.TimeStamperCertificate.Subject } else { '(none)' }",
  "  }",
  "}",
  "if ($errors.Count -gt 0) {",
  '  $errors | ForEach-Object { Write-Host "::error::$_" }',
  "  exit 1",
  "}",
];

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
    expect(executableLines(DECODE_GATE.run)).toEqual(DECODE_EXEC);
    expect(DECODE_GATE.run).toContain('echo "::error::APPLE_API_KEY_BASE64 is empty');
  });

  it("the macOS verify step refuses an unsigned bundle instead of skipping", () => {
    // Every line that runs, pinned exactly. `toContain("codesign --verify
    // --deep --strict")` was the original and is satisfied by
    // `if ! { codesign --verify --deep --strict ... || true; }`, which can never
    // report a failure — see executableLines() above for why the whole category,
    // not the three known spellings, is what this now closes.
    const run = MACOS_VERIFY.run ?? "";
    expect(executableLines(run)).toEqual(MACOS_VERIFY_EXEC);
    // The message is prose and deliberately outside the pin, but it is the only
    // thing that tells a human WHY the release stopped, so assert it survives.
    expect(run).toContain(
      'echo "::error::APPLE_CERTIFICATE is empty — this bundle is unsigned and un-notarized, and Gatekeeper will refuse it on every Mac (#1746)."',
    );
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
    // `/\$errors\.Count -gt 0/` is unanchored, so it still matches inside
    // `if ($errors.Count -gt 0 -and $false) {` — which can never be true, leaving
    // the `exit 1` below it dead while both regexes stay green. Pin what runs.
    const run = windowsVerifyStep().run ?? "";
    expect(executableLines(run)).toEqual(WINDOWS_VERIFY_EXEC);
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
