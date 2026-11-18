/**
 * The development allowance closed in release builds (#2410, #1123; ADR-039
 * P9, V15, item 28).
 *
 * A release build of the server ignores `TANDEM_MODELS_DEV_ORIGIN` unless its
 * argv carries `--tandem-e2e-harness`, which only the E2E harness's launcher
 * adds. A server run from source (no `__TANDEM_VERSION__` define) is unchanged.
 * What this file pins:
 *
 *  1. The fact itself (`src/server/models/dev-allowance-build.ts`), built with
 *     esbuild with and without the define, asked each row (L1 to L8).
 *  2. The one call in `server.ts`, its import, and that nothing else reads the
 *     variable or decides the build.
 *  3. The harness signal's reach: only the leaf names it under `src/`, nothing
 *     under `src-tauri/`, and no server code pushes it onto `process.argv`.
 *  4. The shipped launchers pass nothing else: the npm `tandem` spawns the
 *     server with exactly `[SERVER_DIST]`, and the desktop shell's Node command
 *     takes no argument beyond the ones `tests/build/sidecar-argv-flag.test.ts`
 *     pins (that test proves the flag is present; these prove nothing else is
 *     passed, so a shortcut or a file name cannot carry the harness argument).
 *  5. The E2E launcher adds the argument, run for real in a temp directory.
 *  6. CI's `check` runs the built-bundle check after Build.
 *
 * The define reaching `dist/server` is pinned from the evaluated tsup config
 * in `client-config-home-wiring.test.ts`, which names this leaf as its second
 * reader.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { E2E_HARNESS_ARGV_FLAG } from "../../src/server/models/dev-allowance-build.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const LEAF = join(ROOT, "src", "server", "models", "dev-allowance-build.ts");
const SERVER_TS = "src/server/mcp/server.ts";
const scratch = mkdtempSync(join(tmpdir(), "tandem-dev-allowance-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const posix = (p: string) => p.replace(/\\/g, "/");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");

/** TypeScript/JavaScript source with every comment removed by the TS printer,
 *  so prose cannot satisfy or trip a pin and strings are left whole. */
function code(rel: string): string {
  const kind = rel.endsWith(".svelte") ? ts.ScriptKind.TS : ts.ScriptKind.Unknown;
  const sf = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, false, kind);
  return ts.createPrinter({ removeComments: true }).printFile(sf);
}

/** Rust source with `//` comments removed (CRLF-safe). */
function rust(rel: string): string {
  return read(rel)
    .split(/\r?\n/)
    .map((line) => line.replace(/^(\s*)\/\/.*$/, "$1").replace(/\s\/\/\s.*$/, ""))
    .join("\n");
}

/** Every `.ts` file under `src/` (Svelte files hold no server code). */
function srcTsFiles(dir = join(ROOT, "src")): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...srcTsFiles(p));
    else if (name.endsWith(".ts")) out.push(posix(relative(ROOT, p)));
  }
  return out.sort();
}

type Leaf = {
  devAllowanceBuild: (argv: readonly string[]) => string;
  E2E_HARNESS_ARGV_FLAG: string;
};
const built: Record<string, string> = {};

async function buildLeaf(define: Record<string, string>, name: string): Promise<Leaf> {
  const out = await build({
    entryPoints: [LEAF],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    define,
  });
  const text = out.outputFiles[0]?.text ?? "";
  built[name] = text;
  const file = join(scratch, `${name}.mjs`);
  writeFileSync(file, text);
  return (await import(pathToFileURL(file).href)) as Leaf;
}

const withDefine = await buildLeaf({ __TANDEM_VERSION__: JSON.stringify("1.2.3") }, "with");
const withoutDefine = await buildLeaf({}, "without");
const NODE = ["node", "server.js"];

