import { readdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

/**
 * Two obligations that no type can carry, pinned as a census.
 *
 * TypeScript has no `#[must_use]`. Both mechanisms below hand a caller
 * something it is *required* to consume, and in both cases forgetting compiles
 * perfectly:
 *
 *   1. **`reloadFromDisk` returns `false` when it did not reload.** Discarding
 *      that is #1641 — the file-watcher told the user a reload had happened for
 *      a pass that did nothing, sometimes while the in-flight reload was still
 *      mid-transaction. It shipped that way for months alongside two sibling
 *      callers that DID check. Making the return a tagged object instead of a
 *      boolean would not have helped: discarding an object is exactly as easy.
 *   2. **`OpenSuccess` must be projected through `toWireResult`** before it
 *      goes to a client. `res.json` takes `unknown` and the MCP payload is
 *      built from a spread, so shipping the internal union straight out would
 *      put `kind` on the wire and drop the three booleans every existing client
 *      reads — with nothing in this repo going red.
 *
 * So the guard keys on the structural fact — WHICH modules call these — rather
 * than on any text shape inside them. A new call site is what needs a human to
 * look, and a census is what makes a new call site visible.
 *
 * **What this cannot do**, stated so nobody reads more into a green run: it
 * does not prove the existing sites consume the value *correctly*. It proves
 * the set has not grown. Behaviour is pinned separately — #1641's toast count
 * in `adr-034-open-characterization.test.ts`, the wire key set in the same
 * file, and the round trip in `open-result-message.test.ts`.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

/**
 * Every `.ts` under `src/`, read once.
 *
 * Deliberately the whole tree rather than a hand-listed set of directories:
 * the thing being guarded is "a call site appeared somewhere", so scoping the
 * sweep narrower than the widest place a call site could appear would let the
 * next one land outside the guard's own field of view.
 */
function sourceFiles(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".svelte")) {
        out.push({
          rel: path.relative(SRC, full).split(path.sep).join("/"),
          text: readFileSync(full, "utf-8"),
        });
      }
    }
  };
  walk(SRC);
  return out;
}

/**
 * Strip comments and string/template literals before looking for a call.
 *
 * Without this the census counts prose. `reloadFromDisk` and `toWireResult`
 * are both named in a dozen explanatory comments across `src/` — several of
 * them written by this very unit — and a guard that cannot tell a mention from
 * a call reports whatever the documentation happens to say.
 */
function stripNonCode(text: string): string {
  return (
    text
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ")
      .replace(/`(?:\\.|[^`\\])*`/g, '""')
      .replace(/"(?:\\.|[^"\\])*"/g, '""')
      .replace(/'(?:\\.|[^'\\])*'/g, '""')
      // Spread is not member access. `callSitesOf` rejects a leading `.` so that
      // `foo.toWireResult(x)` — a different function that happens to share the
      // name — does not count, and `...toWireResult(result)` was caught by that
      // rule and silently dropped `mcp/document.ts` from the census. A census
      // that quietly omits a real call site is worse than no census.
      .replace(/\.\.\./g, " ")
  );
}

/** Modules that CALL `name`, by relative path under `src/`. */
function callSitesOf(name: string): string[] {
  const call = new RegExp(`(?<![\\w$.])${name}\\s*\\(`);
  return sourceFiles()
    .filter((f) => call.test(stripNonCode(f.text)))
    .map((f) => f.rel)
    .sort();
}

describe("reloadFromDisk's skipped-reload return has to be consumed (#1641)", () => {
  /**
   * Each entry names what the caller DOES with a `false`, because that is the
   * part a new caller has to think about — and the three answers genuinely
   * differ, which is why the obligation could not be folded into the callee.
   */
  const CALLERS: Record<string, string> = {
    "server/documents/watcher.ts": "suppresses the file-reloaded toast (#1641)",
    "server/mcp/file-opener.ts": "throws RELOAD_IN_PROGRESS / withholds its own toast",
  };

  it("is called from exactly the modules that are known to handle a skip", () => {
    expect(
      callSitesOf("reloadFromDisk"),
      "a new caller must decide what a skipped reload means for it — see this file's header, then add it here",
    ).toEqual(Object.keys(CALLERS).sort());
  });

  it("no call site discards the result as a bare statement", () => {
    // The exact shape of #1641: `await reloadFromDisk(...);` on its own. A
    // consuming caller reads it into a variable or tests it inline.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      for (const line of stripNonCode(file.text).split("\n")) {
        if (/^\s*(await\s+)?reloadFromDisk\s*\(/.test(line))
          offenders.push(`${file.rel}: ${line.trim()}`);
      }
    }
    expect(offenders, "the return value is the claim's warrant — read it").toEqual([]);
  });
});

describe("OpenSuccess reaches a client only through toWireResult", () => {
  /**
   * Every module that projects. Three HTTP routes were byte-identical and now
   * share `sendOpenResult`; `tandem_open` stays separate because it is the MCP
   * wire and attaches a message.
   */
  const PROJECTORS = [
    "server/documents/open.ts",
    "server/mcp/document.ts",
    "server/mcp/routes/_shared.ts",
  ];

  it("is projected from exactly the modules that are known to ship a payload", () => {
    expect(
      callSitesOf("toWireResult"),
      "a module shipping an open result to a client must project it — do not hand out the internal union",
      // `open.ts` is the definition site and is included by the same scan; a
      // separate exemption for it would be one more thing to keep in sync.
    ).toEqual([...PROJECTORS].sort());
  });

  it("the three HTTP routes go through the shared sender, not their own res.json", () => {
    // Not a style preference: a route that rebuilds the body inline is a
    // fourth place to forget the projection, and `res.json`'s `unknown`
    // parameter means forgetting compiles.
    for (const route of ["open", "upload", "scratchpad"]) {
      const text = stripNonCode(
        readFileSync(path.join(SRC, "server/mcp/routes", `${route}.ts`), "utf-8"),
      );
      expect(text, `${route}.ts should call sendOpenResult`).toMatch(/sendOpenResult\s*\(/);
      expect(text, `${route}.ts should not build the open response body itself`).not.toMatch(
        /res\.json\s*\(\s*\{\s*data:/,
      );
    }
  });
});
