import { describe, expect, it } from "vitest";
import {
  envProxyMayCarry,
  isLoopbackHandleDestination,
  isOwnerHandleShape,
  OWNER_HANDLE_ENV,
  OWNER_HANDLE_URL_ENV,
  ownerHandleForUpstream,
} from "../../src/shared/owner-handle.js";

/** R2.1 / R2.2 as pure vectors (#2358 PR 3a). The real bridge is driven in
 * tests/cli/mcp-stdio-owner-handle.test.ts. */

const HANDLE = `th_${"Z9_-".repeat(8)}`;
const env = (url: string, handle: string | undefined = HANDLE): NodeJS.ProcessEnv => ({
  [OWNER_HANDLE_ENV]: handle,
  [OWNER_HANDLE_URL_ENV]: url,
});

describe("owner handle shape", () => {
  it("is th_ plus exactly 32 base64url characters", () => {
    expect(HANDLE).toHaveLength(35);
    expect(isOwnerHandleShape(HANDLE)).toBe(true);
    expect(isOwnerHandleShape(`${HANDLE}x`)).toBe(false);
    expect(isOwnerHandleShape(HANDLE.slice(0, -1))).toBe(false);
    expect(isOwnerHandleShape(`tx_${HANDLE.slice(3)}`)).toBe(false);
    expect(isOwnerHandleShape(`${HANDLE.slice(0, -1)}=`)).toBe(false);
    expect(isOwnerHandleShape(` ${HANDLE}`)).toBe(false);
    expect(isOwnerHandleShape(undefined)).toBe(false);
  });
});

describe("ownerHandleForUpstream", () => {
  it.each([
    ["http://127.0.0.1:3479", "http://127.0.0.1:3479"],
    ["http://127.0.0.1:41234", "http://127.0.0.1:41234/"],
    ["http://[::1]:41234", "http://[::1]:41234"],
  ])("presents to %s when the launcher named %s", (resolved, named) => {
    expect(ownerHandleForUpstream(resolved, env(named))).toBe(HANDLE);
  });

  it("the bridge parses an IPv6 base URL the launcher writes", () => {
    expect(new URL("http://[::1]:5000/mcp").port).toBe("5000");
    expect(isLoopbackHandleDestination("http://[::1]:5000")).toBe(true);
  });

  it.each([
    ["another port", "http://127.0.0.1:1111", "http://127.0.0.1:2222"],
    ["localhost", "http://localhost:3479", "http://localhost:3479"],
    [
      "non-loopback (as if LAN_BIND_ENABLED were on)",
      "http://192.168.1.5:3479",
      "http://192.168.1.5:3479",
    ],
    ["rest of 127/8", "http://127.0.0.2:3479", "http://127.0.0.2:3479"],
    ["https", "https://127.0.0.1:3479", "https://127.0.0.1:3479"],
    ["no explicit port", "http://127.0.0.1", "http://127.0.0.1"],
    ["a path", "http://127.0.0.1:3479/x", "http://127.0.0.1:3479/x"],
    ["credentials", "http://u:p@127.0.0.1:3479", "http://u:p@127.0.0.1:3479"],
    ["garbage", "not a url", "not a url"],
  ])("withholds it for %s", (_n, resolved, named) => {
    expect(ownerHandleForUpstream(resolved, env(named))).toBeUndefined();
  });

  it("withholds it with no launcher URL variable, or a blank one", () => {
    expect(ownerHandleForUpstream("http://127.0.0.1:3479", { [OWNER_HANDLE_ENV]: HANDLE })).toBe(
      undefined,
    );
    expect(ownerHandleForUpstream("http://127.0.0.1:3479", env("  "))).toBeUndefined();
  });

  it("withholds a malformed handle", () => {
    expect(
      ownerHandleForUpstream("http://127.0.0.1:3479", env("http://127.0.0.1:3479", "th_x")),
    ).toBe(undefined);
  });
});

describe("envProxyMayCarry (review item 3; measured on Node 22.23.4)", () => {
  const URL_ = "http://127.0.0.1:4000";
  const P = "http://127.0.0.1:9";
  it.each([
    ["no proxy flag", { HTTP_PROXY: P }, [], false],
    ["NODE_USE_ENV_PROXY=1 + HTTP_PROXY", { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: P }, [], true],
    ["lower-case http_proxy", { NODE_USE_ENV_PROXY: "1", http_proxy: P }, [], true],
    [
      "--use-env-proxy in NODE_OPTIONS",
      { NODE_OPTIONS: "--x --use-env-proxy", HTTP_PROXY: P },
      [],
      true,
    ],
    ["--use-env-proxy in execArgv", { HTTP_PROXY: P }, ["--use-env-proxy"], true],
    [
      "NODE_USE_ENV_PROXY=true (not honoured by Node)",
      { NODE_USE_ENV_PROXY: "true", HTTP_PROXY: P },
      [],
      false,
    ],
    ["only HTTPS_PROXY", { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: P }, [], false],
    ["NO_PROXY=*", { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: P, NO_PROXY: "*" }, [], false],
    [
      "NO_PROXY=127.0.0.1",
      { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: P, NO_PROXY: "a.b,127.0.0.1" },
      [],
      false,
    ],
    [
      "no_proxy=127.0.0.1:4000",
      { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: P, no_proxy: "127.0.0.1:4000" },
      [],
      false,
    ],
    [
      "NO_PROXY=localhost (does not exempt 127.0.0.1)",
      { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: P, NO_PROXY: "localhost" },
      [],
      true,
    ],
    [
      "NO_PROXY=127.0.0.0/8 (no CIDR in Node)",
      { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: P, NO_PROXY: "127.0.0.0/8" },
      [],
      true,
    ],
    [
      "NO_PROXY for another port",
      { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: P, NO_PROXY: "127.0.0.1:1" },
      [],
      true,
    ],
  ] as const)("%s → %s", (_n, env, argv, expected) => {
    expect(envProxyMayCarry(URL_, env as NodeJS.ProcessEnv, argv)).toBe(expected);
  });

  it("an IPv6 base URL is exempted by ::1 or [::1]", () => {
    const env = { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: P };
    expect(envProxyMayCarry("http://[::1]:4000", { ...env, NO_PROXY: "::1" })).toBe(false);
    expect(envProxyMayCarry("http://[::1]:4000", { ...env, NO_PROXY: "[::1]" })).toBe(false);
    expect(envProxyMayCarry("http://[::1]:4000", env)).toBe(true);
  });

  it("ownerHandleForUpstream withholds the handle when the proxy may carry it", () => {
    const base = { [OWNER_HANDLE_ENV]: HANDLE, [OWNER_HANDLE_URL_ENV]: URL_ };
    expect(ownerHandleForUpstream(URL_, base)).toBe(HANDLE);
    expect(ownerHandleForUpstream(URL_, { ...base, NODE_USE_ENV_PROXY: "1", HTTP_PROXY: P })).toBe(
      undefined,
    );
    expect(ownerHandleForUpstream(URL_, base, ["--use-env-proxy"])).toBe(HANDLE);
    expect(ownerHandleForUpstream(URL_, { ...base, HTTP_PROXY: P }, ["--use-env-proxy"])).toBe(
      undefined,
    );
  });
});
