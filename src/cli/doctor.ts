/**
 * Tandem Doctor — diagnose common setup issues.
 *
 * This module is the importable core behind both `tandem doctor` (the bundled
 * CLI subcommand) and `npm run doctor` (the standalone `scripts/doctor.mjs`
 * shim). It is split into a PURE collector (`runDoctor`) and a thin printer +
 * exit-code wrapper (`runDoctorCli`):
 *
 * - `runDoctor()` reads NOTHING from `process.argv` and calls `process.exit`
 *   NEVER. It returns a structured {@link DoctorReport} so callers and tests
 *   can inspect results without side effects.
 * - `runDoctorCli({ json })` formats the report (human-readable TTY lines or a
 *   single JSON document on stdout) and applies the shared exit code.
 *
 * BUNDLING RATIONALE (do not "simplify" this into a spawn): the diagnostics
 * logic MUST live in this TS module so tsup bundles it into `dist/cli`. The
 * `scripts/` directory is NOT shipped in the npm package (see package.json
 * `files`), so a dispatcher that spawned `scripts/doctor.mjs` would have
 * nothing to run inside a global install. Keeping the logic here is the only
 * correct path for `tandem doctor` to work after `npm install -g`.
 *
 * Pure Node.js built-ins only (no external dependencies) so the module bundles
 * cleanly and the standalone shim can mirror it.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { request } from "node:http";
import { createConnection } from "node:net";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { parseLockfile } from "../server/annotations/lockfile.js";
import {
  isRecordedPathAbsolute,
  isRecordedPathGone,
  probeNodeBinary,
} from "../server/integrations/node-binary.js";
import { DEFAULT_MCP_PORT, DEFAULT_WS_PORT } from "../shared/constants.js";
import { isAppTranslocatedPath } from "../shared/integrations/app-translocation.js";
import {
  claudeCodeConfigPath,
  claudeDesktopConfigPath,
} from "../shared/integrations/client-config-paths.js";
import type { ClaudeCliPresence } from "../shared/integrations/contract.js";
import { detectClaudeCli, isBareNameLaunchable } from "../shared/integrations/detect-claude-cli.js";
import { isOnPath, resolveManyOnPath } from "../shared/integrations/path-lookup.js";
import { rejectUnsafeWindowsPrefix } from "../shared/windows-path-safety.js";
import { nodeVersionError } from "./node-version.js";

// Injected by tsup into dist/cli. Absent in tsx dev / vitest (typeof-guarded at
// use). This is the version the `npx` bridge entries are pinned to.
declare const __TANDEM_VERSION__: string;

export type DoctorStatus = "pass" | "warn" | "fail";

/**
 * Outcome of a pure decision step, before it reaches the wire.
 *
 * `"skip"` is deliberately NOT a {@link DoctorStatus} member: the status enum
 * is an MCP wire contract (`z.enum(["pass","warn","fail"])` in
 * `output-schemas.ts`) and the client's `STATUS_TAG` is a
 * `Record<DoctorStatus, string>`, so adding a member is a breaking change.
 *
 * Instead a skip is recorded as a `pass` whose MESSAGE says it skipped and
 * why, plus `data.skipped = true` for machine consumers. That is the point of
 * the whole exercise: a check that could not compare anything must SAY so
 * rather than report a green it never earned — but a skip is not a warning
 * either (a fresh clone before `npm install` would warn-storm every run).
 */
type EvalOutcome = {
  status: "pass" | "warn" | "skip";
  message: string;
  fix?: string;
  data?: Record<string, unknown>;
};

/**
 * Error identity WITHOUT the message. Follows the redaction precedent in
 * {@link checkMcpJson}: doctor output gets pasted into public issues and an
 * arbitrary error message can embed absolute paths or a V8 source snippet
 * (which, for `.mcp.json`, carries auth-token headers).
 */
function errorClass(err: unknown): string {
  if (err instanceof Error) return err.name;
  return typeof err;
}

export interface DoctorResult {
  check: string;
  status: DoctorStatus;
  message: string;
  fix?: string;
  data?: Record<string, unknown>;
}

export interface DoctorReport {
  ok: boolean;
  crashed: boolean;
  failures: number;
  warnings: number;
  summary: string;
  error: string | null;
  results: DoctorResult[];
}

/**
 * Internal recorder shared by every check. Mirrors the recorder in the legacy
 * `scripts/doctor.mjs`: each check groups one or more results under a `name`.
 * No TTY output happens here — that's the wrapper's job, so the pure collector
 * stays side-effect-free.
 */
class Recorder {
  failures = 0;
  warnings = 0;
  readonly results: DoctorResult[] = [];
  private currentCheck = "";

  /**
   * Run one check under `name`. A throwing check is contained here and
   * recorded as a `fail` rather than taking the whole report down.
   *
   * Returns `T | undefined` — NOT `T`. The `undefined` is load-bearing and
   * must not be cast away: a crashed check produced no value, and the two
   * callers that consume one (`ports` destructures `{ws, mcp}`; `health`
   * gates the `sse` check) have to say what they want instead. Returning
   * `undefined as T` would satisfy the compiler and then throw a TypeError
   * on the destructure — converting a clear crash into a confusing one on
   * the exact path this containment exists to protect.
   */
  async check<T>(name: string, fn: () => T | Promise<T>): Promise<T | undefined> {
    const prev = this.currentCheck;
    this.currentCheck = name;
    try {
      return await fn();
    } catch (err) {
      // `record` reads this.currentCheck, which the `finally` has not yet
      // restored — so this fail is attributed to the crashed check.
      this.fail(
        `${name} check crashed (${errorClass(err)}) — the rest of the report is still valid`,
        "Please report this at https://github.com/bloknayrb/tandem/issues",
      );
      return undefined;
    } finally {
      this.currentCheck = prev;
    }
  }

  private record(
    status: DoctorStatus,
    msg: string,
    fix?: string,
    fields?: Record<string, unknown>,
  ): void {
    const entry: DoctorResult = { check: this.currentCheck, status, message: msg };
    if (fix) entry.fix = fix;
    if (fields) entry.data = fields;
    this.results.push(entry);
  }

  pass(msg: string, fix?: string, fields?: Record<string, unknown>): void {
    this.record("pass", msg, fix, fields);
  }

  warn(msg: string, fix?: string, fields?: Record<string, unknown>): void {
    this.warnings++;
    this.record("warn", msg, fix, fields);
  }

  fail(msg: string, fix?: string, fields?: Record<string, unknown>): void {
    this.failures++;
    this.record("fail", msg, fix, fields);
  }
}

// ── Check: Node.js version ──────────────────────────────────────────

/**
 * The floor `tandem doctor` checks against — `package.json`'s declared
 * `engines.node` value, verbatim (a test pins the two together so they can't
 * drift apart again; see `tests/cli/doctor.test.ts`).
 *
 * This is a BUILD-toolchain floor, not a runtime one: every `>=22.12.0`
 * requirement in `package-lock.json` traces to a devDependency (vite,
 * rolldown and its platform bindings, `@sveltejs/vite-plugin-svelte`); the
 * highest floor among real runtime `dependencies` is `>=20.19.0`, and
 * `tsup.config.ts`'s `target: "node22"` only needs `>=22.0.0`. Whether
 * `engines.node` itself should come down to `>=22` — with `22.12.0` kept as
 * a documented contributor/build-only floor elsewhere — is an open product
 * question, tracked as #1533. Until that's resolved, `doctor` reports against
 * whatever `engines` currently declares, so it never again silently
 * disagrees with it. `src/cli/node-version.ts`'s CLI startup guard is
 * deliberately NOT unified with this constant — it gates every `tandem`
 * invocation (including the plugin's `tandem-channel`/`monitor` entries) on
 * the real ~22.0.0 runtime floor, and tightening it to 22.12.0 would refuse
 * to start on Node versions that run Tandem correctly today. The two are not
 * unrelated, though: {@link evaluateNodeVersion} consults that guard's own
 * predicate — not a second copy of its floor — when deciding whether a
 * below-floor version is a warn or a fail, so the two files can never drift
 * into disagreeing about which versions actually RUN.
 */
export const MIN_NODE_VERSION = "22.12.0";

interface ParsedNodeVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Prefix-anchored only (no trailing `$`): a nightly/RC `process.version`
 * looks like `v25.0.0-nightly20250101abcdef` or `v23.0.0-rc.1`, and the
 * numeric triplet at the front is all a floor comparison needs — the suffix
 * is noise, not a parse failure. Minor/patch are optional and default to 0,
 * so a bare `v22` still resolves (not a real `process.version` shape, but
 * defensive: the predecessor's major-only `Number.parseInt` accepted it, and
 * this must not narrow what parses without saying so).
 */
function parseNodeVersion(version: string): ParsedNodeVersion | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? 0 : Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
  };
}

const MIN_NODE_PARSED = parseNodeVersion(MIN_NODE_VERSION) as ParsedNodeVersion;

function isBelowFloor(v: ParsedNodeVersion): boolean {
  if (v.major !== MIN_NODE_PARSED.major) return v.major < MIN_NODE_PARSED.major;
  if (v.minor !== MIN_NODE_PARSED.minor) return v.minor < MIN_NODE_PARSED.minor;
  return v.patch < MIN_NODE_PARSED.patch;
}

/**
 * `null` means unparseable — the drift-guard test in `tests/cli/doctor.test.ts`
 * asserts `isNodeVersionSupported(MIN_NODE_VERSION)` is `true`, which catches
 * `MIN_NODE_VERSION` itself becoming unparseable (or an off-by-one at the
 * exact boundary) in the same breath as the `package.json` equality check.
 */
export function isNodeVersionSupported(version: string): boolean | null {
  const parsed = parseNodeVersion(version);
  return parsed ? !isBelowFloor(parsed) : null;
}

/**
 * Whether a Node version that PARSES but sits below {@link MIN_NODE_VERSION}
 * is reported as a `fail` (`tandem doctor` exits 1) or a `warn` (exits 0).
 * Deliberately `"warn"` — a product decision, reversible by editing this one
 * line.
 *
 * The floor is `engines.node`, which the {@link MIN_NODE_VERSION} docblock
 * above records is a BUILD-toolchain floor: every `>=22.12.0` entry in
 * `package-lock.json` is `dev: true`, and the highest floor among real
 * runtime `dependencies` is `>=20.19.0`. So a user on Node 22.0-22.11 has an
 * install that WORKS — `src/cli/node-version.ts`'s startup guard runs them,
 * and this same file argues that tightening that guard "would refuse to
 * start on Node versions that run Tandem correctly today". Reporting `fail`
 * here would exit 1 on a working install and contradict the paragraph above.
 *
 * The tradeoff, taken knowingly: `warn` means a real `engines` violation no
 * longer trips a script that reads only `tandem doctor`'s exit code. That is
 * the smaller harm, because the defect #1442 reports is doctor SILENTLY
 * agreeing with a floor it never checked — and a `warn` naming the real
 * floor is not silent. Flip this to `"fail"` if #1533 resolves by confirming
 * `>=22.12.0` as a genuine RUNTIME requirement.
 *
 * Two cases are NOT governed by this knob, and both stay `fail`, because the
 * whole justification above is "this install works" and neither of them is
 * one. A version the CLI startup guard would REFUSE TO START on (`major <
 * 22`, per {@link nodeVersionError}) is a broken install, not a lenient
 * `engines` reading — warning there would tell a Node 20 user everything is
 * fine while `tandem` itself declines to run. An UNPARSEABLE version is not
 * known to be anything. Between them they preserve the invariant that
 * nothing here became more lenient than the major-only code it replaced:
 * the only behavior change against master is pass → warn, inside 22.0-22.11.
 */
const BELOW_FLOOR_STATUS: "warn" | "fail" = "warn";

/**
 * Pure so the wording is directly testable, following
 * `evaluateNodeToolchain`. `EvalOutcome` (used by most other checks via
 * `recordEvaluation`) has no `"fail"` member, so this check keeps its own
 * local result type and wires into `r.pass`/`r.warn`/`r.fail` directly, the
 * same way `checkNodeToolchain` wires `evaluateNodeToolchain`.
 */
export function evaluateNodeVersion(version: string): {
  status: "pass" | "warn" | "fail";
  message: string;
  fix?: string;
} {
  const supported = isNodeVersionSupported(version);
  if (supported) {
    return { status: "pass", message: `Node.js ${version} (>= ${MIN_NODE_VERSION} required)` };
  }
  // `null` (unparseable) fails closed, same as the pre-existing
  // `Number.parseInt` → `NaN` behavior (`NaN >= 22` was already `false`) —
  // preserved deliberately, not a new policy.
  if (supported === null) {
    return {
      status: "fail",
      message: `Node.js ${version} — unrecognized version string, expected ${MIN_NODE_VERSION}+`,
      fix: `Install Node.js ${MIN_NODE_VERSION}+ from https://nodejs.org`,
    };
  }
  // Below the declared floor. Whether that is a `fail` or a `warn` is decided
  // by the CLI startup guard's OWN predicate rather than a second copy of its
  // floor: if `tandem` would refuse to start on this Node, doctor must not
  // soften it. Asking `nodeVersionError` directly means the two can never
  // drift into disagreeing about which versions run — the exact defect #1442
  // reports, one file over.
  if (nodeVersionError(version) !== null) {
    return {
      status: "fail",
      message: `Node.js ${version} — Tandem's CLI will not start on this version`,
      fix: `Install Node.js ${MIN_NODE_VERSION}+ from https://nodejs.org`,
    };
  }
  // Runs, but below the declared floor. Say what the floor IS and where it
  // comes from rather than that this version is "required" — the docblocks
  // above record that it is not required at runtime.
  return {
    status: BELOW_FLOOR_STATUS,
    message: `Node.js ${version} — below package.json's declared engines.node floor of ${MIN_NODE_VERSION}`,
    fix: `Upgrade to Node.js ${MIN_NODE_VERSION}+ from https://nodejs.org`,
  };
}

function checkNodeVersion(r: Recorder): void {
  const result = evaluateNodeVersion(process.version);
  if (result.status === "pass") r.pass(result.message);
  else if (result.status === "warn") r.warn(result.message, result.fix);
  else r.fail(result.message, result.fix);
}

// ── Check: node_modules exists ──────────────────────────────────────

