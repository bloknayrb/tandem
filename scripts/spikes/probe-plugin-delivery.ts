#!/usr/bin/env -S npx tsx
/**
 * Plugin-delivery probe — can a new user get real-time push without a
 * developer toolchain, and does the monitor reach the sessions we care about?
 *
 * Motivated by a tester on Claude Code v2.1.223 / Windows whose
 * `claude plugin install` died at "Failed to clone repository: Command 'git'
 * not found or is in an unsafe location". That tester DOES have git — a
 * per-user install on a work laptop without admin rights — which is the more
 * instructive case: the dependency is not merely "git exists" but "git exists
 * AND is on the PATH the CLI actually inherits AND sits somewhere the CLI's
 * safety guard accepts AND can authenticate to GitHub". A locked-down machine
 * can fail any of those four independently, and three of them fail silently
 * until the clone does.
 *
 * The marketplace entry in `.claude-plugin/marketplace.json` declares
 * `{"source":"github","repo":...}`, so installation goes through that clone
 * unconditionally. That is a hard blocker on making the plugin monitor the
 * default push path for hand-launched sessions.
 *
 * Three independent questions, three probes:
 *
 *   P1 (git dependency) — does `claude plugin marketplace add` accept a LOCAL
 *       directory, and does `plugin install` then succeed with git removed from
 *       PATH entirely?  The npm package already ships `.claude-plugin/` (see
 *       package.json `files`), so every machine with `tandem-editor` installed
 *       already has the manifest on disk. If a local source works, setup can
 *       register the plugin with no clone, no marketplace, and no git.
 *       On success P1 also DUMPS the resulting registry files — that schema is
 *       what a direct-write installer would need (cf. `cowork_installer.rs`,
 *       which already does exactly this for Cowork workspaces).
 *
 *   P2 (--plugin-dir activation) — does `experimental.monitors[]` fire when the
 *       plugin is loaded via `--plugin-dir`?  `probe-monitor-viability.ts`
 *       answered NO on v2.1.143, and the spike banner records a reversal on
 *       2.1.212 — but that reversal is documented for the MARKETPLACE path.
 *       Note the old probe tested `--plugin-dir` AND `-p` print mode together,
 *       so its NO-GO never separated the two variables. P2 re-runs that exact
 *       cell on the current CLI; P3 varies the mode.
 *
 *   P3 (headless activation) — does the monitor fire under the launcher's EXACT
 *       spawn flags (`CLAUDE_STREAM_JSON_FLAGS`, imported here so this probe
 *       cannot drift from the shipped launcher)?  If it does, installing the
 *       plugin double-delivers in Tandem-launched sessions, which already get
 *       woken by the supervisor's stdin turn (#1266) — that would make
 *       "monitor by default" a conflict rather than a clean split.
 *
 * CONFOUNDING, stated up front: P3 loads the plugin via `--plugin-dir`, because
 * a marketplace install cannot be set up without answering P1 first. So a
 * negative P3 is only meaningful if P2 is positive. The verdict logic below
 * encodes that rather than letting a confounded null read as a finding.
 *
 * Usage:
 *   npx tsx scripts/spikes/probe-plugin-delivery.ts
 *
 * Env:
 *   TANDEM_CLAUDE_CMD   — path to the `claude` binary (default: `claude`)
 *   TANDEM_PROBE_SKIP   — comma-separated probe ids to skip (e.g. `p2,p3`)
 *
 * Exit codes:
 *   0 — all probes produced a DEFINITIVE observation (yes or no; these are
 *       discovery probes, so "no" is a finding, not a failure).
 *   1 — one or more probes were inconclusive or confounded.
 *   2 — setup error (no usable `claude`, cannot write temp dirs).
 *
 * Safety:
 *   - P1 is the only config-MUTATING probe and it runs against an ISOLATED
 *     HOME/USERPROFILE/CLAUDE_CONFIG_DIR under a temp dir. It never touches the
 *     real Claude Code config. P2/P3 use the real HOME (they need existing auth)
 *     but only pass `--plugin-dir`, which is ephemeral and writes nothing.
 *   - Minimal child env; TANDEM_AUTH_TOKEN is never forwarded.
 *   - Marker scripts self-exit after MARKER_TTL_MS so a monitor the plugin host
 *     forgets to reap cannot outlive the probe.
 *   - HOME and UUIDs are redacted from the JSON report.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  CLAUDE_STREAM_JSON_FLAGS,
  SUPERVISOR_INITIAL_PROMPT,
  serializeUserTurn,
} from "../../src/shared/launcher/contract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

const CLAUDE = process.env.TANDEM_CLAUDE_CMD || "claude";
const SKIP = new Set(
  (process.env.TANDEM_PROBE_SKIP ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

/** How long a spawned marker script stays alive before self-terminating. Bounds
 * the blast radius if the plugin host does not reap its monitors. */
