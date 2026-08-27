import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

/**
 * CLAUDE.md critical rule: "Startup document opens must precede server bind."
 *
 * The runtime alternative — importing `index.ts` and observing
 * `vi.fn().mock.invocationCallOrder` — would require stubbing ~20 transitive
 * imports (Hocuspocus, MCP server, durable-annotation store, file watcher,
 * port-resolution, etc.) before `main()` auto-runs on module load. The
 * mocking surface would itself be a maintenance hazard.
 *
 * Instead this test asserts the invariant directly against the source: the
 * `await maybeOpenStartupFile(...)` line MUST appear before the first
 * reference to `startHocuspocus(`. A future refactor that moves the await
 * below the Hocuspocus bind — the exact regression this rule guards
 * against — would fail this assertion.
 */
describe("index.ts startup ordering invariant", () => {
  it("awaits maybeOpenStartupFile before any startHocuspocus invocation", async () => {
    const indexPath = path.resolve(fileURLToPath(import.meta.url), "../../../src/server/index.ts");
    const src = await readFile(indexPath, "utf8");

    const startupCallIdx = src.indexOf("maybeOpenStartupFile(process.env.TANDEM_OPEN_FILE)");
    expect(startupCallIdx, "expected exactly one maybeOpenStartupFile call site").toBeGreaterThan(
      -1,
    );

    const hocuspocusCallIdx = src.indexOf("startHocuspocus(wsPort)");
    expect(hocuspocusCallIdx, "expected a startHocuspocus(wsPort) call site").toBeGreaterThan(-1);

    expect(
      startupCallIdx,
      "maybeOpenStartupFile must appear before startHocuspocus in source order",
    ).toBeLessThan(hocuspocusCallIdx);

    // Belt and suspenders: the call must be awaited, not fire-and-forget.
    // We look for "await maybeOpenStartupFile" within the line of the call.
    const startupLineStart = src.lastIndexOf("\n", startupCallIdx) + 1;
    const startupLineEnd = src.indexOf("\n", startupCallIdx);
    const startupLine = src.slice(
      startupLineStart,
      startupLineEnd === -1 ? src.length : startupLineEnd,
    );
    expect(
      startupLine,
      "maybeOpenStartupFile must be awaited (fire-and-forget would race the bind)",
    ).toMatch(/\bawait\s+maybeOpenStartupFile\b/);
  });

  /**
   * The spec above pins ONE call site by its literal text. Every other startup
   * document open — session restore, the post-upgrade CHANGELOG tab, the
   * first-run welcome file — had no ordering guard at all, and each is subject
   * to the same rule for the same reason: a browser that reconnects after the
   * bind but before an open sees an incomplete `openDocuments` list and
   * CRDT-merges it back over the real one.
   *
   * So this derives the set rather than listing it: any imported binding named
   * `open*`/`restore*`/`maybeOpen*` is startup work that must complete before
   * the bind, and every call site of every one of them must precede the
   * earliest bind, awaited.
   *
   * **Textual position is only a proxy for execution order, and the first
   * version of this spec was defeated by exactly that gap.** A reviewer added
   *
   *     async function openLateStartupDoc(p: string) { await openFromDisk(p); }
   *
   * above `main()` and called it immediately before `startMcpServerHttp(` — the
   * call to `openFromDisk` is textually early, the open happens after the bind,
   * and every assertion passed. That is not an exotic mutation: the two opens
   * at index.ts's version-check branch are an obvious candidate for extraction
   * into an `openStartupDocuments()` helper.
   *
   * The repair is to make the proxy sound rather than to add another position
   * check: every open must sit **directly in `main()`'s own body**, never
   * inside a nested function. Then textual order IS execution order, because
   * there is no call site that can be moved independently of its code.
   */
  it("awaits every startup document open in main(), before the earliest bind", async () => {
    const indexPath = path.resolve(fileURLToPath(import.meta.url), "../../../src/server/index.ts");
    const raw = await readFile(indexPath, "utf8");

    // Comments and string literals are blanked to spaces rather than removed,
    // so every index below still points at the real file. Scanning raw source
    // would let a comment reading `restoreOpenDocuments()` both inflate the
    // call-site count and fail the test for a prose edit.
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
      .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + " ".repeat(m.length - p1.length))
      .replace(/`(?:\\.|[^`\\])*`/g, (m) => " ".repeat(m.length))
      .replace(/'(?:\\.|[^'\\\n])*'/g, (m) => " ".repeat(m.length))
      .replace(/"(?:\\.|[^"\\\n])*"/g, (m) => " ".repeat(m.length));

    // A namespace import defeats specifier-list parsing entirely, so refuse to
    // report a verdict rather than report a clean one. Fail closed: the whole
    // point of this spec is that a new startup open cannot hide.
    expect(
      raw.match(/import\s*\*\s*as\s+\w+\s+from\s*["']\.[^"']*["']/g) ?? [],
      "index.ts uses a namespace import from a relative module — this derivation reads named specifiers only and cannot see through it. Teach it, or import by name.",
    ).toEqual([]);

    // Local binding names, so `import { x as openThing }` is caught, and the
    // optional default-import prefix so `import def, { x } from …` is too.
    const opens = new Set<string>();
    for (const m of raw.matchAll(
      /import\s*(?:type\s*)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["']\.[^"']*["']/gs,
    )) {
      for (const spec of m[1].split(",")) {
        const local = spec
          .trim()
          .split(/\s+as\s+/)
          .pop()
          ?.trim();
        if (local && /^(open|restore|maybeOpen)[A-Z]/.test(local)) opens.add(local);
      }
    }

    // Positive anchor: a zero-length set satisfies "every call site precedes the
    // bind" vacuously, and a rename out of the prefix vocabulary is exactly how
    // the set would silently shrink to zero.
    //
    // `restoreCtrlSession` is in this list but is NOT a document open — it
    // restores CTRL_ROOM state and hands back the previously-active id. It is
    // swept in because it is subject to the same before-bind rule, not because
    // the name means what the vocabulary implies.
    for (const expected of [
      "restoreCtrlSession",
      "restoreOpenDocuments",
      "openFromDisk",
      "maybeOpenStartupFile",
    ]) {
      expect(
        opens,
        `expected ${expected} to still be startup work — if it was renamed, update this anchor and the prefix vocabulary above`,
      ).toContain(expected);
    }

    // The bind side is derived too: matching `startHocuspocus(wsPort)` alone is
    // how an aliased or added bind contributes nothing. It gets the same named
    // anchor as the open side — without one, renaming or wrapping the EARLIEST
    // bind leaves this green while pushing `firstBind` later and silently
    // widening the window every open is allowed to occupy.
    const bindIdxs: number[] = [];
    for (const bind of ["startHocuspocus", "startMcpServerHttp", "startMcpServerStdio"]) {
      const sites = [...src.matchAll(new RegExp(`\\b${bind}\\(`, "g"))].map(
        (m) => m.index as number,
      );
      expect(
        sites.length,
        `expected ${bind} to still be a bind call site in index.ts`,
      ).toBeGreaterThan(0);
      bindIdxs.push(...sites);
    }
    const firstBind = Math.min(...bindIdxs);

    // Brace walk with a scope stack, so each call site's enclosing function is
    // known. `blocks` (if/try/for) do not break the ordering proxy; a nested
    // function does, because its body can be invoked from anywhere.
    interface Frame {
      isFn: boolean;
      name: string;
    }
    const stack: Frame[] = [];
    const enclosingFn = new Map<number, string>();
    const openCall = new RegExp(`\\b(${[...opens].join("|")})\\(`, "g");
    const callIdxs = new Map<number, string>();
    for (const m of src.matchAll(openCall)) callIdxs.set(m.index as number, m[1]);

    for (let i = 0; i < src.length; i += 1) {
      if (callIdxs.has(i)) {
        const fn = [...stack].reverse().find((f) => f.isFn);
        enclosingFn.set(i, fn?.name ?? "<module>");
      }
      const ch = src[i];
      if (ch === "{") {
        const before = src.slice(Math.max(0, i - 300), i).trimEnd();
        let isFn = before.endsWith("=>");
        let name = "<anonymous>";
        if (!isFn && before.endsWith(")")) {
          // Walk back to the matching "(" and read the header before it.
          let depth = 0;
          let j = before.length - 1;
          for (; j >= 0; j -= 1) {
            if (before[j] === ")") depth += 1;
            else if (before[j] === "(") {
              depth -= 1;
              if (depth === 0) break;
            }
          }
          const header = before.slice(0, j).trimEnd();
          const named = header.match(/(?:function\s*\*?\s*)?([\w$]+)\s*$/);
          // `if (…) {`, `for (…) {` etc. also end in ")" — they are blocks.
          if (named && !/^(if|for|while|switch|catch|with|return)$/.test(named[1])) {
            isFn = true;
            name = named[1];
          }
        }
        stack.push({ isFn, name });
      } else if (ch === "}") {
        stack.pop();
      }
    }

    expect(
      enclosingFn.size,
      "expected startup opens to actually be called — a zero-call-site file passes every ordering assertion",
    ).toBeGreaterThan(3);

    for (const [idx, enclosing] of enclosingFn) {
      const name = callIdxs.get(idx) as string;
      expect(
        enclosing,
        `${name}() is called from ${enclosing}(), not directly from main(). A helper is defined early and can be CALLED late, which makes source position meaningless for this rule — inline it into main(), or teach this spec to follow the helper's own call site.`,
      ).toBe("main");
      expect(idx, `${name}() must be called before the server binds`).toBeLessThan(firstBind);
      const lineStart = src.lastIndexOf("\n", idx) + 1;
      expect(
        src.slice(lineStart, idx + name.length + 1),
        `${name}() must be awaited — fire-and-forget races the bind it is ordered against`,
      ).toMatch(new RegExp(`\\bawait\\s+${name}\\($`));
    }
  });

  it("awaits best-effort existing-skill refresh before HTTP readiness in every launcher mode", async () => {
    const indexPath = path.resolve(fileURLToPath(import.meta.url), "../../../src/server/index.ts");
    const src = await readFile(indexPath, "utf8");

    const supervisorStart = src.indexOf("async function startLauncherSupervisor()");
    const supervisorEnd = src.indexOf("// Swallow known Hocuspocus/ws protocol errors");
    const supervisorBody = src.slice(supervisorStart, supervisorEnd);
    expect(supervisorBody).not.toContain("refreshSkillIfStale");
    expect(supervisorBody).not.toContain("refreshExistingSkillIfStale");

    const httpStart = src.indexOf('if (transportMode === "http")');
    const stdioStart = src.indexOf("} else {\n    // Stdio mode", httpStart);
    const httpBody = src.slice(httpStart, stdioStart);
    const refreshIdx = httpBody.indexOf("refreshExistingSkillIfStale");
    expect(refreshIdx, "HTTP startup must refresh an existing standalone skill").toBeGreaterThan(
      -1,
    );

    const bindIdx = httpBody.indexOf("startMcpServerHttp(");
    expect(bindIdx, "HTTP bind call must exist").toBeGreaterThan(-1);
    expect(refreshIdx, "skill refresh must finish before Tandem can report ready").toBeLessThan(
      bindIdx,
    );

    for (const launcherMarker of [
      'launcherUnavailableReason === "deferred-autostart"',
      'launcherUnavailableReason !== "disabled-by-env"',
      "await startLauncherSupervisor()",
    ]) {
      const markerIdx = httpBody.indexOf(launcherMarker);
      expect(markerIdx, `expected launcher branch marker: ${launcherMarker}`).toBeGreaterThan(-1);
      expect(
        refreshIdx,
        `skill refresh must precede ${launcherMarker} so launcher mode cannot suppress it`,
      ).toBeLessThan(markerIdx);
    }

    const refreshThroughBind = httpBody.slice(refreshIdx, bindIdx);
    expect(httpBody, "skill refresh import must be awaited, not fire-and-forget").toMatch(
      /\bawait\s+import\("\.\/integrations\/apply\.js"\)[\s\S]*?refreshExistingSkillIfStale\(\)/,
    );
    expect(refreshThroughBind, "unexpected refresh failures must be caught before bind").toMatch(
      /refreshExistingSkillIfStale\(\)\)[\s\S]*?\.catch\(/,
    );
    expect(refreshThroughBind, "unexpected refresh failures must stay non-fatal").toContain(
      "Skill refresh failed (non-fatal)",
    );
  });
});
