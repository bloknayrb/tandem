/**
 * Bind-mode safety checks for TANDEM_BIND_HOST.
 *
 * Extracted from index.ts main() so the logic is fully unit-testable without
 * spawning a process. index.ts calls checkBindConfig(), acts on the result,
 * then passes resolvedLanIP to startMcpServerHttp for the Host-header allowlist.
 */

import type { NetworkInterfaceInfo } from "os";
import { networkInterfaces as osNetworkInterfaces } from "os";

export interface BindCheckOptions {
  /** The value of TANDEM_BIND_HOST (or DEFAULT_BIND_HOST if not set). */
  bindHost: string;
  /** MCP port, used only to construct error messages. */
  port: number;
  /** Auth token (null when token-store returned nothing). */
  authToken: string | null;
  /** True when TANDEM_ALLOW_UNAUTHENTICATED_LAN=1 is set. */
  allowUnauthLAN: boolean;
  /** Explicit LAN IP from TANDEM_LAN_IP env var (may be undefined). */
  lanIP?: string;
  /**
   * Injected for testing. Defaults to os.networkInterfaces.
   * Signature matches the Node built-in.
   */
  networkInterfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
}

export interface BindCheckResult {
  /** false means the caller must emit stderrMessage then exit(exitCode). */
  ok: boolean;
  exitCode?: number;
  /** Message to write to stderr before exiting (when ok === false). */
  stderrMessage?: string;
  /**
   * When ok === true and bind is non-loopback, the LAN warning to emit.
   * Undefined for loopback binds.
   */
  lanWarning?: string;
  /**
   * The resolved LAN IP to use for the Host-header allowlist.
   * Set when the bind is non-loopback and ok === true.
   * undefined for loopback binds.
   */
  resolvedLanIP?: string;
  /**
   * All detected non-internal IPv4 addresses (populated even when resolvedLanIP
   * is set, so the caller can log them).
   */
  detectedIPs?: string[];
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** True when bindHost is a non-loopback value (including 0.0.0.0). */
export function isNonLoopback(bindHost: string): boolean {
  return !LOOPBACK_HOSTS.has(bindHost);
}

/**
 * Pure function — no process.exit, no process.env access, no side effects.
 * index.ts reads the result and acts on it.
 */
export function checkBindConfig(opts: BindCheckOptions): BindCheckResult {
  const { bindHost, port, authToken, allowUnauthLAN, lanIP } = opts;

  if (!isNonLoopback(bindHost)) {
    // Default loopback path — nothing to check.
    return { ok: true };
  }

  // ── Invariant 3: fail-closed without token ──────────────────────────────────
  if (!authToken && !allowUnauthLAN) {
    return {
      ok: false,
      exitCode: 1,
      stderrMessage:
        `[tandem] Refusing to bind on ${bindHost}:${port} without an auth token.\n` +
        `Set TANDEM_ALLOW_UNAUTHENTICATED_LAN=1 to explicitly opt in to insecure mode,\n` +
        `or run \`tandem setup\` (CLI) / launch Tauri once to provision a token.\n`,
    };
  }

  // ── Multi-homed detection ───────────────────────────────────────────────────
  // Only fire when bindHost is a wildcard (0.0.0.0 / ::). If the user already
  // supplied a specific IP they've chosen their interface — skip the check.
  const isWildcard = bindHost === "0.0.0.0" || bindHost === "::";

  const getInterfaces = opts.networkInterfaces ?? osNetworkInterfaces;

  let detectedIPs: string[] = [];
  let resolvedLanIP: string | undefined;

  if (isWildcard) {
    const ifaceMap = getInterfaces();
    detectedIPs = Object.values(ifaceMap)
      .flat()
      .filter(
        (iface): iface is NonNullable<typeof iface> =>
          !!iface && iface.family === "IPv4" && !iface.internal,
      )
      .map((i) => i.address);

    if (detectedIPs.length > 1 && !lanIP) {
      return {
        ok: false,
        exitCode: 1,
        stderrMessage:
          `[tandem] Multiple non-internal IPv4 addresses detected: ${detectedIPs.join(", ")}.\n` +
          `Set TANDEM_LAN_IP=<address> to specify which address to advertise.\n`,
        detectedIPs,
      };
    }

    resolvedLanIP = lanIP ?? detectedIPs[0];
  } else {
    // User specified a concrete IP — use it directly.
    resolvedLanIP = bindHost;
  }

  // ── Invariant 4: plaintext LAN warning (token present only) ─────────────────
  let lanWarning: string | undefined;
  if (authToken) {
    lanWarning =
      `[tandem] WARNING: Tandem is listening on ${bindHost}:${port}. ` +
      `Tokens and document content transit unencrypted; ` +
      `do not use on untrusted networks (public Wi-Fi, shared LAN).\n`;
  }

  return { ok: true, lanWarning, resolvedLanIP, detectedIPs };
}
