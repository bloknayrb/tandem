import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #2422 seam: every other suite runs with `loopbackFetch` delegating to the
 * global `fetch` (tests/setup/loopback-fetch-passthrough.ts), so a request that
 * slipped back to a bare `fetch(` in a program that carries the token would be
 * invisible to them. Pin it from source: the stdio bridge, `rotate-token`, the
 * shim, the monitor and the shared helpers make no bare `fetch(` call.
 */
const ROOT = resolve(__dirname, "../..");
const DIRS = ["src/cli", "src/channel", "src/monitor", "src/shared"];
const ALLOWED = new Set(["src/shared/loopback-fetch.ts"]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("no bare fetch() in the programs that carry the token (#2422)", () => {
  it("finds the files it is meant to scan", () => {
    const files = DIRS.flatMap((d) => walk(join(ROOT, d)));
    expect(files.some((f) => f.endsWith("rotate-token.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("auth-fetch.ts"))).toBe(true);
  });

  it("calls loopbackFetch, never a bare fetch", () => {
    const offenders: string[] = [];
    for (const f of DIRS.flatMap((d) => walk(join(ROOT, d)))) {
      const rel = f.slice(ROOT.length + 1).replace(/\\/g, "/");
      if (ALLOWED.has(rel)) continue;
      const code = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      if (/(^|[^\w.$])fetch\s*\(/m.test(code)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
