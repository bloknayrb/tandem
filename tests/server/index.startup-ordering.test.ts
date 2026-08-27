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
   * So this derives the set rather than listing it. Any imported binding whose
   * name starts `open`/`restore`/`maybeOpen` counts as a document open, and
   * every call site of every one of them must precede the earliest bind.
   * Adding a fifth startup open is then covered automatically — provided it is
   * named in that vocabulary, which is the honest limit of a text derivation.
   * The named-anchor assertion below is what makes a rename out of the
   * vocabulary fail loudly instead of silently shrinking the set.
   */
  it("awaits every startup document open before the earliest server bind", async () => {
    const indexPath = path.resolve(fileURLToPath(import.meta.url), "../../../src/server/index.ts");
    const src = await readFile(indexPath, "utf8");

    // Local binding names, so `import { x as openThing }` is caught and a
    // same-named local helper from an unimported module is not.
    const opens = new Set<string>();
    for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']\.[^"']*["']/gs)) {
      for (const spec of m[1].split(",")) {
        const local = spec
          .trim()
          .split(/\s+as\s+/)
          .pop()
          ?.trim();
        if (local && /^(open|restore|maybeOpen)[A-Z]/.test(local)) opens.add(local);
      }
    }

    // Positive anchor: a zero-length set would satisfy "every call site
    // precedes the bind" vacuously, and a rename out of the prefix vocabulary
    // is exactly how the set would silently shrink to zero.
    for (const expected of [
      "restoreCtrlSession",
      "restoreOpenDocuments",
      "openFileByPath",
      "maybeOpenStartupFile",
    ]) {
      expect(
        opens,
        `expected ${expected} to still be a startup open — if it was renamed, update this anchor and the prefix vocabulary above`,
      ).toContain(expected);
    }

    // The bind side is derived the same way: `startHocuspocus(wsPort)` is not
    // the only bind, and matching its call text alone is how an aliased or
    // added bind contributes nothing to the check.
    const bindIdxs: number[] = [];
    for (const bind of ["startHocuspocus", "startMcpServerHttp", "startMcpServerStdio"]) {
      expect(opens, `${bind} must not itself be classed as an open`).not.toContain(bind);
      for (const m of src.matchAll(new RegExp(`\\b${bind}\\(`, "g"))) {
        bindIdxs.push(m.index as number);
      }
    }
    expect(bindIdxs.length, "expected at least one server bind call site").toBeGreaterThan(0);
    const firstBind = Math.min(...bindIdxs);

    let sites = 0;
    for (const name of opens) {
      for (const m of src.matchAll(new RegExp(`\\b${name}\\(`, "g"))) {
        const idx = m.index as number;
        // No filter narrowing this to main()'s body. A call site hoisted into
        // a helper is exactly the restructure that would slip a late open past
        // a body-scoped scan, so every call site in the file is in scope. That
        // makes a legitimately-late helper a false positive — deliberately: a
        // red test forcing someone to reason about bind ordering beats a hole.
        sites += 1;
        expect(idx, `${name}() must be called before the server binds`).toBeLessThan(firstBind);
        const lineStart = src.lastIndexOf("\n", idx) + 1;
        expect(
          src.slice(lineStart, idx + name.length + 1),
          `${name}() must be awaited — fire-and-forget races the bind it is ordered against`,
        ).toMatch(new RegExp(`\\bawait\\s+${name}\\($`));
      }
    }
    expect(sites, "expected startup opens to actually be called in main()").toBeGreaterThan(3);
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
