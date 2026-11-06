import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import {
  bridgeInstallKind,
  detectTargets,
  installSkill,
  mayTouchDefaultClientConfigs,
} from "../../src/server/integrations/apply.js";

/**
 * #2358 PR 2b — the stand-in home for Claude client configs.
 *
 * The boot sweep now rewrites `~/.claude.json`, and no test, dev server or E2E
 * run may touch the real one. `src/server/integrations/client-config-home.ts`
 * redirects every client-config and skill path whenever the build define
 * `__TANDEM_VERSION__` is ABSENT, and never when it is present. This file pins
 * every half of that, so deleting the gate, the define, or a harness line fails
 * here rather than on someone's real config:
 *
 * 1. Behaviour, both ways: the leaf is built in-process with and without the
 *    define (esbuild, ~10 ms) and each build is asked the question.
 * 2. The define reaches both bundles that import the leaf.
 * 3. No bundle WITHOUT the define (stdio-bridge, channel, monitor) can reach it.
 * 4. The harnesses set the variable (vitest root, per worker; playwright's server).
 * 5. At runtime under vitest, detection resolves under the stand-in, never under
 *    the real home (read from the passwd entry, not `$HOME`).
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const LEAF = join(ROOT, "src", "server", "integrations", "client-config-home.ts");
const scratch = mkdtempSync(join(tmpdir(), "tandem-cch-wiring-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Leaf = {
  devClientConfigHome: (env: NodeJS.ProcessEnv, fallback: () => string) => string | undefined;
};

async function buildLeaf(define: Record<string, string>, name: string): Promise<Leaf> {
  const out = await build({
    entryPoints: [LEAF],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    define,
  });
  const file = join(scratch, `${name}.mjs`);
  writeFileSync(file, out.outputFiles[0]?.text ?? "");
  return (await import(pathToFileURL(file).href)) as Leaf;
}

describe("the gate, built both ways", () => {
  it("a build WITH the define ignores the variable and never redirects", async () => {
    const leaf = await buildLeaf({ __TANDEM_VERSION__: JSON.stringify("1.2.3") }, "with");
    expect(leaf.devClientConfigHome({ TANDEM_CLIENT_CONFIG_HOME: "/stand-in" }, () => "/fb")).toBe(
      undefined,
    );
    expect(leaf.devClientConfigHome({}, () => "/fb")).toBe(undefined);
  });

  it("a build WITHOUT the define honours the variable, and never falls back to the real home", async () => {
    const leaf = await buildLeaf({}, "without");
    expect(leaf.devClientConfigHome({ TANDEM_CLIENT_CONFIG_HOME: "/stand-in" }, () => "/fb")).toBe(
      "/stand-in",
    );
    expect(leaf.devClientConfigHome({}, () => "/fb")).toBe("/fb");
    expect(leaf.devClientConfigHome({ TANDEM_CLIENT_CONFIG_HOME: "" }, () => "/fb")).toBe("/fb");
  });
});

type TsupEntry = { outDir?: string; define?: Record<string, string>; entry?: string[] };
const TSUP_CONFIG_URL = pathToFileURL(join(ROOT, "tsup.config.ts")).href;
const tsupConfig: unknown = (await import(TSUP_CONFIG_URL)).default;
const entries = (Array.isArray(tsupConfig) ? tsupConfig : [tsupConfig]) as TsupEntry[];

describe("the define reaches every bundle that imports the leaf", () => {
  it.each(["dist/server", "dist/cli"])("%s defines __TANDEM_VERSION__", (outDir) => {
    const entry = entries.find((e) => e.outDir === outDir);
    expect(entry, `no tsup entry writes ${outDir}`).toBeDefined();
    expect(entry?.define?.__TANDEM_VERSION__).toBeTruthy();
  });

  it.each(["dist/stdio-bridge", "dist/channel", "dist/monitor"])(
    "%s (no define) cannot reach the leaf or apply.ts",
    async (outDir) => {
      const entry = entries.find((e) => e.outDir === outDir);
      expect(entry?.define?.__TANDEM_VERSION__).toBeUndefined();
      const result = await build({
        entryPoints: (entry?.entry ?? []).map((e) => join(ROOT, e)),
        bundle: true,
        write: false,
        metafile: true,
        format: "esm",
        platform: "node",
        packages: "external",
        logLevel: "silent",
      });
      const inputs = Object.keys(result.metafile?.inputs ?? {}).map((p) => p.replace(/\\/g, "/"));
      expect(inputs.length).toBeGreaterThan(0);
      expect(inputs.some((p) => p.endsWith("integrations/client-config-home.ts"))).toBe(false);
      expect(inputs.some((p) => p.endsWith("integrations/apply.ts"))).toBe(false);
    },
  );

  it("only apply.ts imports the leaf", () => {
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|svelte)$/.test(name) && /client-config-home/.test(readFileSync(p, "utf-8")))
          importers.push(relative(ROOT, p).replace(/\\/g, "/"));
      }
    };
    walk(join(ROOT, "src"));
    expect(importers.sort()).toEqual([
      "src/server/integrations/apply.ts",
      "src/server/integrations/client-config-home.ts",
    ]);
  });
});

describe("the harnesses set the stand-in", () => {
  it("vitest's root test.env sets it", () => {
    expect(readFileSync(join(ROOT, "vitest.config.ts"), "utf-8")).toMatch(
      /TANDEM_CLIENT_CONFIG_HOME:\s*path\.join\(TEST_APP_DATA_ROOT/,
    );
  });

  it("the per-worker setup narrows it to the worker's own directory", () => {
    expect(readFileSync(join(ROOT, "tests", "setup", "app-data-isolation.ts"), "utf-8")).toMatch(
      /process\.env\.TANDEM_CLIENT_CONFIG_HOME\s*=\s*path\.join\(dir,/,
    );
  });

  it("playwright's E2E server env sets it, and the built (CI) arm also moves HOME", () => {
    const text = readFileSync(join(ROOT, "playwright.config.ts"), "utf-8");
    expect(text).toMatch(/TANDEM_CLIENT_CONFIG_HOME:\s*resolve\(E2E_APP_DATA_DIR/);
    expect(text).toMatch(/process\.env\.CI\s*\?\s*\{\s*HOME:\s*resolve\(E2E_APP_DATA_DIR/);
    expect(text).toMatch(/USERPROFILE:\s*resolve\(E2E_APP_DATA_DIR/);
  });
});

describe("at runtime under vitest", () => {
  it("detection resolves every config under the stand-in, never the real home", () => {
    const standIn = process.env.TANDEM_CLIENT_CONFIG_HOME;
    expect(standIn, "the per-worker setup did not run").toBeTruthy();
    const realHome = userInfo().homedir;
    const targets = detectTargets({ force: true });
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) {
      expect(t.configPath.startsWith(standIn as string)).toBe(true);
      expect(t.configPath.startsWith(join(realHome, "."))).toBe(false);
    }
  });
});

describe("the other gates (#2358 PR 2b round 2)", () => {
  it("installSkill with no override writes under the stand-in", async () => {
    const standIn = process.env.TANDEM_CLIENT_CONFIG_HOME as string;
    await installSkill();
    expect(statSync(join(standIn, ".claude", "skills", "tandem", "SKILL.md")).isFile()).toBe(true);
  });

  it("boot housekeeping runs only with a stand-in home or from an installed build", () => {
    expect(mayTouchDefaultClientConfigs({ standIn: undefined, installKind: null })).toBe(false);
    expect(mayTouchDefaultClientConfigs({ standIn: undefined, installKind: "installed" })).toBe(
      true,
    );
    expect(mayTouchDefaultClientConfigs({ standIn: undefined, installKind: "appimage" })).toBe(
      true,
    );
    expect(mayTouchDefaultClientConfigs({ standIn: "/stand-in", installKind: null })).toBe(true);
  });

  it("an AppImage mount counts as one only for the sidecar itself", () => {
    const script = join(
      scratch,
      ".mount_TandemQ1w2E3",
      "usr",
      "lib",
      "Tandem",
      "dist",
      "stdio-bridge",
      "index.js",
    );
    mkdirSync(join(script, ".."), { recursive: true });
    writeFileSync(script, "");
    const argv = ["node", "server.js", "--tauri-sidecar"];
    expect(bridgeInstallKind(script, { TANDEM_TAURI_SIDECAR: "1" }, argv)).toBe("appimage");
    expect(bridgeInstallKind(script, { TANDEM_TAURI_SIDECAR: "1" }, ["node", "x"])).toBe(null);
  });
});

describe("the boot gate is wired at both call sites (#2358 PR 2b code review)", () => {
  const apply = readFileSync(join(ROOT, "src", "server", "integrations", "apply.ts"), "utf-8");
  const body = (signature: string) => {
    const start = apply.indexOf(signature);
    expect(start, `${signature} not found`).toBeGreaterThan(-1);
    return apply.slice(start, start + 4000);
  };
  const GATE = "if (opts.homeOverride === undefined && !mayTouchDefaultClientConfigs()) return;";

  it("the sweep returns on the gate before it detects or prepares anything", () => {
    const fn = body("export async function refreshAllMcpEntryBinaries(");
    const gate = fn.indexOf(GATE);
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(fn.indexOf("prepareAppImageBridgeCopy("));
    expect(gate).toBeLessThan(fn.indexOf("detectTargets("));
  });

  it("the skill refresh returns on the gate before it resolves or screens a path", () => {
    const fn = body("export async function refreshExistingSkillIfStale(");
    const gate = fn.indexOf(GATE);
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(fn.indexOf("assertPathSafe("));
  });
});

describe("the uninstall scrub's skill removal uses the stand-in too", () => {
  it("removes the stand-in's skill, not the real one", async () => {
    const { removeSkillDir } = await import("../../src/cli/uninstall-scrub.js");
    const standIn = process.env.TANDEM_CLIENT_CONFIG_HOME as string;
    await installSkill();
    const skill = join(standIn, ".claude", "skills", "tandem", "SKILL.md");
    expect(statSync(skill).isFile()).toBe(true);
    const logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      warnings: () => 0,
      close: async () => {},
    };
    await removeSkillDir(logger);
    expect(() => statSync(skill)).toThrow();
  });
});
