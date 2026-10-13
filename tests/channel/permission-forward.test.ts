/**
 * What the channel shim's permission relay puts on the wire (#1884).
 *
 * Claude Code's `permission_request` notification carries `input_preview` —
 * the approval prompt's payload: file bodies for a `Write`, the command line
 * for a `Bash`. `POST /api/channel-permission` is a `NON_LOOPBACK_ALLOWED`
 * route, so under Cowork that body crosses the LAN in plaintext, and the
 * server discards the field on arrival anyway (#1794). The shim must therefore
 * not send it. Its `PermissionRequestSchema` omits the field, so the SDK's
 * parse strips it before the handler runs, and the handler forwards only the
 * three named fields.
 *
 * Drives the real handler: the SDK `Server` is replaced by a shell that hands
 * back what `setNotificationHandler` registered, the notification is parsed
 * through the registered schema exactly as the SDK would, and the POST body
 * is read off the fetch stub. A source-text sweep could not tell a forwarded
 * field from one merely mentioned in a comment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodTypeAny } from "zod";
import { createFetchStub } from "../monitor/fetch-harness.js";

type Registered = { schema: ZodTypeAny; handler: (notification: unknown) => Promise<void> };

const { registered } = vi.hoisted(() => ({ registered: [] as Registered[] }));

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: class {
    setRequestHandler(): void {}
    setNotificationHandler(schema: ZodTypeAny, handler: Registered["handler"]): void {
      registered.push({ schema, handler });
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

describe("channel shim permission relay body (#1884)", () => {
  let stub: ReturnType<typeof createFetchStub>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    registered.length = 0;
    stub = createFetchStub();
    stub.install();
    vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
  });
  afterEach(() => {
    stub.restore();
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("forwards requestId, toolName and description — never the prompt's input_preview", async () => {
    stub.on(
      "/api/channel-permission",
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const { runChannel } = await import("../../src/channel/run.js");
    await runChannel({ skipReachabilityLog: true });

    expect(registered).toHaveLength(1);
    const { schema, handler } = registered[0]!;
    const preview = "rm -rf / --no-preserve-root";
    const raw = {
      method: "notifications/claude/channel/permission_request",
      params: {
        request_id: "req_1",
        tool_name: "Bash",
        description: "Run the cleanup script",
        input_preview: preview,
      },
    };
    // Through the registered schema, as the SDK does before invoking a handler.
    await handler(schema.parse(raw));

    const post = stub.calls.find((c) => c.url.includes("/api/channel-permission"));
    expect(post).toBeDefined();
    const body = String(post?.init?.body);
    expect(JSON.parse(body)).toEqual({
      requestId: "req_1",
      toolName: "Bash",
      description: "Run the cleanup script",
    });
    expect(body).not.toContain(preview);
    expect(body).not.toContain("inputPreview");
  });
});

/**
 * A licence-refused relay is logged as a licence refusal, once per refused
 * stretch, not as a plain 403 (#1521). The latch lives inside `runChannel`:
 * the two licence cases below run back to back against the same cached module
 * and each expects exactly one licence line, which a module-level latch would
 * fail on the second.
 */
describe("channel shim permission relay under a licence refusal (#1521)", () => {
  let stub: ReturnType<typeof createFetchStub>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let status = 403;
  let body: unknown = {};

  beforeEach(() => {
    registered.length = 0;
    stub = createFetchStub();
    stub.install();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    status = 403;
    body = { error: "LICENSE_REQUIRED", kind: "unlicensed", message: "AI is off (test copy)" };
    stub.on("/api/channel-permission", () => new Response(JSON.stringify(body), { status }));
  });
  afterEach(() => {
    stub.restore();
    vi.restoreAllMocks();
  });

  async function relay(): Promise<void> {
    const { schema, handler } = registered[registered.length - 1]!;
    await handler(
      schema.parse({
        method: "notifications/claude/channel/permission_request",
        params: { request_id: "r", tool_name: "Bash", description: "d" },
      }),
    );
  }
  const lines = (): string[] => errorSpy.mock.calls.map((c: unknown[]) => c.map(String).join(" "));
  const licenceLines = () => lines().filter((l) => l.includes("Permission relay refused"));

  for (const round of [1, 2]) {
    it(`logs the licence line once across two refused relays (run ${round})`, async () => {
      const { runChannel } = await import("../../src/channel/run.js");
      await runChannel({ skipReachabilityLog: true });
      await relay();
      await relay();
      expect(licenceLines()).toHaveLength(1);
      expect(licenceLines()[0]).toContain("AI is off (test copy)");
      expect(lines().some((l) => l.includes("the request is dropped"))).toBe(false);
    });
  }

  it("the twin: a plain 403 (not a licence body) still logs the dropped line", async () => {
    body = { error: "FORBIDDEN", message: "nope" };
    const { runChannel } = await import("../../src/channel/run.js");
    await runChannel({ skipReachabilityLog: true });
    await relay();
    expect(licenceLines()).toHaveLength(0);
    expect(lines().some((l) => l.includes("HTTP 403") && l.includes("dropped"))).toBe(true);
  });

  it("a successful relay re-arms the latch", async () => {
    const { runChannel } = await import("../../src/channel/run.js");
    await runChannel({ skipReachabilityLog: true });
    await relay();
    status = 200;
    body = { ok: true };
    await relay();
    status = 403;
    body = { error: "LICENSE_REQUIRED", message: "AI is off (test copy)" };
    await relay();
    expect(licenceLines()).toHaveLength(2);
  });
});
