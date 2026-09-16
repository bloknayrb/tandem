import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = path.resolve(__dirname, "../../src/cli/index.ts");

/** Run the real CLI's `--help` the way a user does. Precedent: mcp-stdio.test.ts. */
function runHelp(): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI_ENTRY, "--help"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.on("close", (code) => resolvePromise({ code, stdout }));
  });
}

/**
 * #1823 item 11 — `--help` drift. Every dispatched command was documented
 * EXCEPT `start`, which is dispatched via the `!args[0] || args[0] === "start"`
 * arm and appeared only as bare `tandem`.
 */
describe("tandem --help (#1823)", () => {
  it("documents every command the dispatcher accepts", async () => {
    // DERIVED, not hardcoded: a fixed array would pass today and catch no
    // future drift. The dispatch literals are de-duplicated into a Set
    // because the `isStdioMode` guard repeats three of them, so a naive scan
    // returns ten literals for seven commands. The `args.includes(...)` flag
    // forms (--help, --version, --apply, --json) are out of the derivation by
    // design — they are flags, not commands.
    const src = await fs.readFile(CLI_ENTRY, "utf-8");
    const dispatched = new Set<string>();
    for (const m of src.matchAll(/args\[0\]\s*===\s*"([^"]+)"/g)) dispatched.add(m[1]);

    expect(
      dispatched.size,
      "the dispatch scan found nothing — the regex has drifted from the source",
    ).toBeGreaterThan(5);

    const { code, stdout } = await runHelp();
    expect(code).toBe(0);

    for (const cmd of dispatched) {
      expect(stdout, `\`${cmd}\` is dispatched but missing from --help`).toContain(cmd);
    }
  }, 30_000);
});
