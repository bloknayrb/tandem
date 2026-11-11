#!/usr/bin/env node
/**
 * Is the BUILT server bundle ownership-on or ownership-off? (#2358, ADR-054)
 *
 * Ownership ships dark behind the `__OWNERSHIP_ENABLED__` define. Every source-
 * level pin (the literal, the tsup block, the identifier `ownership-flag.ts`
 * reads) can be green while the artifact is wrong — a misspelled identifier or a
 * dropped define leaves the bundle falling back to the `TANDEM_OWNERSHIP` env
 * var, which is exactly the half-on build a shell export must never produce.
 * So this boots `dist/server/index.js` and asks it twice.
 *
 * First through a log line (PR 1a): with ownership on, the server's log lines
 * print a session id as `#` plus 8 hex characters of its SHA-256; with it off,
 * they print the id.
 *
 * Then through enforcement itself (PR 1c, ownership design §12: "a second,
 * runtime anchor starts the built server and asserts it refuses a non-owner
 * write"). Two sessions connect; the first opens a scratchpad and appends to
 * it, which must succeed either way; the second appends to the same document.
 * With ownership on that write must be refused `NOT_DOC_OWNER` / `held`; with
 * it off it must succeed. Requiring the owner's own write keeps a bundle that
 * refuses everything from passing as "on".
 *
 *   --expect on   the child gets NO `TANDEM_OWNERSHIP`, so only the define can
 *                 turn it on (the `ownership-flag-on` job, after
 *                 scripts/ci/build-ownership-on.ts);
 *   --expect off  the child gets `TANDEM_OWNERSHIP=1`, so a bundle that fell
 *                 back to the env var would turn on and fail (`check`, after the
 *                 normal build: a release ignores the variable).
 *
 * The child's environment is built here from scratch (`serverEnvFor`), never
 * inherited: a home, app-data and config directories inside one temp dir, so a
 * boot cannot touch the runner's — or a developer's — real Claude config,
 * skills, sessions or store; two free ports that are never the product's or a
 * test harness's (the server kills whatever holds its ports); no launcher, no
 * sample document, no wizard. Only its own child is ever killed.
 *
 * Exit 0 = the expectation holds; 1 = it does not; 3 = could not evaluate (no
 * bundle, never healthy, no session line). Two test seams, never used by a
 * workflow step (the wiring test pins every step's `run`):
 *  - `--entry=<file>` boots that script instead of the bundle, so the whole boot
 *    path — the environment it builds, the ids it reads back — runs against
 *    fixture servers in tests/scripts/fixtures/;
 *  - `--stderr-file=<path> --ids=<a>,<b>` skips the boot and judges a captured
 *    log, so the verdict-to-exit mapping is tested by spawning this script.
 *
 * Residual: the server kills whatever holds its two ports at boot, so a port
 * taken by something else between this picking it and the server binding it
 * would be killed. Negligible on a CI runner; on a developer machine the
 * window is milliseconds and the ports are random high ones.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXIT_OK = 0;
export const EXIT_MISMATCH = 1;
export const EXIT_CANNOT_EVALUATE = 3;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER_ENTRY = path.join(REPO_ROOT, "dist/server/index.js");

/** Both ids this probe reads back are random UUIDs; anything else is a broken read, not a verdict. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The 8-hex hash `src/server/sessions/log-id.ts` prints for an id while ownership is on. */
export function hashForLog(id) {
  return `#${createHash("sha256").update(String(id).toLowerCase()).digest("hex").slice(0, 8)}`;
}

/**
 * The one line this reads: "MCP session established: <mcp id> (claude session
 * <claude id>)". Matched loosely after the colon so a reworded tail does not
 * read as "off".
 */
const ESTABLISHED = /MCP session established: /;

/**
 * Judge a captured server log. Pure. Keys on OUR two ids only — the
 * `Mcp-Session-Id` the server minted and the Claude session id this probe sent —
 * never on "some hash appears somewhere".
 *
 * @param {string} stderrText
 * @param {string[]} ids
 * @param {"on" | "off"} expect
 * @returns {{ code: 0 | 1 | 3, reason: string }}
 */
