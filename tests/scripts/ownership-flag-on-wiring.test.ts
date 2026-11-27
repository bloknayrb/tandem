import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  EXIT_MISMATCH,
  hashForLog,
  judgeProbe,
  judgeRefusal,
  EXIT_CANNOT_EVALUATE as PROBE_CANNOT,
  EXIT_OK as PROBE_OK,
  probeRefusal,
  reservedPorts,
  rpcMessage,
  serverEnvFor,
  toolEnvelope,
} from "../../scripts/ci/ownership-bundle-probe.mjs";
import {
  EXIT_CANNOT_EVALUATE,
  EXIT_FAILED,
  EXIT_OK,
  evaluateAnchors,
} from "../../scripts/ci/ownership-flag-on-runner.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * `check`'s ownership steps (#2358, ADR-054; ownership design §12): the bundle
 * probe and the anchor runner. ADR-051: the job does the work; this test,
 * inside `check`, pins the steps and the inputs they read, so disarming them
 * means editing something a required check reads.
 *
 * Until the flip a separate `ownership-flag-on` job ran everything flag-on
 * while a release build stayed flag-off, and was itself a required check.
 * Since the flip (ADR-054's flip amendment) the release literal is on, so
 * `check` builds and tests ownership-on itself. Branch protection stopped
 * requiring the job on 2026-11-27 and it was deleted; its anchor step moved
 * into `check`. The file keeps its name so the docs that cite it stay right.
 *
 * ADR-051's rules, as applied here:
 * 1. npm scripts the steps depend on are pinned by exact equality.
 * 2. YAML attributes are read as parsed fields: whole step objects are
 *    compared, so a `continue-on-error`, `shell`, `if` or `env` added to a
 *    pinned step changes the object and fails.
 * 3. Position is pinned where it carries meaning: the probe right after
 *    Build, the anchor runner after the Test step whose report it reads.
 * 4. One owner per fact: `check`'s Test command and its file anchor are
 *    `vitest-file-anchor-wiring.test.ts`'s; "the root `test.env` lacks
 *    TANDEM_OWNERSHIP" is `tests/server/ownership-flag.test.ts`'s.
 */

type Step = Record<string, unknown>;
type Job = Record<string, unknown> & { steps: Step[] };
const WORKFLOW_PATH = path.join(ROOT, ".github/workflows/ci.yml");
const workflow = parse(readFileSync(WORKFLOW_PATH, "utf-8")) as Record<string, unknown> & {
  jobs: Record<string, Job>;
};
const check = workflow.jobs.check;

function checkStep(predicate: (s: Step) => boolean, label: string): Step {
  const step = check.steps.find(predicate);
  if (!step) throw new Error(`ci.yml: check has no ${label} step`);
  return step;
}

const checkTestRun = checkStep((s) => s.name === "Test", "Test").run;

const PROBE_ON = "node scripts/ci/ownership-bundle-probe.mjs --expect on";

describe("check's ownership anchor step (ADR-051)", () => {
  it("the flag-on job is gone, and nothing else runs the suite with the variable set", () => {
    expect(workflow.jobs["ownership-flag-on"]).toBeUndefined();
    for (const [name, j] of Object.entries(workflow.jobs)) {
      for (const step of j.steps ?? []) {
        const env = step.env as Record<string, unknown> | undefined;
        expect(env?.TANDEM_OWNERSHIP, `${name}: ${String(step.name ?? step.run)}`).toBeUndefined();
      }
    }
  });

  it("the workflow sets no env or defaults that every job would inherit", () => {
    expect(workflow.env).toBeUndefined();
    expect(workflow.defaults).toBeUndefined();
  });

  it("runs after check's Test step, survives a red Test, and is pinned whole", () => {
    expect(typeof checkTestRun).toBe("string");
    expect(String(checkTestRun)).toContain("--outputFile.json=.vitest-report.json");
    const test = check.steps.findIndex((s) => s.name === "Test");
    const i = check.steps.findIndex((s) => s.name === "Ownership anchor ran flag-on");
    expect(i, "check no longer runs the ownership anchor").toBeGreaterThan(test);
    expect(check.steps[i]).toEqual({
      name: "Ownership anchor ran flag-on",
      if: "${{ !cancelled() }}",
      run: "node scripts/ci/ownership-flag-on-runner.mjs .vitest-report.json",
    });
    expect(
      check.steps.filter((s) => s.run === check.steps[i].run),
      "the anchor step appears once",
    ).toHaveLength(1);
  });

  it("the npm script the Test step runs cannot swallow a failure", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.test).toBe("vitest");
    expect(pkg.scripts["test:e2e"]).toBe("playwright test");
  });

  it("E2E under CI runs the built bundle the probe checked", () => {
    // check's E2E step sets no variable, so it is flag-on only through the
    // bundle; this pins that the CI branch is the bundle, which the probe
    // proved ownership-on by its define.
    const src = readFileSync(path.join(ROOT, "playwright.config.ts"), "utf-8");
    expect(src).toMatch(
      /command:\s*process\.env\.CI\s*\?\s*"node scripts\/e2e-server\.mjs dist\/server\/index\.js"/,
    );
  });
});

