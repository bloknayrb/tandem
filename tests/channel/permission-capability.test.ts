/**
 * The channel shim no longer asks Claude Code for tool-approval prompts
 * (#1885, closing #1884 at the source).
 *
 * Declaring `claude/channel/permission` tells Claude Code to forward every
 * approval prompt to the shim as a `permission_request` notification. Tandem
 * never had a way to answer one, so each prompt only reached a server-side
 * holding map that any local caller could read. The capability is withdrawn,
 * no notification handler is registered, and the relay routes are deleted.
 * Re-declaring the capability is a security change (ADR-047's 2026-10-28
 * update), so this file pins the declared set exactly.
 *
 * Drives the real `runChannel`: the SDK `Server` is replaced by a shell that
 * records its constructor options and every `setNotificationHandler` call.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { constructed, notificationHandlers } = vi.hoisted(() => ({
  constructed: [] as Array<{ info: unknown; options: Record<string, unknown> }>,
  notificationHandlers: [] as unknown[],
}));

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: class {
    constructor(info: unknown, options: Record<string, unknown>) {
      constructed.push({ info, options });
    }
    setRequestHandler(): void {}
    setNotificationHandler(schema: unknown): void {
      notificationHandlers.push(schema);
    }
    async connect(): Promise<void> {}
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {},
}));
// The SSE consumer never settles; it is not what this file is about.
vi.mock(import("../../src/channel/event-bridge.js"), () => ({
  startEventBridge: async () => {},
}));

const RUN_TS_PATH = fileURLToPath(new URL("../../src/channel/run.ts", import.meta.url));

/** run.ts with block and line comments removed, so the comment that explains
 *  the withdrawal can neither satisfy nor trip the sweep below. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("channel shim declares no permission capability (#1885)", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    constructed.length = 0;
    notificationHandlers.length = 0;
    vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
  });
  afterEach(() => {
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("declares exactly `claude/channel` among its experimental capabilities, and still declares tools", async () => {
    const { runChannel } = await import("../../src/channel/run.js");
    await runChannel({ skipReachabilityLog: true });

    expect(constructed).toHaveLength(1);
    const capabilities = constructed[0]?.options.capabilities as Record<string, unknown>;
    // A set pin, not a "does not contain": a renamed permission capability
    // would slip past a negative check.
    expect(capabilities.experimental).toEqual({ "claude/channel": {} });
    expect(capabilities.tools).toEqual({});
  });

  it("registers no notification handler, so a `permission_request` reaches nothing", async () => {
    const { runChannel } = await import("../../src/channel/run.js");
    await runChannel({ skipReachabilityLog: true });

    expect(constructed).toHaveLength(1);
    expect(notificationHandlers).toHaveLength(0);
  });

  it("run.ts code names neither the relay route nor the notification", async () => {
    const code = stripComments(await readFile(RUN_TS_PATH, "utf8"));
    // Positive control: the strip must leave real code behind.
    expect(code).toContain("claude/channel");
    expect(code).not.toContain("channel-permission");
    expect(code).not.toContain("API_CHANNEL_PERMISSION");
    expect(code).not.toContain("permission_request");
    expect(code).not.toContain("claude/channel/permission");
  });
});