export function judgeProbe(stderrText, ids, expect) {
  const lines = String(stderrText)
    .split(/\r?\n/)
    .filter((l) => ESTABLISHED.test(l));
  if (lines.length === 0) {
    return { code: EXIT_CANNOT_EVALUATE, reason: "no 'MCP session established' line" };
  }
  // An empty id would read as "printed raw" (every string includes ""), so an
  // id that is not exactly a lowercase UUID cannot be judged at all.
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => !UUID.test(String(id)))) {
    return { code: EXIT_CANNOT_EVALUATE, reason: "the ids to look for are not lowercase UUIDs" };
  }
  const text = lines.join("\n");
  const raw = ids.filter((id) => text.includes(id));
  const hashed = ids.filter((id) => text.includes(hashForLog(id)));
  // How many of our ids each expectation wants printed raw, and hashed.
  const want = { on: [0, ids.length], off: [ids.length, 0] }[expect];
  if (want === undefined) {
    return { code: EXIT_CANNOT_EVALUATE, reason: `unknown expectation ${JSON.stringify(expect)}` };
  }
  if (raw.length === want[0] && hashed.length === want[1]) {
    return {
      code: EXIT_OK,
      reason: `ownership is ${expect.toUpperCase()}: ${raw.length} id(s) raw, ${hashed.length} hashed`,
    };
  }
  return {
    code: EXIT_MISMATCH,
    reason: `expected ownership ${expect.toUpperCase()}: ${raw.length}/${ids.length} id(s) printed raw, ${hashed.length}/${ids.length} hashed`,
  };
}

/**
 * Judge the two writes. Pure.
 *
 * @param {unknown} ownWrite    the envelope the document's opener got for its own append
 * @param {unknown} otherWrite  the envelope a second session got for its append
 * @param {"on" | "off"} expect
 * @returns {{ code: 0 | 1 | 3, reason: string }}
 */
export function judgeRefusal(ownWrite, otherWrite, expect) {
  const isEnvelope = (e) => e !== null && typeof e === "object" && typeof e.error === "boolean";
  if (!isEnvelope(ownWrite) || !isEnvelope(otherWrite)) {
    return { code: EXIT_CANNOT_EVALUATE, reason: "a write returned no tool envelope" };
  }
  if (expect !== "on" && expect !== "off") {
    return { code: EXIT_CANNOT_EVALUATE, reason: `unknown expectation ${JSON.stringify(expect)}` };
  }
  // Whatever the flag, the session that opened the document may write to it.
  // Anything else is not a verdict about the flag at all.
  if (ownWrite.error !== false) {
    return {
      code: EXIT_CANNOT_EVALUATE,
      reason: `the document's own opener could not write to it (${String(ownWrite.code)})`,
    };
  }
  const refused =
    otherWrite.error === true &&
    otherWrite.code === "NOT_DOC_OWNER" &&
    otherWrite.details?.reason === "held";
  const accepted = otherWrite.error === false;
  if (!refused && !accepted) {
    return {
      code: EXIT_CANNOT_EVALUATE,
      reason: `the second session's write was neither accepted nor refused NOT_DOC_OWNER/held (${String(otherWrite.code)})`,
    };
  }
  if (refused === (expect === "on")) {
    return {
      code: EXIT_OK,
      reason: `ownership is ${expect.toUpperCase()}: a non-owner's write was ${refused ? "refused NOT_DOC_OWNER" : "accepted"}`,
    };
  }
  return {
    code: EXIT_MISMATCH,
    reason: `expected ownership ${expect.toUpperCase()}: a non-owner's write was ${refused ? "refused NOT_DOC_OWNER" : "accepted"}`,
  };
}

/** The JSON-RPC message in a Streamable HTTP response body (plain JSON, or one SSE `data:` line). */
export function rpcMessage(bodyText) {
  const text = String(bodyText).trim();
  const candidates = text.startsWith("{")
    ? [text]
    : text
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // not this line
    }
  }
  return undefined;
}