describe("check sets no variable, and proves the release bundle is ownership-on by its define", () => {
  it("TANDEM_OWNERSHIP appears in no check-job env and on no other check step", () => {
    expect(check.env).toBeUndefined();
    for (const step of check.steps) {
      const env = step.env as Record<string, unknown> | undefined;
      expect(env?.TANDEM_OWNERSHIP, `check step ${String(step.name ?? step.run)}`).toBeUndefined();
    }
  });

  it("the probe step is pinned whole, immediately after Build", () => {
    // Since the flip (ADR-054's flip amendment): `--expect on` gives the
    // child TANDEM_OWNERSHIP=0, so only the release build's define can turn
    // it on (an unset variable would follow the literal and prove nothing). Before it, this step ran `--expect off` with the variable set.
    const i = check.steps.findIndex((s) => s.run === PROBE_ON);
    expect(i, "check no longer runs the --expect on probe").toBeGreaterThan(0);
    expect(check.steps[i - 1]).toEqual({ name: "Build", run: "npm run build" });
    expect(check.steps[i]).toEqual({
      name: "Release bundle is ownership-on",
      run: PROBE_ON,
      "timeout-minutes": 2,
    });
    expect(
      check.steps.some((s) => typeof s.run === "string" && s.run.includes("--expect off")),
    ).toBe(false);
  });
});

describe("scripts/ci/ownership-flag-on-runner.mjs", () => {
  const FIXTURES = path.join(ROOT, "tests/scripts/fixtures/ownership-anchor");
  // Captured from real vitest JSON reports of tests/server/ownership-anchor.test.ts
  // (vitest 5.0.5), run once with TANDEM_OWNERSHIP=1 and once without, then
  // trimmed and given repo-relative names.
  const passed = JSON.parse(readFileSync(path.join(FIXTURES, "passed.json"), "utf-8"));
  const skipped = JSON.parse(readFileSync(path.join(FIXTURES, "skipped.json"), "utf-8"));
  const runner = path.join(ROOT, "scripts/ci/ownership-flag-on-runner.mjs");

  it("passes a run where every anchor assertion passed", () => {
    expect(evaluateAnchors(passed, ROOT).code).toBe(EXIT_OK);
  });

  it("refuses a run where the anchor skipped: the run came out flag-off", () => {
    // vitest reports this file's status as `passed`; only assertions tell.
    expect(skipped.testResults[0].status).toBe("passed");
    const v = evaluateAnchors(skipped, ROOT);
    expect(v.code).toBe(EXIT_FAILED);
    expect(v.reason).toMatch(/flag-off/);
  });

  it("refuses a failed anchor and a failed run", () => {
    const failed = structuredClone(passed);
    failed.testResults[0].assertionResults[0].status = "failed";
    expect(evaluateAnchors(failed, ROOT).code).toBe(EXIT_FAILED);
    const runFailed = structuredClone(passed);
    runFailed.success = false;
    runFailed.numFailedTests = 1;
    expect(evaluateAnchors(runFailed, ROOT).code).toBe(EXIT_FAILED);
  });

  it("cannot evaluate a report without the anchor file, or no report at all", () => {
    const missing = structuredClone(passed);
    missing.testResults[0].name = "tests/server/something-else.test.ts";
    expect(evaluateAnchors(missing, ROOT).code).toBe(EXIT_CANNOT_EVALUATE);
    expect(evaluateAnchors(null, ROOT).code).toBe(EXIT_CANNOT_EVALUATE);
    expect(evaluateAnchors({ success: true }, ROOT).code).toBe(EXIT_CANNOT_EVALUATE);
  });

  it("its main maps each verdict to its exit code (spawned)", () => {
    const run = (args: string[]) =>
      spawnSync(process.execPath, [runner, ...args], { cwd: ROOT, encoding: "utf-8" }).status;
    expect(run([path.join(FIXTURES, "passed.json")])).toBe(0);
    expect(run([path.join(FIXTURES, "skipped.json")])).toBe(1);
    expect(run([path.join(FIXTURES, "no-such-report.json")])).toBe(3);
    expect(run([])).toBe(3);
  });
});

