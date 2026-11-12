/**
 * Source pins for the measurement harness (#1123 brief R1.1, R1.4, R4).
 *
 *  - The harness defines no system prompt, no tool schema and no chat request:
 *    it can only measure the shipped ones.
 *  - Nothing in it is reachable from a shipped bundle or the published package.
 *  - Its entry scripts start nothing when imported, and never load the product
 *    before pointing its app data inside their own run directory.
 *  - It is typechecked in `check`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { isMain, samePath } from "../../../../probe/local-model-spike/harness/main-guard.js";
import { harnessConfig } from "../../../../probe/local-model-spike/harness/model-config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SPIKE = path.join(ROOT, "probe", "local-model-spike");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "runs" || entry.name === "node_modules") continue;
      out.push(...tsFiles(full));
    } else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const rel = (file: string) => path.relative(SPIKE, file).split(path.sep).join("/");
const read = (file: string) => fs.readFileSync(file, "utf8");

/** Files on a run path. The frozen June prompt is history and is exempt by path. */
const HARNESS_FILES = tsFiles(SPIKE).filter((f) => !rel(f).startsWith("june-2026/"));

describe("the harness defines no loop, prompt, tool schema or chat request of its own", () => {
  it("has the files this pin expects", () => {
    const names = HARNESS_FILES.map(rel);
    for (const expected of [
      "measure.ts",
      "read.ts",
      "report.ts",
      "dogfood-m1.ts",
      "harness/trial.ts",
      "harness/fetch-tap.ts",
    ]) {
      expect(names).toContain(expected);
    }
    // The copies are gone.
    for (const gone of [
      "loop.ts",
      "tools.ts",
      "ollama.ts",
      "prompts.ts",
      "fallback.ts",
      "batch-fallback.ts",
      "batch.ts",
    ]) {
      expect(names).not.toContain(gone);
    }
    expect(fs.existsSync(path.join(SPIKE, "june-2026", "prompts.ts"))).toBe(true);
  });

  it("no system message, and the only message text written for a model is the warm-up's", () => {
    const withMessages: string[] = [];
    for (const file of HARNESS_FILES) {
      const src = read(file);
      expect(src, `${rel(file)} builds a system message`).not.toMatch(/role:\s*["']system["']/);
      expect(src, `${rel(file)} defines a system prompt`).not.toMatch(/SYSTEM_PROMPT\s*=/);
      expect(src, `${rel(file)} writes prompt text`).not.toMatch(/You are a writing collaborator/);
      if (/role:\s*["']user["']/.test(src)) withMessages.push(rel(file));
    }
    // Named exemption: the unscored warm-up call, which goes through the
    // shipped client and never reaches a trial.
    expect(withMessages).toEqual(["harness/preflight.ts"]);
  });

  it("no tool schema: tool lists come from the product's exports", () => {
    for (const file of HARNESS_FILES) {
      const src = read(file);
      expect(src, rel(file)).not.toMatch(/parameters:\s*\{\s*type:\s*["']object["']/);
      expect(src, rel(file)).not.toMatch(/:\s*ToolSchema\[\]\s*=\s*\[/);
      expect(src, rel(file)).not.toMatch(/type:\s*["']function["']\s*,\s*function:\s*\{\s*name/);
    }
  });

  it("no chat request: nothing posts to a chat path or builds a chat body", () => {
    // Exempt BY NAME: the fetch tap, which only observes the shipped client's
    // traffic, and the scripted stand-in, which only writes RESPONSES. Metadata
    // paths (`/api/version`, `/api/show`, `/api/tags`, `/api/ps`) are not chat.
    const exempt = new Set(["harness/fetch-tap.ts", "harness/scripted-model.ts"]);
    for (const file of HARNESS_FILES) {
      if (exempt.has(rel(file))) continue;
      const src = read(file);
      expect(src, rel(file)).not.toMatch(
        /\/v1\/chat\/completions|["'`]\/api\/chat["'`]|\/api\/generate/,
      );
      // A literal sampling value or request flag would be a restated call shape.
      expect(src, rel(file)).not.toMatch(
        /tool_choice|stream:\s*true|temperature\s*:\s*[\d.]|options:\s*\{/,
      );
    }
    // The tap itself issues no request: it only ever calls the fetch it wrapped.
    const tap = read(path.join(SPIKE, "harness", "fetch-tap.ts"));
    expect(tap).not.toMatch(/new Request\(/);
    expect(tap.match(/\bfetch\(/g) ?? []).toEqual([]);
    expect(tap.match(/previous\(input, init\)/g)?.length).toBe(2);
  });

  it("no loop: a trial reaches the model only through the shipped collaborator and turn runner", () => {
    const trial = read(path.join(SPIKE, "harness", "trial.ts"));
    expect(trial).toMatch(/createLocalModelCollaborator\(/);
    expect(trial).toMatch(/runLocalModelTurn\(\{\s*\.\.\.opts,/);
    for (const file of HARNESS_FILES) {
      const src = read(file);
      expect(src, rel(file)).not.toMatch(/\brunLoop\(/);
      expect(src, rel(file)).not.toMatch(/while\s*\([^)]*turns?\s*</i);
    }
    // `chat()` is called in exactly one place: the warm-up.
    const callers = HARNESS_FILES.filter((f) => /\bchat\(\{/.test(read(f))).map(rel);
    expect(callers).toEqual(["harness/preflight.ts"]);
  });

  it("no model is named: no list, no ladder, no default", () => {
    for (const file of HARNESS_FILES) {
      if (rel(file) === "harness/scenarios/june.ts") continue;
      expect(read(file), rel(file)).not.toMatch(/qwen|llama3|mistral|gemma|phi-?\d|deepseek/i);
    }
  });
});

describe("nothing in the harness reaches a shipped bundle or the published package", () => {
  it("no file under src/ names the harness in any import form", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|svelte|js|mjs|cjs)$/.test(entry.name)) {
          // Static import, side-effect import, dynamic import or require.
          if (/["'`][^"'`\n]*probe\/local-model-spike/.test(read(full))) {
            const text = read(full)
              .split("\n")
              .filter(
                (l) =>
                  /["'`][^"'`\n]*probe\/local-model-spike/.test(l) && !/^\s*(\*|\/\/|\/\*)/.test(l),
              );
            if (text.length > 0) offenders.push(path.relative(ROOT, full));
          }
        }
      }
    };
    walk(path.join(ROOT, "src"));
    expect(offenders).toEqual([]);
  });

  it("the npm package, the bundler and the desktop bundle name nothing under probe/", () => {
    const pkg = JSON.parse(read(path.join(ROOT, "package.json"))) as {
      files: string[];
      bin?: unknown;
    };
    expect(pkg.files.some((f) => f.includes("probe"))).toBe(false);
    expect(JSON.stringify(pkg.bin ?? {})).not.toContain("probe");
    expect(read(path.join(ROOT, "tsup.config.ts"))).not.toContain("probe");
    expect(read(path.join(ROOT, "src-tauri", "tauri.conf.json"))).not.toContain("probe");
  });

  it("the only changes under src/ are exports: the two the harness imports exist and are plain constants", () => {
    const collaborator = read(path.join(ROOT, "src/server/local-model/collaborator.ts"));
    expect(collaborator).toMatch(/export const INLINE_CHAR_LIMIT = \d+;/);
    expect(collaborator).toMatch(/export const TRUNCATION_MARKER =/);
  });
});

describe("entry scripts", () => {
  const ENTRIES = ["measure.ts", "read.ts", "report.ts", "dogfood-m1.ts", "generate-envelope.ts"];

  it("start nothing when imported", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const before = fs.readdirSync(SPIKE).sort();
    const fixtureStat = fs.statSync(path.join(SPIKE, "fixtures", "envelope-50page.md")).mtimeMs;
    for (const name of ENTRIES) {
      const mod = (await import(path.join(SPIKE, name))) as Record<string, unknown>;
      expect(typeof (mod.main ?? mod.generate), name).toBe("function");
    }
    expect(exit).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(fs.readdirSync(SPIKE).sort()).toEqual(before);
    expect(fs.statSync(path.join(SPIKE, "fixtures", "envelope-50page.md")).mtimeMs).toBe(
      fixtureStat,
    );
    exit.mockRestore();
    write.mockRestore();
  });

  it("each runs its main only behind the main guard", () => {
    for (const name of ENTRIES) {
      const src = read(path.join(SPIKE, name));
      expect(src, name).toMatch(/if \(isMain\(import\.meta\.url\)\)/);
    }
  });

  /** Static imports of `file`, followed through the harness, as repo-relative paths. */
  function staticClosure(file: string, seen = new Set<string>()): Set<string> {
    if (seen.has(file)) return seen;
    seen.add(file);
    const src = read(file);
    for (const m of src.matchAll(/^import\s+(?!type\b)[^;]*?from\s+["'](\.[^"']+)["'];/gms)) {
      const target = path.resolve(path.dirname(file), m[1].replace(/\.js$/, ".ts"));
      if (fs.existsSync(target)) staticClosure(target, seen);
    }
    return seen;
  }

  it("never load the product statically: it is imported only after the app-data directory is set", () => {
    for (const name of ["measure.ts", "read.ts", "report.ts", "dogfood-m1.ts"]) {
      const closure = [...staticClosure(path.join(SPIKE, name))].map((f) =>
        path.relative(ROOT, f).split(path.sep).join("/"),
      );
      expect(
        closure.filter((f) => f.startsWith("src/")),
        name,
      ).toEqual([]);
      expect(
        closure.every((f) => f.startsWith("probe/local-model-spike/")),
        name,
      ).toBe(true);
    }
    // The three that load the product do it after `isolateAppData(`.
    for (const name of ["measure.ts", "read.ts", "dogfood-m1.ts"]) {
      const src = read(path.join(SPIKE, name));
      const isolate = src.indexOf("isolateAppData(", src.indexOf("export async function main"));
      const firstDynamic = src.indexOf("await import(");
      const firstBatch = src.indexOf('import("./harness/');
      expect(isolate, name).toBeGreaterThan(-1);
      expect(Math.min(...[firstDynamic, firstBatch].filter((i) => i > -1)), name).toBeGreaterThan(
        isolate,
      );
    }
    // The report loads no product code at all, statically or dynamically.
    expect(read(path.join(SPIKE, "report.ts"))).not.toMatch(/import\(/);
  });

  it("recognise the same script under two spellings of its path, including Windows ones", () => {
    expect(samePath("/a/b/measure.ts", "/a/b/measure.ts", "linux")).toBe(true);
    expect(samePath("/a/b/measure.ts", "/a/B/measure.ts", "linux")).toBe(false);
    expect(samePath("C:\\Repo\\probe\\measure.ts", "c:\\repo\\probe\\measure.ts", "win32")).toBe(
      true,
    );
    expect(samePath("C:\\Repo\\probe\\measure.ts", "C:/Repo/probe/measure.ts", "win32")).toBe(true);
    expect(samePath("C:\\Repo\\probe\\measure.ts", "C:\\Repo\\probe\\report.ts", "win32")).toBe(
      false,
    );
    // Not the entry: this test file is not the script Node was started with.
    expect(isMain(import.meta.url)).toBe(false);
    expect(isMain(import.meta.url, undefined)).toBe(false);
    expect(isMain(import.meta.url, fileURLToPath(import.meta.url))).toBe(true);
  });
});

describe("the harness is typechecked in check", () => {
  it("its directory is in the node test config, as a whole directory", () => {
    const config = read(path.join(ROOT, "tsconfig.tests.node.json"));
    expect(config).toContain('"probe/**/*.ts"');
  });

  it("run output is gitignored", () => {
    expect(read(path.join(ROOT, ".gitignore"))).toMatch(/^probe\/local-model-spike\/runs\/$/m);
  });
});

describe("the model config a trial runs with is what the product's resolver builds", () => {
  it("equals resolveLocalModelConfig() for a saved Ollama entry with the same endpoint and model", async () => {
    vi.resetModules();
    vi.doMock("../../../../src/server/models/registry.js", () => ({
      getCachedModelsFile: () => ({
        version: 1,
        defaultModelId: "e1",
        models: [
          {
            id: "e1",
            provider: "local-ollama",
            displayName: "some/model:7b",
            modelId: "some/model:7b",
            endpoint: "http://127.0.0.1:11434",
            enabled: true,
          },
        ],
      }),
    }));
    const { resolveLocalModelConfig } = await import(
      "../../../../src/server/local-model/config-source.js"
    );
    expect(resolveLocalModelConfig()).toEqual(
      harnessConfig("some/model:7b", "http://127.0.0.1:11434"),
    );
    vi.doUnmock("../../../../src/server/models/registry.js");
    vi.resetModules();
  });
});