describe("the fact, built both ways (L1 to L8)", () => {
  it("the argument is the one string", () => {
    expect(E2E_HARNESS_ARGV_FLAG).toBe("--tandem-e2e-harness");
    expect(withDefine.E2E_HARNESS_ARGV_FLAG).toBe(E2E_HARNESS_ARGV_FLAG);
  });

  it("L1, L2: no define is source, with or without the argument", () => {
    expect(withoutDefine.devAllowanceBuild(NODE)).toBe("source");
    expect(withoutDefine.devAllowanceBuild([...NODE, "--tandem-e2e-harness"])).toBe("source");
  });

  it("L3, L4: a release build without the argument is release, the desktop sidecar too", () => {
    expect(withDefine.devAllowanceBuild(NODE)).toBe("release");
    expect(withDefine.devAllowanceBuild([...NODE, "--tauri-sidecar"])).toBe("release");
  });

  it("L5, L6: a release build with the argument is the E2E harness", () => {
    expect(withDefine.devAllowanceBuild([...NODE, "--tandem-e2e-harness"])).toBe("e2e-harness");
    expect(withDefine.devAllowanceBuild([...NODE, "--tauri-sidecar", "--tandem-e2e-harness"])).toBe(
      "e2e-harness",
    );
  });

  it.each([["--tandem-e2e-harness=1"], ["--tandem-e2e-harnessX"], ["x--tandem-e2e-harness"]])(
    "L7: %s is not the argument (exact element equality)",
    (arg) => {
      expect(withDefine.devAllowanceBuild([arg])).toBe("release");
    },
  );

  it.each(["with", "without"])("L8: the %s build reads no environment", (name) => {
    expect(built[name]).not.toContain("process.env");
    expect(built[name]).not.toContain("import.meta.env");
  });

  it("the leaf imports nothing and names no `process` at all, so argv is only its parameter", () => {
    const leaf = code("src/server/models/dev-allowance-build.ts");
    expect(leaf).not.toMatch(/\bimport\b|\brequire\s*\(/);
    expect(leaf).not.toMatch(/\bprocess\b|\bglobalThis\b/);
  });
});

describe("the one call, and nothing else decides it", () => {
  const server = code(SERVER_TS);

  it("server.ts passes the environment's value and the build from argv, exactly once", () => {
    const call =
      /const modelsDevOrigin = resolveModelsDevOrigin\(\s*process\.env\[MODELS_DEV_ORIGIN_ENV\],\s*devAllowanceBuild\(process\.argv\),?\s*\);/g;
    expect([...server.matchAll(call)]).toHaveLength(1);
    expect(server.split("allowance: modelsDevOrigin.origin")).toHaveLength(2);
  });

  it("server.ts imports devAllowanceBuild, unaliased, from the leaf", () => {
    expect(read(SERVER_TS)).toContain(
      'import { devAllowanceBuild } from "../models/dev-allowance-build.js";',
    );
    expect(server).not.toMatch(/devAllowanceBuild\s+as\b/);
  });

  it("devAllowanceBuild is defined only in the leaf", () => {
    const definers = srcTsFiles().filter((f) =>
      /\b(?:function|const|let|var|class)\s+devAllowanceBuild\b/.test(code(f)),
    );
    expect(definers).toEqual(["src/server/models/dev-allowance-build.ts"]);
  });

  it("resolveModelsDevOrigin is called once in src/ outside own-window.ts", () => {
    const calls = srcTsFiles()
      .filter((f) => f !== "src/server/models/own-window.ts")
      .flatMap((f) => [...code(f).matchAll(/resolveModelsDevOrigin\(/g)].map(() => f));
    expect(calls).toEqual([SERVER_TS]);
  });

  it("the files that name the variable (comments stripped) are exactly today's four", () => {
    const readers = srcTsFiles().filter((f) =>
      /MODELS_DEV_ORIGIN_ENV|TANDEM_MODELS_DEV_ORIGIN/.test(code(f)),
    );
    expect(readers).toEqual([
      "src/client/models/own-window.ts",
      "src/server/mcp/server.ts",
      "src/server/models/own-window.ts",
      "src/shared/models/contract.ts",
    ]);
  });

  it("the variable is read from the environment once, in server.ts", () => {
    const reads = srcTsFiles().flatMap((f) =>
      [
        ...code(f).matchAll(
          /process\.env\[MODELS_DEV_ORIGIN_ENV\]|process\.env\.TANDEM_MODELS_DEV_ORIGIN/g,
        ),
      ].map(() => f),
    );
    expect(reads).toEqual([SERVER_TS]);
  });
});

describe("the harness signal's reach", () => {
  it("under src/, only the leaf names the argument or its constant (comments stripped)", () => {
    const naming = srcTsFiles().filter((f) =>
      /--tandem-e2e-harness|E2E_HARNESS_ARGV_FLAG/.test(code(f)),
    );
    expect(naming).toEqual(["src/server/models/dev-allowance-build.ts"]);
  });

  it("no tracked file under src-tauri/ names it", () => {
    const files = execFileSync("git", ["ls-files", "-z", "src-tauri"], {
      cwd: ROOT,
      encoding: "utf-8",
    })
      .split("\0")
      .filter((f) => f.length > 0 && !/\.(png|ico|icns|bmp)$/i.test(f));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      expect(readFileSync(join(ROOT, f), "utf-8"), f).not.toContain("tandem-e2e-harness");
    }
  });

  it("no server code changes process.argv", () => {
    const mutators = srcTsFiles()
      .filter((f) => f.startsWith("src/server/"))
      .filter((f) => /process\.argv\s*=|process\.argv\.(push|unshift|splice)/.test(code(f)));
    expect(mutators).toEqual([]);
  });
});

describe("the shipped launchers pass nothing else", () => {
  it("the npm `tandem` spawns the server exactly once, with exactly [SERVER_DIST]", () => {
    const start = code("src/cli/start.ts");
    const spawns = [...start.matchAll(/spawn\(([^;]*?)\)/gs)].filter((m) =>
      m[1].includes("SERVER_DIST"),
    );
    expect(spawns).toHaveLength(1);
    expect(start).toMatch(/spawn\(process\.execPath, \[SERVER_DIST\],/);
  });

  it("sidecar.rs: every `.args(` is a known one, and there is no `.arg(`", () => {
    const src = rust("src-tauri/src/sidecar.rs");
    const args = [...src.matchAll(/\.args\([^\n]*/g)].map((m) => m[0].trim().replace(/;$/, ""));
    expect(args).toEqual([
      // The Linux direct spawn of the Node sidecar (pinned with its flag by sidecar-argv-flag).
      '.args([server_js, "--tauri-sidecar"])',
      // The Linux trampoline: its vector is pdeathsig_exec_args, pinned below.
      ".args(sidecar_anchor::pdeathsig_exec_args(",
      // The non-Linux spawn of the Node sidecar.
      '.args([server_js_str.as_str(), "--tauri-sidecar"])',
      // run_system32_tool: netstat/tasklist, not the Node command.
      ".args(args)",
    ]);
    expect(src).toMatch(/std::process::Command::new\(program\)\s*\.args\(args\)/);
    expect(src).not.toMatch(/\.arg\(/);
  });

  it("sidecar_anchor.rs: no `.args(`, two known `.arg(`, and the trampoline vector has five items", () => {
    const src = rust("src-tauri/src/sidecar_anchor.rs");
    expect(src).not.toMatch(/\.args\(/);
    expect([...src.matchAll(/\.arg\(([^)]*)\)/g)].map((m) => m[0])).toEqual([
      // The probe of the reaper (not the Node command).
      ".arg(PROBE_FLAG)",
      // A #[cfg(test)] /bin/sleep child.
      '.arg("30")',
    ]);
    const body =
      /pub\(crate\) fn pdeathsig_exec_args\([^)]*\)\s*->\s*Vec<OsString>\s*\{\s*vec!\[([\s\S]*?)\]\s*\}/.exec(
        src,
      )?.[1];
    expect(body, "pdeathsig_exec_args not found").toBeDefined();
    const items = (body as string)
      .split(/,\s*\n/)
      .map((s) => s.trim().replace(/,$/, ""))
      .filter((s) => s.length > 0);
    expect(items).toEqual([
      "OsString::from(TRAMPOLINE_FLAG)",
      "OsString::from(parent_pid.to_string())",
      "node.to_owned()",
      "OsString::from(server_js)",
      'OsString::from("--tauri-sidecar")',
    ]);
  });
});

describe("the E2E launcher adds the argument", () => {
  const launcher = read("scripts/e2e-server.mjs");

  it("holds the same literal", () => {
    expect(launcher).toContain(`const E2E_HARNESS_ARGV_FLAG = "${E2E_HARNESS_ARGV_FLAG}"`);
  });

  /** Runs the real launcher in a fresh temp parent, never the E2E data dir. */
  function runLauncher(dataBasename: string) {
    const parent = mkdtempSync(join(scratch, "launcher-"));
    const entry = join(parent, "entry", "print-argv.mjs");
    mkdirSync(join(parent, "entry"));
    writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv));\n");
    const data = join(parent, "data", dataBasename);
    mkdirSync(data, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env, TANDEM_APP_DATA_DIR: data };
    delete env.CI;
    return spawnSync(process.execPath, ["scripts/e2e-server.mjs", entry, "x"], {
      env,
      encoding: "utf8",
      cwd: ROOT,
      timeout: 30_000,
    });
  }

  it("appends the argument after the caller's own", () => {
    const r = runLauncher("tandem-e2e-data");
    expect(r.status, r.stderr).toBe(0);
    const argv = JSON.parse(r.stdout) as string[];
    expect(argv.slice(-2)).toEqual(["x", "--tandem-e2e-harness"]);
  });

  it("refuses, starting nothing, when the app-data directory is not the E2E one", () => {
    const r = runLauncher("not-e2e-data");
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("CI's check runs the built-bundle check after Build", () => {
  type Step = Record<string, unknown>;
  const workflow = parse(read(".github/workflows/ci.yml")) as {
    jobs: { check: { steps: Step[] } };
  };
  const steps = workflow.jobs.check.steps;
  const RUN = "node scripts/ci/models-dev-allowance-bundle-check.mjs";

  it("the step is pinned whole, after Build", () => {
    const i = steps.findIndex((s) => s.run === RUN);
    const build = steps.findIndex((s) => s.name === "Build");
    expect(i, "check no longer runs the bundle check").toBeGreaterThan(build);
    expect(build).toBeGreaterThan(-1);
    expect(steps[i]).toEqual({
      name: "Release bundle ignores TANDEM_MODELS_DEV_ORIGIN outside the E2E harness",
      run: RUN,
    });
  });

  function check(text: string | null) {
    const dir = mkdtempSync(join(scratch, "bundle-"));
    const file = join(dir, "index.js");
    if (text !== null) writeFileSync(file, text);
    return spawnSync(process.execPath, ["scripts/ci/models-dev-allowance-bundle-check.mjs", file], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });
  }

  it("passes the leaf as built with the define", () => {
    expect(check(built.with).status).toBe(0);
  });

  it("fails the leaf as built without it, a bundle without the leaf, and a missing bundle", () => {
    expect(check(built.without).status).toBe(1);
    expect(check("console.log(1);\n").status).toBe(1);
    expect(check(null).status).toBe(3);
  });
});
