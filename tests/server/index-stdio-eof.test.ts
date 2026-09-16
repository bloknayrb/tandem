import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * #1823 item 3 — stdio mode never exited on stdin EOF.
 *
 * This is a SOURCE-SHAPE PIN, not a behaviour test, and deliberately so:
 * `src/server/index.ts` cannot be imported by a test (importing it runs
 * `main()`, which calls `freePort()` and kills whatever holds :3478/:3479), and
 * the handler has no behavioural twin to drive. `boot-order.test.ts` uses the
 * same technique for the same reason.
 */
describe("stdio stdin-EOF shutdown (#1823)", () => {
  const readIndex = () => fs.readFile(path.join(__dirname, "../../src/server/index.ts"), "utf-8");

  /** The `if (transportMode === "stdio") { ... }` block, and nothing else. */
  function stdinBlock(src: string): string {
    const start = src.indexOf('if (transportMode === "stdio") {');
    expect(start, "the stdio-gated stdin handler must exist").toBeGreaterThan(-1);
    const end = src.indexOf("\n}\n", start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  }

  it("runs the graceful shutdown on EOF instead of only logging", async () => {
    const block = stdinBlock(await readIndex());
    expect(block).toContain('process.stdin.on("end"');
    expect(block).toMatch(/shutdown\(/);
    expect(block).toContain("startupComplete");
  });

  it("arms the gate only AFTER the open-document restore", async () => {
    const src = await readIndex();
    const restoreIdx = src.indexOf("await restoreOpenDocuments");
    const armIdx = src.indexOf("startupComplete = true");
    expect(restoreIdx, "the restore must exist").toBeGreaterThan(-1);
    expect(armIdx, "the gate must be armed somewhere").toBeGreaterThan(-1);
    // An EOF before this point would reach `saveCurrentSession()`, which
    // persists the CTRL doc with no restore guard — cloning an empty, freshly
    // created ctrl doc over the user's real chat history.
    expect(armIdx).toBeGreaterThan(restoreIdx);
  });

  it("gates on the POSITIVE condition, with the immediate exit in the else arm", async () => {
    // The assertion that makes this file discriminate. An INVERTED guard
    // (`if (!startupComplete) void shutdown(...)`) references both identifiers
    // and would satisfy the first spec while doing exactly the data loss the
    // gate exists to prevent. Polarity is the contract, so it is read
    // positionally: `shutdown(` must come before `process.exit(0)`.
    const block = stdinBlock(await readIndex());
    expect(block).toMatch(/if\s*\(\s*startupComplete\s*\)/);
    const shutdownIdx = block.indexOf("shutdown(");
    const exitIdx = block.indexOf("process.exit(0)");
    expect(shutdownIdx).toBeGreaterThan(-1);
    expect(exitIdx).toBeGreaterThan(-1);
    expect(exitIdx).toBeGreaterThan(shutdownIdx);
  });
});