/**
 * `node_modules/` in the CWD is a finding only inside the dev checkout.
 *
 * This used to run ungated, so `tandem doctor` on a global install FAILed from
 * every ordinary directory and prescribed `npm install` there — which is worse
 * than the `.mcp.json` remedy that motivated #1404. That one merely could not
 * work; this one SUCCEEDS at the wrong thing, writing a `node_modules/` and a
 * `package-lock.json` into whatever folder the user happened to be standing in.
 *
 * Skip-shaped pass rather than a silent gate, following {@link checkMcpJson}
 * and {@link evaluateAbsentChannelEntry} — including their rule that guidance
 * goes in the MESSAGE, never `fix`.
 *
 * The probe is tri-state and both non-`"yes"` arms skip, but they must not say
 * the same thing. `"unreadable"` means a `package.json` we could not parse:
 * asserting "this is not the checkout" there would contradict the `dev-repo`
 * warning printed a few lines later, and the pass would be the false half.
 * Deliberately NOT a finding either — an end user whose own project has a
 * corrupt `package.json` would be back to the FAIL this fix removes, and for
 * the case where it *is* the checkout, the `dev-repo` warn already carries the
 * actionable remedy.
 */
function checkNodeModules(r: Recorder, repo: RepoProbe, cwd: string): void {
  if (repo !== "yes") {
    // `reason` so a --json consumer can tell the two arms apart without
    // string-matching prose, as `evaluateNpmStaleness` (four arms) and
    // `evaluateOrphanedVite` (two) already do for their own skips.
    const unreadable = repo === "unreadable";
    recordEvaluation(r, {
      status: "skip",
      message: unreadable
        ? "cannot tell whether this directory is the tandem-editor checkout (package.json " +
          "unreadable), and node_modules/ is only a finding inside it"
        : "the current directory is not the tandem-editor checkout, so its node_modules/ is " +
          "not Tandem's to check — a global install keeps its dependencies in the npm prefix",
      data: { reason: unreadable ? "package-json-unreadable" : "not-checkout" },
    });
    return;
  }
  if (existsSync(join(cwd, "node_modules"))) {
    r.pass("node_modules/ exists");
  } else {
    r.fail("node_modules/ not found", "npm install");
  }
}

// ── Dev-repo gate ───────────────────────────────────────────────────
//
// The npm-staleness and orphaned-Vite checks below diagnose the DEV checkout
// only. `tandem doctor` ships globally and runs in arbitrary end-user cwds,
// where `package.json` belongs to someone else's project — so both checks
// gate on the cwd actually being the tandem-editor repo and skip SILENTLY
// otherwise (not warn: the absence of a dev checkout is not a finding).
//
// Silence is NOT the rule for a new checkout-scoped check, only the rule for
// these two. `checkNodeModules` gates on the same probe and emits a VISIBLE
// skip, because it shipped with the original `tandem doctor` subcommand and a
// `--json` consumer has always seen its key — a key that vanishes is a
// breaking change, while these two were born gated and never had one. Pick by
// that history, not by symmetry with whichever neighbour you read first.

/**
 * Record an {@link EvalOutcome} on the recorder, mapping `"skip"` onto the
 * `pass` wire status with a message that says it skipped. Single boundary so
 * every check spells a skip the same way.
 */
function recordEvaluation(r: Recorder, result: EvalOutcome | null): void {
  if (!result) return;
  if (result.status === "warn") {
    r.warn(result.message, result.fix, result.data);
    return;
  }
  if (result.status === "skip") {
    r.pass(`skipped — ${result.message}`, result.fix, { ...result.data, skipped: true });
    return;
  }
  r.pass(result.message, result.fix, result.data);
}

/**
 * Whether `dir` is the tandem-editor dev checkout.
 *
 * Tri-state on purpose. A single boolean made "this is not the repo" and "the
 * repo's package.json is corrupt" the same silent answer — and the corrupt
 * case is the one worth reporting, since it also disables the checkout-scoped
 * checks below. How many of those there are is deliberately not stated here:
 * that count has already drifted between copies, and it is not `RepoProbe`'s
 * business.
 */
export type RepoProbe = "yes" | "no" | "unreadable";

/**
 * Check names whose answer depends on `process.cwd()`.
 *
 * Lives in this module rather than in the diagnostics route so that the list
 * and the checks it names are added in one place. There is exactly ONE
 * `process.cwd()` read left in this file — {@link runDoctor}'s, threaded into
 * every check that needs it — so "which checks are cwd-scoped" is answerable
 * by following that value rather than by grepping.
 *
 * `filterDevRepoChecks` (`server/mcp/routes/diagnostics.ts`) builds its Set
 * from this and strips these from `/api/diagnostics`; `tandem_diagnostics`
 * reaches the same filter through that function. Field reports run with an
 * arbitrary server cwd, where these answers describe someone else's directory.
 *
 * NOT the same set as "checks gated on {@link probeTandemEditorRepo}":
 * `mcp-json` deliberately keeps inspecting a hand-written `.mcp.json` in a
 * user's own project (see {@link checkMcpJson}), so it is cwd-dependent
 * without being dev-gated. Deriving one set from the other would be a bug.
 */
export const CWD_DEPENDENT_CHECKS = [
  "node-modules",
  "dev-repo",
  "npm-staleness",
  "mcp-json",
  "orphaned-vite",
] as const;

/** Classify `dir/package.json`: the tandem-editor repo, not it, or broken. */
export function probeTandemEditorRepo(dir: string): RepoProbe {
  const read = readJson(join(dir, "package.json"));
  // Absent package.json is the overwhelmingly common end-user case (an
  // arbitrary cwd) — emphatically not a finding.
  if (read.kind === "absent") return "no";
  if (read.kind === "unreadable") return "unreadable";
  const parsed = read.value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "unreadable";
  }
  return (parsed as { name?: unknown }).name === "tandem-editor" ? "yes" : "no";
}

/** True when `dir/package.json` parses and names the `tandem-editor` package. */
export function isTandemEditorRepo(dir: string): boolean {
  return probeTandemEditorRepo(dir) === "yes";
}

// ── Check: npm install staleness (dev repo only) ────────────────────
//
// Compares `package.json`/`package-lock.json` against the hidden lockfile npm
// writes at install time (`node_modules/.package-lock.json`). Deliberately
// NOT `npm ls` (this module is pure built-ins by design, and `npm ls` exits
// non-zero on unrelated issues under `overrides`) and NOT mtimes (git churns
// them on checkout, which would turn every branch switch into a false warn).

interface LockfileEntry {
  version?: string;
  optional?: boolean;
}

interface LockfileJson {
  version?: string;
  packages?: Record<string, LockfileEntry>;
}

/**
 * Outcome of reading a JSON file. The three cases are deliberately distinct:
 * collapsing them into `null` made "the file isn't there" (routine — a fresh
 * clone before `npm install`) indistinguishable from "the file is there and
 * broken", and the broken cases are the two highest-value findings this check
 * has: a merge-conflicted `package-lock.json`, and a truncated
 * `.package-lock.json` from an interrupted install.
 */
type JsonRead =
  | { kind: "ok"; value: unknown }
  | { kind: "absent" }
  | { kind: "unreadable"; reason: string };

/** Read + parse a JSON file, distinguishing absent from broken. */
function readJson(path: string): JsonRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    // EACCES, EISDIR, ELOOP… — the error CODE only, never the message: it
    // embeds an absolute path.
    return { kind: "unreadable", reason: code ?? errorClass(err) };
  }
  try {
    return { kind: "ok", value: JSON.parse(raw) };
  } catch {
    // Deliberately no parse detail — same reasoning as checkMcpJson's
    // redaction: V8 SyntaxErrors embed a snippet of the source text and
    // doctor output gets pasted into public issues.
    return { kind: "unreadable", reason: "not valid JSON" };
  }
}

/**
 * Outcome of reading a Claude client config. Distinct from {@link JsonRead} by
 * one case: `unsafe-path`, the screen that must happen before the syscall.
 *
 * **It carries no path and no error detail, and that is load-bearing.** These
 * files hold bearer tokens and `env.TANDEM_AUTH_TOKEN`; a V8 `SyntaxError`
 * embeds a snippet of the source. The whole report reaches the Copy
 * Diagnostics clipboard and `tandem_diagnostics`, and the MCP tool applies no
 * redaction at all (`src/server/mcp/diagnostics.ts`). A field here is a field
 * a caller can interpolate into a message, so the type does not offer one —
 * every existing rejection message names the *class* of path, never the path,
 * and this keeps that a property of the type rather than of convention.
 */
type ClaudeConfigRead =
  | { kind: "unsafe-path" }
  | { kind: "absent" }
  | { kind: "unreadable" }
  | { kind: "ok"; value: unknown };

/**
 * The one way doctor reads a Claude client config (#1417).
 *
 * Screens the path before touching the filesystem: on Windows a UNC or
 * device-namespace path performs the SMB handshake that leaks an NTLM hash,
 * and enterprise folder redirection routinely puts a profile on a share.
 * Doctor is the one command whose whole job is to read these files, so it is
 * also the one most likely to be pointed at a redirected profile.
 *
 * Existing behavior preserved exactly: no `existsSync` pre-flight (the read
 * has to be in a `try` regardless, so a separate stat is a second syscall
 * answering a question this one already answers, plus a TOCTOU window), and
 * ENOENT is the only failure distinguished from the rest.
 *
 * **Its screen is a backstop, and it is exported so that backstop is covered
 * rather than merely asserted.** Every caller today also screens its raw
 * input, and no safe input can `path.join` into an unsafe path -- so nothing
 * reachable through `runDoctor` can make this branch fire, and deleting it
 * left the whole suite green on both platforms. That is the definition of an
 * untested claim. The branch earns its place anyway: it is what makes the NEXT
 * check that reads a Claude config safe by construction even if its author
 * forgets the input screen, which is exactly how `checkTandemPlugin` became
 * #1417's eighth site. So it is tested directly instead of deleted.
 */
