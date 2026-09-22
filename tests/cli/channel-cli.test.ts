/**
 * #1890 — `tandem channel` must survive a Tandem that is not up yet.
 *
 * The plugin spawns this as an MCP server the moment Claude Code starts, which
 * is routinely before the desktop app has finished booting. A fatal `/health`
 * preflight killed the host before `runChannel` installed the never-exiting
 * consumer, taking the push path out for the rest of the session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runChannel } from "../../src/channel/run.js";
import { runChannelCli } from "../../src/cli/channel.js";

vi.mock("../../src/channel/run.js", () => ({
  runChannel: vi.fn(async () => {}),
}));

// A throwing process.exit, so an exit is observable rather than killing the
// vitest worker — the same pattern `preflight.test.ts` uses.
class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
  }
}

describe("runChannelCli (#1890)", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitSignal(code ?? 0);
    }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // Everything a preflight probe could reach refuses the connection.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    vi.mocked(runChannel).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves and hands off even with the server down", async () => {
    await expect(runChannelCli()).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(runChannel).toHaveBeenCalled();
  });

  it("leaves the consumer's own non-fatal probe armed", async () => {
    await runChannelCli();
    // Not `skipReachabilityLog: true`: dropping the fatal preflight while
    // keeping the flag would remove the exit AND the last DOWN-SERVER
    // diagnostic on this path. (Only the down case — the surviving probe is a
    // raw TCP connect and cannot see an unhealthy server.)
    const opts = vi.mocked(runChannel).mock.calls[0]?.[0];
    expect(opts?.skipReachabilityLog).not.toBe(true);
  });
});
