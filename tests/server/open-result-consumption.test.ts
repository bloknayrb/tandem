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
 *      existing clients reads — with nothing in this repo going red. The check
 *      is on the RESPONSE BODY, not on the module: whatever is in it after the
 *      projection is blanked out must name no open result. A site that reads
 *      named fields off one passes, because it leaves nothing behind.
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
    "server/documents/reload-family.ts": "throws RELOAD_IN_PROGRESS / withholds its own toast",
  };

  it("is called from exactly the modules that are known to handle a skip", () => {
    expect(
      callSitesOf("reloadFromDisk"),
      "a new caller must decide what a skipped reload means for it — see this file's header, then add it here",
    ).toEqual(Object.keys(CALLERS).sort());
  });

  /**
   * Every syntactic form that genuinely CONSUMES the boolean.
   *
   * Exported from the spec body so the vacuity control below can attack the
   * same array the real check uses — a control built from its own private copy
   * proves nothing about the matcher in service.
   */
  const CONSUMING = [
    // `const ok = await f(…)` / `let ok = f(…)`, including destructures
    /(?:const|let|var)\s+[\w${}[\],\s:]+=\s*(?:await\s+)?reloadFromDisk\s*\(/,
    // `x = await f(…)` / `this.ok = f(…)` / `arr[i] = f(…)`
    /[\w$\].)]\s*=\s*(?:await\s+)?reloadFromDisk\s*\(/,
    // `return f(…)` / `return await f(…)`
    /return\s+(?:await\s+)?reloadFromDisk\s*\(/,
    // `if (await f(…))`, `if (!(await f(…)))`, `while (…)`
    /(?:if|while)\s*\(\s*!*\(?\s*(?:await\s+)?reloadFromDisk\s*\(/,
    // `a && f(…)`, `a ?? f(…)`, `c ? f(…) : x`
    /(?:&&|\|\||\?\??|:)\s*!*\(?\s*(?:await\s+)?reloadFromDisk\s*\(/,
  ];

  const CALL_RE = /(?<![\w$.])reloadFromDisk\s*\(/;

  /**
   * The function's own declaration, which matches the call shape.
   *
   * The previous denylist never needed this: none of its four patterns
   * described a declaration. An allowlist sees every match, so the definition
   * has to be excluded explicitly — that is the cost of failing closed, and it
   * is the right cost. The trailing `(?![\\w$])` is load-bearing: without it
   * this also skips `const reloadFromDiskResult = f(reloadFromDisk(x))`, so the
   * fix for a false positive would have opened a hole.
   */
  const DECLARATION = /\b(?:function|const|let|var)\s+reloadFromDisk(?![\w$])/;

  it("no call site discards the result", () => {
    // **This enumerates the CONSUMING forms, not the discarding ones**, and the
    // direction is the whole design. Two successive denylists were defeated.
    // First a line-anchored check, by `await Promise.all([reloadFromDisk(...)])`.
    // Then the four-shape list that replaced it, by
    // `paths.map((p) => reloadFromDisk(p))` — #1641's exact defect, in an
    // already-listed module, while the comment right here claimed that class was
    // fixed. `setTimeout(() => reloadFromDisk(p), 0)` and
    // `void (async () => { await reloadFromDisk(p); })()` walk the same gap.
    //
    // A denylist of discard shapes is bounded by whoever wrote it. The set of
    // ways to CONSUME a value is bounded by the language. So every call site
    // must match one of `CONSUMING`, and anything unrecognised is an offender:
    // a new legitimate idiom fails this spec and gets added deliberately, which
    // is the failure direction we want. The alternative is a new idiom joining
    // the allowed set in silence.
    //
    // An unused `const` is caught by `noUnusedLocals`, not here.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      for (const line of stripNonCode(file.text).split("\n")) {
        if (!CALL_RE.test(line)) continue;
        if (DECLARATION.test(line)) continue;
        if (!CONSUMING.some((re) => re.test(line))) {
          offenders.push(`${file.rel}: ${line.trim()}`);
        }
      }
    }
    expect(
      offenders,
      "the return value is the claim's warrant — read it. If this is a legitimate consuming form CONSUMING does not know about, add it there rather than working around it",
    ).toEqual([]);
  });

  it("the consuming-form allowlist rejects the shapes that defeated its predecessors", () => {
    // An allowlist broad enough to match everything passes the spec above while
    // constraining nothing, and looks identical in the output. These are the
    // four forms that actually got through a previous version of this check,
    // written as the source lines they appeared as. Each must be judged an
    // offender by the SAME array the real spec uses.
    const KNOWN_DISCARDS = [
      "await reloadFromDisk(id, filePath, format);",
      "void reloadFromDisk(id, filePath, format);",
      "await Promise.all([reloadFromDisk(id, filePath, format)]);",
      "const tasks = paths.map((p) => reloadFromDisk(p));",
      "setTimeout(() => reloadFromDisk(p), 0);",
      "reloadFromDisk(id, filePath, format).catch(() => {});",
    ];
    for (const line of KNOWN_DISCARDS) {
      expect(CALL_RE.test(line), `control: the call matcher sees \`${line}\``).toBe(true);
      expect(
        CONSUMING.some((re) => re.test(line)),
        `\`${line}\` discards the result and must not be recognised as consuming`,
      ).toBe(false);
    }

    // And the positive half: the forms that ARE consuming must be recognised,
    // or the spec above would report every real call site as an offender and
    // the next person would widen CONSUMING until the noise stopped.
    const KNOWN_CONSUMERS = [
      "const reloaded = await reloadFromDisk(id, filePath, format);",
      "if (!(await reloadFromDisk(id, filePath, format))) return false;",
      "return reloadFromDisk(id, filePath, format);",
      "const ok = didWrite && (await reloadFromDisk(id, filePath, format));",
    ];
    // The declaration exclusion must skip the definition and NOTHING else.
    expect(
      DECLARATION.test("export async function reloadFromDisk("),
      "control: the definition is excluded",
    ).toBe(true);
    expect(
      DECLARATION.test("const reloadFromDiskResult = wrap(reloadFromDisk(id));"),
      "a similarly-named binding must not launder a real call past the check",
    ).toBe(false);

    for (const line of KNOWN_CONSUMERS) {
      expect(
        CONSUMING.some((re) => re.test(line)),
        `\`${line}\` consumes the result and must be recognised`,
      ).toBe(true);
    }
  });
});

const ENTRY_POINTS = "openFromDisk|openFromUpload|openScratchpad|openFromRestore";

/**
 * Modules that hand an open result to a client, derived rather than listed.
 *
 * A module qualifies when it both calls an open entry point AND writes a
 * response — `res.json` for the HTTP wire, `mcpSuccess` for the MCP one.
 */
function shippingModules(): Array<{ rel: string; code: string }> {
  const ENTRY = new RegExp(`(?<![\\w$.])(${ENTRY_POINTS})\\s*\\(`);
  const RESPONDS = /(?<![\w$.])(res\s*(\.\w+\s*\([^)]*\))?\.json|mcpSuccess)\s*\(/;
  return sourceFiles()
    .map((f) => ({ rel: f.rel, code: stripNonCode(f.text) }))
    .filter(({ code }) => ENTRY.test(code) && RESPONDS.test(code))
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

/** The argument text of every `res.json(…)` / `mcpSuccess(…)` call, paren-balanced. */
function responseArguments(code: string): string[] {
  const open = /(?<![\w$.])(res\s*(\.\w+\s*\([^)]*\))?\.json|mcpSuccess)\s*\(/g;
  const out: string[] = [];
  for (const m of code.matchAll(open)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const from = i;
    while (i < code.length && depth > 0) {
      if (code[i] === "(") depth += 1;
      else if (code[i] === ")") depth -= 1;
      i += 1;
    }
    out.push(code.slice(from, i - 1));
  }
  return out;
}

/**
 * Calls that provably do not put an `OpenSuccess` anywhere, blanked out before
 * the response argument is inspected.
 *
 * Three names, each earning its place: `toWireResult` and `sendOpenResult` are
 * the projection, and `openResultMessage` returns a **string**. Anything else
 * receiving an open result inside a response argument is the thing this guard
 * is looking for, so the list stays this short on purpose — every addition is a
 * new way for the object to reach a client unprojected.
 */
const SAFE_CONSUMERS = "toWireResult|sendOpenResult|openResultMessage";

function blankSafeConsumers(text: string): string {
  // Paren-balanced, not `\([^()]*\)`. A regex that cannot cross a nested paren
  // reported `res.json({ data: toWireResult(await openFromDisk(p)) })` — a
  // CORRECT projection — as a leak: the projector call never matched, so the
  // inner entry-point call was left standing. A guard whose job is to fail on
  // the leak must not fail on the fix; that error trains the next reader to
  // edit the guard.
  const head = new RegExp(`(?<![\\w$.])(${SAFE_CONSUMERS})\\s*\\(`, "g");
  const chars = [...text];
  for (const m of text.matchAll(head)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    while (i < text.length && depth > 0) {
      if (text[i] === "(") depth += 1;
      else if (text[i] === ")") depth -= 1;
      i += 1;
    }
    for (let j = m.index ?? 0; j < i; j += 1) chars[j] = " ";
  }
  return chars.join("");
}

/** Names bound to an open result, e.g. `const result = await openFromDisk(…)`. */
function openResultBindings(code: string): string[] {
  const decl = new RegExp(
    `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?(?:${ENTRY_POINTS})\\s*\\(`,
    "g",
  );
  return [...code.matchAll(decl)].map((m) => m[1] as string);
}

describe("an open result reaches a client only through the projection", () => {
  /**
   * The obligation, checked where it actually binds: the response argument.
   *
   * **Three drafts, three defeats, and the shape of all three is why this one
   * looks nothing like them.** The first asserted which modules CALL
   * `toWireResult` — the wrong polarity, red on a new *correct* projector and
   * green on the leak. The second derived the shipping modules correctly but
   * exempted `mcp/convert.ts` BY MODULE, and a mutation planting a real leak
   * inside that module stayed green. The third scoped the check to declared
   * bindings and skipped any file containing a projector call anywhere — which
   * is the same module-wide exemption again, in a shape I did not recognize
   * because I had just written a comment claiming to have removed it. It lost
   * to both `res.json({ data: await openFromDisk(p) })` (no binding to find)
   * and to a second handler added to `mcp/document.ts` (whose `tandem_open`
   * already calls the projector, so the whole file was skipped).
   *
   * Every one of those failures came from checking a MODULE. So this checks
   * the response argument itself: whatever is left in it after blanking the
   * three calls that provably do not emit an `OpenSuccess` must contain no open
   * entry-point call and no open-result binding. Cherry-picking passes because
   * `result.fileName` leaves no bare `result`; the projection passes because it
   * is blanked; a raw union in either form fails.
   */
  it("no response body carries an unprojected open result", () => {
    const bare = new RegExp(`(?<![\\w$.])(${ENTRY_POINTS})\\s*\\(`);
    const offenders: string[] = [];
    for (const { rel, code } of shippingModules()) {
      const names = openResultBindings(code);
      for (const arg of responseArguments(code)) {
        const rest = blankSafeConsumers(arg);
        if (bare.test(rest)) {
          offenders.push(`${rel}: opens inline inside a response body`);
          continue;
        }
        for (const name of names) {
          if (new RegExp(`(?<![\\w$.])${name}(?![\\w$\\s]*\\.)`).test(rest)) {
            offenders.push(`${rel}: \`${name}\` reaches a response body unprojected`);
          }
        }
      }
    }
    expect(
      offenders,
      "an open result must be projected (sendOpenResult for HTTP, toWireResult for MCP) or read field-by-field before it goes in a response body",
    ).toEqual([]);
  });

  it("finds the modules that ship one at all", () => {
    // A derivation that derives nothing satisfies the check above no matter how
    // broken it is. The positive anchor: a regex that stops matching turns this
    // red rather than quietly making the guard vacuous.
    const rels = shippingModules().map((m) => m.rel);
    expect(rels).toContain("server/mcp/document.ts");
    expect(rels).toContain("server/mcp/routes/open.ts");
    expect(rels).toContain("server/mcp/routes/upload.ts");
    expect(rels).toContain("server/mcp/routes/scratchpad.ts");
  });

  it("reads the response bodies it claims to read", () => {
    // The second anchor, on the extractor rather than the derivation: a
    // paren-balanced scan that returned nothing would make the check above
    // pass no matter what `src/` contained.
    //
    // Deliberately NOT "one of document.ts's bodies contains `toWireResult`",
    // which an earlier draft asserted. That goes red on a refactor hoisting the
    // projection to `const wire = toWireResult(result)` one line up — a legal,
    // behaviour-identical edit. An anchor that fires on a legal edit teaches
    // the next reader to edit the anchor.
    const doc = shippingModules().find((m) => m.rel === "server/mcp/document.ts");
    expect(
      responseArguments(doc?.code ?? "").length,
      "document.ts writes several response bodies",
    ).toBeGreaterThan(1);

    // And the nesting the real bodies depend on, pinned deterministically.
    expect(responseArguments("mcpSuccess({ a: f(g(1)), b: 2 }) res.json({ c: 3 })")).toEqual([
      "{ a: f(g(1)), b: 2 }",
      "{ c: 3 }",
    ]);
  });

  it("tells a cherry-pick, a projection and a leak apart", () => {
    // The rule itself, on synthetic input — the three cases `src/` does not
    // currently contain all at once, so the discrimination is asserted by
    // something rather than inferred from an empty offender list.
    const check = (body: string, names: string[]) => {
      // Through `stripNonCode` first, exactly as the real sweep does. Skipping
      // it made the `...toWireResult(result)` row read as a leak: the blanking
      // regex has a `(?<![\w$.])` lookbehind so that `foo.toWireResult(` — a
      // different function sharing the name — is not treated as the projector,
      // and a literal spread's third dot trips it. `stripNonCode` normalizes
      // `...` to a space, which is why production code passes and only this
      // hand-written input did not.
      const rest = blankSafeConsumers(stripNonCode(body));
      const bare = new RegExp(`(?<![\\w$.])(${ENTRY_POINTS})\\s*\\(`);
      if (bare.test(rest)) return "leak";
      for (const n of names) {
        if (new RegExp(`(?<![\\w$.])${n}(?![\\w$\\s]*\\.)`).test(rest)) return "leak";
      }
      return "ok";
    };
    expect(check("{ id: result.documentId }", ["result"]), "cherry-pick").toBe("ok");
    expect(check("{ ...toWireResult(result) }", ["result"]), "projection").toBe("ok");
    expect(check("{ data: result }", ["result"]), "bare binding").toBe("leak");
    expect(check("{ ...result }", ["result"]), "spread binding").toBe("leak");
    expect(check("{ data: await openFromDisk(p) }", []), "inline open").toBe("leak");
  });

  it("the three HTTP routes go through the shared sender, not their own res.json", () => {
    // Narrower than the check above and still worth keeping: a route may meet
    // the obligation by calling `toWireResult` itself, which is correct but
    // re-opens the three-places-to-forget problem `sendOpenResult` closed.
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