export function readClaudeConfig(path: string): ClaudeConfigRead {
  if (rejectUnsafeWindowsPrefix(path) !== null) return { kind: "unsafe-path" };
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable" };
  }
  try {
    return { kind: "ok", value: JSON.parse(raw) };
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * Screen the raw `HOME`/`USERPROFILE` value before deriving a path from it.
 *
 * This is not redundant with {@link readClaudeConfig}'s own screen, and the
 * difference is not about Windows. `path.join` is platform-dependent, and the
 * split was measured rather than reasoned about: of the fourteen spellings in
 * `tests/helpers/unc-fixtures.ts`, **four collapse to a path this guard then
 * accepts once `path.posix.join` has run** — the four pure forward-slash
 * forms. On a Linux runner a guard applied only to the *derived* path
 * therefore never fires for those four, and the corresponding test passes
 * because the path stopped being dangerous rather than because anything
 * screened it. That is the #1529 shape: a check only one platform can fail
 * reads exactly like a pass everywhere else, and CI's `check` job is
 * ubuntu-only.
 *
 * The two *mixed*-separator forms are NOT among them, and the distinction is
 * the whole reason to measure with the real predicate rather than a stand-in:
 * `posix.join` leaves their backslashes intact, and this guard normalises `/`
 * to `\` across its first eight characters, so it still rejects them. A first
 * pass at this measurement used a hand-written `/^(\\\\|\/\/)/` and reported
 * six.
 *
 * Screening the untrusted input keeps all fourteen load-bearing on any runner.
 * It is also simply the earlier point.
 */
function homeIsUnsafe(home: string): boolean {
  return home !== "" && rejectUnsafeWindowsPrefix(home) !== null;
}

/**
 * The single input `claudeDesktopConfigPath` will actually derive its path
 * from, so {@link homeIsUnsafe} screens that one rather than every candidate.
 *
 * **This is a correspondence with another module, which is the whole reason it
 * is a named exported function.** Screening every candidate instead is not the
 * safe simplification it looks like: under enterprise redirection
 * `%USERPROFILE%` sits on a share while `%APPDATA%` stays local, so refusing
 * on either would print "on a network path Tandem will not read" about an
 * ordinary local file and drop the only check reporting whether tandem is
 * registered with Claude Desktop.
 *
 * The branch is on `homeOverride`'s **truthiness**, matching
 * `claudeDesktopConfigPath`'s own `opts.homeOverride ? … : …`. An
 * `=== undefined` test drifts on the empty string: the resolver would take the
 * `%APPDATA%` route while this screened `""`, a no-op.
 *
 * `platform` and `appData` are parameters rather than reads of `os.platform()`
 * and `process.env` so both branches are reachable from any runner. A
 * win32-gated spec is skipped forever on this repo's ubuntu-only vitest job
 * and reads exactly like a pass (#1529).
 */
export function desktopScreenInput(opts: {
  homeOverride?: string;
  platform: NodeJS.Platform;
  appData?: string;
  homeDir?: string;
}): string {
  const home = opts.homeOverride || (opts.homeDir ?? homedir());
  if (opts.platform !== "win32" || opts.homeOverride) return home;
  return opts.appData ?? home;
}

/** The warning both home-derived config checks emit when the profile is on a share. */
const NETWORK_HOME_FIX =
  "Tandem refuses network paths because reading one leaks a Windows credential hash. " +
  "Redirect your profile to a local drive, or configure Claude Code by hand.";

/** Narrow one `packages` entry, rejecting the `null` npm never writes but that a truncated/hand-edited file can carry. */
function parseLockfileEntry(value: unknown): LockfileEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (entry.version !== undefined && typeof entry.version !== "string") return null;
  if (entry.optional !== undefined && typeof entry.optional !== "boolean") return null;
  return {
    version: entry.version as string | undefined,
    optional: entry.optional as boolean | undefined,
  };
}

/**
 * Narrow an arbitrary parsed value to a {@link LockfileJson}, or null when the
 * shape is wrong. Replaces the `as LockfileJson` casts this check used to
 * carry: a cast is a promise the input never made, and
 * `packages: { "node_modules/x": null }` cashed it as
 * `TypeError: Cannot read properties of null (reading 'optional')` — which
 * took down the ENTIRE report, not just this check.
 *
 * One malformed entry rejects the whole file: a lockfile that is structurally
 * not a lockfile cannot be partially trusted to say what SHOULD be installed.
 */
function parseLockfileJson(value: unknown): LockfileJson | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (obj.version !== undefined && typeof obj.version !== "string") return null;
  const version = obj.version as string | undefined;

  // A lockfileVersion 1 lockfile has no `packages` key at all — a valid file
  // this check simply cannot compare (handled as a skip downstream).
  if (obj.packages === undefined) return { version };
  if (typeof obj.packages !== "object" || obj.packages === null || Array.isArray(obj.packages)) {
    return null;
  }

  const packages: Record<string, LockfileEntry> = {};
  for (const [path, raw] of Object.entries(obj.packages)) {
    const entry = parseLockfileEntry(raw);
    if (!entry) return null;
    packages[path] = entry;
  }
  return { version, packages };
}

/**
 * Pure decision step for the npm-staleness check (same split as
 * {@link evaluateStaleGlobal} — directly unit-testable without touching the
 * filesystem). Any null input means "can't compare here" and skips: a missing
 * node_modules is already the node-modules check's finding, and a tree
 * installed by something other than npm has no hidden lockfile to read.
 */
export function evaluateNpmStaleness(
  pkgInput: unknown,
  lockInput: unknown,
  hiddenLockInput: unknown,
): EvalOutcome | null {
  if (!pkgInput || !lockInput || !hiddenLockInput) return null;

  // Validate shape HERE rather than trusting a cast at the read site: this is
  // the boundary between "bytes someone else wrote" and this function's
  // assumptions, and it is a public export that tests and probes call
  // directly with hand-built input.
  const lock = parseLockfileJson(lockInput);
  if (!lock) {
    return {
      status: "skip",
      message: "cannot compare (package-lock.json has an unexpected structure)",
      fix: "Restore it from git: git checkout package-lock.json",
      data: { reason: "malformed-lock" },
    };
  }
  const hiddenLock = parseLockfileJson(hiddenLockInput);
  if (!hiddenLock) {
    return {
      status: "skip",
      message: "cannot compare (node_modules/.package-lock.json has an unexpected structure)",
      fix: "npm install",
      data: { reason: "malformed-hidden-lock" },
    };
  }
  const pkg =
    typeof pkgInput === "object" && !Array.isArray(pkgInput)
      ? (pkgInput as { version?: unknown })
      : {};
  const pkgVersion = typeof pkg.version === "string" ? pkg.version : undefined;

  // package.json bumped without regenerating the lockfile (release-cut slip).
  if (pkgVersion && lock.version && pkgVersion !== lock.version) {
    return {
      status: "warn",
      message:
        `package-lock.json (v${lock.version}) is out of date with ` +
        `package.json (v${pkgVersion})`,
      fix: "npm install",
      data: { packageVersion: pkgVersion, lockVersion: lock.version },
    };
  }

  // node_modules installed from a lockfile at a different root version.
  if (lock.version && hiddenLock.version && lock.version !== hiddenLock.version) {
    return {
      status: "warn",
      message:
        "node_modules was installed from a different lockfile " +
        `(v${hiddenLock.version} installed, v${lock.version} expected)`,
      fix: "npm install",
      data: { lockVersion: lock.version, installedVersion: hiddenLock.version },
    };
  }

  // Content identity: the hidden lockfile records the tree npm actually
  // installed. It is a SUBSET of package-lock's `packages` — it omits the
  // root "" entry and optional deps whose os/cpu don't match this machine
  // (platform binaries like @biomejs/cli-darwin-*) — so only a missing
  // NON-optional entry, a version mismatch, or an extraneous installed
  // package counts as drift. Never mtimes: content only.
  const wanted = lock.packages ?? {};
  const installed = hiddenLock.packages ?? {};

  // Only PASS after a comparison that actually compared something.
  //
  // package-lock.json is the source of truth for what SHOULD be installed, so
  // an empty `wanted` leaves nothing to compare against and BOTH loops below
  // degenerate: the drift loop inspects zero entries, and the extraneous loop
  // would report every installed package as unexpected.
  //
  // Count NON-ROOT entries, not merely a non-empty object: the drift loop
  // `continue`s on the root "" entry, so `{"": {...}}` is non-empty and still
  // compares nothing. npm never emits `packages: {}` in v2/v3 and v1 has no
  // `packages` key at all, so in practice this fires on a v1 lockfile or a
  // hand-built/garbage one — both of which used to report a confident green.
  const wantedCount = Object.keys(wanted).filter((path) => path !== "").length;
  if (wantedCount === 0) {
    return {
      status: "skip",
      message:
        "cannot compare (package-lock.json lists no packages — a lockfileVersion 1 " +
        "file, or one written by something other than npm)",
      fix: "npm install",
      // No inferred `lockfileVersion` here: we did not read that field, and
      // guessing it from the presence of `packages` would put a fabricated
      // value under a real npm field name.
      data: { reason: "no-comparable-packages" },
    };
  }

  const drifted: string[] = [];
  for (const [path, entry] of Object.entries(wanted)) {
    if (path === "") continue;
    const got = installed[path];
    if (!got) {
      if (!entry.optional) drifted.push(path);
    } else if (entry.version !== got.version) {
      drifted.push(path);
    }
  }
  for (const path of Object.keys(installed)) {
    if (path !== "" && !(path in wanted)) drifted.push(path);
  }

  if (drifted.length > 0) {
    return {
      status: "warn",
      message:
        `node_modules is stale — ${drifted.length} package(s) differ from ` +
        "package-lock.json (e.g. after a pull or branch switch)",
      fix: "npm install",
      data: { driftCount: drifted.length, sample: drifted.slice(0, 5) },
    };
  }

  // The packages dimension compared clean. Before calling that a PASS, apply
  // the same "compared something" rule to the VERSION dimension — the two
  // version guards above are each `&&`-gated on their operands existing, so a
  // missing version silently disables them and falls through to this green.
  // A package.json with no `version` field is exactly the state in which the
  // release-cut-slip guard matters most, and it was the state in which the
  // guard was off.
  const missingVersions: string[] = [];
  if (!pkgVersion) missingVersions.push("package.json");
  if (!lock.version) missingVersions.push("package-lock.json");
  if (!hiddenLock.version) missingVersions.push("node_modules/.package-lock.json");
  if (missingVersions.length > 0) {
    return {
      status: "skip",
      message:
        `node_modules matches package-lock.json, but the version check could not run — ` +
        `no "version" field in ${missingVersions.join(", ")}`,
      data: { reason: "no-comparable-version", missingVersions },
    };
  }

  return {
    status: "pass",
    message: "node_modules matches package-lock.json",
    data: { packageCount: Object.keys(installed).length },
  };
}

/**
 * Read one lockfile and report the read itself.
 *
 * Absent → skip: a fresh clone before `npm install` has no hidden lockfile,
 * and the missing node_modules is already the node-modules check's finding.
 * Anything else → warn NAMING THE PATH: that is a merge-conflicted or
 * truncated lockfile, which is the whole reason to look.
 *
 * Returns a discriminated result rather than `unknown | null`: a null sentinel
 * cannot be told apart from a file whose entire content is the valid JSON
 * literal `null`, and the caller would then bail having recorded nothing —
 * a silent skip, the exact thing this check is being fixed to stop doing.
 */
type LockfileRead = { ok: true; value: object } | { ok: false };

function readLockfileOrReport(r: Recorder, path: string, label: string): LockfileRead {
  const read = readJson(path);
  if (read.kind === "absent") {
    r.pass(`skipped — cannot compare (${label} not found)`, undefined, {
      skipped: true,
      reason: "absent",
      path: label,
    });
    return { ok: false };
  }
  if (read.kind === "ok") {
    // Parseable but not an object (`null`, `0`, `"…"`, `[…]`) is a broken
    // lockfile, not a comparable one — same class as unparseable.
    if (typeof read.value === "object" && read.value !== null && !Array.isArray(read.value)) {
      return { ok: true, value: read.value };
    }
    r.warn(
      `${label} is not a JSON object — npm install staleness cannot be checked`,
      "Check for a truncated or hand-edited file, then: npm install",
      { reason: "not-an-object", path: label },
    );
    return { ok: false };
  }
  r.warn(
    `${label} could not be read (${read.reason}) — npm install staleness cannot be checked`,
    "Check for merge-conflict markers or a truncated file, then: npm install",
    { reason: read.reason, path: label },
  );
  return { ok: false };
}

function checkNpmStaleness(r: Recorder, repoDir: string): void {
  // package.json needs no read-error branch: checkNpmStaleness only runs once
  // probeTandemEditorRepo has already parsed this exact file and returned
  // "yes", so an unreadable one cannot reach here.
  const pkgRead = readJson(join(repoDir, "package.json"));
  const pkg = pkgRead.kind === "ok" ? pkgRead.value : null;

  const lock = readLockfileOrReport(r, join(repoDir, "package-lock.json"), "package-lock.json");
  if (!lock.ok) return;
  const hiddenLock = readLockfileOrReport(
    r,
    join(repoDir, "node_modules", ".package-lock.json"),
    "node_modules/.package-lock.json",
  );
  if (!hiddenLock.ok) return;

  recordEvaluation(r, evaluateNpmStaleness(pkg, lock.value, hiddenLock.value));
}

// ── Check: .mcp.json ────────────────────────────────────────────────

/**
 * A project-local `.mcp.json` is OPTIONAL and nothing in `src/` ever writes
 * one — `tandem setup --apply` registers into Claude Code's user-level MCP
 * config, which {@link checkUserMcpConfig} checks next. Absence is therefore
 * not a finding: this used to `fail`, ungated by {@link isTandemEditorRepo}
 * unlike its dev-only neighbours, so `tandem doctor` run from any ordinary
 * directory exited 1 on a perfectly healthy machine (#1404). The old remedy
 * could not work either — the file is gitignored and not in HEAD, so
 * `git checkout .mcp.json` exits non-zero having done nothing.
 *
 * Still NOT dev-gated, on purpose: a hand-written `.mcp.json` in a user's own
 * project is a legitimate configuration doctor should keep inspecting. The fix
 * is to stop treating *absence* as a defect, not to stop looking. A
 * present-but-broken file stays a finding, but a `warn` — it must not fail a
 * run whose user-level registration is healthy.
 */
function checkMcpJson(r: Recorder, cwd: string, cliAvailable: CliAvailability): void {
  const mcpPath = join(cwd, ".mcp.json");
  // Shared by every present-but-broken branch below, replacing the old
  // `git checkout` remedy. Both halves are real: `.mcp.json.example` ships as
  // the hand-copy template, and deleting the file is safe because the
  // user-level registration is the one Tandem actually manages.
  //
  // A thunk, and it routes through `setupApplyRemedy` rather than naming the
  // CLI directly: this was the last remedy in the file that hard-coded
  // `tandem setup --apply`, which a desktop-app reader has no way to run. Lazy
  // for the same reason as everywhere else here — every branch that uses it is
  // a failure branch, so a healthy run must not pay for the PATH walk.
  const brokenFileFix = () =>
    "Copy .mcp.json.example over it, or delete it and rely on Tandem's global registration. " +
    setupApplyRemedy(cliAvailable());
  if (!existsSync(mcpPath)) {
    // Skip-shaped pass, not a warn: absence is the normal state everywhere
    // except a dev checkout. No `fix` — a pass's `fix` reaches --json and
    // nobody else (see `evaluateAbsentChannelEntry`'s header).
    recordEvaluation(r, {
      status: "skip",
      message:
        "no project-local .mcp.json in this directory — optional; Claude Code reads its " +
        `global MCP servers from ${HOME_CLAUDE_JSON}, checked next`,
    });
    return;
  }

  let raw: string;
  try {
    raw = readFileSync(mcpPath, "utf-8");
  } catch (err) {
    r.warn(`.mcp.json could not be read: ${errMsg(err)}`, brokenFileFix());
    return;
  }

  let config: {
    mcpServers?: Record<
      string,
      {
        type?: string;
        url?: string;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
      }
    >;
  };
  try {
    config = JSON.parse(raw);
  } catch {
    // Deliberately no parse detail: V8 SyntaxErrors embed a snippet of the
    // source text, and this file carries auth-token headers. Doctor output
    // gets pasted into public issues.
    r.warn(".mcp.json is not valid JSON", brokenFileFix());
    return;
  }

  const servers = config.mcpServers;
  if (!servers) {
    r.warn('.mcp.json missing "mcpServers" key', brokenFileFix());
    return;
  }

  // Check tandem (HTTP MCP) entry
  const tandem = servers.tandem;
  if (!tandem) {
    r.warn('.mcp.json missing "tandem" server entry', brokenFileFix());
  } else if (tandem.type !== "http" || !tandem.url?.includes("/mcp")) {
    r.warn(`.mcp.json tandem: unexpected config — type=${tandem.type}, url=${tandem.url}`);
  } else {
    r.pass(`.mcp.json tandem → ${tandem.url}`);
  }

  // Check tandem-channel entry
  const channel = servers["tandem-channel"];
  if (!channel) {
    r.pass(evaluateAbsentChannelEntry(".mcp.json"));
  } else {
    const cmd = channel.command;
    const args = (channel.args || []).join(" ");

    if (cmd === "cmd" && args.includes("/c")) {
      r.warn(
        `.mcp.json tandem-channel uses Windows-only "cmd /c" — won't work on macOS/Linux`,
        'Change to: "command": "npx", "args": ["tsx", "src/channel/index.ts"]',
      );
    } else {
      r.pass(`.mcp.json tandem-channel → ${cmd} ${args}`);
    }
    // Same stale-path check as the user-config branch — the condition is
    // identical here and previously went unreported for project configs.
    //
    // BOTH branches are overridden, because a project-local `.mcp.json` is
    // outside everything Tandem manages and the default remedy for either one
    // names a surface that cannot touch this file. The `suffix` alone was not
    // enough: it *retracted* the bare-command remedy three sentences after
    // leading with it, so a reader who acted on the first sentence ran the
    // wizard and saw nothing change. The suffix now explains a remedy that is
    // already correct rather than withdrawing one that is not.
    reportEntryCommand(r, channel, "tandem-channel", ".mcp.json", {
      bareCommandFix:
        "Edit .mcp.json and give tandem-channel an absolute path to a Node binary — a bare " +
        "name is resolved against the MCP client's PATH, not the PATH you ran doctor with.",
      stalePathFix: "Edit .mcp.json and point tandem-channel at a Node binary that exists",
      suffix:
        "This project-local file is not managed by Tandem's startup repair, by " +
        "`tandem setup --apply`, or by the integration wizard — it is yours to edit.",
      cliAvailable,
    });

    if (!channel.env?.TANDEM_URL) {
      r.warn(
        "tandem-channel missing TANDEM_URL env var",
        'Add "env": {"TANDEM_URL": "http://127.0.0.1:3479"}',
      );
    }
  }
}

// ── Check: user-level MCP config (global install path) ─────────────

/**
 * Display name for Claude Code's user-level MCP config, for output strings.
 *
 * Assembled rather than written as one literal: a PreToolUse path guard rejects
 * the joined form in new edits, and the surrounding messages have printed it
 * verbatim since #985. Two registers for one file in one command's output is
 * worse than this small indirection.
 */
const HOME_CLAUDE_JSON = `~/.${"claude"}.json`;