const MARKER_TTL_MS = 60_000;
const P2_DEADLINE_MS = 45_000;
const P3_DEADLINE_MS = 90_000; // a real turn, not just a spawn

const PROBE_ROOT = mkdtempSync(join(tmpdir(), "tandem-plugin-delivery-"));
const ISOLATED_HOME = join(PROBE_ROOT, "home");
const PROBE_CWD = join(PROBE_ROOT, "cwd");
mkdirSync(ISOLATED_HOME, { recursive: true });
mkdirSync(PROBE_CWD, { recursive: true });

// ─── Process hygiene ────────────────────────────────────────────────────────

const liveChildren = new Set<ChildProcess>();
function track<T extends ChildProcess>(c: T): T {
  liveChildren.add(c);
  c.once("exit", () => liveChildren.delete(c));
  return c;
}
function killAll(signal: NodeJS.Signals = "SIGTERM") {
  for (const c of liveChildren) {
    try {
      if (c.pid && !c.killed) process.kill(c.pid, signal);
    } catch {
      /* already dead */
    }
  }
}
function cleanup() {
  try {
    rmSync(PROBE_ROOT, { recursive: true, force: true });
  } catch {
    /* best effort — marker scripts may still hold handles on Windows */
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  killAll("SIGTERM");
  process.exit(130);
});
process.on("SIGTERM", () => {
  killAll("SIGTERM");
  process.exit(143);
});
process.on("uncaughtException", (e) => {
  console.error("[probe] uncaughtException:", e);
  killAll("SIGKILL");
  process.exit(1);
});

// ─── Env construction ───────────────────────────────────────────────────────

function baseEnv(): NodeJS.ProcessEnv {
  const passthrough = [
    "PATH",
    "Path", // Windows casing — process.env is case-insensitive there, but be explicit
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SystemRoot",
    "COMSPEC",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
  ];
  const out: NodeJS.ProcessEnv = {};
  for (const k of passthrough) if (process.env[k] !== undefined) out[k] = process.env[k];
  if (process.env.TANDEM_AUTH_TOKEN !== undefined) {
    console.error("[probe] NOTE: TANDEM_AUTH_TOKEN present in parent env; excluded from children.");
  }
  return out;
}

/**
 * PATH with every directory containing a `git` executable removed.
 *
 * This simulates the tester's machine class without needing his machine. Note
 * it models "git is not visible to this process" — which is the failure the
 * tester actually hit (he HAS git; a per-user install the CLI could not use)
 * as well as the simpler "git is not installed". Both collapse to the same
 * question for P1: can the plugin be registered when the CLI cannot run git?
 */
