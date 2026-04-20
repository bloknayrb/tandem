/**
 * Tests for src/server/bind-check.ts
 *
 * All tests are pure unit tests — checkBindConfig is a side-effect-free function
 * that accepts injected networkInterfaces, so no process spawning required.
 */

import type * as os from "os";
import { describe, expect, it } from "vitest";
import { checkBindConfig, isNonLoopback } from "../../src/server/bind-check.js";

// ── helpers ────────────────────────────────────────────────────────────────────

function makeIface(address: string, internal: boolean): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${address}/24`,
  };
}

function singleLanInterfaces(ip = "192.168.1.50"): () => NodeJS.Dict<os.NetworkInterfaceInfo[]> {
  return () => ({
    lo: [makeIface("127.0.0.1", true)],
    eth0: [makeIface(ip, false)],
  });
}

function multiLanInterfaces(): () => NodeJS.Dict<os.NetworkInterfaceInfo[]> {
  return () => ({
    lo: [makeIface("127.0.0.1", true)],
    eth0: [makeIface("192.168.1.50", false)],
    wlan0: [makeIface("10.0.0.5", false)],
  });
}

function loopbackOnlyInterfaces(): () => NodeJS.Dict<os.NetworkInterfaceInfo[]> {
  return () => ({
    lo: [makeIface("127.0.0.1", true)],
  });
}

const VALID_TOKEN = "abc123";

// ── isNonLoopback ──────────────────────────────────────────────────────────────

describe("isNonLoopback", () => {
  it("127.0.0.1 is loopback", () => {
    expect(isNonLoopback("127.0.0.1")).toBe(false);
  });
  it("localhost is loopback", () => {
    expect(isNonLoopback("localhost")).toBe(false);
  });
  it("::1 is loopback", () => {
    expect(isNonLoopback("::1")).toBe(false);
  });
  it("0.0.0.0 is non-loopback", () => {
    expect(isNonLoopback("0.0.0.0")).toBe(true);
  });
  it("specific LAN IP is non-loopback", () => {
    expect(isNonLoopback("192.168.1.50")).toBe(true);
  });
});

// ── Test 1: default bind (loopback) ───────────────────────────────────────────

describe("checkBindConfig — loopback (default)", () => {
  it("returns ok=true with no other fields when bindHost is 127.0.0.1", () => {
    const result = checkBindConfig({
      bindHost: "127.0.0.1",
      port: 3479,
      authToken: null,
      allowUnauthLAN: false,
    });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBeUndefined();
    expect(result.stderrMessage).toBeUndefined();
    expect(result.lanWarning).toBeUndefined();
    expect(result.resolvedLanIP).toBeUndefined();
  });

  it("returns ok=true for localhost", () => {
    const result = checkBindConfig({
      bindHost: "localhost",
      port: 3479,
      authToken: null,
      allowUnauthLAN: false,
    });
    expect(result.ok).toBe(true);
  });
});

// ── Test 2: fail-closed without token ─────────────────────────────────────────

describe("checkBindConfig — Invariant 3 (fail-closed without token)", () => {
  it("exits 1 when bindHost=0.0.0.0, no token, no TANDEM_ALLOW_UNAUTHENTICATED_LAN", () => {
    const result = checkBindConfig({
      bindHost: "0.0.0.0",
      port: 3479,
      authToken: null,
      allowUnauthLAN: false,
      networkInterfaces: singleLanInterfaces(),
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderrMessage).toContain("[tandem] Refusing to bind on 0.0.0.0:3479");
    expect(result.stderrMessage).toContain("TANDEM_ALLOW_UNAUTHENTICATED_LAN=1");
    expect(result.stderrMessage).toContain("tandem setup");
  });

  it("fail-closed message contains correct host and port", () => {
    const result = checkBindConfig({
      bindHost: "192.168.1.50",
      port: 9000,
      authToken: null,
      allowUnauthLAN: false,
    });
    expect(result.ok).toBe(false);
    // Should not even reach networkInterfaces check — token check fires first
    expect(result.stderrMessage).toContain("192.168.1.50:9000");
  });

  it("fail-closed message matches Invariant 3 exact text pattern", () => {
    const result = checkBindConfig({
      bindHost: "0.0.0.0",
      port: 3479,
      authToken: null,
      allowUnauthLAN: false,
      networkInterfaces: singleLanInterfaces(),
    });
    expect(result.stderrMessage).toContain(
      "[tandem] Refusing to bind on 0.0.0.0:3479 without an auth token.",
    );
    expect(result.stderrMessage).toContain(
      "Set TANDEM_ALLOW_UNAUTHENTICATED_LAN=1 to explicitly opt in to insecure mode,",
    );
    expect(result.stderrMessage).toContain(
      "or run `tandem setup` (CLI) / launch Tauri once to provision a token.",
    );
  });
});

// ── Test 3: opt-in escape hatch ────────────────────────────────────────────────

describe("checkBindConfig — opt-in escape hatch (TANDEM_ALLOW_UNAUTHENTICATED_LAN=1)", () => {
  it("does not exit when allowUnauthLAN=true even without token", () => {
    const result = checkBindConfig({
      bindHost: "0.0.0.0",
      port: 3479,
      authToken: null,
      allowUnauthLAN: true,
      networkInterfaces: singleLanInterfaces(),
    });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBeUndefined();
    expect(result.stderrMessage).toBeUndefined();
  });

  it("does not emit fail-closed message when opted in", () => {
    const result = checkBindConfig({
      bindHost: "0.0.0.0",
      port: 3479,
      authToken: null,
      allowUnauthLAN: true,
      networkInterfaces: singleLanInterfaces(),
    });
    expect(result.stderrMessage).toBeUndefined();
  });

  it("no lanWarning when token is absent even with opt-in", () => {
    const result = checkBindConfig({
      bindHost: "0.0.0.0",
      port: 3479,
      authToken: null,
      allowUnauthLAN: true,
      networkInterfaces: singleLanInterfaces(),
    });
    // lanWarning only fires when token IS present (Invariant 4)
    expect(result.lanWarning).toBeUndefined();
  });
});

// ── Test 4: happy path (token present) ────────────────────────────────────────

describe("checkBindConfig — Invariant 4 (plaintext LAN warning)", () => {
  it("emits lanWarning when bindHost=0.0.0.0 and token is present", () => {
    const result = checkBindConfig({
      bindHost: "0.0.0.0",
      port: 3479,
      authToken: VALID_TOKEN,
      allowUnauthLAN: false,
      networkInterfaces: singleLanInterfaces(),
    });
    expect(result.ok).toBe(true);
    expect(result.lanWarning).toContain("[tandem] WARNING:");
    expect(result.lanWarning).toContain("0.0.0.0:3479");
    expect(result.lanWarning).toContain("unencrypted");
    expect(result.lanWarning).toContain("untrusted networks");
  });

  it("lanWarning matches Invariant 4 exact text pattern", () => {
    const result = checkBindConfig({
      bindHost: "0.0.0.0",
      port: 3479,
      authToken: VALID_TOKEN,
      allowUnauthLAN: false,
      networkInterfaces: singleLanInterfaces(),
    });
    expect(result.lanWarning).toContain("[tandem] WARNING: Tandem is listening on 0.0.0.0:3479.");
    expect(result.lanWarning).toContain("Tokens and document content transit unencrypted;");
    expect(result.lanWarning).toContain(
      "do not use on untrusted networks (public Wi-Fi, shared LAN).",
    );
  });

  it("no lanWarning for loopback bind even with token", () => {
    const result = checkBindConfig({
      bindHost: "127.0.0.1",
      port: 3479,
      authToken: VALID_TOKEN,
      allowUnauthLAN: false,
    });
    expect(result.lanWarning).toBeUndefined();
  });
});

// ── Test 5: multi-homed detection ─────────────────────────────────────────────

describe("checkBindConfig — multi-homed detection", () => {
  it("exits 1 when multiple non-internal IPs exist and TANDEM_LAN_IP not set", () => {
    const result = checkBindConfig({
      bindHost: "0.0.0.0",
      port: 3479,
      authToken: VALID_TOKEN,
      allowUnauthLAN: false,
      networkInterfaces: multiLanInterfaces(),
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderrMessage).toContain("Multiple non-internal IPv4 addresses detected");
    expect(result.stderrMessage).toContain("192.168.1.50");
    expect(result.stderrMessage).toContain("10.0.0.5");
    expect(result.stderrMessage).toContain("TANDEM_LAN_IP=<address>");
  });

  it("includes all detected IPs in error message", () => {
    const result = checkBindConfig({
      bindHost: "0.0.0.0",
      port: 3479,
      authToken: VALID_TOKEN,
      allowUnauthLAN: false,
      networkInterfaces: multiLanInterfaces(),
    });
    // Both IPs must appear in the message
    expect(result.stderrMessage).toContain("192.168.1.50");
    expect(result.stderrMessage).toContain("10.0.0.5");
    expect(result.detectedIPs).toHaveLength(2);
  });

  it("proceeds when TANDEM_LAN_IP is set with multiple interfaces", () => {
    const result = checkBindConfig({
      bindHost: "0.0.0.0",
      port: 3479,
      authToken: VALID_TOKEN,
      allowUnauthLAN: false,
      lanIP: "192.168.1.50",
      networkInterfaces: multiLanInterfaces(),
    });
    expect(result.ok).toBe(true);
    expect(result.resolvedLanIP).toBe("192.168.1.50");
  });

  it("multi-homed check does NOT fire for loopback bind", () => {
    const result = checkBindConfig({
      bindHost: "127.0.0.1",
      port: 3479,
      authToken: VALID_TOKEN,
      allowUnauthLAN: false,
      networkInterfaces: multiLanInterfaces(),
    });
    // Loopback path short-circuits before multi-homed check
    expect(result.ok).toBe(true);
  });
});

// ── Test 6: single LAN IP ─────────────────────────────────────────────────────

describe("checkBindConfig — single LAN IP auto-detection", () => {
  it("resolves single non-internal IPv4 automatically", () => {
    const result = checkBindConfig({
      bindHost: "0.0.0.0",
      port: 3479,
      authToken: VALID_TOKEN,
      allowUnauthLAN: false,
      networkInterfaces: singleLanInterfaces("192.168.1.77"),
    });
    expect(result.ok).toBe(true);
    expect(result.resolvedLanIP).toBe("192.168.1.77");
    expect(result.detectedIPs).toEqual(["192.168.1.77"]);
  });

  it("TANDEM_LAN_IP overrides auto-detected single IP", () => {
    const result = checkBindConfig({
      bindHost: "0.0.0.0",
      port: 3479,
      authToken: VALID_TOKEN,
      allowUnauthLAN: false,
      lanIP: "10.0.0.99",
      networkInterfaces: singleLanInterfaces("192.168.1.77"),
    });
    expect(result.ok).toBe(true);
    expect(result.resolvedLanIP).toBe("10.0.0.99");
  });

  it("no non-internal interfaces — resolvedLanIP is undefined", () => {
    const result = checkBindConfig({
      bindHost: "0.0.0.0",
      port: 3479,
      authToken: VALID_TOKEN,
      allowUnauthLAN: false,
      networkInterfaces: loopbackOnlyInterfaces(),
    });
    expect(result.ok).toBe(true);
    expect(result.resolvedLanIP).toBeUndefined();
    expect(result.detectedIPs).toHaveLength(0);
  });
});

// ── Test 7: specific (non-wildcard) non-loopback bind ─────────────────────────

describe("checkBindConfig — specific non-loopback IP (no multi-homed check)", () => {
  it("uses bindHost directly as resolvedLanIP when it is a specific IP", () => {
    const result = checkBindConfig({
      bindHost: "192.168.1.50",
      port: 3479,
      authToken: VALID_TOKEN,
      allowUnauthLAN: false,
      // Providing multi-homed interfaces — but check should be skipped for specific IP
      networkInterfaces: multiLanInterfaces(),
    });
    expect(result.ok).toBe(true);
    expect(result.resolvedLanIP).toBe("192.168.1.50");
    // multi-homed check did not fire (no exit)
    expect(result.exitCode).toBeUndefined();
  });

  it("specific IP bind does not call networkInterfaces", () => {
    let called = false;
    const mockInterfaces = () => {
      called = true;
      return multiLanInterfaces()();
    };
    const result = checkBindConfig({
      bindHost: "192.168.1.50",
      port: 3479,
      authToken: VALID_TOKEN,
      allowUnauthLAN: false,
      networkInterfaces: mockInterfaces,
    });
    expect(result.ok).toBe(true);
    // networkInterfaces should NOT have been called — user specified their IP
    expect(called).toBe(false);
  });
});

// ── Test 8b: IPv6 :: wildcard bind ───────────────────────────────────────────

describe("checkBindConfig — IPv6 '::' wildcard bind", () => {
  it("treats '::' as wildcard and triggers multi-homed detection like 0.0.0.0", () => {
    const result = checkBindConfig({
      bindHost: "::",
      port: 3479,
      authToken: VALID_TOKEN,
      allowUnauthLAN: false,
      networkInterfaces: multiLanInterfaces(),
    });
    // With multiple interfaces and no lanIP, multi-homed detection must fire
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderrMessage).toContain("Multiple non-internal IPv4 addresses detected");
  });

  it("'::' with single LAN interface resolves resolvedLanIP", () => {
    const result = checkBindConfig({
      bindHost: "::",
      port: 3479,
      authToken: VALID_TOKEN,
      allowUnauthLAN: false,
      networkInterfaces: singleLanInterfaces("192.168.1.50"),
    });
    expect(result.ok).toBe(true);
    expect(result.resolvedLanIP).toBe("192.168.1.50");
  });

  it("'::' with TANDEM_LAN_IP set bypasses multi-homed check", () => {
    const result = checkBindConfig({
      bindHost: "::",
      port: 3479,
      authToken: VALID_TOKEN,
      allowUnauthLAN: false,
      lanIP: "10.0.0.1",
      networkInterfaces: multiLanInterfaces(),
    });
    expect(result.ok).toBe(true);
    expect(result.resolvedLanIP).toBe("10.0.0.1");
  });
});

// ── Test 8: Hocuspocus stays loopback (static check) ─────────────────────────

describe("Hocuspocus stays loopback", () => {
  it("provider.ts hardcodes address: '127.0.0.1' (static check)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const dir = dirname(fileURLToPath(import.meta.url));
    const providerPath = join(dir, "../../src/server/yjs/provider.ts");
    const content = await readFile(providerPath, "utf8");

    // The hardcoded loopback address must be present
    expect(content).toContain('address: "127.0.0.1"');

    // TANDEM_BIND_HOST must NOT appear in provider.ts — Hocuspocus ignores the env var
    expect(content).not.toContain("TANDEM_BIND_HOST");
  });
});