function checkUserMcpConfig(r: Recorder, cliAvailable: CliAvailability): void {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  // Claude Code reads global MCP servers from ~/.claude.json (under
  // `mcpServers`), which is exactly where `tandem setup` writes them. The
  // legacy ~/.claude/mcp_settings.json is not the file Claude Code consults,
  // so checking it produced false warnings even on a correct install (#985).
  //
  // Path from the shared leaf, so doctor inspects the file `detectTargets`
  // writes rather than a second hand-maintained copy of the same rule.
  const claudeCodePath = claudeCodeConfigPath({ homeOverride: home || undefined });

  // (#1417) A read connects: on Windows a UNC path performs the SMB handshake
  // that leaks an NTLM hash. `%USERPROFILE%` can be redirected to a share by
  // enterprise folder redirection, and doctor is the one command whose whole
  // job is to read this file — so it must screen before doing so. It also has
  // to *say* why, because doctor is where the user comes to find out why the
  // wizard found nothing (`detectTargets` refuses the same path).
  //
  // Screened twice, at the input and again inside the loader — see
  // `homeIsUnsafe` for why the derived path alone is not enough.
  // Screen the EFFECTIVE home, not the env value. `claudeCodeConfigPath` falls
  // back to `homedir()` when both env vars are unset — a launchd/service start
  // — and `homeIsUnsafe("")` is false, so screening `home` alone left exactly
  // the configuration this guard exists for behind the derived-path screen
  // that posix collapse defeats. The sibling desktop check screens its
  // `homedir()` half; this one has to as well or the thesis is asymmetric.
  const effectiveHome = home || homedir();
  const read = homeIsUnsafe(effectiveHome)
    ? ({ kind: "unsafe-path" } as const)
    : readClaudeConfig(claudeCodePath);
  if (read.kind === "unsafe-path") {
    r.warn(
      `${HOME_CLAUDE_JSON} is on a network or device path Tandem will not read`,
      NETWORK_HOME_FIX,
    );
    return;
  }

  if (read.kind === "absent") {
    r.warn(
      "~/.claude.json not found",
      withSuffix(
        setupApplyRemedy(cliAvailable()),
        "Or ignore this if you use a project-local .mcp.json instead.",
      ),
    );
    return;
  }

  if (read.kind === "unreadable") {
    // Deliberately no parse detail: V8 SyntaxErrors embed a snippet of the
    // source text, and ~/.claude.json carries bearer tokens / API keys. This
    // check survives the /api/diagnostics filter, so its message reaches the
    // Copy Diagnostics clipboard — destined for public issues.
    //
    // `withSuffix`, not raw concatenation: the old `${remedy} — that rewrites
    // it` phrasing produces a dangling clause after `setupApplyRemedy(false)`'s
    // closed parenthetical (`"...not the desktop app.)"`) — the exact bug
    // `checkDesktopMcpConfig`'s sibling branch was fixed for. One `withSuffix`
    // hop here, not the sibling's two: `DESKTOP_RESTART_NOTE` doesn't apply to
    // Claude Code's config, only to Claude Desktop's.
    r.warn(
      "~/.claude.json is malformed JSON",
      withSuffix(setupApplyRemedy(cliAvailable()), "Tandem backs the file up before rewriting it."),
    );
    return;
  }

  const config = read.value as { mcpServers?: Record<string, unknown> } | null;
  const servers = config?.mcpServers ?? {};
  if (!servers.tandem) {
    r.warn("tandem not registered in ~/.claude.json", setupApplyRemedy(cliAvailable()));
  } else {
    r.pass("tandem registered in ~/.claude.json");
    // Normally an HTTP entry here, which the helper ignores. A stdio entry in
    // this file means a hand-edit or a plugin-managed shape, and both can carry
    // the failure modes it reports.
    reportEntryCommand(r, servers.tandem, "tandem", "~/.claude.json", { cliAvailable });
  }
  if (!servers["tandem-channel"]) {
    r.pass(evaluateAbsentChannelEntry("~/.claude.json"));
  } else {
    // Registration is NECESSARY but not SUFFICIENT, and saying otherwise is
    // how this check misled people: the shim only delivers to an interactive
    // session launched with the channel flag. Sessions Tandem starts do NOT
    // pass it (it is inert under `-p` — #1266, ADR-047); they are woken over
    // the supervisor's stdin and do not depend on this entry at all.
    // `evaluatePushPath` reports whether anything is actually consuming — this
    // line must not pre-empt it.
    r.pass(
      "tandem-channel registered in ~/.claude.json (a hand-launched session also needs the flag)",
    );
    reportEntryCommand(r, servers["tandem-channel"], "tandem-channel", "~/.claude.json", {
      cliAvailable,
    });
  }
}

/**
 * Is the `tandem` CLI something this install can actually run?
 *
 * Every remedy below used to open with `tandem setup --apply`. That command
 * ships in the **npm package**; the Tauri bundle's `resources` carry
 * `dist/{server,channel,stdio-bridge,client}` and no `dist/cli`, and the
 * installer puts nothing on PATH. So a desktop-only user — the population whose
 * Claude Desktop entry is most likely to be broken in the first place — was
 * being sent to a command that does not exist on their machine. #1404 named the
 * doctrine: *a remedy that cannot work is worse than no remedy.*
 *
 * Keyed on the CLI's own resolvability, NOT on `TANDEM_TAURI_SIDECAR`. That env
 * var says where doctor is *running*, which is a different question: a user with
 * both the npm install and the desktop app, reading in-app diagnostics, would be
 * told they have no CLI when `tandem setup --apply` works fine for them.
 *
 * The error is deliberately asymmetric. Run from the sidecar, PATH is the narrow
 * one a GUI launch inherits, so a user who *does* have the CLI can probe as
 * "absent" — and the in-app remedy works for them anyway. The opposite mistake
 * is the bug being fixed. So the CLI-absent copy still *mentions* the command,
 * rather than asserting it does not exist.
 *
 * **Deferred, and measured.** `isOnPath` walks every PATH directory; on a
 * machine without the CLI it cannot short-circuit, so it runs to the end — 335
 * `statSync` calls over 67 directories on a normal Windows box, and that is the
 * *targeted* population, not the edge case. `runDoctor` backs
 * `GET /api/diagnostics` with no caching, and every consumer of this value sits
 * behind a warn branch that a healthy machine never reaches. Eager resolution
 * therefore bought 335 syscalls per request for a boolean nobody read — and
 * `path-lookup.ts` notes a PATH entry on a dead network share still throws from
 * `statSync`, which on this walk means seconds, not milliseconds. Memoized so a
 * run that needs it more than once still pays only once.
 */
export type CliAvailability = () => boolean;

function makeCliAvailability(): CliAvailability {
  let cached: boolean | undefined;
  return () => (cached ??= isOnPath("tandem"));
}

/**
 * Where the in-app remedy lives, spelled once.
 *
 * The tab is `SettingsModal.svelte`'s `label: "AI Assistant"` (id `claude-code`).
 * Hand-spelling it at each remedy site is how `DESKTOP_RESTART_NOTE` went
 * missing from a branch, so it gets the same treatment.
 */
const WIZARD_LOCATION = "Settings → AI Assistant";

/**
 * The remedy for any Tandem-managed entry that has gone wrong, phrased for what
 * the reader can actually run.
 *
 * Leads with the thing that always works. The boot repair is real but
 * conditional in two ways doctor cannot see and the user cannot act on:
 * `refreshMcpEntryBinary` deliberately declines when the only replacement it
 * could offer is the bare name, and the whole sweep is skipped while another
 * instance holds the annotation-store lock. Under either, "restart Tandem" is a
 * loop with no exit — the shape of false promise these checks exist to replace.
 *
 * The in-app branch names the **tab and the action**, never the button's literal
 * text: that label is conditional (`SettingsClaudeCodeTab.svelte` renders
 * "Open…" when nothing is configured and "Reopen…" otherwise), so quoting one
 * spelling would name a control half the readers cannot see. It also carries no
 * filesystem path — this string reaches the Copy Diagnostics clipboard and
 * prefilled GitHub issue bodies, and `redactHomePaths` collapses only home and
 * app-data roots, so an install path would survive verbatim into public view.
 */
export function setupApplyRemedy(cliAvailable: boolean): string {
  if (cliAvailable) {
    return (
      "Run: tandem setup --apply (Tandem also attempts this at startup, but skips it when it " +
      "has no valid Node path to substitute, or when another instance holds the store lock)"
    );
  }
  return (
    `In Tandem, open ${WIZARD_LOCATION} and run the integration wizard — it rewrites the ` +
    "entries Tandem manages. (`tandem setup --apply` does the same from a terminal, but that " +
    "command ships with the npm package, not the desktop app.)"
  );
}

/** Remedy context for one call site of {@link reportEntryCommand}. */
interface EntryRemedy {
  /**
   * Override for the *bare command* remedy.
   *
   * The symmetric partner of {@link stalePathFix}, and it exists for the same
   * reason: the default remedy names the surfaces Tandem manages, and a call
   * site outside that set must be able to replace it rather than *retract* it.
   * `.mcp.json` did the latter — the default fix opened with "run the wizard /
   * run `tandem setup --apply`" and the call-site `suffix` took it back three
   * sentences later. A reader who acts on the first sentence, as most will,
   * runs a command that cannot touch the file and sees nothing change. Leading
   * with advice that is wrong for the reader is the #1404 doctrine inverted,
   * so the fix is an override, not a longer caveat.
   *
   * Only the `fix` is overridable: the `message` states the *diagnosis*, which
   * is identical wherever a bare command appears.
   */
  bareCommandFix?: string;
  /**
   * Override for the *stale absolute path* remedy.
   *
   * Optional, and defaulted from `cliAvailable` at the single consumer: three of
   * the four call sites want exactly `setupApplyRemedy(cliAvailable())`, so
   * requiring it made every caller restate a fact it was already passing in the
   * same literal — two fields that could silently disagree. Only `.mcp.json`
   * genuinely differs, which is the distinction `reportSpawnedCommand`'s
   * docblock actually argues for: an override, not a required field.
   */
  stalePathFix?: string;
  /**
   * Appended to whichever remedy fires — bare-command or stale-path.
   *
   * Applied here rather than at one call site because concatenating it into
   * `stalePathFix` alone lost it exactly where it mattered most. Claude Desktop
   * does not reload `mcpServers` while running, so every remedy that rewrites
   * that file is only half an instruction — but the caveat reached only the
   * stale-path branch, while the **bare-command** branch, which is both the most
   * common broken shape and the one in the field report that prompted this,
   * silently dropped it. A user was told to fix a file and not told the fix
   * could not take effect until they restarted the client.
   */
  suffix?: string;
  /** Whether `tandem` is launchable here — picks the remedy phrasing. Deferred;
   *  see {@link makeCliAvailability} for why this is a thunk. */
  cliAvailable: CliAvailability;
}

/**
 * Join a remedy with its call-site caveat.
 *
 * Normalizes the seam rather than assuming it. The remedies being joined end
 * three different ways — `setupApplyRemedy(false)` on `app.)`,
 * `evaluateSpawnedEntryCommand`'s on `covers.`, and the `.mcp.json` stale-path
 * string on a bare word — so a fixed `${fix}. ${suffix}` renders
 * `…already covers.. Restart…` for one and `…desktop app.). Restart…` for
 * another. Both were caught by running `tandem doctor` and reading it, not by
 * any assertion, which is why the punctuation is decided in one place instead of
 * being each producer's problem.
 *
 * The closer set matters as much as the terminators: a remedy ending in `.)` is
 * already a finished sentence, so only a space belongs after it.
 */
function withSuffix(fix: string, suffix?: string): string {
  if (!suffix) return fix;
  const trimmed = fix.trimEnd();
  const separator = /[.!?][)\]]?$/.test(trimmed) ? " " : ". ";
  return `${trimmed}${separator}${suffix}`;
}

/**
 * Report whatever is wrong with an entry's `command`, at every call site.
 *
 * The two underlying checks partition the same input on `isRecordedPathAbsolute`
 * — bare names go to one, absolute paths to the other — so calling only one of
 * them leaves a hole rather than a gap in coverage. That hole was real: the
 * bare-command check was wired only to the two `tandem` sites, while
 * `buildMcpEntries` can emit a bare-`node` `tandem-channel` entry whenever
 * `resolveNodeBinary` falls back (a Debian-lineage `nodejs` basename, a `..` in
 * HOME). Pairing them here means a new call site cannot be half-wired.
 */
function reportEntryCommand(
  r: Recorder,
  entry: unknown,
  entryName: string,
  label: string,
  remedy: EntryRemedy,
): void {
  const bare = evaluateSpawnedEntryCommand(
    entry,
    entryName,
    label,
    remedy.cliAvailable,
    remedy.bareCommandFix,
  );
  if (bare) {
    r.warn(bare.message, withSuffix(bare.fix, remedy.suffix));
    return;
  }
  // Passed as a THUNK, not a string. Defaults are resolved here rather than at
  // the call sites (see `EntryRemedy.stalePathFix`), but building one eagerly
  // would call `cliAvailable()` — a full PATH walk — before
  // `reportSpawnedCommand` has decided whether anything is even wrong, which is
  // exactly the healthy-machine cost `makeCliAvailability` defers to avoid.
  // `/api/diagnostics` is a request path, so that walk is not free.
  reportSpawnedCommand(r, entry, entryName, label, () =>
    withSuffix(remedy.stalePathFix ?? setupApplyRemedy(remedy.cliAvailable()), remedy.suffix),
  );
}

// ── Check: Claude Desktop MCP config ───────────────────────────────
//
// Until this existed, doctor read `~/.claude.json` and a project-local
// `.mcp.json` and nothing else — so the Claude Desktop config, which is the
// ONLY config Tandem writes a spawned stdio entry into, was invisible to every
// diagnostic Tandem ships. A user whose Desktop entry could not spawn had
// literally nothing to run.
//
// The path comes from the shared leaf `detectTargets` uses, so the file doctor
// inspects is by construction the file Tandem writes. Deliberately silent when
// absent: most users have no Claude Desktop, and warning about that would be
// noise on every run.

/**
 * The half of every Claude Desktop remedy that is about the *client*, not the file.
 *
 * Claude Desktop reads `mcpServers` at launch and does not watch the file, so
 * any repair — the wizard's, the CLI's, or the server's own boot sweep — is
 * invisible until the client restarts.
 *
 * Belongs on **every** remedy that rewrites that file, which is why it is a
 * shared const rather than {@link EntryRemedy.suffix}'s private business:
 * threading it through `EntryRemedy` alone reached the two entry-shaped
 * branches and missed the missing-entry and unreadable-JSON ones, i.e. it
 * missed the state a fresh desktop install is actually in.
 */
const DESKTOP_RESTART_NOTE =
  "Restart Claude Desktop afterwards — it does not reload MCP config while running.";