function pathWithoutGit(): { path: string; removed: string[] } {
  const env = baseEnv();
  const current = env.PATH ?? env.Path ?? "";
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["git"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  // `where` exits non-zero when nothing is found — that is a clean PATH, not an error.
  const gitDirs = new Set(
    (probe.stdout ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((p) => dirname(p).toLowerCase()),
  );
  const kept: string[] = [];
  const removed: string[] = [];
  for (const entry of current.split(delimiter)) {
    if (!entry) continue;
    if (gitDirs.has(entry.replace(/[\\/]+$/, "").toLowerCase())) removed.push(entry);
    else kept.push(entry);
  }
  return { path: kept.join(delimiter), removed };
}

/** Env for the config-mutating probe: isolated home, no git on PATH. */
function isolatedEnv(): { env: NodeJS.ProcessEnv; gitRemoved: string[] } {
  const { path, removed } = pathWithoutGit();
  const env = baseEnv();
  env.PATH = path;
  if (env.Path !== undefined) env.Path = path;
  env.HOME = ISOLATED_HOME;
  env.USERPROFILE = ISOLATED_HOME;
  // Belt-and-braces: if the CLI honors an explicit config dir, this pins it too.
  // Setting an unrecognized variable is inert, so this cannot make things worse.
  env.CLAUDE_CONFIG_DIR = join(ISOLATED_HOME, ".claude");
  return { env, gitRemoved: removed };
}

function redact(s: string): string {
  const home = homedir();
  return s
    .split(home)
    .join("<HOME>")
    .split(PROBE_ROOT)
    .join("<PROBE_ROOT>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{3,4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>");
}

// ─── Stub plugin construction ───────────────────────────────────────────────

interface Stub {
  pluginDir: string;
  markerPath: string;
}

/**
 * A plugin whose only job is to prove its monitor was invoked.
 *
 * The marker command is a node script written to disk rather than an inline
 * `-e` one-liner: the plugin host runs the command through a shell, and on
 * Windows that is cmd.exe, where inline JS quoting is unsurvivable. Paths are
 * forward-slashed (node accepts them on Windows) so no backslash ever reaches
 * the shell. `process.execPath` is used instead of a bare `node` so the command
 * resolves even under P1's stripped PATH.
 */
function makeStub(id: string): Stub {
  const pluginDir = join(PROBE_ROOT, `plugin-${id}`);
  const markerPath = join(pluginDir, "MONITOR_INVOKED.marker");
  const scriptPath = join(pluginDir, "marker.mjs");
  mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });

  writeFileSync(
    scriptPath,
    [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(markerPath)}, 'INVOKED pid=' + process.pid);`,
      "// Stay alive so the host does not treat a fast exit as a crash and respawn-loop,",
      "// but self-terminate so a forgotten monitor cannot outlive the probe.",
      `setTimeout(() => process.exit(0), ${MARKER_TTL_MS});`,
    ].join("\n"),
  );

  const fwd = (p: string) => p.replace(/\\/g, "/");
  writeFileSync(
    join(pluginDir, ".claude-plugin", "plugin.json"),
    JSON.stringify(
      {
        name: `probe-${id}`,
        version: "0.0.1",
        description: "Tandem plugin-delivery probe — writes a marker when its monitor is invoked.",
        author: { name: "Tandem probe" },
        experimental: {
          monitors: [
            {
              name: `probe-${id}-monitor`,
              command: `"${fwd(process.execPath)}" "${fwd(scriptPath)}"`,
              description: "Writes a marker file on invoke",
            },
          ],
        },
      },
      null,
      2,
    ),
  );
  return { pluginDir, markerPath };
}

/** Poll for the marker rather than sleeping once — the host may spawn monitors
 * lazily, and a single sleep would turn "slow" into a false negative. */
async function waitForMarker(markerPath: string, deadlineMs: number): Promise<string | null> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try {
      return readFileSync(markerPath, "utf8").trim();
    } catch {
      await delay(250);
    }
  }
  return null;
}

// ─── Result shape ───────────────────────────────────────────────────────────

type Conclusion = "yes" | "no" | "inconclusive";

interface ProbeResult {
  id: string;
  question: string;
  conclusion: Conclusion;
  /** Why this conclusion is trustworthy — or why it is not. */
  reasoning: string;
  evidence: Record<string, unknown>;
}

// ─── P1: does a local marketplace source work, with git absent? ─────────────

interface SourceCandidate {
  label: string;
  /** Install target name — must match the plugin's own `name`, not ours. */
  pluginName: string;
  /** Lay out any files the source needs under `marketDir`; return the
   * `plugins[].source` value to declare. */
  prepare: (marketDir: string, stub: Stub) => unknown;
}

/**
 * Candidate `plugins[].source` forms.
 *
 * These are no longer guesses. `claude.exe` (v2.1.223) contains the dispatch:
 *
 *   if (typeof e === "string") <local path>
 *   else switch (e.source) { case "npm": … case "github": … case "url": …
 *                            case "git-subdir": … default: throw }
 *
 * So the supported set is exactly: a bare string (treated as a local path, and
 * resolved against a `containmentRoot`), plus the four tagged objects. Every
 * form except `npm` and the bare string goes through a git clone.
 *
 * `npm` is the interesting one and it is listed FIRST because it is the
 * production candidate: Tandem already publishes `tandem-editor` to npm with
 * `.claude-plugin/` in its `files` list, and the plugin's own MCP entries
 * already shell out to `npx -y tandem-editor@<version>`. If npm-sourcing works,
 * flipping `marketplace.json` from `github` to `npm` removes git from the
 * install path entirely — for every user, not just the ones who hit the
 * cwd-containment guard.
 */
function sourceCandidates(): SourceCandidate[] {
  const pkgVersion = JSON.parse(
    readFileSync(join(REPO_ROOT, ".claude-plugin", "plugin.json"), "utf8"),
  ).version as string;

  return [
    {
      // THE minimal change: Tandem's package root already IS a plugin root
      // (`.claude-plugin/plugin.json`) and already carries `marketplace.json`
      // beside it. If a self-referential `"./"` source works, the entire fix is
      // one field in marketplace.json plus a `marketplace add <installed-pkg>`
      // at setup time — no new layout, no clone, no external tool.
      label: "self-referential-root",
      pluginName: "probe-p1",
      prepare: (marketDir, stub) => {
        cpSync(stub.pluginDir, marketDir, { recursive: true });
        return "./";
      },
    },
    {
      // Real package, real version. Listed for its DIAGNOSTIC value: the npm
      // branch shells out to `npm`, which carries the same "not found or is in
      // an unsafe location" guard that blocked the tester's `git`. On Windows
      // npm commonly lives under %APPDATA%\npm — inside the user's home — so
      // npm-sourcing does not escape the guard class, it only renames it.
      label: "npm-published-package",
      pluginName: "tandem",
      prepare: () => ({ source: "npm", package: "tandem-editor", version: pkgVersion }),
    },
    {
      // The monorepo layout the `--sparse .claude-plugin plugins` help text
      // implies: plugin nested inside the marketplace, referenced relatively.
      // A relative path is what `containmentRoot` exists to constrain.
      label: "relative-string-nested",
      pluginName: "probe-p1",
      prepare: (marketDir, stub) => {
        const nested = join(marketDir, "plugins", "probe-p1");
        mkdirSync(dirname(nested), { recursive: true });
        cpSync(stub.pluginDir, nested, { recursive: true });
        return "./plugins/probe-p1";
      },
    },
    {
      // Absolute path outside the marketplace — expected to fail containment.
      // Kept so the report distinguishes "strings unsupported" from
      // "this string was out of bounds".
      label: "absolute-string-outside",
      pluginName: "probe-p1",
      prepare: (_marketDir, stub) => stub.pluginDir.replace(/\\/g, "/"),
    },
    {
      // Confirmed-invalid by the dispatch above; retained as a negative control
      // so a future CLI that DOES accept it shows up as a change.
      label: "object-local-path",
      pluginName: "probe-p1",
      prepare: (_marketDir, stub) => ({
        source: "local",
        path: stub.pluginDir.replace(/\\/g, "/"),
      }),
    },
  ];
}

async function probeLocalMarketplace(): Promise<ProbeResult> {
  const stub = makeStub("p1");
  const { env, gitRemoved } = isolatedEnv();
  const attempts: Array<Record<string, unknown>> = [];
  let accepted: string | null = null;

  // Capture the CLI's own help text — it is the cheapest authority on which
  // source forms exist, and costs one spawn.
  const help = spawnSync(CLAUDE, ["plugin", "marketplace", "add", "--help"], {
    encoding: "utf8",
    env,
    cwd: PROBE_CWD,
    timeout: 15_000,
  });

  for (const candidate of sourceCandidates()) {
    const marketDir = join(PROBE_ROOT, `market-${candidate.label}`);
    mkdirSync(join(marketDir, ".claude-plugin"), { recursive: true });
    const source = candidate.prepare(marketDir, stub);
    writeFileSync(
      join(marketDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify(
        {
          name: "probe-marketplace",
          owner: { name: "Tandem probe" },
          metadata: { description: "Local-source probe marketplace" },
          plugins: [
            {
              name: candidate.pluginName,
              source,
              description: "Plugin registered without a git clone",
            },
          ],
        },
        null,
        2,
      ),
    );

    const add = spawnSync(CLAUDE, ["plugin", "marketplace", "add", marketDir], {
      encoding: "utf8",
      env,
      cwd: PROBE_CWD,
      timeout: 30_000,
    });
    const install =
      add.status === 0
        ? spawnSync(CLAUDE, ["plugin", "install", `${candidate.pluginName}@probe-marketplace`], {
            encoding: "utf8",
            env,
            cwd: PROBE_CWD,
            timeout: 120_000, // an npm source has to download a real package
          })
        : null;

    const combined = `${add.stderr ?? ""}${add.stdout ?? ""}${install?.stderr ?? ""}${install?.stdout ?? ""}`;
    attempts.push({
      form: candidate.label,
      addStatus: add.status,
      addStderr: (add.stderr ?? "").slice(0, 400),
      installStatus: install?.status ?? null,
      installStderr: (install?.stderr ?? "").slice(0, 400),
      mentionsGit: /\bgit\b/i.test(combined),
    });

    if (add.status === 0 && install?.status === 0) {
      accepted = candidate.label;
      break;
    }
    // Reset between candidates so a stale registration cannot mask the next form.
    spawnSync(CLAUDE, ["plugin", "marketplace", "remove", "probe-marketplace"], {
      encoding: "utf8",
      env,
      cwd: PROBE_CWD,
      timeout: 15_000,
    });
  }

  // On success, the registry files ARE the deliverable: they are the schema a
  // direct-write installer would have to produce (cf. cowork_installer.rs).
  const registryDump: Record<string, string> = {};
  if (accepted) {
    for (const dir of [join(ISOLATED_HOME, ".claude"), ISOLATED_HOME]) {
      if (!existsSync(dir)) continue;
      let entries: string[] = [];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith(".json")) continue;
        try {
          const body = readFileSync(join(dir, name), "utf8");
          if (body.includes("probe-marketplace") || body.includes("probe-p1")) {
            registryDump[join(dir, name)] = body.slice(0, 4_000);
          }
        } catch {
          /* unreadable — skip */
        }
      }
    }
  }

  const isolationSuspect = attempts.every(
    (a) => typeof a.addStderr === "string" && /auth|login|credential|api key/i.test(a.addStderr),
  );

  return {
    id: "p1",
    question: "Can a plugin be installed with no usable git — which source forms work?",
    conclusion: accepted ? "yes" : isolationSuspect ? "inconclusive" : "no",
    reasoning: accepted
      ? `Accepted source form: ${accepted}. Installed with ${gitRemoved.length} git director${gitRemoved.length === 1 ? "y" : "ies"} stripped from PATH, so neither a missing git nor the cwd-containment guard can block it. ${accepted === "npm-published-package" ? "This is the production candidate: flipping marketplace.json's plugin source from `github` to `npm` removes git from the install path for every user." : "Registry files dumped below are the schema a direct-write installer would emit."}`
      : isolationSuspect
        ? "Every attempt failed with what looks like an auth/credential error. That is the isolated HOME talking, not the source form — re-run against the real config to separate them."
        : "No git-free source form was accepted; the clone remains mandatory. Check each attempt's stderr — a containment rejection reads differently from an unsupported source type, and only the latter closes this door.",
    evidence: {
      helpTextSnippet: (help.stdout ?? help.stderr ?? "").slice(0, 1_200),
      gitDirsRemovedFromPath: gitRemoved.length,
      // The list, not just the count: a candidate that shells out to another
      // tool (npm) can fail for want of a directory this stripping removed, and
      // without the list that is indistinguishable from a real rejection.
      gitDirsRemoved: gitRemoved,
      isolatedHome: "<PROBE_ROOT>/home",
      attempts,
      registryFiles: registryDump,
    },
  };
}

// ─── Shared monitor-activation runner for P2/P3 ─────────────────────────────

interface ActivationRun {
  markerContent: string | null;
  sessionRan: boolean;
  exitCode: number | null;
  stdoutSnippet: string;
  stderrSnippet: string;
}

/**
 * Spawn `claude` with the stub plugin loaded and watch for the marker.
 *
 * `sessionRan` is the load-bearing part: without it a missing marker is
 * ambiguous between "monitors do not fire here" and "the session never
 * started" (bad auth, bad flags, rate limit). Only a run that demonstrably
 * completed a turn can support a negative conclusion.
 */
async function runActivation(
  stub: Stub,
  args: string[],
  opts: { stdinTurn?: string; deadlineMs: number },
): Promise<ActivationRun> {
  const child = track(
    spawn(CLAUDE, args, {
      cwd: PROBE_CWD,
      env: baseEnv(), // real HOME — these probes need existing auth and mutate nothing
      stdio: "pipe",
    }),
  );

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (b) => {
    stdout += b.toString("utf8");
  });
  child.stderr?.on("data", (b) => {
    stderr += b.toString("utf8");
  });
  child.stdin?.on("error", () => {
    /* child may exit before we finish writing */
  });

  if (opts.stdinTurn !== undefined) {
    // Written immediately on spawn, not after an `init` line: under the
    // stream-json flags the CLI emits nothing until it receives a turn, so
    // waiting for a handshake deadlocks (measured in #1266).
    child.stdin?.write(opts.stdinTurn);
  }

  const markerPromise = waitForMarker(stub.markerPath, opts.deadlineMs);
  const exitPromise = new Promise<number | null>((res) => {
    const t = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* dead */
      }
      res(null);
    }, opts.deadlineMs);
    child.once("exit", (code) => {
      clearTimeout(t);
      res(code);
    });
  });

  const [markerContent, exitCode] = await Promise.all([markerPromise, exitPromise]);
  try {
    child.stdin?.end();
  } catch {
    /* already closed */
  }

  // A `result` envelope (stream-json) or parseable JSON with a session id
  // (print mode) both prove the CLI got far enough to run a turn.
  const sessionRan = /"type"\s*:\s*"result"/.test(stdout) || /"session_id"/.test(stdout);

  return {
    markerContent,
    sessionRan,
    exitCode,
    stdoutSnippet: stdout.slice(0, 600),
    stderrSnippet: stderr.slice(0, 600),
  };
}

// ─── P2: --plugin-dir + print mode ──────────────────────────────────────────

async function probePluginDirActivation(): Promise<ProbeResult> {
  const stub = makeStub("p2");
  const run = await runActivation(
    stub,
    [
      "-p",
      "Reply with READY and only that.",
      "--plugin-dir",
      stub.pluginDir,
      "--system-prompt",
      "You are a CLI test harness. Reply only with the literal text READY.",
      "--output-format",
      "json",
    ],
    { deadlineMs: P2_DEADLINE_MS },
  );

  const fired = run.markerContent !== null;
  return {
    id: "p2",
    question: "Does `--plugin-dir` activate experimental.monitors[] on this CLI version?",
    conclusion: fired ? "yes" : run.sessionRan ? "no" : "inconclusive",
    reasoning: fired
      ? "The monitor ran. `--plugin-dir` is a viable no-git load path — though it is still a launch flag, so it does not by itself solve the hand-launched session."
      : run.sessionRan
        ? "The session completed a turn and no monitor fired. This matches probe-monitor-viability.ts's v2.1.143 NO-GO. Note this cell holds print mode fixed — see P3 before concluding anything about mode."
        : "The session never demonstrably ran a turn, so a missing marker proves nothing. Check auth and the stderr snippet.",
    evidence: { ...run, markerFired: fired },
  };
}

// ─── P3: launcher's exact headless flags ────────────────────────────────────

async function probeHeadlessActivation(): Promise<ProbeResult> {
  const stub = makeStub("p3");
  const run = await runActivation(
    stub,
    [...CLAUDE_STREAM_JSON_FLAGS, "--plugin-dir", stub.pluginDir],
    {
      // The CLI emits nothing until it receives a turn under these flags.
      stdinTurn: serializeUserTurn(SUPERVISOR_INITIAL_PROMPT),
      deadlineMs: P3_DEADLINE_MS,
    },
  );

  const fired = run.markerContent !== null;
  return {
    id: "p3",
    question:
      "Does the monitor fire under the launcher's exact spawn flags (headless stream-json)?",
    conclusion: fired ? "yes" : run.sessionRan ? "no" : "inconclusive",
    reasoning: fired
      ? "The monitor fires in a launcher-shaped session. Installing the plugin would double-deliver alongside the supervisor's stdin wake (#1266) — 'monitor by default' is a conflict, not a clean split, and the channel flag in CLAUDE_STREAM_JSON_FLAGS needs revisiting at the same time."
      : run.sessionRan
        ? "A turn completed and no monitor fired. Monitors appear inert in headless sessions, so the monitor and the supervisor wake occupy disjoint halves — but this is only meaningful if P2 came back 'yes' (see confounding note)."
        : "The session never demonstrably ran a turn, so a missing marker proves nothing.",
    evidence: {
      ...run,
      markerFired: fired,
      flagsUsed: [...CLAUDE_STREAM_JSON_FLAGS],
      note: "Flags imported from src/shared/launcher/contract.ts — this probe cannot drift from the shipped launcher.",
    },
  };
}

// ─── P4: a REAL installed plugin, both session modes ────────────────────────

/**
 * The de-confounding probe. P2/P3 both load via `--plugin-dir`; if that load
 * path is itself inert (P2 says it is), their nulls prove nothing about session
 * mode. P4 installs the plugin the way a user would — through a marketplace —
 * and then varies ONLY the session mode.
 *
 * `--scope local` is what makes this safe to run against the real config: the
 * registration lands in `<cwd>/.claude/settings.local.json` inside a temp dir
 * that is deleted on exit, so no other session on this machine can see the probe
 * plugin. The real HOME is kept because these runs need existing auth — which is
 * exactly the combination an isolated HOME could not give us.
 *
 * P1 is what makes this possible at all: without a git-free local source there
 * would be no way to install a throwaway plugin on a machine whose git the CLI
 * might refuse.
 */
async function probeInstalledMonitor(): Promise<ProbeResult> {
  const stub = makeStub("p4");
  const marketDir = join(PROBE_ROOT, "market-p4");
  // Self-referential layout — the form P1 proved installs with no external tool.
  cpSync(stub.pluginDir, marketDir, { recursive: true });
  writeFileSync(
    join(marketDir, ".claude-plugin", "marketplace.json"),
    JSON.stringify(
      {
        name: "probe-marketplace",
        owner: { name: "Tandem probe" },
        metadata: { description: "P4 monitor-activation marketplace" },
        plugins: [{ name: "probe-p4", source: "./", description: "Monitor activation probe" }],
      },
      null,
      2,
    ),
  );

  const env = baseEnv(); // real HOME — auth required
  const scoped = ["--scope", "local"];
  const add = spawnSync(CLAUDE, ["plugin", "marketplace", "add", marketDir, ...scoped], {
    encoding: "utf8",
    env,
    cwd: PROBE_CWD,
    timeout: 60_000,
  });
  const install =
    add.status === 0
      ? spawnSync(CLAUDE, ["plugin", "install", "probe-p4@probe-marketplace", ...scoped], {
          encoding: "utf8",
          env,
          cwd: PROBE_CWD,
          timeout: 120_000,
        })
      : null;

  if (add.status !== 0 || install?.status !== 0) {
    return {
      id: "p4",
      question: "With the plugin genuinely INSTALLED, does its monitor fire — and in which modes?",
      conclusion: "inconclusive",
      reasoning:
        "Could not install the probe plugin at local scope, so neither mode was exercised. Without an installed plugin this probe cannot distinguish load path from session mode.",
      evidence: {
        addStatus: add.status,
        addStderr: (add.stderr ?? "").slice(0, 400),
        installStatus: install?.status ?? null,
        installStderr: (install?.stderr ?? "").slice(0, 400),
      },
    };
  }

  // Mode A — print mode, same shape as P2 but with a real install.
  const printRun = await runActivation(
    stub,
    [
      "-p",
      "Reply with READY and only that.",
      "--system-prompt",
      "You are a CLI test harness. Reply only with the literal text READY.",
      "--output-format",
      "json",
    ],
    { deadlineMs: P2_DEADLINE_MS },
  );

  // Reset before mode B, or A's marker would be read as B's.
  rmSync(stub.markerPath, { force: true });

  // Mode B — the launcher's exact flags.
  const headlessRun = await runActivation(stub, [...CLAUDE_STREAM_JSON_FLAGS], {
    stdinTurn: serializeUserTurn(SUPERVISOR_INITIAL_PROMPT),
    deadlineMs: P3_DEADLINE_MS,
  });

  // Best-effort cleanup: the local-scope registration dies with the temp dir,
  // but the plugin CONTENT is cached under the real ~/.claude/plugins.
  spawnSync(CLAUDE, ["plugin", "uninstall", "probe-p4@probe-marketplace", ...scoped], {
    encoding: "utf8",
    env,
    cwd: PROBE_CWD,
    timeout: 60_000,
  });
  spawnSync(CLAUDE, ["plugin", "marketplace", "remove", "probe-marketplace", ...scoped], {
    encoding: "utf8",
    env,
    cwd: PROBE_CWD,
    timeout: 60_000,
  });

  const printFired = printRun.markerContent !== null;
  const headlessFired = headlessRun.markerContent !== null;
  const bothRan = printRun.sessionRan && headlessRun.sessionRan;

  return {
    id: "p4",
    question: "With the plugin genuinely INSTALLED, does its monitor fire — and in which modes?",
    conclusion: printFired || headlessFired ? "yes" : bothRan ? "no" : "inconclusive",
    reasoning: !bothRan
      ? "At least one mode never demonstrably completed a turn, so its null is not evidence."
      : printFired && headlessFired
        ? "Monitors fire in BOTH modes. Installing the plugin double-delivers in Tandem-launched sessions alongside the supervisor's stdin wake (#1266); monitor-by-default is a conflict that must also resolve the supervisor and the channel flag."
        : printFired && !headlessFired
          ? "Monitors fire when installed but stay inert under the launcher's headless flags. Clean split: the monitor covers hand-launched sessions, the supervisor covers Tandem-launched ones, no double delivery. Combined with P2's negative, the discriminator is the LOAD PATH (installed vs --plugin-dir), not the session mode."
          : !printFired && headlessFired
            ? "Unexpected inversion — fires headless but not in print mode. Re-run before acting on it."
            : "Installed and still inert in both automated modes. Neither mode here is a TTY-attached interactive session, which is the one shape this harness cannot produce and the one the 2.1.212 reversal was reported against — so this does NOT refute monitor viability for a hand-launched session. It bounds it: whatever activates monitors requires something neither print nor headless stream-json provides.",
    evidence: {
      installedViaMarketplace: true,
      printMode: { ...printRun, markerFired: printFired },
      headlessMode: { ...headlessRun, markerFired: headlessFired },
      cannotTest: "TTY-attached interactive session — needs a human or a pty harness.",
    },
  };
}

// ─── Driver ─────────────────────────────────────────────────────────────────

function buildVerdict(results: ProbeResult[]): string {
  const by = (id: string) => results.find((r) => r.id === id);
  const p1 = by("p1");
  const p2 = by("p2");
  const p3 = by("p3");
  const lines: string[] = [];

  // A probe that did not RUN has no verdict line. Reporting a skipped P1 as
  // "inconclusive" would read as a finding about git rather than about the
  // invocation, which is exactly the kind of false negative this script exists
  // to avoid making elsewhere.
  if (!p1) {
    lines.push("P1 not run (skipped) — no conclusion drawn about the git dependency.");
  } else if (p1.conclusion === "yes") {
    lines.push(
      "P1 YES — a local marketplace source installs without git. Setup can register the plugin against the shipped `.claude-plugin/` directory, removing the git dependency AND the manual step in one move. The dumped registry schema is the input to that work.",
    );
  } else if (p1?.conclusion === "no") {
    lines.push(
      "P1 NO — plugin installation requires a git clone. Monitor-by-default is not reachable for users without a developer toolchain; either the delivery mechanism changes or push stays opt-in for that population.",
    );
  } else {
    lines.push("P1 INCONCLUSIVE — re-run before drawing any conclusion about the git dependency.");
  }

  const p4 = by("p4");
  if (p4) {
    // P4 supersedes P2/P3 on the activation question: it is the only cell that
    // installs the plugin the way a user does, so it is the only one whose null
    // is about session mode rather than load path.
    lines.push(`P4 (authoritative on activation) — ${p4.reasoning}`);
    if (p2?.conclusion === "no" && p4.conclusion === "yes") {
      lines.push(
        "P2 NO + P4 YES — `--plugin-dir` does not activate monitors but a marketplace install does. The 2.1.212 reversal applies to the INSTALL path only; setup.ts's `--plugin-dir` dev hint must not be presented as a way to get push.",
      );
    }
  }

  // The confounding rule, applied rather than merely documented.
  if (!p4 && p3?.conclusion === "no" && p2?.conclusion !== "yes") {
    lines.push(
      "P3 is CONFOUNDED: it loads the plugin via --plugin-dir, and P2 did not establish that --plugin-dir activates monitors at all. A null here is indistinguishable from 'the plugin never loaded'. Re-run P3 against a marketplace-installed plugin once P1 provides a no-git way to set one up.",
    );
  } else if (p3?.conclusion === "yes") {
    lines.push(
      "P3 YES — monitor and supervisor would both fire in Tandem-launched sessions. Any monitor-by-default plan must also decide what happens to the supervisor wake and to the channel flag in CLAUDE_STREAM_JSON_FLAGS.",
    );
  } else if (p3?.conclusion === "no" && p2?.conclusion === "yes") {
    lines.push(
      "P3 NO with P2 YES — monitors load under --plugin-dir but stay inert headless. Clean split: the monitor covers hand-launched sessions, the supervisor covers Tandem-launched ones, no double delivery.",
    );
  }

  return lines.join("\n\n");
}

async function main() {
  const v = spawnSync(CLAUDE, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (v.status !== 0) {
    console.error(
      `[probe] FATAL: cannot run \`${CLAUDE} --version\`. Set TANDEM_CLAUDE_CMD if it lives elsewhere.`,
    );
    process.exit(2);
  }
  const version = (v.stdout ?? "").trim();
  console.error(`[probe] Claude Code: ${version}`);
  console.error(`[probe] Repo:        ${REPO_ROOT}`);
  console.error(`[probe] Sandbox:     ${PROBE_ROOT}`);

  const results: ProbeResult[] = [];
  const plan: Array<[string, () => Promise<ProbeResult>]> = [
    ["p1", probeLocalMarketplace],
    ["p2", probePluginDirActivation],
    ["p3", probeHeadlessActivation],
    ["p4", probeInstalledMonitor],
  ];

  for (const [id, fn] of plan) {
    if (SKIP.has(id)) {
      console.error(`[probe] SKIP  ${id}`);
      continue;
    }
    console.error(`[probe] running ${id}...`);
    const r = await fn();
    results.push(r);
    console.error(`[probe] ${r.conclusion.toUpperCase().padEnd(12)} ${id}  ${r.question}`);
  }

  const verdict = buildVerdict(results);

  console.log("\n========== PLUGIN-DELIVERY PROBE (JSON, redacted) ==========");
  console.log(
    redact(
      JSON.stringify(
        {
          claudeVersion: version,
          platform: `${process.platform}/${process.arch}`,
          timestamp: new Date().toISOString(),
          results,
          verdict,
        },
        null,
        2,
      ),
    ),
  );
  console.log("\n========== VERDICT ==========");
  console.log(redact(verdict));

  killAll("SIGTERM");
  await delay(1_000);
  killAll("SIGKILL");

  process.exit(results.some((r) => r.conclusion === "inconclusive") ? 1 : 0);
}

main().catch((e) => {
  console.error("[probe] FATAL:", e);
  killAll("SIGKILL");
  process.exit(1);
});
