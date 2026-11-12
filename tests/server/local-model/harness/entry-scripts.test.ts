/**
 * The entry scripts, run as real child processes (#1123 brief R3, R4.2).
 *
 * Why a child process: the product fixes its session directory when
 * `src/server/platform.ts` is first imported, so "the app-data directory is
 * pointed inside the run directory BEFORE the product loads" can only be
 * proved where the product has not been loaded yet. Under vitest it already
 * has been.
 *
 * The "model" is a few lines of `node:http` on 127.0.0.1 inside this test: it
 * answers the metadata paths and streams one fixed reply. It is test
 * scaffolding, not a stub model server for the product's E2E suite.
 *
 * Children are started with `process.execPath --import tsx`, never `npx`
 * (spawning a `.cmd` without a shell is refused on Windows).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SPIKE = path.join(ROOT, "probe", "local-model-spike");
const TAG = "org/some-model:q4";
const CHILD_TIMEOUT_MS = 120_000;

let server: http.Server;
let endpoint: string;
let tmp: string;
let runsDir: string;
let sentinel: string;
const chatBodies: string[] = [];

function run(script: string, args: string[]): Promise<{ code: number; out: string }> {
  // Every place a default app-data root could be derived from points at the
  // sentinel, and the override the harness must set for itself is removed.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
  ]) {
    env[key] = sentinel;
  }
  delete env.TANDEM_APP_DATA_DIR;
  delete env.TANDEM_DATA_DIR;
  delete env.TANDEM_LICENSE_GATE;
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", path.join(SPIKE, script), ...args],
      { cwd: ROOT, env, timeout: CHILD_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: number }).code ?? 1) : 0;
        resolve({ code: typeof code === "number" ? code : 1, out: `${stdout}\n${stderr}` });
      },
    );
  });
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-harness-entry-"));
  runsDir = path.join(tmp, "runs");
  sentinel = path.join(tmp, "sentinel-home");
  fs.mkdirSync(runsDir);
  fs.mkdirSync(sentinel);
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const json = (value: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.url === "/api/version") return json({ version: "0.0.0-test" });
      if (req.url === "/api/show") {
        return json({
          capabilities: ["completion", "tools"],
          model_info: { "arch.context_length": 8192 },
        });
      }
      if (req.url === "/api/tags")
        return json({ models: [{ name: TAG, digest: "sha256:feedface" }] });
      if (req.url === "/api/ps") return json({ models: [{ name: TAG, context_length: 4096 }] });
      if (req.url === "/v1/chat/completions") {
        chatBodies.push(body);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "The document does not say." } }] })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("entry scripts as child processes", () => {
  it(
    "measure → read → report: a screen of one model, every write inside the run directory",
    async () => {
      const measured = await run("measure.ts", [
        "--model",
        TAG,
        "--tier",
        "chat",
        "--screen",
        "--hardware",
        "test bench, CPU only",
        "--endpoint",
        endpoint,
        "--runs-dir",
        runsDir,
      ]);
      expect(measured.out).toContain("Run complete: 20 trial(s) scored");
      expect(measured.code).toBe(0);
      expect(measured.out).toContain("Model digest: sha256:feedface");
      expect(measured.out).toContain("Context length: 4096");

      const runs = fs.readdirSync(runsDir);
      expect(runs).toHaveLength(1);
      const runId = runs[0];
      expect(runId).toMatch(/^[0-9TZ]+-chat-screen-org_some-model_q4-[0-9a-f]{8}$/);
      const runDir = path.join(runsDir, runId);

      // 20 trials plus one warm-up call reached the "model": the warm-up is not a trial.
      expect(chatBodies).toHaveLength(21);
      expect(JSON.parse(chatBodies[0]).messages).toHaveLength(1);

      // The product's app data is inside the run directory; nothing leaked to
      // any default location, and nothing was written beside the runs directory.
      expect(fs.existsSync(path.join(runDir, "app-data"))).toBe(true);
      expect(fs.readdirSync(sentinel)).toEqual([]);
      expect(fs.readdirSync(tmp).sort()).toEqual(["runs", "sentinel-home"]);

      const identity = JSON.parse(fs.readFileSync(path.join(runDir, "identity.json"), "utf8"));
      expect(identity).toMatchObject({
        modelTag: TAG,
        modelDigest: "sha256:feedface",
        ollamaVersion: "0.0.0-test",
        tier: "chat",
        mode: "screen",
        repeats: 1,
      });
      expect(identity.sessions[0]).toMatchObject({
        hardware: "test bench, CPU only",
        contextLength: 4096,
      });
      // "unknown" where git will not answer for this checkout (the child runs with
      // another HOME, so a `safe.directory` entry may not apply): never fatal.
      expect(identity.commit).toMatch(/^(?:[0-9a-f]{40}|unknown)$/);
      const fingerprint = JSON.parse(fs.readFileSync(path.join(SPIKE, "fingerprint.json"), "utf8"));
      expect(identity.fingerprint).toBe(fingerprint.current); // tsx computes what `check` pins

      const read = await run("read.ts", ["--run", runId, "--runs-dir", runsDir]);
      expect(read.code).toBe(0);
      const reading = fs.readFileSync(path.join(runDir, "reading.txt"), "utf8");
      expect(reading).toContain("TRIAL 1 of 20");
      expect(reading).toContain("FIXTURE TEXTS");
      const template = JSON.parse(
        fs.readFileSync(path.join(runDir, "verdicts.template.json"), "utf8"),
      );
      expect(template.entries).toHaveLength(20);
      expect(fs.existsSync(path.join(runDir, "verdicts.json"))).toBe(false);

      const report = await run("report.ts", ["--run", runId, "--runs-dir", runsDir]);
      expect(report.code).toBe(0);
      expect(report.out).toContain("Outcome: SCREEN");
      expect(report.out).toContain("It cannot pass or fail a model.");
      expect(report.out).toContain("Overlapping intervals are not a ranking.");
      expect(report.out).toContain(TAG);
      expect(report.out).not.toMatch(/Outcome: (PASS|FAIL)/);

      // The reading file shows, and the report judges, the documents stored
      // with the run; a stored document changed since refuses both (review M3).
      const fixturesFile = path.join(runDir, "fixtures.json");
      const storedFixtures = fs.readFileSync(fixturesFile, "utf8");
      const parsedFixtures = JSON.parse(storedFixtures) as Record<string, { text: string }>;
      const firstKey = Object.keys(parsedFixtures)[0];
      expect(reading).toContain(parsedFixtures[firstKey].text.split("\n")[0]);
      parsedFixtures[firstKey].text += " (edited)";
      fs.writeFileSync(fixturesFile, JSON.stringify(parsedFixtures));
      for (const script of ["read.ts", "report.ts"]) {
        const refused = await run(script, ["--run", runId, "--runs-dir", runsDir]);
        expect(refused.code, script).toBe(2);
        expect(refused.out, script).toMatch(/Refusing/);
        expect(refused.out, script).toMatch(/does not match its own hash/);
      }
      fs.writeFileSync(fixturesFile, storedFixtures);

      // A resume of a complete run scores nothing more.
      const resumed = await run("measure.ts", [
        "--model",
        TAG,
        "--tier",
        "chat",
        "--screen",
        "--hardware",
        "test bench, CPU only",
        "--endpoint",
        endpoint,
        "--runs-dir",
        runsDir,
        "--resume",
        runId,
      ]);
      expect(resumed.out).toContain("Run complete: 0 trial(s) scored");
    },
    4 * CHILD_TIMEOUT_MS,
  );

  it(
    "measure refuses a model the server does not have, a path as a run id, and missing arguments",
    async () => {
      const before = fs.readdirSync(runsDir).length;
      const noArgs = await run("measure.ts", []);
      expect(noArgs.code).toBe(2);
      const asPath = await run("measure.ts", [
        "--model",
        TAG,
        "--tier",
        "chat",
        "--hardware",
        "x",
        "--runs-dir",
        runsDir,
        "--resume",
        "../elsewhere",
      ]);
      expect(asPath.code).toBe(2);
      expect(asPath.out).toContain("not a path");
      const closed = await run("measure.ts", [
        "--model",
        TAG,
        "--tier",
        "chat",
        "--hardware",
        "x",
        "--runs-dir",
        runsDir,
        "--endpoint",
        "http://example.com:11434",
      ]);
      expect(closed.code).toBe(2);
      expect(closed.out).toContain("endpoint refused");
      expect(fs.readdirSync(runsDir)).toHaveLength(before); // a refused run leaves nothing behind
    },
    3 * CHILD_TIMEOUT_MS,
  );

  it(
    "dogfood-m1 keeps its flags and exit codes: 2 without --model, 0 on PASS, 1 on FAIL",
    async () => {
      const noModel = await run("dogfood-m1.ts", ["--tier", "chat"]);
      expect(noModel.code).toBe(2);
      expect(noModel.out).toContain("--model <tag> is required");

      const badTier = await run("dogfood-m1.ts", ["--model", TAG, "--tier", "both"]);
      expect(badTier.code).toBe(2);

      // The stand-in answers in text and calls no tool.
      const chat = await run("dogfood-m1.ts", [
        "--model",
        TAG,
        "--tier",
        "chat",
        "--endpoint",
        endpoint,
      ]);
      expect(chat.out).toContain("PASS (chat)");
      expect(chat.code).toBe(0);

      const editing = await run("dogfood-m1.ts", [
        "--model",
        TAG,
        "--tier",
        "editing",
        "--endpoint",
        endpoint,
      ]);
      expect(editing.out).toContain("FAIL (editing)");
      expect(editing.code).toBe(1);
      expect(fs.readdirSync(sentinel)).toEqual([]);
    },
    4 * CHILD_TIMEOUT_MS,
  );
});

describe("the fetch tap against a real connection", () => {
  it("an abort while the tap is reading a clone still reaches the product as an AbortError", async () => {
    // The loop tells a timeout from an error by the AbortError's name. The tap
    // tees the response body; this checks, with real `fetch` over a real
    // socket, that teeing does not turn the abort into some other failure.
    const { installFetchTap } = await import(
      "../../../../probe/local-model-spike/harness/fetch-tap.js"
    );
    const stall = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`);
      // …and never ends.
    });
    await new Promise<void>((resolve) => stall.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(stall.address() as AddressInfo).port}/v1/chat/completions`;
    const tap = installFetchTap();
    try {
      const ctrl = new AbortController();
      const res = await fetch(url, { method: "POST", body: "{}", signal: ctrl.signal });
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("partial");
      const pending = reader.read();
      ctrl.abort();
      const err = await pending.then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.name).toBe("AbortError");
      await tap.settle(500);
      expect(tap.records).toHaveLength(1);
      expect(tap.records[0].status).toBe(200);
    } finally {
      tap.restore();
      stall.closeAllConnections();
      await new Promise<void>((resolve) => stall.close(() => resolve()));
    }
  }, 30_000);
});