describe("scripts/ci/ownership-bundle-probe.mjs", () => {
  const MCP = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
  const CLAUDE = "6f1c3a52-9b7d-4e0f-8a2c-1d5e7b9f3c40";
  const line = (a: string, b: string) =>
    `[Tandem] MCP session established: ${a} (claude session ${b}) (client x) — 1 live`;
  const probe = path.join(ROOT, "scripts/ci/ownership-bundle-probe.mjs");

  it("judges ON only when both of its ids are hashed and neither is raw", () => {
    const on = line(hashForLog(MCP), hashForLog(CLAUDE));
    expect(judgeProbe(on, [MCP, CLAUDE], "on").code).toBe(PROBE_OK);
    expect(judgeProbe(line(MCP, CLAUDE), [MCP, CLAUDE], "on").code).toBe(EXIT_MISMATCH);
    expect(judgeProbe(line(hashForLog(MCP), CLAUDE), [MCP, CLAUDE], "on").code).toBe(EXIT_MISMATCH);
  });

  it("judges OFF only when both of its ids are raw and neither is hashed", () => {
    expect(judgeProbe(line(MCP, CLAUDE), [MCP, CLAUDE], "off").code).toBe(PROBE_OK);
    expect(judgeProbe(line(hashForLog(MCP), hashForLog(CLAUDE)), [MCP, CLAUDE], "off").code).toBe(
      EXIT_MISMATCH,
    );
  });

  it("cannot evaluate a log with no session line, or no ids", () => {
    expect(judgeProbe("[Tandem] Starting server", [MCP, CLAUDE], "on").code).toBe(PROBE_CANNOT);
    expect(judgeProbe(line(MCP, CLAUDE), [], "off").code).toBe(PROBE_CANNOT);
  });

  it("hashes exactly as src/server/sessions/log-id.ts does", () => {
    const src = readFileSync(path.join(ROOT, "src/server/sessions/log-id.ts"), "utf-8");
    expect(src).toContain(
      'createHash("sha256").update(id.toLowerCase()).digest("hex").slice(0, 8)',
    );
    expect(hashForLog(MCP)).toMatch(/^#[0-9a-f]{8}$/);
  });

  it("builds the child's environment itself: isolated homes, no inherited secrets, the variable set against the expectation", () => {
    const parent = {
      PATH: "/bin",
      TANDEM_AUTH_TOKEN: "secret",
      HOME: "/real",
      TANDEM_OWNERSHIP: "1",
    };
    const on = serverEnvFor("on", "/tmp/p", { ws: 5001, mcp: 5002 }, parent);
    // Set, not absent: since the flip an unset variable follows the `true`
    // literal, so a bundle with the define dropped would pass `--expect on`.
    expect(on.TANDEM_OWNERSHIP).toBe("0");
    expect(on.TANDEM_AUTH_TOKEN).toBeUndefined();
    expect(on.PATH).toBe("/bin");
    for (const k of [
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "XDG_CACHE_HOME",
    ]) {
      // XDG_DATA_HOME matters most: the auth token file lives under env-paths'
      // data dir and ignores TANDEM_APP_DATA_DIR.
      expect(on[k]?.startsWith(path.join("/tmp/p", "home")), k).toBe(true);
    }
    expect(on.TANDEM_APP_DATA_DIR).toBe(path.join("/tmp/p", "app-data"));
    expect(on).toMatchObject({
      TANDEM_PORT: "5001",
      TANDEM_MCP_PORT: "5002",
      TANDEM_NO_SAMPLE: "1",
      TANDEM_DISABLE_LAUNCHER: "1",
      TANDEM_DISABLE_FIRST_RUN_WIZARD: "1",
    });
    const off = serverEnvFor("off", "/tmp/p", { ws: 5001, mcp: 5002 }, parent);
    expect(off.TANDEM_OWNERSHIP).toBe("1");
  });

  it("never picks the product's ports or a reserved test pair", () => {
    const avoid = reservedPorts(readFileSync(path.join(ROOT, "scripts/test-ports.ts"), "utf-8"));
    for (const p of [3478, 3479, 4573, 4728, 4729, 4378, 4379])
      expect(avoid.has(p), String(p)).toBe(true);
  });

  it("boots its entry with an environment it built itself (spawned against fixture servers)", () => {
    // The env-following fixture hashes when TANDEM_OWNERSHIP is unset or "1",
    // as a bundle with the define dropped would since the flip, and refuses to
    // start unless the probe isolated its home. So both expectations must FAIL
    // against it: `off` because the probe hands the child "1", `on` because it
    // hands it "0". A probe that inherited the parent's env, or stopped setting
    // the variable for either, turns one of these green.
    const fixtures = path.join(ROOT, "tests/scripts/fixtures/ownership-probe");
    const boot = (expect: string, entry: string) =>
      spawnSync(process.execPath, [probe, `--expect=${expect}`, `--entry=${entry}`], {
        cwd: ROOT,
        encoding: "utf-8",
        env: { ...process.env, TANDEM_OWNERSHIP: "1", TANDEM_AUTH_TOKEN: "x".repeat(40) },
        timeout: 60_000,
      });
    const follower = path.join(fixtures, "env-following-server.mjs");
    const off = boot("off", follower);
    expect(off.status, off.stderr).toBe(1);
    expect(off.stderr).toMatch(/expected ownership OFF: 0\/2 id\(s\) printed raw, 2\/2 hashed/);
    const on = boot("on", follower);
    expect(on.status, on.stderr).toBe(1);
    expect(on.stderr).toMatch(/expected ownership ON: 2\/2 id\(s\) printed raw, 0\/2 hashed/);
    const silent = boot("off", path.join(fixtures, "silent-server.mjs"));
    expect(silent.status, silent.stderr).toBe(3);
    expect(silent.stderr).toMatch(/no 'MCP session established' line/);
    const exiting = boot("off", path.join(fixtures, "exiting-server.mjs"));
    expect(exiting.status, exiting.stderr).toBe(3);
    expect(exiting.stderr).toMatch(/never became healthy/);
  }, 120_000);

  it("its main maps each verdict to its exit code (spawned, judging a captured log)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ownership-probe-test-"));
    try {
      const file = path.join(dir, "stderr.txt");
      const run = (expect: string, text: string, ids = `${MCP},${CLAUDE}`) => {
        writeFileSync(file, text);
        return spawnSync(
          process.execPath,
          [probe, `--expect=${expect}`, `--stderr-file=${file}`, `--ids=${ids}`],
          { cwd: ROOT, encoding: "utf-8" },
        ).status;
      };
      expect(run("on", line(hashForLog(MCP), hashForLog(CLAUDE)))).toBe(0);
      expect(run("on", line(MCP, CLAUDE))).toBe(1);
      expect(run("off", line(MCP, CLAUDE))).toBe(0);
      expect(run("off", "nothing")).toBe(3);
      // An empty id is "printed raw" by every string; it must not judge.
      expect(run("off", line(MCP, CLAUDE), `${MCP},`)).toBe(3);
      expect(run("sideways", line(MCP, CLAUDE))).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the probe's second, runtime anchor: a non-owner write (PR 1c, ownership design §12)", () => {
  const PROBE = readFileSync(path.join(ROOT, "scripts/ci/ownership-bundle-probe.mjs"), "utf-8");
  const ok = { error: false, data: { appended: true } };
  const refused = {
    error: true,
    code: "NOT_DOC_OWNER",
    details: {
      reason: "held",
      documentId: "d",
      holder: { label: "owner-aaaa", displayKind: "terminal" },
    },
  };

  it("on: the opener writes and the second session is refused NOT_DOC_OWNER / held", () => {
    expect(judgeRefusal(ok, refused, "on").code).toBe(0);
    // A bundle whose define did not take accepts the write: a mismatch, not "cannot evaluate".
    expect(judgeRefusal(ok, ok, "on").code).toBe(1);
  });

  it("off: both writes are accepted, and a refusal is a mismatch", () => {
    expect(judgeRefusal(ok, ok, "off").code).toBe(0);
    expect(judgeRefusal(ok, refused, "off").code).toBe(1);
  });

  it("a bundle that refuses everything, or answers anything else, is not a verdict", () => {
    // The opener's own write must succeed either way.
    expect(judgeRefusal(refused, refused, "on").code).toBe(3);
    expect(judgeRefusal({ error: true, code: "INTERNAL_ERROR" }, refused, "on").code).toBe(3);
    // The second write must be exactly accepted or exactly NOT_DOC_OWNER/held.
    expect(judgeRefusal(ok, { error: true, code: "INTERNAL_ERROR" }, "on").code).toBe(3);
    expect(
      judgeRefusal(ok, { error: true, code: "NOT_DOC_OWNER", details: { reason: "claimed" } }, "on")
        .code,
    ).toBe(3);
    expect(judgeRefusal(undefined, ok, "on").code).toBe(3);
    expect(judgeRefusal(ok, ok, "sideways" as "on").code).toBe(3);
  });

  it("reads a tool envelope out of a JSON body and out of an SSE body", () => {
    const rpc = {
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text", text: JSON.stringify(refused) }] },
    };
    expect(toolEnvelope(JSON.stringify(rpc))).toEqual(refused);
    expect(toolEnvelope(`event: message\ndata: ${JSON.stringify(rpc)}\n\n`)).toEqual(refused);
    expect(rpcMessage("not json")).toBeUndefined();
    expect(toolEnvelope('{"jsonrpc":"2.0","id":2,"error":{"code":-32000}}')).toBeUndefined();
  });

  it("the boot path judges the write only after the log line agrees, and returns its verdict", () => {
    // Source pin: the workflow step is unchanged (`--expect on`), so what makes
    // the job run this anchor is the probe calling it on its only boot path.
    const boot = PROBE.slice(
      PROBE.indexOf("async function probe("),
      PROBE.indexOf("const MCP_HEADERS"),
    );
    expect(boot).toMatch(/const verdict = judgeProbe\(/);
    expect(boot).toMatch(/const refusal = await probeRefusal\(baseUrl, mcpSessionId, expect\);/);
    expect(boot).toMatch(/if \(refusal\.code !== EXIT_OK\) \{[\s\S]*?return refusal;/);
    // No environment variable or flag can skip it.
    expect(PROBE).not.toMatch(/SKIP|process\.env\.[A-Z_]*REFUSAL/);
    const refusalFn = PROBE.slice(PROBE.indexOf("async function probeRefusal("));
    expect(refusalFn).toMatch(/"tandem_scratchpad"/);
    expect(refusalFn).toMatch(/return judgeRefusal\(ownWrite, otherWrite, expect\);/);
  });
});

describe("probeRefusal by behaviour (#2358 flip-blocker row, the plan's gate (c))", () => {
  // A stub of Tandem's /mcp: two sessions, a scratchpad, then a write by each.
  // `refuse` decides whether the second session's write is refused
  // NOT_DOC_OWNER/held. The probe must open the document as the first session,
  // write as it, then initialize a SECOND session under its own Claude session
  // id and write as that one.
  async function runAgainstStub(refuse: boolean, expectOn: "on" | "off") {
    const seen: Array<{
      session: string;
      claude: string | undefined;
      method: string;
      tool?: string;
    }> = [];
    // "s1" is the session the probe opened before calling probeRefusal.
    let sessions = 1;
    const server = createServer((req: IncomingMessage, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        const msg = JSON.parse(body) as { id?: number; method: string; params?: { name?: string } };
        const session = String(req.headers["mcp-session-id"] ?? "");
        const claude = req.headers["x-claude-session-id"] as string | undefined;
        seen.push({ session, claude, method: msg.method, tool: msg.params?.name });
        const send = (result: unknown, headers: Record<string, string> = {}) => {
          res.writeHead(200, { "content-type": "application/json", ...headers });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, result }));
        };
        if (msg.method === "initialize") {
          sessions += 1;
          return send({}, { "mcp-session-id": `s${sessions}` });
        }
        if (msg.method !== "tools/call") return send({});
        const env = (e: unknown) => ({ content: [{ type: "text", text: JSON.stringify(e) }] });
        if (msg.params?.name === "tandem_scratchpad") {
          return send(env({ error: false, data: { documentId: "doc1" } }));
        }
        if (session === "s1") return send(env({ error: false, data: {} }));
        return send(
          env(
            refuse
              ? { error: true, code: "NOT_DOC_OWNER", message: "held", details: { reason: "held" } }
              : { error: false, data: {} },
          ),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const verdict = await probeRefusal(`http://127.0.0.1:${port}`, "s1", expectOn);
      return { verdict, seen };
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  it("refused by the second session, expecting on: OK; expecting off: a mismatch", async () => {
    expect((await runAgainstStub(true, "on")).verdict.code).toBe(PROBE_OK);
    expect((await runAgainstStub(true, "off")).verdict.code).toBe(EXIT_MISMATCH);
  });

  it("accepted from the second session, expecting off: OK; expecting on: a mismatch", async () => {
    expect((await runAgainstStub(false, "off")).verdict.code).toBe(PROBE_OK);
    expect((await runAgainstStub(false, "on")).verdict.code).toBe(EXIT_MISMATCH);
  });

  it("the writes come from two sessions, the second initialized under its own Claude session id", async () => {
    const { seen } = await runAgainstStub(true, "on");
    const writes = seen.filter((r) => r.tool === "tandem_appendContent");
    expect(writes.map((w) => w.session)).toEqual(["s1", "s2"]);
    const scratch = seen.filter((r) => r.tool === "tandem_scratchpad");
    expect(scratch.map((w) => w.session)).toEqual(["s1"]);
    const secondInit = seen.find((r) => r.method === "initialize");
    expect(secondInit?.claude).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("the E2E MCP client's identity (PR 1c, ownership design §12)", () => {
  // The flag-on E2E run is part of the required `ownership-flag-on` job. With
  // ownership on, a client that sends no identity header is its own owner
  // record per connection, so the document one spec opened would refuse the
  // next spec. Every E2E client therefore sends one fixed client id.
  const HELPERS = readFileSync(path.join(ROOT, "tests/e2e/helpers.ts"), "utf-8");

  it("every MCP transport the E2E helper builds sends the one fixed X-Tandem-Client-Id", () => {
    const transports = HELPERS.match(/new StreamableHTTPClientTransport\([\s\S]*?\);/g) ?? [];
    expect(transports.length).toBeGreaterThan(0);
    for (const t of transports) {
      expect(t).toMatch(/"X-Tandem-Client-Id": E2E_TANDEM_CLIENT_ID/);
    }
  });

  it("the id is a constant the server accepts as a client id, and no other E2E file builds a transport", () => {
    const id = /export const E2E_TANDEM_CLIENT_ID = "([^"]+)";/.exec(HELPERS)?.[1];
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const e2eDir = path.join(ROOT, "tests/e2e");
    const others = readdirSync(e2eDir, { recursive: true })
      .map(String)
      .filter((f) => /\.(ts|mts|js|mjs)$/.test(f) && f !== "helpers.ts")
      .filter((f) =>
        /new StreamableHTTPClientTransport\(/.test(readFileSync(path.join(e2eDir, f), "utf-8")),
      );
    expect(others).toEqual([]);
  });
});