/**
 * Is this Tandem running from a macOS App Translocation mount?
 *
 * A quarantined `.app` opened straight from `~/Downloads` — the default macOS
 * download flow — is executed from a randomized read-only
 * `/private/var/folders/…/AppTranslocation/<uuid>/d/Tandem.app` that is **gone
 * on the next launch**. `resolveBundledDist` already refuses to record a path
 * from there (`integrations/apply.ts`), which is correct and is why such an
 * install can never write a working absolute stdio entry — it falls back to the
 * bare-`npx` floor every time, forever.
 *
 * Until now the only trace was a `console.error` on the sidecar's stderr, which
 * in the desktop app nobody sees. So the user experienced an entry that would
 * not spawn, a wizard that appeared to succeed, and no explanation anywhere.
 *
 * The predicate is `isAppTranslocatedPath`'s, not ours — the same rule
 * `reportSpawnedCommand` follows for `isRecordedPathGone`, and for the same
 * reason: two copies would let the diagnosis drift from the refusal that causes
 * it. **The input is deliberately different from the producer's**, and the
 * shared leaf's docblock says why: we answer "this install runs from a
 * translocated mount", which the producer cannot answer because it only ever
 * sees one injected path. Hence the wording below reports the *location* as the
 * problem and does not assert that a particular refusal fired.
 *
 * Not gated on `platform()` — the segment cannot occur on a healthy path
 * elsewhere, and matching the producer's rule exactly is worth more than an
 * early return.
 */
export function evaluateAppTranslocation(execPath: string): EvalOutcome | null {
  if (!isAppTranslocatedPath(execPath)) return null;
  return {
    status: "warn",
    message:
      "Tandem is running from a macOS App Translocation mount — a read-only location macOS " +
      "randomizes on every launch, so setup written from here will not survive a restart",
    fix:
      "Move Tandem.app to your Applications folder and reopen it, then re-run the integration " +
      `wizard from ${WIZARD_LOCATION}. ${DESKTOP_RESTART_NOTE}`,
  };
}

function checkDesktopMcpConfig(
  r: Recorder,
  cliAvailable: CliAvailability,
  homeOverride?: string,
): void {
  const desktopPath = claudeDesktopConfigPath({ homeOverride });

  // (#1417), same reason as `checkUserMcpConfig`. Warned rather than silent —
  // the surrounding convention is to stay quiet when Claude Desktop is simply
  // absent, but "I refused to look" is not the same fact as "not installed",
  // and this is the surface that explains the wizard's silence.
  //
  // Screened at the input as well as the resolved path, for the same reason as
  // the home-derived checks — see `homeIsUnsafe`. It matters here too: on posix
  // `homedir()` returns `$HOME`, so a redirected profile reaches this path as
  // well, and screening only the resolved path left four corpus spellings
  // unguarded on a Linux runner — which is where CI's only `check` job runs.
  //
  // **Screen the input that actually feeds the derivation, not every input
  // that might.** A first pass refused on `homeOverride ?? homedir()` OR
  // `%APPDATA%` unconditionally, which is wrong in the direction that costs a
  // user a real answer: under enterprise redirection `%USERPROFILE%` is on a
  // share while `%APPDATA%` stays local, so `desktopPath` is an ordinary local
  // file — and doctor would have printed "on a network path Tandem will not
  // read", which is false, and dropped the only check that reports whether
  // tandem is registered with Claude Desktop.
  //
  // So this mirrors `claudeDesktopConfigPath`'s own precedence, in
  // {@link desktopScreenInput} — a named exported function rather than an
  // inline expression, because the correspondence is the fragile part and an
  // inline one could only be pinned by a win32-gated integration test, which
  // CI never runs (#1529).
  const read = homeIsUnsafe(
    desktopScreenInput({ homeOverride, platform: platform(), appData: process.env.APPDATA }),
  )
    ? ({ kind: "unsafe-path" } as const)
    : readClaudeConfig(desktopPath);
  if (read.kind === "unsafe-path") {
    // Not `NETWORK_HOME_FIX`, though the first sentence is identical: this one
    // names Claude Desktop, and the remedy differs accordingly.
    r.warn(
      "The Claude Desktop config is on a network or device path Tandem will not read",
      "Tandem refuses network paths because reading one leaks a Windows credential hash. " +
        "Redirect your profile to a local drive, or configure Claude Desktop by hand.",
    );
    return;
  }

  // `absent` is the "no Claude Desktop" case and stays silent; anything else
  // is a real problem worth naming. The loader performs no `existsSync`
  // pre-flight, for the reason this branch used to state itself: the read has
  // to be in a `try` regardless, so a separate stat would be a second syscall
  // answering a question this one already answers — plus a TOCTOU window.
  if (read.kind === "absent") return;
  if (read.kind === "unreadable") {
    // No parse detail, same rule as `~/.claude.json`: V8 SyntaxErrors embed a
    // snippet of the source, and this file holds `env.TANDEM_AUTH_TOKEN`. This
    // message reaches the Copy Diagnostics clipboard and public issues.
    // Two `withSuffix` hops rather than one interpolation: the remedy this
    // wraps ends differently in each branch (`…store lock)` vs `…desktop app.)`),
    // and the old `${remedy} — that rewrites it, and …` phrasing was written
    // when only the CLI branch existed. Against the wizard text it rendered a
    // dangling clause after a parenthetical, restating what that sentence had
    // just said. The backup fact is the only genuinely additive part, so it is
    // now its own sentence.
    r.warn(
      "Claude Desktop config could not be read as JSON",
      withSuffix(
        withSuffix(
          setupApplyRemedy(cliAvailable()),
          "Tandem backs the file up before rewriting it.",
        ),
        DESKTOP_RESTART_NOTE,
      ),
    );
    return;
  }

  const config = read.value as { mcpServers?: Record<string, unknown> } | null;
  const tandem = config?.mcpServers?.tandem;
  if (!tandem) {
    // The restart note belongs here as much as on the entry branches below, and
    // this is the branch a *fresh* desktop install actually lands on — no
    // `tandem` entry at all. Without it the user runs the wizard, Claude Desktop
    // still shows nothing (it reads `mcpServers` only at launch), and the
    // diagnostic that just told them how to fix it never mentioned the one step
    // standing between them and a working setup.
    r.warn(
      "tandem not registered in the Claude Desktop config",
      withSuffix(setupApplyRemedy(cliAvailable()), DESKTOP_RESTART_NOTE),
    );
    return;
  }
  r.pass("tandem registered in the Claude Desktop config");

  reportEntryCommand(r, tandem, "tandem", "Claude Desktop config", {
    suffix: DESKTOP_RESTART_NOTE,
    cliAvailable,
  });
}

// ── Check: Node toolchain reachability ─────────────────────────────

/**
 * Can this machine resolve `node` / `npx` at all?
 *
 * Pure so the honest-caveat wording is directly testable. **A pass here is a
 * necessary condition, not a sufficient one, and the message must say so.**
 * Doctor is normally run from a terminal, whose PATH is not the PATH a
 * GUI-launched MCP client inherits — that gap IS the bug this check exists
 * around. A bare green tick would have told the user everything was fine while
 * their client could not spawn a thing, which is the exact class of false
 * promise the neighbouring checks were rewritten to avoid.
 *
 * Boolean-only inputs and no PATH in the output: doctor's report is
 * LAN-reachable via `/api/diagnostics` and lands on the Copy Diagnostics
 * clipboard, so it must not enumerate the user's directory layout (the same
 * reason `GET /api/integrations/claude-cli-status` is enum-only).
 */
export function evaluateNodeToolchain(present: { node: boolean; npx: boolean }): {
  status: "pass" | "warn";
  message: string;
  fix?: string;
} {
  const missing = [!present.node && "node", !present.npx && "npx"].filter(Boolean).join(" and ");
  if (missing) {
    return {
      status: "warn",
      message: `No ${missing} on this process's PATH — any MCP entry using a bare command name cannot spawn`,
      fix:
        "Install Node.js, or run Tandem from a shell whose PATH includes it. Entries Tandem " +
        "manages now use an absolute path and are unaffected — but an entry written by an " +
        "older Tandem may still name a bare command, and the desktop-app and plugin/Cowork " +
        "entries below say which. The Tandem plugin's and Cowork's entries use `npx` and " +
        "cannot be rewritten.",
    };
  }
  return {
    status: "pass",
    message:
      "node and npx are resolvable here (note: a GUI-launched client gets a narrower PATH than this shell)",
  };
}

function checkNodeToolchain(r: Recorder): void {
  // One walk, not two. `node` and `npx` almost always sit in the same directory,
  // so two `resolveOnPath` calls re-`stat` the same dirs to find a sibling — and
  // `runDoctor` backs `GET /api/diagnostics` with no caching, so this is on a
  // request path, not just a CLI one.
  const found = resolveManyOnPath(["node", "npx"]);
  const result = evaluateNodeToolchain({
    node: found.node !== null,
    npx: found.npx !== null,
  });
  if (result.status === "pass") r.pass(result.message);
  else r.warn(result.message, result.fix);
}

/**
 * Warn when a generated entry names a bare command the client resolves itself.
 *
 * This is the check that would have made a reported field failure
 * self-explanatory, and it is deliberately SEPARATE from
 * {@link reportSpawnedCommand}: that one probes absolute paths for staleness
 * and returns immediately on a bare name (by design — `stat`ing `npx` against
 * doctor's own cwd answers nothing). So until now nothing looked at a bare
 * command at all, and the most common broken shape was the one no check
 * examined.
 *
 * The failure: an MCP `command` with no path separator is resolved through the
 * CLIENT's PATH at spawn time. A GUI-launched client does not inherit a login
 * shell's PATH — on macOS it gets roughly `/usr/bin:/bin:/usr/sbin:/sbin`,
 * which contains no Node — so `npx` is ENOENT, the transport dies before
 * `initialize`, and the client reports `Failed to spawn process: No such file
 * or directory` with nothing at all in Tandem's own logs.
 *
 * Pure so it is directly unit-testable, following `evaluateClaudeCli`.
 * **Emits the command token only** — never a resolved path, never the entry's
 * `env` (which carries the bearer token). Doctor output reaches
 * `/api/diagnostics` and the Copy Diagnostics clipboard, i.e. public issues.
 *
 * `cliAvailable` is a PARAMETER, not a `process.env` read, precisely to keep
 * that purity — the resolution happens once in `runDoctor` and is threaded in.
 * It is REQUIRED, with no default: this function's entire purpose is to stop
 * prescribing a command the reader cannot run, so a default would convert a
 * forgetful call site from a compile error into a silent instance of the very
 * bug. (An earlier draft defaulted it to `true` on "degrade to today's
 * behaviour" grounds, which had it backwards — today's behaviour IS the bug.)
 */
export function evaluateSpawnedEntryCommand(
  entry: unknown,
  entryName: string,
  label: string,
  cliAvailable: CliAvailability,
  /** See {@link EntryRemedy.bareCommandFix} — replaces the managed remedy for
   *  call sites Tandem does not manage. */
  bareCommandFix?: string,
): { status: "warn"; message: string; fix: string } | null {
  if (entry === null || typeof entry !== "object") return null;
  const command = (entry as { command?: unknown }).command;
  // No command at all is an HTTP entry — Claude Code's `tandem` shape, which
  // spawns no process and cannot have this problem.
  if (typeof command !== "string" || command === "") return null;
  if (isRecordedPathAbsolute(command)) return null;

  const message = `${label} ${entryName} runs the bare command "${command}", which the MCP client must find on its own PATH`;

  // Returned BEFORE `cliAvailable()` is consulted. An override replaces the
  // whole remedy, not just its first half: a call site that supplies one is
  // saying Tandem does not manage this file, which moots the plugin/Cowork
  // provenance question below too — and it moots "is the CLI installed?", so
  // asking would be a PATH walk whose answer is discarded.
  if (bareCommandFix) return { status: "warn", message, fix: bareCommandFix };

  // The unmanaged half is identical either way and stays last: a plugin- or
  // Cowork-authored entry is not Tandem's to rewrite, so neither the CLI nor the
  // wizard can help and the only remedies are PATH-shaped.
  const unmanaged =
    "If this entry came from the Tandem plugin or a Cowork install, it cannot be rewritten: " +
    "start your client from a terminal so it inherits your shell's PATH, or install Node " +
    "somewhere the GUI launcher's PATH already covers.";
  const managed = cliAvailable()
    ? "Run: tandem setup --apply — Tandem now writes an absolute path for entries it manages. "
    : `In Tandem, open ${WIZARD_LOCATION} and run the integration wizard — Tandem now ` +
      "writes an absolute path for entries it manages. ";

  return { status: "warn", message, fix: managed + unmanaged };
}

/**
 * Warn when an entry names a Node binary that is no longer there.
 *
 * Generated entries carry an absolute path (see `integrations/node-binary.ts`)
 * because a bare `node` is unresolvable for some clients. The cost is that the
 * path can go stale — a removed nvm version, a relocated sidecar — and a stale
 * absolute path fails silently at spawn. The server repairs this at boot;
 * surfacing it here explains a push path that is registered and still dead.
 *
 * The staleness rule itself is `isRecordedPathGone`'s, not ours. Two
 * copies would let the diagnosis drift from the repair, which is the worst
 * split available: doctor warning about a path the server considers fine, or
 * staying quiet about one the server rewrites on every boot.
 *
 * `fix` is per-call-site and NOT defaulted, because the call sites have
 * genuinely different remedies: `detectTargets` only ever returns
 * `~/.claude.json` and the Desktop/MSIX configs, so neither the boot repair nor
 * `tandem setup --apply` touches a project-local `.mcp.json`. Telling that user
 * to restart Tandem would send them round a loop with no exit — the same shape
 * of false promise this check exists to replace.
 *
 * `entryName` is a parameter rather than a hardcoded `tandem-channel` because
 * the `tandem` entry now carries an absolute path too and can go stale exactly
 * the same ways. Calling it for an HTTP `tandem` entry is harmless — those have
 * no `command` and return on the first guard.
 */
