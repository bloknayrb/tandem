/**
 * #1294 — absolute paths must not reach non-loopback callers.
 *
 * Every case here pairs a non-loopback ABSENCE assertion with a loopback
 * POSITIVE CONTROL on the same sample. An absence assertion alone passes
 * against a route that returns nothing at all, or against a field that was
 * renamed out from under the test — which is how a scrub test silently stops
 * testing the scrub.
 */
import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import {
  isLoopbackRequest,
  scrubOptionalPathForCaller,
  scrubPathForCaller,
  sendApiError,
} from "../../../src/server/mcp/routes/_shared.js";

const LOCAL = { socket: { remoteAddress: "127.0.0.1" } };
const LAN = { socket: { remoteAddress: "192.168.1.50" } };

const POSIX_PATH = "/home/alice/Documents/Q3-plan.md";
const WIN_PATH = "C:\\Users\\alice\\Documents\\Q3-plan.md";

describe("scrubPathForCaller", () => {
  it("returns the full path to a loopback caller and a basename to a LAN one", () => {
    expect(scrubPathForCaller(LOCAL, POSIX_PATH)).toBe(POSIX_PATH);

    const scrubbed = scrubPathForCaller(LAN, POSIX_PATH);
    expect(scrubbed).toBe("Q3-plan.md");
    // The username is the actual disclosure being prevented.
    expect(scrubbed).not.toContain("alice");
  });

  it("splits Windows-style paths even when running on Linux", () => {
    // `path.basename` does NOT treat `\` as a separator on POSIX, so it would
    // return the whole string here — leaking the username on exactly the
    // platform CI runs on. The helper uses crossBasename for this reason.
    const scrubbed = scrubPathForCaller(LAN, WIN_PATH);
    expect(scrubbed).toBe("Q3-plan.md");
    expect(scrubbed).not.toContain("alice");
  });

  it("treats an unknown peer address as remote (fail-closed)", () => {
    expect(isLoopbackRequest({ socket: { remoteAddress: undefined } })).toBe(false);
    expect(isLoopbackRequest({})).toBe(false);
    expect(scrubPathForCaller({}, POSIX_PATH)).toBe("Q3-plan.md");
  });

  it("normalizes IPv6 loopback spellings as loopback", () => {
    expect(isLoopbackRequest({ socket: { remoteAddress: "::1" } })).toBe(true);
    expect(isLoopbackRequest({ socket: { remoteAddress: "::ffff:127.0.0.1" } })).toBe(true);
  });

  it("passes null/undefined through rather than inventing a path", () => {
    expect(scrubOptionalPathForCaller(LAN, null)).toBeNull();
    expect(scrubOptionalPathForCaller(LAN, undefined)).toBeNull();
    expect(scrubOptionalPathForCaller(LOCAL, POSIX_PATH)).toBe(POSIX_PATH);
  });
});

describe("sendApiError — raw fs messages do not cross the network (#1294)", () => {
  function mockRes(remoteAddress: string | undefined) {
    const json = vi.fn();
    const res = {
      req: { socket: { remoteAddress } },
      status: vi.fn(() => ({ json })),
    } as unknown as Response;
    return { res, json };
  }

  const fsError = Object.assign(
    new Error(`ENOENT: no such file or directory, open '${POSIX_PATH}'`),
    { code: "ENOENT" },
  );

  it("gives a LAN caller the label without the path", () => {
    const { res, json } = mockRes("192.168.1.50");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    sendApiError(res, fsError);

    const body = json.mock.calls[0]?.[0];
    expect(body.error).toBe("NOT_FOUND"); // the actionable signal survives
    expect(body.message).not.toContain("/home/alice");
    expect(body.message).not.toContain("alice");
  });

  it("still gives a loopback caller the full detail", () => {
    // Positive control on the same sample. Without it, the assertion above
    // would pass against a change that blanked the message for everyone —
    // which would be a regression for the local UI, not a fix.
    const { res, json } = mockRes("127.0.0.1");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    sendApiError(res, fsError);

    const body = json.mock.calls[0]?.[0];
    expect(body.error).toBe("NOT_FOUND");
    expect(body.message).toContain(POSIX_PATH);
  });

  it("fails closed when the response carries no request", () => {
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) } as unknown as Response;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    sendApiError(res, fsError);
    expect(json.mock.calls[0]?.[0].message).not.toContain("alice");
  });
});