/** The tool envelope (`{ error, code?, data?, details? }`) inside a `tools/call` response body. */
export function toolEnvelope(bodyText) {
  const text = rpcMessage(bodyText)?.result?.content?.find?.((c) => c?.type === "text")?.text;
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The ports a run must never use: the product's, and every reserved test pair
 * in scripts/test-ports.ts (read from its text, so a new pair joins by itself).
 */
export function reservedPorts(testPortsSource) {
  const ports = new Set([3478, 3479]);
  for (const m of String(testPortsSource).matchAll(/export const \w+_PORT = (\d+);/g)) {
    ports.add(Number(m[1]));
  }
  return ports;
}

/**
 * The child's whole environment. Pure. Inherits PATH (and Windows' SystemRoot,
 * which Node needs there) and nothing else: no token, no bind host, no data
 * dir, no TANDEM_OWNERSHIP from the parent. Every home and data location points
 * into `dir`; `XDG_DATA_HOME` in particular, because the auth token file lives
 * under env-paths' data dir and ignores `TANDEM_APP_DATA_DIR`.
 *
 * @param {"on" | "off"} expect
 * @param {string} dir  the temp dir every home and data location points into
 * @param {{ ws: number, mcp: number }} ports
 * @param {Record<string, string | undefined>} parentEnv
 */
export function serverEnvFor(expect, dir, ports, parentEnv) {
  /** @type {Record<string, string>} */
  const env = {};
  if (parentEnv.PATH !== undefined) env.PATH = parentEnv.PATH;
  if (parentEnv.SystemRoot !== undefined) env.SystemRoot = parentEnv.SystemRoot;
  const home = path.join(dir, "home");
  for (const key of ["HOME", "USERPROFILE"]) env[key] = home;
  env.APPDATA = path.join(home, "AppData", "Roaming");
  env.LOCALAPPDATA = path.join(home, "AppData", "Local");
  env.XDG_CONFIG_HOME = path.join(home, ".config");
  env.XDG_DATA_HOME = path.join(home, ".local", "share");
  env.XDG_STATE_HOME = path.join(home, ".local", "state");
  env.XDG_CACHE_HOME = path.join(home, ".cache");
  env.TANDEM_APP_DATA_DIR = path.join(dir, "app-data");
  env.TANDEM_PORT = String(ports.ws);
  env.TANDEM_MCP_PORT = String(ports.mcp);
  env.TANDEM_NO_SAMPLE = "1";
  env.TANDEM_DISABLE_LAUNCHER = "1";
  env.TANDEM_DISABLE_FIRST_RUN_WIZARD = "1";
  if (expect === "off") env.TANDEM_OWNERSHIP = "1";
  return env;
}

function freePort(avoid) {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {import("node:net").AddressInfo} */ (srv.address());
      srv.close(() => (avoid.has(port) ? freePort(avoid).then(resolve, reject) : resolve(port)));
    });
  });
}

async function waitHealthy(baseUrl, isExited) {
  for (let i = 0; i < 60; i++) {
    if (isExited()) return false;
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--expect") args.expect = argv[++i];
    else if (a.startsWith("--expect=")) args.expect = a.slice("--expect=".length);
    else if (a.startsWith("--stderr-file=")) args.stderrFile = a.slice("--stderr-file=".length);
    else if (a.startsWith("--entry=")) args.entry = a.slice("--entry=".length);
    else if (a.startsWith("--ids=")) args.ids = a.slice("--ids=".length).split(",");
  }
  return args;
}

function report(result) {
  const tag =
    result.code === EXIT_OK ? "OK" : result.code === EXIT_MISMATCH ? "FAIL" : "CANNOT EVALUATE";
  process.stderr.write(`[ownership-probe] ${tag}: ${result.reason}\n`);
  if (result.code === EXIT_CANNOT_EVALUATE) {
    process.stderr.write("[ownership-probe] The probe could not evaluate. This is not a pass.\n");
  }
  return result.code;
}

