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
 *   2. **`OpenSuccess` must be projected through `toWireResult`** before its
 *      whole payload goes to a client. `res.json` takes `unknown` and the MCP
 *      payload is built from a spread, so shipping the internal union straight
 *      out would put `kind` on the wire and drop the three booleans every
 *      existing clients reads — with nothing in this repo going red. A site
 *      that only ever reads NAMED FIELDS off the result never puts the object
 *      anywhere, so it can neither ship `kind` nor drop a boolean; that, and
 *      not a list of trusted modules, is what the guard treats as safe.
 *
 * So the guard keys on the structural fact — WHICH modules call these — rather
 * than on any text shape inside them. A new call site is what needs a human to
 * look, and a census is what makes a new call site visible.
 *
 * **What this cannot do**, stated so nobody reads more into a green run: it
 * does not prove the existing sites consume the value *correctly*, only that
 * they consume it at all and that no new site skips the obligation. Behaviour
 * is pinned separately — #1641's toast count in
 * `adr-034-open-characterization.test.ts`, the wire key set in the same file,
 * and the round trip in `open-result-message.test.ts`.
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

  it("no call site discards the result", () => {
    // #1641's own shape is `await reloadFromDisk(...);` as a bare statement,
    // but review defeated a line-anchored version of this check with
    // `await Promise.all([reloadFromDisk(...)])` — the same defect, in an
    // already-listed module, invisible to both specs. So the discarding forms
    // are enumerated rather than assumed to be one.
    //
    // Consuming forms deliberately allowed: `if (!(await f(…)))`, `const x =
    // await f(…)`, `return f(…)`. An unused `const` is caught by
    // `noUnusedLocals`, not here.
    const DISCARDS = [
      /^\s*(await\s+)?reloadFromDisk\s*\(/, // bare statement — #1641 itself
      /^\s*void\s+reloadFromDisk\s*\(/, // explicitly thrown away
      /\[\s*reloadFromDisk\s*\(/, // Promise.all([...]) and friends
      /reloadFromDisk\s*\([^)]*\)\s*\.\s*(then|catch|finally)\s*\(/, // floating chain
    ];
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      for (const line of stripNonCode(file.text).split("\n")) {
        if (DISCARDS.some((re) => re.test(line))) offenders.push(`${file.rel}: ${line.trim()}`);
      }
    }
    expect(offenders, "the return value is the claim's warrant — read it").toEqual([]);
  });
});

/**
 * Modules that hand an open result to a client, derived rather than listed.
 *
 * A module qualifies when it both calls an open entry point AND writes a
 * response — `res.json` for the HTTP wire, `mcpSuccess` for the MCP one. That
 * is the structural fact "this module ships an open result", and it is the
 * thing the projection obligation attaches to.
 */
function shippingModules(): Array<{ rel: string; code: string }> {
  const ENTRY = /(?<![\w$.])(openFromDisk|openFromUpload|openScratchpad|openFromRestore)\s*\(/;
  const RESPONDS = /(?<![\w$.])(res\s*(\.\w+\s*\([^)]*\))?\.json|mcpSuccess)\s*\(/;
  return sourceFiles()
    .map((f) => ({ rel: f.rel, code: stripNonCode(f.text) }))
    .filter(({ code }) => ENTRY.test(code) && RESPONDS.test(code))
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Names bound to the result of an open entry point, e.g. `const result = await openFromDisk(…)`. */
function openResultBindings(code: string): string[] {
  const decl =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:openFromDisk|openFromUpload|openScratchpad|openFromRestore)\s*\(/g;
  return [...code.matchAll(decl)].map((m) => m[1] as string);
}

/**
 * Uses of `name` that are NOT a member access — i.e. the whole value, not one
 * field of it. `result.fileName` is a cherry-pick; `{ data: result }` and
 * `...result` are the whole payload.
 */
function wholeValueUses(code: string, name: string): number {
  const decl = new RegExp(`(?:const|let|var)\\s+${name}\\s*=`, "g");
  const any = new RegExp(`(?<![\\w$.])${name}(?![\\w$])(\\s*\\??\\.)?`, "g");
  let whole = 0;
  for (const m of code.matchAll(any)) {
    if (m[1]) continue; // member access
    whole += 1;
  }
  return whole - [...code.matchAll(decl)].length; // the declaration itself is not a use
}

describe("a module that ships an open result projects it", () => {
  /**
   * The obligation, per module that ships one.
   *
   * **This half had the wrong polarity and three reviewers said so.** It used
   * to assert which modules CALL `toWireResult` — which goes red when a new
   * *correct* projector appears, and stays green for the leak named in this
   * file's header. A fourth route writing `res.json({ data: result })` calls
   * the projector zero times, so the set never changed and the guard never
   * fired. A census pointed at the fix instead of the failure is not a census.
   *
   * **The first rewrite was still defeated, by its own escape hatch.** It
   * exempted `mcp/convert.ts` BY MODULE for cherry-picking two fields — and a
   * mutation planting a real leak inside that module stayed green, because a
   * module-wide exemption exempts everything the module later does. The
   * exemption was also unnecessary: `convert.ts` returns its payload to the
   * tool layer rather than writing a response, so it never entered the
   * derivation to begin with. An escape hatch nothing needed, wide enough to
   * hide the failure the census exists for.
   *
   * So there is no module list. A non-projecting shipper is allowed exactly
   * when it never uses an open result as a WHOLE VALUE — every reference is
   * `result.someField`. Cherry-picking named fields cannot ship `kind` and
   * cannot drop the booleans, because it never puts the object anywhere. That
   * is the actual reason those sites are safe, so it is what gets checked.
   */
  it("every module that ships an open result projects it or only ever cherry-picks fields", () => {
    const offenders: string[] = [];
    for (const { rel, code } of shippingModules()) {
      if (/(?<![\w$.])(toWireResult|sendOpenResult)\s*\(/.test(code)) continue;
      for (const name of openResultBindings(code)) {
        const whole = wholeValueUses(code, name);
        if (whole > 0) offenders.push(`${rel}: \`${name}\` used as a whole value ${whole}x`);
      }
    }
    expect(
      offenders,
      "this module hands a whole open result to a client without projecting it — call sendOpenResult (HTTP) or toWireResult (MCP), or read named fields off it instead",
    ).toEqual([]);
  });

  it("finds the modules that ship one at all", () => {
    // A derivation that derives nothing satisfies the filter above no matter
    // how broken it is. This is the positive anchor: the four known shippers
    // must be in the derived set, so a regex that stops matching turns this red
    // rather than quietly making the guard vacuous.
    const rels = shippingModules().map((m) => m.rel);
    expect(rels).toContain("server/mcp/document.ts");
    expect(rels).toContain("server/mcp/routes/open.ts");
    expect(rels).toContain("server/mcp/routes/upload.ts");
    expect(rels).toContain("server/mcp/routes/scratchpad.ts");
  });

  it("tells a cherry-pick apart from a whole-value use", () => {
    // The allowance above has no instance in `src/` today — every shipper
    // projects — so the rule that decides who may skip the projector is
    // otherwise asserted by nobody. `mcp/convert.ts` looked like the instance
    // and is not one: it hands its payload back to the tool layer rather than
    // writing a response, so it never enters the derivation at all. An earlier
    // draft exempted it BY MODULE anyway, and a mutation planting a real leak
    // inside that module stayed green — a module-wide exemption exempts
    // everything the module later does. Hence a rule, checked directly.
    const cherry = "const result = await openFromDisk(p); return { id: result.documentId };";
    const whole = "const result = await openFromDisk(p); res.json({ data: result });";
    const spread = "const result = await openFromDisk(p); res.json({ ...result });";

    expect(openResultBindings(cherry)).toEqual(["result"]);
    expect(wholeValueUses(cherry, "result"), "field reads are not whole-value uses").toBe(0);
    expect(wholeValueUses(whole, "result"), "passing the object is").toBe(1);
    // `stripNonCode` normalizes `...` to a space, which is how the spread
    // reaches this function in a real sweep.
    expect(wholeValueUses(stripNonCode(spread), "result"), "so is spreading it").toBe(1);
  });

  it("the three HTTP routes go through the shared sender, not their own res.json", () => {
    // Narrower than the derivation above and still worth keeping: a route may
    // satisfy the obligation by calling `toWireResult` itself, which is correct
    // but re-opens the three-places-to-forget problem `sendOpenResult` closed.
    for (const route of ["open", "upload", "scratchpad"]) {
      const text = stripNonCode(
        readFileSync(path.join(SRC, "server/mcp/routes", `${route}.ts`), "utf-8"),
      );
      expect(text, `${route}.ts should call sendOpenResult`).toMatch(/sendOpenResult\s*\(/);
      expect(text, `${route}.ts should not build the open response body itself`).not.toMatch(
        /res\s*(\.\w+\s*\([^)]*\))?\.json\s*\(\s*\{\s*data\s*:/,
      );
    }
  });
});