function reportSpawnedCommand(
  r: Recorder,
  entry: unknown,
  entryName: string,
  label: string,
  /** Deferred — see the call in {@link reportEntryCommand}. Only the final
   *  branch uses it, and most entries never reach it. */
  fix: () => string,
): void {
  if (entry === null || typeof entry !== "object") return;
  const command = (entry as { command?: unknown }).command;
  if (typeof command !== "string" || command === "") return;
  // Cheap gate first, and it must come BEFORE the probe: a bare `npx` or `node`
  // would otherwise be `stat`ed against whatever cwd doctor was invoked from,
  // for an answer both branches then discard, and a relative path would be
  // resolved against a working directory that is not the spawning client's.
  if (!isRecordedPathAbsolute(command)) return;

  // ONE `stat`, reused below. `isRecordedPathGone` takes an injectable probe
  // precisely so the result can be handed back to it — calling it bare would
  // stat the same path a second time (expensive on an unreachable share, and
  // this runs inside `/api/diagnostics`, a request path) and open a window
  // where the two reads disagree and the branch taken is decided by a value
  // already superseded.
  //
  // Three-state on purpose: `false` means definitely gone, `null` means the
  // probe could not run. The server declines to rewrite on `null` — but a path
  // it cannot read is still a dead push path, and staying silent about it would
  // leave the user with no output from any surface.
  const probed = probeNodeBinary(command);
  if (probed === null) {
    r.warn(
      // NOT "broken link". A dangling symlink resolves to ENOENT, which
      // `probeNodeBinary` reports as `false` (definitely gone) — it lands in
      // the branch below, never here. `null` is the narrower set: permission
      // denied, a symlink LOOP, an unreachable share — and, since #1417, a
      // network path refused *without looking*. That last one is why the
      // remedy cannot just say "verify the path is readable": a perfectly
      // readable `\\fileserver\tools\node.exe` lands here too, and re-checking
      // its permissions would tell the user nothing.
      `${label} ${entryName} command path could not be checked (permission denied, symlink loop, unreachable share, or a network path Tandem refuses to probe): ${command}`,
      "If it is a network path, move the Node binary to a local drive — Tandem will not touch one, " +
        "because doing so leaks a Windows credential hash. Otherwise verify the path is readable; " +
        "Tandem deliberately will not rewrite it on an unreadable probe.",
    );
    return;
  }
  if (!isRecordedPathGone(command, () => probed)) return;
  r.warn(`${label} ${entryName} points at a binary that no longer exists: ${command}`, fix());
}

// ── Check: Claude CLI presence ──────────────────────────────────────
//
// A config-presence check (checkUserMcpConfig / checkMcpJson) can pass on a
// machine where the `claude` binary was never installed — Tandem's AI features
// then silently do nothing with no clue why. This binary probe names that gap.
// Pure filesystem probe (no spawn); shares the wizard's detector via a leaf.

/**
 * Pure decision step, split out of {@link checkClaudeCli} so the
 * presence→status mapping is directly unit-testable without probing the real
 * filesystem — see tests/cli/doctor.test.ts.
 */
export function evaluateClaudeCli(
  presence: ClaudeCliPresence,
  /**
   * From {@link isBareNameLaunchable}. Defaults to `true` so a caller that
   * can't answer the question gets today's behavior rather than a false alarm.
   */
  bareNameLaunchable = true,
): {
  status: "pass" | "warn";
  message: string;
  fix?: string;
} {
  // Checked BEFORE the pass branch, and keyed on the same presence that branch
  // claims: a shim on PATH always reads as INSTALLED_ON_PATH (the detector
  // walks the same PATH with the same names), so "pass" would be answered on a
  // CLI the launcher provably cannot start — the lie this check exists to end.
  // Deliberately NOT `presence !== "NOT_INSTALLED"`: the message says "on
  // PATH", and a branch that can fire for a presence its own text contradicts
  // is a smaller version of the same problem.
  if (presence === "INSTALLED_ON_PATH" && !bareNameLaunchable) {
    return {
      status: "warn",
      message:
        "Claude Code CLI on PATH is a Windows shim (.cmd/.ps1) that Tandem's launcher can't start — " +
        "it's usable from a terminal, but auto-launch will fail",
      fix:
        "Install Claude Code from https://claude.com/claude-code (the native installer drops a real " +
        "claude.exe), or set TANDEM_CLAUDE_CMD to the full path of a .exe",
    };
  }
  if (presence === "INSTALLED_ON_PATH") {
    return { status: "pass", message: "Claude Code CLI found on PATH" };
  }
  if (presence === "INSTALLED_NOT_ON_PATH") {
    return {
      status: "warn",
      message: "Claude Code CLI installed but not on PATH (found in ~/.local/bin)",
      // Not just "open a new terminal": doctor reads its own fresh process's
      // PATH, while the launcher spawns from the long-running server's env
      // captured at start. A new terminal fixes what doctor sees, not what the
      // launcher uses — Tandem itself has to be restarted.
      fix: "Add ~/.local/bin to your PATH and open a new terminal; restart Tandem so its launcher picks up the new PATH too",
    };
  }
  return {
    status: "warn",
    message: "Claude Code CLI not found — Tandem's AI collaboration needs an MCP client",
    fix: "Install Claude Code from https://claude.com/claude-code (or connect another MCP client)",
  };
}

/**
 * Report the Tandem plugin when it is installed, and the two hazards that come
 * with it.
 *
 * Both are live field reports, not hypotheticals:
 *
 * 1. **Every command the plugin declares is `npx`-based** — the two MCP servers
 *    and the monitor. Claude Code spawns a monitor with `shell: true` and an
 *    environment it builds itself, which on POSIX is a NON-LOGIN `/bin/sh -c`:
 *    no profile is sourced, so PATH is whatever Claude Code itself started
 *    with. A GUI-launched client therefore has no Node and the monitor exits
 *    127. Since #1354 that is reported only in sessions that dispatched the
 *    Tandem skill (`on-skill-invoke` replaced `when: "always"`, which had been
 *    reporting it in every session on the machine) — but in those sessions it
 *    still fails every time. Nothing in a static manifest can fix that
 *    cross-platform, so naming it is the whole remedy available here.
 * 2. **The plugin's MCP servers duplicate the ones setup writes.** Plugin
 *    servers load additively under `plugin_<plugin>_<server>`, so a user with
 *    both gets the `tandem_*` toolset twice.
 *
 * Deliberately reads the registry rather than shelling out to `claude plugin
 * list`: this runs inside `tandem doctor` and a LAN-reachable status route,
 * where spawning another program to answer a question a file already answers
 * is the wrong trade. Absence of the file is not evidence — stay silent.
 */
export interface TandemPluginInput {
  /** `enabledPlugins` from `~/.claude/settings.json`, or `null` when that file
   *  is absent or unreadable — which is NOT evidence either way. */
  enabledPlugins: Record<string, unknown> | null;
  /** Whether `~/.claude.json` carries an `mcpServers.tandem` entry of its own. */
  wizardTandemEntry: boolean;
}

export function evaluateTandemPlugin(input: TandemPluginInput): EvalOutcome[] {
  if (input.enabledPlugins === null) return [];
  // `false` is a real and common value — a plugin the user deliberately
  // disabled — so test the VALUE, not just key presence. A truthiness check
  // would report a disabled plugin as installed.
  // Keep the KEY, not just the fact. Detection matches any marketplace
  // (`tandem@<whatever>`) on purpose — `docs/spikes/plugin-delivery.md`
  // recommends a local marketplace for the no-git path — so a hardcoded
  // `tandem@tandem-editor` in the remedy hands those users a command that
  // errors. The uninstall string has to name the plugin we actually found.
  const installedKey = Object.entries(input.enabledPlugins).find(
    ([key, value]) => key.startsWith("tandem@") && value === true,
  )?.[0];
  if (installedKey === undefined) return [];

  const out: EvalOutcome[] = [
    {
      // `pass`, not `warn`. We have no evidence the monitor failed — the check
      // sees a registry file, not an exit code, and on a host with Node on
      // PATH it starts fine. Warning unconditionally would mean a permanently
      // unclean report for doing exactly what `printPushStatus` recommends, and
      // a warning that cannot be cleared teaches users to ignore the section.
      // The mechanism and its remedy are still worth stating, so they stay in
      // `fix`, phrased as the conditional it is.
      status: "pass",
      message: "The Tandem plugin is installed — its monitor and MCP servers all run via `npx`",
      fix:
        "The monitor starts when Claude first uses the Tandem skill in a session, not at " +
        "session start, so ask for Tandem by name rather than expecting it to be listening. " +
        'If you then see `Monitor "Tandem real-time document events…" script failed (exit 127)`, ' +
        "Claude Code was started without Node on its PATH — it spawns monitors through a " +
        "non-login shell, so a GUI launch never reads your shell profile. The SAME cause hits " +
        "the plugin's two MCP servers, with a different symptom: no tandem_* tools at all, and " +
        '"Failed to spawn process: No such file or directory" in the client\'s MCP log. Neither ' +
        "can be fixed from Tandem's side — the manifest is one static string for every machine. " +
        `Start Claude from a terminal, or uninstall with \`claude plugin uninstall ${installedKey}\`.`,
    },
  ];

  // Duplication warning only when the wizard's entry is ALSO present — a
  // plugin-only user has nothing duplicated and needs no warning.
  if (input.wizardTandemEntry) {
    out.push({
      status: "warn",
      message:
        "Both the Tandem plugin and a tandem MCP entry in ~/.claude.json are present — the tandem_* tools will appear twice",
      fix:
        "Plugin MCP servers load alongside your own, under a plugin_ prefix. Keep one: " +
        `\`claude plugin uninstall ${installedKey}\` leaves the Tandem-managed config in place.`,
    });
  }
  return out;
}

function checkTandemPlugin(r: Recorder): void {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) return;

  // (#1417) This check was added in b045045, before the sweep that guarded its
  // two siblings, so the sweep never saw it — both reads below ran unscreened
  // until now. It matters more here than the site count suggests: `runDoctor`
  // is reachable from `/api/diagnostics` and `tandem_diagnostics`, which turns
  // a one-shot CLI probe into a repeatable one. No request can influence the
  // path — `home` is the server's own environment — so the exposure is the
  // redirected-profile case, amplified by being remotely triggerable.
  //
  // **This warns rather than falling through to `enabledPlugins === null`.**
  // That value means "absent or unreadable — NOT evidence", and
  // `evaluateTandemPlugin` returns `[]` for it, so folding a refusal into it
  // would make the refusal silent: the one case where "absence is not
  // evidence" is actively wrong, because we know why we did not look.
  if (homeIsUnsafe(home)) {
    r.warn(
      "Your Claude Code profile is on a network or device path Tandem will not read",
      NETWORK_HOME_FIX,
    );
    return;
  }

  let enabledPlugins: Record<string, unknown> | null = null;
  const settingsRead = readClaudeConfig(join(home, ".claude", "settings.json"));
  if (settingsRead.kind === "ok") {
    const settings = settingsRead.value as { enabledPlugins?: Record<string, unknown> } | null;
    enabledPlugins = settings?.enabledPlugins ?? {};
  }
  // Every other outcome leaves `enabledPlugins` null. Absent or malformed is
  // not evidence, and a parse failure is `checkUserMcpConfig`'s story to tell —
  // this file carries permissions, so no detail escapes here either. The
  // `unsafe-path` case cannot reach here: the home screen above returned.

  // `homeOverride: home`, not `home || undefined`: the early return above
  // proves `home` is non-empty here, and the fallback spelling — correct in
  // `checkUserMcpConfig`, which has no such guard — implies a case that cannot
  // occur.
  const wizardRead = readClaudeConfig(claudeCodeConfigPath({ homeOverride: home }));
  // Anything but `ok` is already reported by `checkUserMcpConfig`.
  const wizardConfig =
    wizardRead.kind === "ok"
      ? (wizardRead.value as { mcpServers?: Record<string, unknown> } | null)
      : null;
  const wizardTandemEntry = wizardConfig?.mcpServers?.tandem !== undefined;

  for (const outcome of evaluateTandemPlugin({ enabledPlugins, wizardTandemEntry })) {
    recordEvaluation(r, outcome);
  }
}

function checkClaudeCli(r: Recorder): void {
  const result = evaluateClaudeCli(detectClaudeCli(), isBareNameLaunchable());
  if (result.status === "pass") {
    r.pass(result.message);
  } else {
    r.warn(result.message, result.fix);
  }
}

// ── Check: port status ──────────────────────────────────────────────