/** Boot the bundle (or a test's `entry`) once and judge it. */
async function probe(expect, entry = SERVER_ENTRY) {
  if (!existsSync(entry)) {
    return { code: EXIT_CANNOT_EVALUATE, reason: `no ${entry}; build first` };
  }
  const avoid = reservedPorts(readFileSync(path.join(REPO_ROOT, "scripts/test-ports.ts"), "utf8"));
  const ws = await freePort(avoid);
  const mcp = await freePort(new Set([...avoid, ws]));
  const dir = await mkdtemp(path.join(tmpdir(), "tandem-ownership-probe-"));
  const claudeSessionId = randomUUID();
  let stderr = "";
  let exited = false;
  const child = spawn(process.execPath, [entry], {
    cwd: dir,
    env: serverEnvFor(expect, dir, { ws, mcp }, process.env),
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (c) => {
    stderr += c.toString("utf8");
  });
  child.once("exit", () => {
    exited = true;
  });
  try {
    const baseUrl = `http://127.0.0.1:${mcp}`;
    if (!(await waitHealthy(baseUrl, () => exited))) {
      return {
        code: EXIT_CANNOT_EVALUATE,
        reason: `server never became healthy on :${mcp}\n--- server stderr ---\n${stderr}`,
      };
    }
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-Claude-Session-Id": claudeSessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "ownership-bundle-probe", version: "1.0.0" },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const mcpSessionId = res.headers.get("mcp-session-id") ?? "";
    await res.text();
    if (!mcpSessionId) {
      return {
        code: EXIT_CANNOT_EVALUATE,
        reason: `initialize answered ${res.status} with no session id`,
      };
    }
    for (let i = 0; i < 20 && !ESTABLISHED.test(stderr); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const verdict = judgeProbe(stderr, [mcpSessionId, claudeSessionId], expect);
    if (verdict.code !== EXIT_OK) {
      verdict.reason += `\n--- server stderr ---\n${stderr}`;
      return verdict;
    }
    // The log line agrees. Now the enforcement itself (see the header).
    const refusal = await probeRefusal(baseUrl, mcpSessionId, expect);
    if (refusal.code !== EXIT_OK) {
      refusal.reason += `\n--- server stderr ---\n${stderr}`;
      return refusal;
    }
    return { code: EXIT_OK, reason: `${verdict.reason}; ${refusal.reason}` };
  } finally {
    if (!exited) {
      child.kill("SIGTERM");
      const killer = setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, 5000);
      await new Promise((r) => (exited ? r() : child.once("exit", r)));
      clearTimeout(killer);
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

async function rpc(baseUrl, sessionId, body, extraHeaders = {}) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      ...MCP_HEADERS,
      ...extraHeaders,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
    signal: AbortSignal.timeout(15_000),
  });
  return { res, text: await res.text() };
}

async function callTool(baseUrl, sessionId, name, args) {
  const { text } = await rpc(baseUrl, sessionId, {
    id: 2,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return toolEnvelope(text);
}

/** The second verdict: a second session's write to a document the first opened. */
async function probeRefusal(baseUrl, firstSessionId, expect) {
  await rpc(baseUrl, firstSessionId, { method: "notifications/initialized" });
  const scratch = await callTool(baseUrl, firstSessionId, "tandem_scratchpad", {
    content: "ownership probe",
  });
  const documentId = scratch?.data?.documentId;
  if (typeof documentId !== "string") {
    return { code: EXIT_CANNOT_EVALUATE, reason: "tandem_scratchpad returned no documentId" };
  }
  const ownWrite = await callTool(baseUrl, firstSessionId, "tandem_appendContent", {
    content: "by the opener",
    documentId,
  });
  // A second session: its own identity, so it is a different owner record.
  const init = await rpc(
    baseUrl,
    undefined,
    {
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "ownership-bundle-probe-2", version: "1.0.0" },
      },
    },
    { "X-Claude-Session-Id": randomUUID() },
  );
  const secondSessionId = init.res.headers.get("mcp-session-id") ?? "";
  if (!secondSessionId) {
    return { code: EXIT_CANNOT_EVALUATE, reason: "the second initialize returned no session id" };
  }
  await rpc(baseUrl, secondSessionId, { method: "notifications/initialized" });
  const otherWrite = await callTool(baseUrl, secondSessionId, "tandem_appendContent", {
    content: "by another session",
    documentId,
  });
  return judgeRefusal(ownWrite, otherWrite, expect);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.expect !== "on" && args.expect !== "off") {
    return report({ code: EXIT_CANNOT_EVALUATE, reason: "pass --expect on or --expect off" });
  }
  if (args.stderrFile !== undefined) {
    let text;
    try {
      text = readFileSync(args.stderrFile, "utf8");
    } catch (err) {
      return report({
        code: EXIT_CANNOT_EVALUATE,
        reason: `cannot read ${args.stderrFile}: ${err}`,
      });
    }
    return report(judgeProbe(text, args.ids ?? [], args.expect));
  }
  return report(
    await probe(args.expect, args.entry === undefined ? undefined : path.resolve(args.entry)),
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`[ownership-probe] crashed: ${err?.stack ?? err}\n`);
      process.exit(EXIT_CANNOT_EVALUATE);
    },
  );
}
