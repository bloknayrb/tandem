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
});
