import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hasExistingTandemEntry,
  readExistingTandemEntries,
  validateChannelEntry,
  validateTandemEntry,
} from "../../../src/server/integrations/existing-config.js";

describe("readExistingTandemEntries", () => {
  let tmpHome: string;
  let prevAppData: string | undefined;

  beforeEach(async () => {
    tmpHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-existing-"));
    // `detectTargets`'s non-MSIX "Claude Desktop" branch reads `process.env.APPDATA`
    // directly and there is no `appDataOverride` field in DetectOptions. Pin it into
    // the empty tmpHome so a real `%APPDATA%\Claude\claude_desktop_config.json` on a
    // Windows dev machine can't leak a "Claude Desktop" target into the assertions.
    // See #736.
    prevAppData = process.env.APPDATA;
    process.env.APPDATA = tmpHome;
  });

  afterEach(async () => {
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
    if (tmpHome) {
      await fs.promises.rm(tmpHome, { recursive: true, force: true });
    }
  });

  // Pin LOCALAPPDATA into tmpHome on every call so `detectTargets`'s Windows
  // MSIX branch doesn't read the real %LOCALAPPDATA% (which lives outside
  // tmpHome and would either fail `assertPathSafe` early or surface
  // user-installed Claude_* packages as targets). `homeOverride` only
  // steers home-rooted lookups; LOCALAPPDATA is a separate env var with its
  // own override field. APPDATA (non-MSIX Desktop branch) is pinned via
  // beforeEach since DetectOptions has no override field for it. See #736.
  const detectOverrides = () => ({ homeOverride: tmpHome, localAppDataOverride: tmpHome });

  it("returns status: missing when ~/.claude.json does not exist (force-detected target)", async () => {
    const installs = await readExistingTandemEntries({ ...detectOverrides(), force: true });
    const cc = installs.find((i) => i.target.kind === "claude-code");
    expect(cc).toBeDefined();
    expect(cc?.status).toBe("missing");
    expect(cc?.tandemEntry).toBeUndefined();
  });

  it("returns status: malformed for invalid JSON", async () => {
    await fs.promises.writeFile(path.join(tmpHome, ".claude.json"), "{ not json", "utf-8");
    const installs = await readExistingTandemEntries(detectOverrides());
    const cc = installs.find((i) => i.target.kind === "claude-code");
    expect(cc?.status).toBe("malformed");
  });

  it("returns status: ok with no entry when mcpServers is absent", async () => {
    await fs.promises.writeFile(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({ otherKey: "value" }),
      "utf-8",
    );
    const installs = await readExistingTandemEntries(detectOverrides());
    const cc = installs.find((i) => i.target.kind === "claude-code");
    expect(cc?.status).toBe("ok");
    expect(cc?.tandemEntry).toBeUndefined();
    expect(cc?.channelEntry).toBeUndefined();
  });

  it("extracts an existing HTTP tandem entry and reports validation: valid", async () => {
    await fs.promises.writeFile(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          tandem: { type: "http", url: "http://127.0.0.1:3479/mcp" },
        },
      }),
      "utf-8",
    );
    const installs = await readExistingTandemEntries(detectOverrides());
    const cc = installs.find((i) => i.target.kind === "claude-code");
    expect(cc?.status).toBe("ok");
    expect(cc?.tandemEntry).toEqual({ type: "http", url: "http://127.0.0.1:3479/mcp" });
    expect(cc?.tandemValidation?.status).toBe("valid");
    expect(cc?.channelEntry).toBeUndefined();
  });

  it("flags a non-loopback HTTP url as invalid-url and surfaces the entry verbatim", async () => {
    await fs.promises.writeFile(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          tandem: { type: "http", url: "http://evil.com:3479/mcp" },
        },
      }),
      "utf-8",
    );
    const installs = await readExistingTandemEntries(detectOverrides());
    const cc = installs.find((i) => i.target.kind === "claude-code");
    expect(cc?.tandemValidation?.status).toBe("invalid-url");
    // Entry surfaced verbatim so user can see what's on disk and decide.
    expect(cc?.tandemEntry?.url).toBe("http://evil.com:3479/mcp");
  });

  it("flags a credential-bearing url (http://evil@127.0.0.1) as invalid-url", async () => {
    await fs.promises.writeFile(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          tandem: { type: "http", url: "http://evil@127.0.0.1:3479/mcp" },
        },
      }),
      "utf-8",
    );
    const installs = await readExistingTandemEntries(detectOverrides());
    const cc = installs.find((i) => i.target.kind === "claude-code");
    expect(cc?.tandemValidation?.status).toBe("invalid-url");
  });

  it("flags a tampered stdio command (npx args swapped to evil-package) as invalid-args", async () => {
    await fs.promises.writeFile(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          tandem: { command: "npx", args: ["-y", "evil-package"] },
        },
      }),
      "utf-8",
    );
    const installs = await readExistingTandemEntries(detectOverrides());
    const cc = installs.find((i) => i.target.kind === "claude-code");
    expect(cc?.tandemValidation?.status).toBe("invalid-args");
  });

  it("extracts both tandem and tandem-channel entries", async () => {
    await fs.promises.writeFile(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          tandem: { type: "http", url: "http://127.0.0.1:3479/mcp" },
          "tandem-channel": {
            command: "node",
            args: ["/path/to/channel.js"],
            env: { TANDEM_URL: "http://127.0.0.1:3479" },
          },
        },
      }),
      "utf-8",
    );
    const installs = await readExistingTandemEntries(detectOverrides());
    const cc = installs.find((i) => i.target.kind === "claude-code");
    expect(cc?.tandemEntry).toBeDefined();
    expect(cc?.channelEntry).toBeDefined();
    expect(cc?.channelEntry?.command).toBe("node");
  });

  it("preserves unrelated mcpServers entries (does not surface them)", async () => {
    await fs.promises.writeFile(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          someOtherServer: { command: "other" },
          tandem: { type: "http", url: "http://127.0.0.1:3479/mcp" },
        },
      }),
      "utf-8",
    );
    const installs = await readExistingTandemEntries(detectOverrides());
    const cc = installs.find((i) => i.target.kind === "claude-code");
    expect(cc?.tandemEntry).toBeDefined();
    expect((cc as { someOtherServer?: unknown }).someOtherServer).toBeUndefined();
  });

  it("returns status: ok with no entry when mcpServers is non-object", async () => {
    await fs.promises.writeFile(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({ mcpServers: "not-an-object" }),
      "utf-8",
    );
    const installs = await readExistingTandemEntries(detectOverrides());
    const cc = installs.find((i) => i.target.kind === "claude-code");
    expect(cc?.status).toBe("ok");
    expect(cc?.tandemEntry).toBeUndefined();
  });

  it("returns no targets when no Claude install is detected (no .claude dir, no force)", async () => {
    const installs = await readExistingTandemEntries(detectOverrides());
    // No ~/.claude.json, no ~/.claude/, not forced — should be empty.
    // `localAppDataOverride: tmpHome` pins the Windows MSIX lookup into the
    // empty tmpdir so real %LOCALAPPDATA%\Packages\Claude_* installs (and
    // the `assertPathSafe` early-return that surfaces previously-pushed
    // Desktop targets) don't leak in on Windows dev machines. See #736.
    expect(installs).toEqual([]);
  });

  it("extracts a tandem-channel entry even when no tandem entry is present", async () => {
    await fs.promises.writeFile(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "tandem-channel": {
            command: "node",
            args: ["/path/to/channel.js"],
          },
        },
      }),
      "utf-8",
    );
    const installs = await readExistingTandemEntries(detectOverrides());
    const cc = installs.find((i) => i.target.kind === "claude-code");
    expect(cc?.status).toBe("ok");
    expect(cc?.tandemEntry).toBeUndefined();
    expect(cc?.channelEntry).toBeDefined();
    expect(cc?.channelEntry?.command).toBe("node");
  });

  it("scrubs env and headers from the returned entries (wire-leak regression)", async () => {
    // The GET /api/integrations/existing route is accessible under
    // TANDEM_ALLOW_UNAUTHENTICATED_LAN=1 — leaking the full McpEntry would
    // expose Tandem's own bearer token (Authorization header) and third-
    // party API keys (env vars on other-vendor MCP servers).
    await fs.promises.writeFile(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          tandem: {
            type: "http",
            url: "http://127.0.0.1:3479/mcp",
            headers: { Authorization: "Bearer secret-token-do-not-leak" },
          },
          "tandem-channel": {
            command: "node",
            args: ["/path/to/channel.js"],
            env: { TANDEM_AUTH_TOKEN: "secret-env-do-not-leak" },
          },
        },
      }),
      "utf-8",
    );
    const installs = await readExistingTandemEntries(detectOverrides());
    const cc = installs.find((i) => i.target.kind === "claude-code");
    expect(cc?.tandemEntry).toBeDefined();
    expect(cc?.channelEntry).toBeDefined();
    // env / headers stripped on extraction
    expect((cc?.tandemEntry as { headers?: unknown }).headers).toBeUndefined();
    expect((cc?.channelEntry as { env?: unknown }).env).toBeUndefined();
    // Validation still runs on the scrubbed shape (validateTandemEntry /
    // validateChannelEntry read command/args/url only).
    expect(cc?.tandemValidation?.status).toBe("valid");
    expect(cc?.channelValidation?.status).toBe("valid");
    // No secret value appears anywhere in the JSON-serialized install.
    const serialized = JSON.stringify(cc);
    expect(serialized).not.toContain("secret-token-do-not-leak");
    expect(serialized).not.toContain("secret-env-do-not-leak");
    expect(serialized).not.toContain("Bearer");
  });

  it("returns status: error with message on a non-ENOENT read failure (EACCES)", async () => {
    // Make ~/.claude.json unreadable. On Linux/macOS, chmod 000 denies even the
    // owner. Skipped on Windows where chmod is a no-op and on root (uid 0,
    // which our CI may run as) where the mode bit doesn't restrict.
    if (process.platform === "win32") return;
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const configPath = path.join(tmpHome, ".claude.json");
    await fs.promises.writeFile(configPath, "{}", "utf-8");
    await fs.promises.chmod(configPath, 0o000);
    try {
      const installs = await readExistingTandemEntries(detectOverrides());
      const cc = installs.find((i) => i.target.kind === "claude-code");
      expect(cc?.status).toBe("error");
      expect(cc?.errorMessage).toBeDefined();
      expect(cc?.errorMessage?.length).toBeGreaterThan(0);
    } finally {
      // Restore so rm -rf can clean up.
      await fs.promises.chmod(configPath, 0o600);
    }
  });
});

