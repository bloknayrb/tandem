import { describe, expect, it } from "vitest";
import { tokenMayGoTo } from "../../src/cli/mcp-stdio.js";
import {
  bearerTokenOf,
  classifyClaudeCodeTandemEntry,
} from "../../src/shared/integrations/claude-code-entry.js";

/**
 * #2358 PR 2b — the one classifier the boot migration and `tandem doctor` share,
 * and the bridge's rule for where its token may go.
 */

const BASE = "http://127.0.0.1:3479";
const TOKEN = "Z".repeat(40);

describe("classifyClaudeCodeTandemEntry", () => {
  it("recognises exactly Tandem's HTTP shape, with and without a token", () => {
    expect(classifyClaudeCodeTandemEntry({ type: "http", url: `${BASE}/mcp` }, BASE)).toEqual({
      kind: "tandem-http",
      token: undefined,
    });
    expect(
      classifyClaudeCodeTandemEntry(
        { type: "http", url: `${BASE}/mcp`, headers: { Authorization: `Bearer ${TOKEN}` } },
        BASE,
      ),
    ).toEqual({ kind: "tandem-http", token: TOKEN });
  });

  it("recognises an absolute Node running Tandem's bridge, Windows-shaped too", () => {
    expect(
      classifyClaudeCodeTandemEntry(
        {
          command: "C:\\Program Files\\nodejs\\node.exe",
          args: ["C:\\T\\dist\\stdio-bridge\\index.js"],
        },
        BASE,
      ).kind,
    ).toBe("bridge");
  });

  it("does not call a bare `node` a bridge (that is reportEntryCommand's case)", () => {
    expect(
      classifyClaudeCodeTandemEntry(
        { command: "node", args: ["/x/dist/stdio-bridge/index.js"] },
        BASE,
      ).kind,
    ).toBe("other");
  });

  it("recognises Tandem's npx bridge", () => {
    expect(
      classifyClaudeCodeTandemEntry(
        { command: "npx", args: ["-y", "tandem-editor", "mcp-stdio"] },
        BASE,
      ).kind,
    ).toBe("npx-bridge");
  });

  it.each([
    [{ command: "/n/node", args: ["/x/server.js"] }],
    [{ command: "/n/node", args: ["/x/dist/stdio-bridge/index.js", "extra"] }],
    [{ type: "http", url: `${BASE}/mcp`, headers: {} }],
  ])("calls %j other", (entry) => {
    expect(classifyClaudeCodeTandemEntry(entry, BASE).kind).toBe("other");
  });

  it("bounds the token", () => {
    expect(bearerTokenOf(`Bearer ${"a".repeat(512)}`)).not.toBeNull();
    expect(bearerTokenOf(`Bearer ${"a".repeat(513)}`)).toBeNull();
  });
});

describe("tokenMayGoTo — the bridge sends its token to this computer only", () => {
  it.each([
    ["http://127.0.0.1:3479", true],
    ["http://127.5.6.7:3479", false],
    ["http://localhost:3479", false],
    ["http://[::1]:3479", true],
    ["http://192.168.1.20:3479", false],
    ["http://[::ffff:127.0.0.1]:3479", false],
    ["http://0.0.0.0:3479", false],
    ["http://example.com:3479", false],
    ["http://127.0.0.1.evil.example:3479", false],
    ["not a url", false],
    ["http://127.0.0.1:4000", false],
    ["http://127.0.0.1", false],
  ])("%s → %s", (url, ok) => {
    expect(tokenMayGoTo(url, {})).toBe(ok);
  });

  it("follows a moved TANDEM_MCP_PORT, and only that one", () => {
    expect(tokenMayGoTo("http://127.0.0.1:4000", { TANDEM_MCP_PORT: "4000" })).toBe(true);
    expect(tokenMayGoTo("http://127.0.0.1:3479", { TANDEM_MCP_PORT: "4000" })).toBe(true);
    expect(tokenMayGoTo("http://127.0.0.1:4001", { TANDEM_MCP_PORT: "4000" })).toBe(false);
    expect(tokenMayGoTo("http://127.0.0.1:4000", { TANDEM_MCP_PORT: "nope" })).toBe(false);
  });
});
