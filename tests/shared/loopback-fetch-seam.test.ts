import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #2422 seam: every other suite runs with `loopbackFetch` delegating to the
 * global `fetch` (tests/setup/loopback-fetch-passthrough.ts), so a request that
 * slipped back to the global `fetch` in a program that carries the token would
 * be invisible to them. Pinned here from source, for `src/cli`, `src/channel`,
 * `src/monitor` and `src/shared`:
 *
 * - the bare identifier `fetch` appears nowhere but `typeof fetch` and an
 *   object key (`fetch: loopbackFetch`): a call, `= fetch`, `fetchImpl: fetch`,
 *   a shorthand `{ fetch }`, `cond ? x : fetch`, `return fetch`, `fetch.call(…)`
 *   and an argument are all caught;
 * - `globalThis.fetch` and `window.fetch` are forbidden;
 * - `undici` is imported only by `loopback-fetch.ts`, so no second, dispatcher-less
 *   `fetch` can be reached under another name;
 * - `node:http` and `node:https` are imported only by `doctor.ts`, whose two
 *   probes pass a private agent (asserted below: an env proxy sends an
 *   absolute-form request through the default agent, which no `CONNECT`
 *   recorder shows).
 *
 * What this cannot see: a request made some other way (a spawned `curl`, a
 * websocket). The real-process tests cover the programs' actual behaviour.
 */
const ROOT = resolve(__dirname, "../..");
const DIRS = ["src/cli", "src/channel", "src/monitor", "src/shared"];
const LOOPBACK = "src/shared/loopback-fetch.ts";
const HTTP_ALLOWED = new Set(["src/cli/doctor.ts"]);

// `fetch` not part of a longer name, a property (`x.fetch`), a path (`a-fetch.js`).
const BARE_FETCH = /(?<![\w.$/-])fetch\b(?!\s*:)/m;
const GLOBAL_FETCH = /\b(?:globalThis|window|self)\.fetch\b/m;
const UNDICI_IMPORT =
  /from\s+["']undici["']|require\(\s*["']undici["']\s*\)|import\(\s*["']undici["']\s*\)/m;
const HTTP_IMPORT =
  /from\s+["']node:https?["']|from\s+["']https?["']|require\(\s*["'](?:node:)?https?["']\s*\)/m;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

function sources(): { rel: string; code: string }[] {
  return DIRS.flatMap((d) => walk(join(ROOT, d))).map((f) => ({
    rel: f.slice(ROOT.length + 1).replace(/\\/g, "/"),
    code: readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/typeof\s+fetch\b/g, "typeof _"),
  }));
}

describe("no path around loopbackFetch in the programs that carry the token (#2422)", () => {
  it("finds the files it is meant to scan", () => {
    const rels = sources().map((s) => s.rel);
    expect(rels).toContain("src/cli/rotate-token.ts");
    expect(rels).toContain("src/cli/license.ts");
    expect(rels).toContain("src/shared/auth-fetch.ts");
  });

  it("uses loopbackFetch, never the bare or global fetch", () => {
    const offenders = sources()
      .filter((s) => s.rel !== LOOPBACK && (BARE_FETCH.test(s.code) || GLOBAL_FETCH.test(s.code)))
      .map((s) => s.rel);
    expect(offenders).toEqual([]);
  });

  it("imports undici only in loopback-fetch.ts", () => {
    expect(
      sources()
        .filter((s) => s.rel !== LOOPBACK && UNDICI_IMPORT.test(s.code))
        .map((s) => s.rel),
    ).toEqual([]);
  });

  it("imports node:http / node:https only in doctor.ts", () => {
    expect(
      sources()
        .filter((s) => !HTTP_ALLOWED.has(s.rel) && HTTP_IMPORT.test(s.code))
        .map((s) => s.rel),
    ).toEqual([]);
  });

  it("the doctor's request sites all pass the private agent", () => {
    const doctor = sources().find((s) => s.rel === "src/cli/doctor.ts")?.code ?? "";
    const sites = doctor.match(/(?<![\w.$])request\(/g) ?? [];
    const agents = doctor.match(/agent:\s*PROBE_AGENT\b/g) ?? [];
    expect(sites.length).toBeGreaterThan(0);
    expect(agents.length).toBe(sites.length);
    expect(doctor).toMatch(/const PROBE_AGENT = new Agent\(\)/);
  });
});