describe("hasExistingTandemEntry", () => {
  it("returns true when any install has a tandem entry", () => {
    const installs = [
      {
        target: {
          label: "Claude Code",
          configPath: "/path",
          kind: "claude-code" as const,
        },
        status: "ok" as const,
        tandemEntry: { type: "http" as const, url: "http://127.0.0.1:3479/mcp" },
      },
    ];
    expect(hasExistingTandemEntry(installs)).toBe(true);
  });

  it("returns false when no install has a tandem entry", () => {
    const installs = [
      {
        target: {
          label: "Claude Code",
          configPath: "/path",
          kind: "claude-code" as const,
        },
        status: "missing" as const,
      },
    ];
    expect(hasExistingTandemEntry(installs)).toBe(false);
  });

  it("returns false on an empty list", () => {
    expect(hasExistingTandemEntry([])).toBe(false);
  });
});

describe("validateTandemEntry", () => {
  it("accepts the canonical loopback HTTP shape", () => {
    expect(validateTandemEntry({ type: "http", url: "http://127.0.0.1:3479/mcp" }).status).toBe(
      "valid",
    );
  });

  it("rejects http://localhost (LoopbackUrl strict 127.0.0.1-only)", () => {
    expect(validateTandemEntry({ type: "http", url: "http://localhost:3479/mcp" }).status).toBe(
      "invalid-url",
    );
  });

  it("rejects credential-bearing URLs", () => {
    expect(
      validateTandemEntry({ type: "http", url: "http://evil@127.0.0.1:3479/mcp" }).status,
    ).toBe("invalid-url");
  });

  it("rejects non-http schemes", () => {
    expect(validateTandemEntry({ type: "http", url: "https://127.0.0.1:3479/mcp" }).status).toBe(
      "invalid-url",
    );
  });

  it("accepts the canonical npx stdio shape", () => {
    expect(
      validateTandemEntry({ command: "npx", args: ["-y", "tandem-editor", "mcp-stdio"] }).status,
    ).toBe("valid");
  });

  it("rejects npx with tampered args", () => {
    expect(validateTandemEntry({ command: "npx", args: ["-y", "evil-package"] }).status).toBe(
      "invalid-args",
    );
  });

  it("accepts a Node-shaped legacy sidecar invocation", () => {
    expect(validateTandemEntry({ command: "node", args: ["/path/to/channel.js"] }).status).toBe(
      "valid",
    );
  });

  it("accepts node-sidecar-{triple} as a valid command", () => {
    expect(
      validateTandemEntry({
        command: "node-sidecar-x86_64-unknown-linux-gnu",
        args: ["/path/to/channel.js"],
      }).status,
    ).toBe("valid");
  });

  it("rejects unrecognized commands like /bin/sh", () => {
    expect(validateTandemEntry({ command: "/bin/sh", args: ["-c", "rm -rf /"] }).status).toBe(
      "invalid-command",
    );
  });

  it("rejects a Node command with non-.js args", () => {
    expect(validateTandemEntry({ command: "node", args: ["evil.sh"] }).status).toBe("invalid-args");
  });
});

describe("validateChannelEntry", () => {
  it("accepts the canonical Node + .js invocation", () => {
    expect(validateChannelEntry({ command: "node", args: ["/dist/channel/index.js"] }).status).toBe(
      "valid",
    );
  });

  it("rejects HTTP shape for the channel slot (channel is stdio-only)", () => {
    expect(validateChannelEntry({ type: "http", url: "http://127.0.0.1:3479" }).status).toBe(
      "invalid-shape",
    );
  });

  it("rejects non-Node commands", () => {
    expect(validateChannelEntry({ command: "/bin/sh", args: ["x.js"] }).status).toBe(
      "invalid-command",
    );
  });

  it("rejects multi-arg invocations", () => {
    expect(validateChannelEntry({ command: "node", args: ["a.js", "b.js"] }).status).toBe(
      "invalid-args",
    );
  });
});