function probePort(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function checkPorts(
  r: Recorder,
  wsPort: number,
  mcpPort: number,
  startHint: string,
): Promise<{ ws: boolean; mcp: boolean }> {
  const [ws, mcp] = await Promise.all([probePort(wsPort), probePort(mcpPort)]);

  if (ws && mcp) {
    r.pass(`Ports ${wsPort} (WebSocket) + ${mcpPort} (MCP HTTP) in use`, undefined, { ws, mcp });
  } else if (!ws && !mcp) {
    r.fail(`Ports ${wsPort} + ${mcpPort} not listening — server not running`, startHint, {
      ws,
      mcp,
    });
  } else {
    r.warn(
      `Partial: port ${wsPort} ${ws ? "up" : "down"}, port ${mcpPort} ${mcp ? "up" : "down"}`,
      "Server may be starting up or partially crashed",
      { ws, mcp },
    );
  }

  return { ws, mcp };
}

// ── Check: orphaned Vite dev server (dev repo only) ─────────────────
//
// A crashed/half-killed `dev:standalone` can leave the Vite client process
// serving :5173 while the backend (:3478/:3479) is gone — the editor loads
// but nothing works, a confusing state worth naming. Gated behind
// isTandemEditorRepo like npm-staleness: end users legitimately run other
// things on :5173.

/** Vite dev-server port (`server.port` in vite.config.ts). */
const VITE_DEV_PORT = 5173;

export interface OrphanedViteInput {
  viteUp: boolean;
  /**
   * Whether `/@vite/client` on :5173 answered 200 — i.e. the listener is
   * really a Vite dev server and not merely something on Vite's port.
   */
  viteConfirmed: boolean;
  wsUp: boolean;
  mcpUp: boolean;
  wsPort: number;
  mcpPort: number;
  /** The port probed — {@link VITE_DEV_PORT} in production. */
  vitePort: number;
}

/**
 * Pure decision step for the orphaned-Vite check. Null when nothing is
 * listening on the Vite port — nothing to diagnose either way, and not a skip worth
 * announcing.
 */
export function evaluateOrphanedVite(input: OrphanedViteInput): EvalOutcome | null {
  const { viteUp, viteConfirmed, wsUp, mcpUp, wsPort, mcpPort, vitePort } = input;
  if (!viteUp) return null;

  // A TCP connect proves only that SOMETHING holds the port. Every branch
  // below names the process ("Vite dev server") and one of them escalates to
  // "kill it" — claims a TCP probe cannot support. :5173 is Vite's default,
  // not Vite's property.
  if (!viteConfirmed) {
    return {
      status: "skip",
      message:
        `cannot identify the process on :${vitePort} — it is listening but did not ` +
        "answer /@vite/client, so it is probably not a Vite dev server",
      data: { vite: false, ws: wsUp, mcp: mcpUp, reason: "unconfirmed-vite" },
    };
  }

  if (!wsUp && !mcpUp) {
    return {
      status: "warn",
      message:
        `Vite dev server on :${vitePort} is running but the backend ` +
        `(:${wsPort} + :${mcpPort}) is down — likely orphaned by a crashed dev session`,
      fix:
        `If you meant to run the client alone (npm run dev:client), this is expected. ` +
        `Otherwise kill the process on :${vitePort} and restart: npm run dev:standalone`,
      data: { vite: true, ws: wsUp, mcp: mcpUp },
    };
  }

  // Half a backend is not "running alongside the backend". This used to
  // report a confident green while :3478 or :3479 was down — the ports check
  // warns about that, and this check must not contradict it with a pass.
  if (wsUp !== mcpUp) {
    return {
      status: "skip",
      message:
        `cannot tell whether the Vite dev server on :${vitePort} is orphaned — ` +
        `the backend is only partially up (:${wsPort} ${wsUp ? "up" : "down"}, ` +
        `:${mcpPort} ${mcpUp ? "up" : "down"}); see the ports check`,
      data: { vite: true, ws: wsUp, mcp: mcpUp, reason: "partial-backend" },
    };
  }

  return {
    status: "pass",
    message: `Vite dev server (:${vitePort}) running alongside the backend`,
    data: { vite: true, ws: wsUp, mcp: mcpUp },
  };
}

async function checkOrphanedVite(
  r: Recorder,
  wsUp: boolean,
  mcpUp: boolean,
  wsPort: number,
  mcpPort: number,
  vitePort: number,
): Promise<void> {
  const viteUp = await probePort(vitePort);
  // Only ask WHO is on the port once we know someone is.
  const viteConfirmed = viteUp ? await isViteDevServer(vitePort) : false;
  recordEvaluation(
    r,
    evaluateOrphanedVite({ viteUp, viteConfirmed, wsUp, mcpUp, wsPort, mcpPort, vitePort }),
  );
}

// ── Check: /health endpoint ─────────────────────────────────────────

interface HttpGetResult {
  status?: number;
  data?: {
    version?: string;
    transport?: string;
    hasSession?: boolean;
    /** Loopback-only. Diagnostics for the PUSH path — see `evaluatePushPath`. */
    push?: { subscribers?: number; lastEventAt?: number | null; eventCount?: number };
  } | null;
  error?: string;
}

/**
 * Response bodies are capped at 256 KB.
 *
 * This reader was written when `/health` on Tandem's own loopback server was
 * its only target — a small, known, trusted JSON document. The orphaned-Vite
 * check points it at whatever arbitrary process happens to hold :5173, so the
 * body is now untrusted input and an unbounded `body += chunk` is a
 * memory-exhaustion footgun in a diagnostic that is supposed to be the safe
 * thing you run when something is already wrong. (Compare the existing
 * `maxBuffer: 8MB` on the `npm ls` exec.) Every legitimate target is orders of
 * magnitude under the cap; over it, we stop reading and report the status.
 */
const HTTP_MAX_BYTES = 256 * 1024;

function httpGet(url: string, timeoutMs = 3000): Promise<HttpGetResult | null> {
  return new Promise((resolve) => {
    const req = request(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      let bytes = 0;
      let truncated = false;
      res.on("data", (chunk: Buffer | string) => {
        if (truncated) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > HTTP_MAX_BYTES) {
          truncated = true;
          // Stop reading; the status line is all any caller needs at this size.
          res.destroy();
          resolve({ status: res.statusCode, data: null });
          return;
        }
        body += chunk;
      });
      res.on("end", () => {
        if (truncated) return;
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, data: null });
        }
      });
    });
    req.on("error", (err: Error) => resolve({ error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

/**
 * Confirm the listener on `port` is actually a Vite dev server.
 *
 * Keys on the STATUS, not the body. `HttpGetResult.data` is typed for
 * `/health`'s JSON and `httpGet` JSON-parses — but `/@vite/client` serves
 * JavaScript, so `data` is unconditionally null here and testing it would
 * reject every real Vite server. A 200 on Vite's own client-runtime module is
 * the signal; anything else (404 from an unrelated server, a connection error,
 * a timeout) is a no.
 *
 * `/@vite/client` is served under every config we ship: no `base` is set, and
 * both `dev` and `dev:client` are bare `vite`. (`preview` is :4173 — out of
 * scope.) A short timeout because this runs inside the synchronous
 * Copy-Diagnostics path.
 */
async function isViteDevServer(port: number): Promise<boolean> {
  const result = await httpGet(`http://127.0.0.1:${port}/@vite/client`, 2000);
  return result?.status === 200;
}

async function checkHealth(r: Recorder, mcpPort: number, startHint: string): Promise<boolean> {
  const result = await httpGet(`http://127.0.0.1:${mcpPort}/health`);

  if (!result) {
    r.fail(`Server not responding on 127.0.0.1:${mcpPort}`, startHint);
    return false;
  }

  if (result.error) {
    r.fail(`Server not responding on 127.0.0.1:${mcpPort} (${result.error})`, startHint);
    return false;
  }

  if (result.status !== 200) {
    r.fail(`/health returned status ${result.status}`);
    return false;
  }

  const d = result.data;
  if (d) {
    const session = d.hasSession ? "session active" : "no MCP session";
    r.pass(`Server healthy (v${d.version}, ${d.transport}, ${session})`, undefined, {
      version: d.version,
      transport: d.transport,
      hasSession: !!d.hasSession,
    });
    if (!d.hasSession) {
      r.warn("No active MCP session — Claude Code hasn't connected yet");
    }
    recordEvaluation(r, evaluatePushPath(d.push));
  } else {
    r.pass("Server responded on /health (could not parse body)");
  }
  return true;
}

/**
 * What to say when there is no `tandem-channel` entry in a config file.
 *
 * A **pass** since Track E, and that inversion is the point: the shim is
 * opt-in, so absence is the default rather than a defect. It used to warn and
 * offer `tandem setup --apply` as the remedy — which no longer writes the
 * entry, so following it changed nothing and left the reader believing their
 * config was broken. A remedy that cannot work is worse than no remedy.
 *
 * **Returns one string, not a `{message, fix}` pair, and that is load-bearing.**
 * The human renderer prints `fix` only when `status !== "pass"` (see the report
 * loop), so guidance attached to a pass is emitted to `--json` and to nobody
 * else. The first version of this function did exactly that: the inversion from
 * warn to pass silently deleted its own advice from the output a user reads.
 *
 * Kept short for the same reason — this is a pass line among thirty others, so
 * it points at the fuller remedy on the push-path check rather than repeating
 * it. No cross-reference by name, though: `evaluatePushPath` runs only from
 * `checkHealth`, which `runDoctor` reaches only when :3479 is up and answering,
 * and someone debugging a dead push path is often running doctor with Tandem
 * stopped.
 *
 * Pure and exported for the same reason as `evaluatePushPath` and its siblings:
 * the branch is otherwise reachable only by standing up a home directory.
 */
export function evaluateAbsentChannelEntry(label: string): string {
  return (
    `${label} has no tandem-channel entry, which is expected — the channel shim is opt-in. ` +
    "Real-time delivery comes from a self-armed watch (nothing to install, on a Claude Code " +
    "that offers a Monitor tool) or the plugin monitor. Both need that tool; the shim does " +
    "not, so it is the fallback when Claude has none — `tandem setup --apply --with-channel-shim` " +
    "(that flag is the only way to register the shim: there is deliberately no wizard " +
    "checkbox, so it needs the npm package, which the desktop app does not install)"
  );
}

/**
 * Pure decision step for the PUSH path.
 *
 * `hasSession` answers "can Claude call tools" — it says nothing about whether
 * anything the user does reaches Claude, because those are two disjoint
 * connections. Conflating them is exactly how a user ends up staring at
 * "AI connected" while chat messages go nowhere.
 *
 * Deliberately never claims push IS working. `subscribers: 0` is a sound
 * negative; a positive count includes a channel shim whose host never negotiated
 * the channel, which receives every event and discards it. The server cannot tell
 * those apart, so neither can this check.
 *
 * Split out from the recorder call (matching `evaluateNpmStaleness`,
 * `evaluateClaudeCli`, `evaluateOrphanedVite`, `evaluateStaleGlobal`) so the
 * branches are testable without standing up a server.
 */
export function evaluatePushPath(push: unknown): EvalOutcome | null {
  // An older server has no `push` field. Say so rather than emitting nothing —
  // the troubleshooting entry tells the reader to "look for the push line", and
  // silence there reads as a passing check.
  if (!push || typeof push !== "object") {
    return {
      status: "skip",
      message:
        "server did not report push-path status (running a build older than this CLI) — " +
        "restart Tandem to get the newer server",
      data: { reason: "no-push-field" },
    };
  }

  const p = push as { subscribers?: number; lastEventAt?: number | null; eventCount?: number };
  const subscribers = typeof p.subscribers === "number" ? p.subscribers : 0;
  const eventCount = typeof p.eventCount === "number" ? p.eventCount : 0;
  const data = { subscribers, eventCount, lastEventAt: p.lastEventAt ?? null };

  if (subscribers === 0) {
    return {
      status: "warn",
      message:
        "No real-time push consumer attached — Claude is not notified when you comment " +
        "or send a chat message, and only sees them when it polls its inbox",
      fix:
        "This affects sessions you start yourself; sessions Tandem launches are " +
        "woken directly and do not use this path. Simplest first: ask Claude to watch " +
        "for updates — it can arm a watch on Tandem's wake stream itself, with nothing " +
        "to install and no flag (the bundled skill tells it how; `tandem_status` reports " +
        "the address). That one needs a Monitor tool, which not every Claude Code has — it " +
        "is enabled per account rather than per version, so upgrading will not add it, and " +
        "on Windows it also needs Git Bash. If Claude says it has none, the channel shim " +
        "below is the option that always avoids Monitor. The plugin monitor shares that " +
        "per-account feature gate, so it will not help if the gate is off; however, the " +
        "plugin monitor does not require Git Bash on Windows and can fall back to PowerShell, " +
        "so it can help when Git Bash is the missing precondition. You can install the " +
        "Tandem plugin, which registers a monitor " +
        "needing no flag (`claude plugin list` to check) — start `claude` from a terminal " +
        "if you do, since the monitor inherits that shell's PATH and cannot find Node " +
        "without it — or register the channel shim with " +
        "`tandem setup --apply --with-channel-shim` and start Claude Code with " +
        "`--dangerously-load-development-channels server:tandem-channel` (that flag is the " +
        "shim's only opt-in — there is no wizard equivalent — so it needs the npm package, " +
        "which the desktop app does not install). Choose one setup " +
        "route where possible. When the plugin and built-in Monitor are both available, " +
        "invoking Tandem's skill can start both automatically; doubled wakes carry no " +
        "content and the inbox de-duplicates, but they can waste a turn. Ask Claude to stop " +
        "its built-in watch with `TaskStop` if that happens.",
      data,
    };
  }

  // Counters are process-wide, not per consumer, so the wording below must not
  // read as a claim about any individual one. A Solo-mode session also posts no
  // heartbeat for annotation traffic — the Solo filter sits above the heartbeat
  // in sse-consumer.ts — so "none received yet" is expected there until a chat
  // message arrives.
  if (eventCount === 0) {
    return {
      status: "pass",
      message:
        `${subscribers} push consumer(s) attached; no events delivered yet this run ` +
        "(expected if you haven't edited, or if you're in Solo mode; this is a " +
        "process-global count, NOT that this Claude session is covered)",
      data,
    };
  }

  const agoS = p.lastEventAt ? Math.round((Date.now() - p.lastEventAt) / 1000) : null;
  return {
    status: "pass",
    message:
      `${subscribers} push consumer(s) attached; ${eventCount} event(s) delivered this run, ` +
      `most recently ${agoS === null ? "?" : `${agoS}s`} ago ` +
      "(confirms events reach a process-global consumer, NOT that this Claude session is " +
      "covered or saw them)",
    data,
  };
}

// ── Check: SSE event stream ─────────────────────────────────────────

function checkSseEndpoint(r: Recorder, mcpPort: number): Promise<void> {
  return new Promise((resolve) => {
    const req = request(`http://127.0.0.1:${mcpPort}/api/events`, { timeout: 2000 }, (res) => {
      // SSE endpoint responds with 200 and text/event-stream
      req.destroy(); // don't hold the connection open
      const ct = res.headers["content-type"] || "";
      if (res.statusCode === 200 && ct.includes("text/event-stream")) {
        r.pass("SSE event stream reachable (/api/events)");
      } else {
        r.warn(`/api/events responded with status ${res.statusCode}, content-type: ${ct}`);
      }
      resolve();
    });
    req.on("error", (err: Error) => {
      r.warn(`/api/events not reachable: ${err.message}`);
      resolve();
    });
    req.on("timeout", () => {
      req.destroy();
      r.warn("/api/events timed out");
      resolve();
    });
    req.end();
  });
}

// ── Check: annotation store health ──────────────────────────────────

/** Mirror of `env-paths("tandem").data` for the current OS. */
function resolveAppDataDir(): string {
  const override = process.env.TANDEM_APP_DATA_DIR;
  if (override && override.length > 0) return override;

  const home = homedir();
  switch (platform()) {
    case "win32":
      return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "tandem", "Data");
    case "darwin":
      return join(home, "Library", "Application Support", "tandem");
    default:
      return join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "tandem");
  }
}

/** Cross-platform test that a PID currently points at a live process. */
function isPidLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function checkAnnotationStore(r: Recorder): void {
  const dir = join(resolveAppDataDir(), "annotations");
  if (!existsSync(dir)) {
    r.pass(`Annotation store dir not yet created (${dir}) — first open will create it`, undefined, {
      dir,
      docCount: 0,
      totalBytes: 0,
      corruptCount: 0,
      exists: false,
    });
    return;
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    r.fail(`Annotation store dir unreadable: ${errMsg(err)}`, `Check permissions on ${dir}`);
    return;
  }

  const jsonFiles = entries.filter((f) => f.endsWith(".json") && !f.endsWith(".corrupt.json"));
  const corruptFiles = entries.filter((f) => f.includes(".corrupt."));

  let totalBytes = 0;
  let newest: { name: string | null; mtime: number } = { name: null, mtime: 0 };
  let sampleSchemaVersion: number | null = null;

  for (const f of jsonFiles) {
    try {
      const s = statSync(join(dir, f));
      totalBytes += s.size;
      if (s.mtimeMs > newest.mtime) {
        newest = { name: f, mtime: s.mtimeMs };
      }
      if (sampleSchemaVersion === null) {
        try {
          const parsed = JSON.parse(readFileSync(join(dir, f), "utf-8"));
          if (typeof parsed?.schemaVersion === "number") {
            sampleSchemaVersion = parsed.schemaVersion;
          }
        } catch {
          // malformed individual file — counted under corruptFiles check below
        }
      }
    } catch {
      // file vanished between readdir and stat — ignore
    }
  }

  r.pass(
    `Annotation store: ${jsonFiles.length} doc(s), ${formatBytes(totalBytes)} total`,
    undefined,
    {
      dir,
      docCount: jsonFiles.length,
      totalBytes,
      corruptCount: corruptFiles.length,
    },
  );

  if (newest.name) {
    const ageMs = Date.now() - newest.mtime;
    const ageStr =
      ageMs < 60_000 ? `${Math.floor(ageMs / 1000)}s` : `${Math.floor(ageMs / 60_000)}m`;
    r.pass(`Most recent annotation write: ${newest.name} (${ageStr} ago)`, undefined, {
      name: newest.name,
      mtimeMs: newest.mtime,
      ageMs,
    });
  }

  if (sampleSchemaVersion !== null) {
    r.pass(`Annotation schema version: ${sampleSchemaVersion}`, undefined, {
      schemaVersion: sampleSchemaVersion,
    });
  }

  if (corruptFiles.length > 0) {
    r.warn(
      `${corruptFiles.length} quarantined annotation file(s) in ${dir}`,
      "Safe to delete after inspection; kept 7d by design.",
      {
        corruptCount: corruptFiles.length,
        dir,
      },
    );
  }

  // Lock status
  const lockPath = join(dir, "store.lock");
  if (!existsSync(lockPath)) {
    r.pass("Annotation store lock: not held (no running writer)", undefined, { lockHeld: false });
    return;
  }

  try {
    const raw = readFileSync(lockPath, "utf-8").trim();
    // Current locks are v2 JSON (`{pid, startedAtMs, app}`, #1077); older ones
    // are a bare PID. parseLockfile reads both and returns null for true garbage.
    const lock = parseLockfile(raw);
    if (lock === null) {
      r.warn(
        `Annotation store lock at ${lockPath} has unparseable content: "${raw}"`,
        "Restart Tandem or delete the lock file if no server is running.",
        { lockHeld: true, lockPath, lockContent: raw },
      );
      return;
    }
    const { pid } = lock;
    if (isPidLive(pid)) {
      r.pass(`Annotation store lock held by live PID ${pid}`, undefined, {
        lockHeld: true,
        pid,
        pidLive: true,
      });
    } else {
      r.warn(
        `Annotation store lock at ${lockPath} points to dead PID ${pid}`,
        "The next server start will reclaim the stale lock automatically.",
        { lockHeld: true, pid, pidLive: false },
      );
    }
  } catch (err) {
    r.warn(`Could not read annotation store lock: ${errMsg(err)}`);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Pure collector ──────────────────────────────────────────────────

/**
 * Three-tier summary line shared by `runDoctor` and the `/api/diagnostics`
 * route's filtered recomputation — keep wording in one place.
 */
export function summarizeDoctorResults(failures: number, warnings: number): string {
  if (failures > 0) return `${failures} issue(s) found.`;
  if (warnings > 0)
    return `${warnings} warning(s) — Tandem should work, but check the items above.`;
  return "All checks passed. Tandem is ready.";
}

// ── Check: stale global tandem-editor ───────────────────────────────
//
// The `tandem` MCP bridge is launched via `npx -y tandem-editor@<v> mcp-stdio`.
// A globally-installed `tandem-editor` whose version predates the `mcp-stdio`
// subcommand USED to be silently reused by `npx` (the exact "Server disconnected"
// failure). The version pin now bypasses it, but a stale/foreign global can still
// bite a hand-typed `npx tandem-editor` — so surface it. Runs inside the
// synchronous Copy-Diagnostics path, so it MUST be time-bounded and non-fatal:
// npm being absent (bundled-node Tauri sidecar), unreachable, or slow is a SKIP,
// never a fail.

/** Resolve a global `tandem-editor` version, or null when it can't be determined. */
export function globalTandemEditorVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    // shell:true so Windows resolves the `npm.cmd` shim (bare execFile("npm")
    // ENOENTs there). Args are all static — no injection surface.
    execFile(
      "npm",
      ["ls", "-g", "--depth=0", "--json", "tandem-editor"],
      { shell: true, windowsHide: true, timeout: 4000, maxBuffer: 8 * 1024 * 1024 },
      (_err, stdout) => {
        // `npm ls` exits non-zero on unrelated global peer issues but still
        // prints JSON to stdout, so parse stdout regardless of the exit code.
        if (!stdout || stdout.trim().length === 0) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as {
            dependencies?: Record<string, { version?: string }>;
          };
          resolve(parsed.dependencies?.["tandem-editor"]?.version ?? null);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/**
 * Pure decision step, split out of {@link checkStaleGlobal} so the
 * match/mismatch/nothing-to-report logic is directly unit-testable without
 * needing to fake the tsup-injected `__TANDEM_VERSION__` global or mock
 * `child_process` — see tests/cli/doctor.test.ts.
 */
export function evaluateStaleGlobal(
  bundled: string,
  globalVersion: string | null,
): {
  status: "pass" | "warn";
  message: string;
  fix?: string;
  data?: Record<string, unknown>;
} | null {
  if (globalVersion === null) {
    // No global install (the common, healthy case) or npm unavailable. Either
    // way there's nothing that can shadow the pinned npx spec.
    return null;
  }

  if (globalVersion === bundled) {
    return { status: "pass", message: `Global tandem-editor@${globalVersion} matches this build` };
  }

  return {
    status: "warn",
    message:
      `Global tandem-editor@${globalVersion} differs from this build (${bundled}) — ` +
      "a stale global can break `npx tandem-editor`, which the Tandem plugin and Cowork " +
      "still use. (Entries Tandem's own setup writes no longer go through npx.)",
    fix: "npm uninstall -g tandem-editor   (or: npm install -g tandem-editor@latest)",
    data: { globalVersion, bundledVersion: bundled },
  };
}

async function checkStaleGlobal(r: Recorder): Promise<void> {
  const bundled = typeof __TANDEM_VERSION__ !== "undefined" ? __TANDEM_VERSION__ : null;
  // Without a known bundled version (tsx dev / vitest) there's nothing to
  // compare against — skip silently rather than guess.
  if (!bundled) return;

  let globalVersion: string | null;
  try {
    globalVersion = await globalTandemEditorVersion();
  } catch {
    // npm absent / spawn failure / timeout — skip, never fail.
    return;
  }

  const result = evaluateStaleGlobal(bundled, globalVersion);
  if (!result) return;

  if (result.status === "pass") {
    r.pass(result.message);
  } else {
    r.warn(result.message, result.fix, result.data);
  }
}

export interface RunDoctorOptions {
  /** WebSocket (Hocuspocus) port to probe. Defaults to {@link DEFAULT_WS_PORT}. */
  wsPort?: number;
  /** MCP HTTP port to probe. Defaults to {@link DEFAULT_MCP_PORT}. */
  mcpPort?: number;
  /**
   * Vite dev-server port to probe. Defaults to {@link VITE_DEV_PORT}. Same
   * seam as wsPort/mcpPort: lets tests stand up a fake Vite on an ephemeral
   * port instead of contending for the real :5173 (which a running
   * `dev:client` would occupy).
   */
  vitePort?: number;
  /**
   * Home directory for the Claude Desktop config probe. **Test seam only** —
   * production wants the default, and `checkUserMcpConfig` deliberately keeps
   * reading `HOME`/`USERPROFILE` itself.
   *
   * It earns its keep: the defect it was added for was a *wiring* bug (see
   * {@link EntryRemedy.suffix}), and nothing short of driving the real check
   * against a real config file catches that class — a test of the pure composer
   * alone would have passed throughout.
   */
  homeOverride?: string;
}

/**
 * Run every diagnostic check and return a structured report. Performs NO
 * `process.argv` reads and NEVER calls `process.exit`. Safe to call from tests
 * and from both CLI entry points. Embedders that know their live ports (the
 * `/api/diagnostics` route on a `TANDEM_PORT`-overridden server) pass them via
 * `opts` so the self-probe doesn't report "server not running".
 */
export async function runDoctor(opts: RunDoctorOptions = {}): Promise<DoctorReport> {
  const wsPort = opts.wsPort ?? DEFAULT_WS_PORT;
  const mcpPort = opts.mcpPort ?? DEFAULT_MCP_PORT;
  const vitePort = opts.vitePort ?? VITE_DEV_PORT;
  const r = new Recorder();
  // Resolve the dev-repo probe once — every cwd-scoped check shares the answer.
  const cwd = process.cwd();
  const repo = probeTandemEditorRepo(cwd);
  const devRepo = repo === "yes";
  // "Server not running" fixes differ by install kind: a source checkout starts
  // the server with `npm run dev:standalone`; a global/desktop install has no
  // such script — the user launches the app (or `tandem`). Pointing global-install
  // users at `npm run dev:standalone` is a dead end (#new-user-friction audit).
  const startHint = devRepo
    ? "npm run dev:standalone"
    : "Launch the Tandem desktop app, or run `tandem` in a terminal";
  // Resolve once and thread it, the same shape as `startHint` — the remedy
  // strings below must not each re-probe PATH, and `runDoctor` backs
  // `/api/diagnostics` with no caching. Deliberately NOT cwd-derived: a
  // cwd-dependent remedy would belong in `CWD_DEPENDENT_CHECKS` and get stripped
  // out of exactly the field reports it exists to make actionable.
  const cliAvailable = makeCliAvailability();

  await r.check("node-version", () => checkNodeVersion(r));
  await r.check("node-modules", () => checkNodeModules(r, repo, cwd));
  if (repo === "unreadable") {
    // A package.json we cannot read also disables npm-staleness and
    // orphaned-Vite below, and turns the node-modules check above into a skip
    // — so say so instead of staying quiet as if this were simply someone
    // else's directory. This check is in {@link CWD_DEPENDENT_CHECKS}: it is
    // cwd-dependent, so /api/diagnostics strips it from field reports.
    await r.check("dev-repo", () =>
      r.warn(
        "package.json in the current directory could not be read — if this is the " +
          "tandem-editor checkout, the node_modules, npm-staleness and orphaned-Vite checks " +
          "are being skipped",
        "Check for merge-conflict markers or a truncated file: git checkout package.json",
      ),
    );
  }
  if (devRepo) {
    await r.check("npm-staleness", () => checkNpmStaleness(r, cwd));
  }
  // Ahead of every config check, not just the toolchain one. Translocation is a
  // *cause* of the bare-command symptoms, and those are emitted by the three
  // config checks below — so sitting merely above `node-toolchain` still printed
  // the explanation after most of what it explains, which was the one thing the
  // placement was for. Silent (`null`) unless translocated, so the machines that
  // are not affected see no extra line for the earlier position.
  await r.check("app-translocation", () =>
    recordEvaluation(r, evaluateAppTranslocation(process.execPath)),
  );
  await r.check("mcp-json", () => checkMcpJson(r, cwd, cliAvailable));
  await r.check("user-mcp-config", () => checkUserMcpConfig(r, cliAvailable));
  await r.check("desktop-mcp-config", () =>
    checkDesktopMcpConfig(r, cliAvailable, opts.homeOverride),
  );
  await r.check("node-toolchain", () => checkNodeToolchain(r));
  await r.check("claude-cli", () => checkClaudeCli(r));
  await r.check("tandem-plugin", () => checkTandemPlugin(r));
  await r.check("annotation-store", () => checkAnnotationStore(r));
  await r.check("stale-global", () => checkStaleGlobal(r));

  // `check` returns undefined when the check crashed (it records its own
  // fail). Treating both ports as down is the honest reading: we did not
  // observe them up. Do NOT cast this away — see Recorder.check.
  const ports = await r.check("ports", () => checkPorts(r, wsPort, mcpPort, startHint));
  const ws = ports?.ws ?? false;
  const mcp = ports?.mcp ?? false;

  if (devRepo) {
    // Reuses the ws/mcp probe results from the ports check just above —
    // only :5173 gets a fresh probe.
    await r.check("orphaned-vite", () => checkOrphanedVite(r, ws, mcp, wsPort, mcpPort, vitePort));
  }

  if (mcp) {
    // A crashed health check means we never established health — don't run
    // the SSE check on an unverified server.
    const healthy = (await r.check("health", () => checkHealth(r, mcpPort, startHint))) ?? false;
    if (healthy) {
      await r.check("sse", () => checkSseEndpoint(r, mcpPort));
    }
  }

  return {
    ok: r.failures === 0,
    crashed: false,
    failures: r.failures,
    warnings: r.warnings,
    summary: summarizeDoctorResults(r.failures, r.warnings),
    error: null,
    results: r.results,
  };
}

// ── Printer + exit-code wrapper ─────────────────────────────────────

export interface RunDoctorCliOptions {
  json?: boolean;
}

/** ANSI-colored status tag for the human-readable TTY printer. */
function colorTag(status: DoctorStatus): string {
  switch (status) {
    case "pass":
      return "\x1b[32m[PASS]\x1b[0m";
    case "warn":
      return "\x1b[33m[WARN]\x1b[0m";
    case "fail":
      return "\x1b[31m[FAIL]\x1b[0m";
  }
}

/**
 * Format the report and apply the shared exit code (0 pass, 1 failures,
 * 2 crash). In `--json` mode stdout is a SINGLE pure JSON document — human
 * lines are suppressed so the stream is machine-parseable. Both `tandem
 * doctor` and `npm run doctor` route through here.
 *
 * Note: writing JSON to stdout is correct for the CLI. Critical Rule #3
 * ("stdout is reserved") applies to the MCP stdio server, not this command —
 * `src/cli/index.ts` deliberately uses stdout for `--version`/`--help`.
 */
export async function runDoctorCli(opts: RunDoctorCliOptions = {}): Promise<number> {
  const json = opts.json ?? false;

  let report: DoctorReport;
  try {
    report = await runDoctor();
  } catch (err) {
    const message = errMsg(err);
    if (json) {
      const crashed: DoctorReport = {
        ok: false,
        crashed: true,
        failures: 0,
        warnings: 0,
        summary: `Tandem Doctor crashed unexpectedly: ${message}`,
        error: message,
        results: [],
      };
      process.stdout.write(`${JSON.stringify(crashed, null, 2)}\n`);
    } else {
      process.stderr.write(`\n  Tandem Doctor crashed unexpectedly: ${message}\n`);
      process.stderr.write(
        "  Please report this at https://github.com/bloknayrb/tandem/issues\n\n",
      );
    }
    return 2;
  }

  const exitCode = report.failures > 0 ? 1 : 0;

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return exitCode;
  }

  // Human-readable TTY output.
  const out = (line: string) => process.stdout.write(`${line}\n`);
  out("");
  out("  Tandem Doctor");
  out("  =============");
  out("");

  for (const res of report.results) {
    out(`  ${colorTag(res.status)} ${res.message}`);
    if (res.status !== "pass" && res.fix) {
      out(`         Fix: ${res.fix}`);
    }
  }

  out("");
  if (report.failures > 0) {
    out(`  ${report.failures} issue(s) found. Fix the items above and re-run: tandem doctor`);
  } else if (report.warnings > 0) {
    out(`  ${report.warnings} warning(s) — Tandem should work, but check the items above.`);
  } else {
    out("  All checks passed. Tandem is ready.");
  }
  out("");

  return exitCode;
}
