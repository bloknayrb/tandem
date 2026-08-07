/**
 * #1293 — `assertLoopbackForMutation` must gate in EVERY configuration.
 *
 * Until this change the check was conditional on
 * `TANDEM_ALLOW_UNAUTHENTICATED_LAN=1`, so it was inert in the configuration
 * every shipped build runs in. The reason it survived to a v1.0 gate is that
 * every pre-existing LAN test set the flag to "1" — and those tests pass
 * identically whether the gate is conditional or not. Nothing covered the
 * default configuration at all.
 *
 * So the load-bearing case here is the **flag-unset** one. Each test below has
 * been run against the unconditional check reverted, and fails there.
 *
 * One row per route family rather than all 23 call sites: the function is
 * shared, so one row per family proves the wiring, while 23 rows would only
 * prove that 23 rows can be written.
 */
import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";
import { assertLoopbackForMutation } from "../../src/server/integrations/api-routes.js";
import { TANDEM_ALLOW_UNAUTHENTICATED_LAN_ENV } from "../../src/shared/constants.js";

const LAN = "192.168.1.100";

function req(remoteAddress: string | undefined): Request {
  return { socket: { remoteAddress }, headers: {} } as unknown as Request;
}

function res(): { response: Response; body: () => unknown; status: () => number | undefined } {
  let statusCode: number | undefined;
  let payload: unknown;
  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: unknown) {
      payload = value;
      return this;
    },
  } as unknown as Response;
  return { response, body: () => payload, status: () => statusCode };
}

/** Run `fn` with the LAN flag forced to a value (or removed), then restore. */
function withFlag<T>(value: "1" | undefined, fn: () => T): T {
  const prev = process.env[TANDEM_ALLOW_UNAUTHENTICATED_LAN_ENV];
  try {
    if (value === undefined) delete process.env[TANDEM_ALLOW_UNAUTHENTICATED_LAN_ENV];
    else process.env[TANDEM_ALLOW_UNAUTHENTICATED_LAN_ENV] = value;
    return fn();
  } finally {
    if (prev === undefined) delete process.env[TANDEM_ALLOW_UNAUTHENTICATED_LAN_ENV];
    else process.env[TANDEM_ALLOW_UNAUTHENTICATED_LAN_ENV] = prev;
  }
}

describe("assertLoopbackForMutation — gates regardless of configuration (#1293)", () => {
  it("rejects a LAN caller with the flag UNSET — the shipped configuration", () => {
    // THE regression test. Before #1293 this returned false and the caller
    // proceeded. The exposed config is not the flag: `bind-check.ts:74` lets
    // `TANDEM_BIND_HOST=<lan>` bind whenever a token exists, and the gate was
    // inert in exactly that case.
    withFlag(undefined, () => {
      const { response, status, body } = res();
      expect(assertLoopbackForMutation(req(LAN), response)).toBe(true);
      expect(status()).toBe(403);
      expect((body() as { error: string }).error).toBe("FORBIDDEN");
    });
  });

  it("still rejects a LAN caller with the flag SET — no regression", () => {
    withFlag("1", () => {
      const { response, status } = res();
      expect(assertLoopbackForMutation(req(LAN), response)).toBe(true);
      expect(status()).toBe(403);
    });
  });

  it("lets a loopback caller through in BOTH flag states", () => {
    // Positive control, and the one that actually matters: every assertion
    // above would also pass against a gate that rejected everything, which
    // would break the local UI rather than fix anything.
    for (const flag of ["1", undefined] as const) {
      withFlag(flag, () => {
        for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
          const { response, status } = res();
          expect(assertLoopbackForMutation(req(addr), response)).toBe(false);
          expect(status()).toBeUndefined();
        }
      });
    }
  });

  it("treats an unknown peer address as remote (fails closed)", () => {
    withFlag(undefined, () => {
      const { response, status } = res();
      expect(assertLoopbackForMutation(req(undefined), response)).toBe(true);
      expect(status()).toBe(403);
    });
  });

  it("no longer names the env var in its default message", () => {
    // The flag is not part of the decision any more. Naming it invited the
    // reader to think setting or clearing it would change the outcome — which
    // is the misunderstanding that let the inverted gate survive this long.
    withFlag(undefined, () => {
      const { response, body } = res();
      assertLoopbackForMutation(req(LAN), response);
      const message = (body() as { message: string }).message;
      expect(message).not.toMatch(/TANDEM_ALLOW_UNAUTHENTICATED_LAN/);
      expect(message).toMatch(/computer running Tandem/);
    });
  });

  it("passes a caller-supplied friendly message through on the unconditional path", () => {
    // `mcp/routes/license.ts:146` is the only caller using the override, because
    // its 403 is read by a *buyer* in the activation form. This had NO coverage:
    // `license-status-route.test.ts` hardcodes remoteAddress 127.0.0.1 in
    // `activateReq`, so its friendly-message test exercises
    // assertOriginAllowlisted's override instead, and would stay green if this
    // path dropped the argument entirely.
    withFlag(undefined, () => {
      const { response, body } = res();
      const friendly = "Activate Tandem on the computer running it.";
      expect(assertLoopbackForMutation(req(LAN), response, friendly)).toBe(true);
      expect((body() as { message: string }).message).toBe(friendly);
    });
  });
});
