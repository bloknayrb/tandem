import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ownershipEnabled } from "../../src/server/ownership-flag.js";
import { OWNERSHIP_ENABLED } from "../../src/shared/constants.js";

/**
 * The ownership flag ships dark (#2358, ADR-054; ownership design §12).
 *
 * - Release builds never carry it on: the literal is `false`, declared once.
 * - A shell export cannot make a half-on build: `tsup.config.ts` derives the
 *   define from that literal and reads no environment at all, and the
 *   identifier `ownership-flag.ts` reads is the key tsup injects.
 * - The default test run is flag-off: no vitest `test.env` and no setup file
 *   sets `TANDEM_OWNERSHIP` (this file is the one owner of that fact).
 *
 * What it cannot see is the built artifact; `scripts/ci/ownership-bundle-probe.mjs`
 * checks that, in `check` (off) and in `ownership-flag-on` (on).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf-8");

/** `//` line comments removed (a `://` in a URL survives), as license-flip-consts does. */
const stripLineComments = (src: string) => src.replace(/(^|[^:])\/\/.*$/gm, "$1");
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ownershipEnabled() without a build define (tsx, vitest)", () => {
  it("is on only for exactly TANDEM_OWNERSHIP=1, read on every call", () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    expect(ownershipEnabled()).toBe(false);
    vi.stubEnv("TANDEM_OWNERSHIP", "1");
    expect(ownershipEnabled()).toBe(true);
    for (const v of ["0", "true", "yes", " 1", "1 "]) {
      vi.stubEnv("TANDEM_OWNERSHIP", v);
      expect(ownershipEnabled(), JSON.stringify(v)).toBe(false);
    }
  });
});

describe("the release literal", () => {
  it("is false", () => {
    expect(OWNERSHIP_ENABLED).toBe(false);
  });

  it("is declared exactly once, as a top-level boolean literal", () => {
    // Anchored and counted, so a commented-out or duplicated copy cannot answer.
    const src = stripLineComments(read("src/shared/constants.ts"));
    const matches = [...src.matchAll(/^export const OWNERSHIP_ENABLED\s*=\s*(true|false)\s*;/gm)];
    expect(matches.map((m) => m[1])).toEqual(["false"]);
  });
});

describe("tsup.config.ts derives the define from the literal, and from nothing else", () => {
  // Line comments only: a block-comment stripper reads the `src/server/license/*`
  // glob in tsup.config.ts's own comments as an opener and eats the code (the
  // trap tests/docs/license-flip-consts.test.ts records). The `^`-anchored
  // matches below are what keep a block-commented copy from answering.
  const src = stripLineComments(read("tsup.config.ts"));

  it("imports the literal and stringifies it, with no environment read anywhere", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\bOWNERSHIP_ENABLED\b[^}]*\}\s*from\s*"\.\/src\/shared\/constants\.js"/,
    );
    expect(src.match(/^const OWNERSHIP_DEFINE = .*$/gm)).toEqual([
      "const OWNERSHIP_DEFINE = JSON.stringify(OWNERSHIP_ENABLED);",
    ]);
    expect(src).not.toMatch(/process\s*\.\s*env|import\.meta\.env/);
  });

  it("puts it in the server and cli blocks of the real config", async () => {
    type Entry = { outDir?: string; define?: Record<string, string> };
    const config = (await import(pathToFileURL(path.join(ROOT, "tsup.config.ts")).href))
      .default as Entry[];
    const carrying = config.filter((e) => e.define && "__OWNERSHIP_ENABLED__" in e.define);
    expect(carrying.map((e) => e.outDir).sort()).toEqual(["dist/cli", "dist/server"]);
    for (const e of carrying) {
      expect(e.define?.__OWNERSHIP_ENABLED__).toBe(JSON.stringify(OWNERSHIP_ENABLED));
    }
  });

  it("is the identifier ownership-flag.ts reads", () => {
    const flag = read("src/server/ownership-flag.ts");
    expect(new Set([...flag.matchAll(/typeof\s+(__\w+__)/g)].map((m) => m[1]))).toEqual(
      new Set(["__OWNERSHIP_ENABLED__"]),
    );
    expect(flag).toMatch(/declare const __OWNERSHIP_ENABLED__: boolean;/);
  });
});

describe("the default test run is flag-off", () => {
  it("no vitest config and no setup file sets TANDEM_OWNERSHIP", () => {
    // The root `test.env` beats the shell, so a key there would make every run
    // flag-on and the ownership-flag-on job's anchor meaningless; a per-project
    // `test.env` or a setup file could drop it from that job instead.
    const setupDir = path.join(ROOT, "tests/setup");
    const files = [
      "vitest.config.ts",
      ...readdirSync(setupDir).map((f) => path.posix.join("tests/setup", f)),
    ];
    expect(files.length).toBeGreaterThan(1);
    for (const f of files) expect(read(f), f).not.toContain("TANDEM_OWNERSHIP");
  });
});
