/**
 * `startMcpServerStdio` threads the live ports into `tandem_diagnostics`.
 *
 * #1806 made the CLI doctor and the HTTP embedders probe the ports the server
 * actually binds (`TANDEM_PORT` / `TANDEM_MCP_PORT`), but the stdio path still
 * built its server with no ports at all, so `tandem_diagnostics` over stdio on
 * a moved install probed 3478/3479, reported them not listening and prescribed
 * a second instance. `index.ts` resolves the ports once; this pins that the
 * stdio entry carries them the whole way to the collector.
 *
 * `runDoctor` is mocked at the module boundary: the real collector reads the
 * caller's HOME and walks PATH, and neither belongs in a wiring test.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDoctor } from "../../src/cli/doctor.js";
import { startMcpServerStdio } from "../../src/server/mcp/server.js";

vi.mock("../../src/cli/doctor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cli/doctor.js")>();
  const stub: import("../../src/cli/doctor.js").DoctorReport = {
    ok: true,
    crashed: false,
    failures: 0,
    warnings: 0,
    summary: "All checks passed.",
    error: null,
    results: [{ check: "health", status: "pass", message: "stubbed" }],
  };
  return { ...actual, runDoctor: vi.fn(async () => stub) };
});

describe("startMcpServerStdio port threading", () => {
  let client: Client | null = null;

  afterEach(async () => {
    await client?.close();
    client = null;
    vi.mocked(runDoctor).mockClear();
  });

  it("hands the resolved ports to tandem_diagnostics, not the defaults", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await startMcpServerStdio({ wsPort: 1234, mcpPort: 5678 }, serverTransport);
    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);

    const result = (await client.callTool({ name: "tandem_diagnostics", arguments: {} })) as {
      structuredContent?: { transport?: string };
    };

    // Exactly-once with exactly these: a fix that threads only one of the two
    // `??` reads, or none, lands on 3478/3479 here and fails.
    expect(vi.mocked(runDoctor)).toHaveBeenCalledExactlyOnceWith({ wsPort: 1234, mcpPort: 5678 });
    expect(result.structuredContent?.transport).toBe("stdio");
  });
});
