import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Spawn-level guard for the `tandem monitor` subcommand.
 *
 * Complements tests/monitor/entry-runtime-split.test.ts (the structural guard):
 * this actually runs `tandem monitor` end-to-end and asserts main() starts
 * exactly ONCE. It closes the untested subcommand-dispatch seam (does the CLI
 * even route `monitor` to the runtime?) and catches any regression that makes
 * the runtime self-invoke on top of the CLI's explicit main() call.
 *
 * Points the monitor at a dead port so it logs its one startup line and then
 * spins in reconnect backoff without ever connecting — we kill it before it
 * matters. Startup ("Tandem monitor starting …") goes to stderr via
 * console.error (STDOUT IS RESERVED, CLAUDE.md rule #3), logged once in main()
 * before the connect loop; reconnect attempts log different lines, so a second
 * "starting" would mean main() ran twice. Mirrors the spawn harness in
 * tests/cli/mcp-stdio.test.ts.
 */

const STARTING_RE = /Tandem monitor starting/g;

let child: ChildProcessWithoutNullStreams | undefined;

afterEach(() => {
  child?.kill();
  child = undefined;
});

describe("tandem monitor subcommand", () => {
  it("dispatches to the runtime and starts main() exactly once", async () => {
    const cliEntry = resolve(__dirname, "../../src/cli/index.ts");
    child = spawn(process.execPath, ["--import", "tsx", cliEntry, "monitor"], {
      env: {
        ...process.env,
        // Dead port: the monitor logs "starting" then loops in backoff.
        TANDEM_URL: "http://127.0.0.1:1",
        // Run as production would (redirect active, no auto-run short-circuit),
        // not as a vitest child — this exercises the real `tandem monitor` path.
        VITEST: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stderrChunks: string[] = [];
    const stdoutChunks: string[] = [];
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c.toString("utf8")));
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c.toString("utf8")));

    // Give the process time to boot (--import tsx startup is slow) and to
    // run several reconnect cycles, so a doubled main() would have surfaced
    // its second "starting" line by now.
    await new Promise((r) => setTimeout(r, 4_000));

    const stderr = stderrChunks.join("");
    const matches = stderr.match(STARTING_RE) ?? [];
    expect(matches.length, `stderr=\n${stderr}`).toBe(1);

    // The startup line must not leak onto stdout (reserved for the plugin
    // host line protocol) — a connect never succeeds here, so stdout stays
    // empty of event lines too.
    expect(stdoutChunks.join("")).not.toMatch(/Tandem monitor starting/);
  }, 30_000);
});
