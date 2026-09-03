/**
 * #1294 — absolute paths must not reach non-loopback callers.
 *
 * Every case here pairs a non-loopback ABSENCE assertion with a loopback
 * POSITIVE CONTROL on the same sample. An absence assertion alone passes
 * against a route that returns nothing at all, or against a field that was
 * renamed out from under the test — which is how a scrub test silently stops
 * testing the scrub.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import {
  ERROR_LABELS,
  errorCodeToHttpStatus,
  errorCodeToLabel,
  GENERIC_ERROR_MESSAGE,
  isLoopbackRequest,
  isValidDocumentId,
  scrubOptionalPathForCaller,
  scrubPathForCaller,
  scrubUrlForCaller,
  sendApiError,
} from "../../../src/server/mcp/routes/_shared.js";

const SHARED_TS_PATH = fileURLToPath(
  new URL("../../../src/server/mcp/routes/_shared.ts", import.meta.url),
);

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

describe("scrubUrlForCaller (#1558)", () => {
  // The canonical fixture from the issue: an entry `extractEntry` cast out of
  // the user's own config file, which is exactly what gets flagged
  // `invalid-url` and was served with its userinfo intact.
  const CREDENTIALED = "http://user:s3cr3t@example.internal/mcp";

  it("returns the url untouched to a loopback caller", () => {
    // Per-caller, like its path sibling: the local UI gets the real value.
    // It is also the only form in which a loopback caller could learn less than
    // it already does — `scrubValidation` runs only on the LAN branch, so the
    // whole url still reaches a local caller inside the validation `reason`.
    expect(scrubUrlForCaller(LOCAL, CREDENTIALED)).toBe(CREDENTIALED);
  });

  it("drops userinfo, path and query for a LAN caller, keeping scheme and authority", () => {
    const scrubbed = scrubUrlForCaller(LAN, CREDENTIALED);
    expect(scrubbed).toBe("http://example.internal");
    expect(scrubbed).not.toContain("s3cr3t");
    expect(scrubbed).not.toContain("user");
    expect(scrubbed).not.toContain("/mcp");
  });

  it("keeps the port, and drops a query string a loopback url can still carry", () => {
    // `LoopbackUrl` checks protocol/username/password/hostname ONLY, so a
    // token in the query survives validation and persists. The port is the half
    // a caller can act on, so it stays.
    expect(scrubUrlForCaller(LAN, "http://127.0.0.1:3479/mcp?token=SEKRIT")).toBe(
      "http://127.0.0.1:3479",
    );
  });

  it("treats an unknown peer address as remote (fail-closed)", () => {
    expect(scrubUrlForCaller({}, CREDENTIALED)).toBe("http://example.internal");
  });

  it("returns undefined for a string that will not parse, rather than guessing", () => {
    expect(scrubUrlForCaller(LAN, "not a url at all")).toBeUndefined();
    expect(scrubUrlForCaller(LAN, "")).toBeUndefined();
  });

  it("returns undefined for a parseable url with no authority", () => {
    // `new URL()` accepts these, and their `host` is "". Emitting
    // `${protocol}//${host}` would produce "file://" while the interesting part
    // — the path — is precisely what this helper exists to withhold.
    expect(scrubUrlForCaller(LAN, `file://${POSIX_PATH}`)).toBeUndefined();
    expect(scrubUrlForCaller(LAN, "foo:/home/alice/notes")).toBeUndefined();
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

  it("gives a 404 its own copy rather than the catch-all", () => {
    // The map was keyed on the ERROR CODE `FILE_NOT_FOUND`, which
    // errorCodeToLabel never emits — it folds every not-found code into the
    // LABEL `NOT_FOUND`. So the most common 404 silently fell through to
    // "The operation failed." while a message written for it sat unreachable.
    const { res, json } = mockRes("192.168.1.50");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    sendApiError(res, fsError);
    expect(json.mock.calls[0]?.[0].message).toBe("The requested file was not found.");
  });
});

describe("GENERIC_ERROR_MESSAGE is keyed on labels, exhaustively", () => {
  it("has an entry for every label errorCodeToLabel can return", () => {
    // Guards the whole class the FILE_NOT_FOUND key was one instance of: a
    // label with no entry degrades silently to the catch-all, and no test
    // asserting on a single code would notice.
    for (const label of ERROR_LABELS) {
      expect(GENERIC_ERROR_MESSAGE[label], `missing generic message for ${label}`).toBeDefined();
    }
  });

  it("declares every label the mapper actually produces", () => {
    // The inverse direction: ERROR_LABELS is hand-maintained, so drive it from
    // the mapper rather than trusting the list. Codes taken from the two
    // switches in _shared.ts plus an unmapped one for the default arm.
    const codes = [
      "ENOENT",
      "FILE_NOT_FOUND",
      "NO_DOCUMENT",
      "NOT_FOUND",
      "INVALID_PATH",
      "UNSUPPORTED_FORMAT",
      "NO_SUGGESTIONS",
      "INVALID_ARGUMENT",
      "ANNOTATION_RESOLVED",
      "READ_ONLY",
      "RELOAD_IN_PROGRESS",
      "EXTERNAL_CONFLICT",
      "FILE_TOO_LARGE",
      "EBUSY",
      "EPERM",
      "EACCES",
      "BACKUP_FAILED",
      "PERMISSION_DENIED",
      "CONFLICT",
      "EMPTY_CONVERSION",
      "OPEN_FAILED",
      "SOMETHING_UNMAPPED",
      "",
    ];
    for (const code of codes) {
      expect(ERROR_LABELS).toContain(errorCodeToLabel(code));
    }
  });
});

describe("errorCodeToHttpStatus / errorCodeToLabel — POST /api/convert's codes (#1796)", () => {
  // Each of these codes reaches `sendApiError` unmapped as of this PR's fix:
  // the route half of the mapping (`POST /api/convert` -> `handleConvert` ->
  // `sendApiError`) previously fell through to the 500 default arm and the
  // catch-all INTERNAL label for every one of them. Pinning status AND label
  // per code so a deleted case goes red rather than silently degrading.
  it("EMPTY_CONVERSION is a 422 with its own label, not the 500 default arm", () => {
    expect(errorCodeToHttpStatus("EMPTY_CONVERSION")).toBe(422);
    expect(errorCodeToLabel("EMPTY_CONVERSION")).toBe("EMPTY_CONVERSION");
  });

  it("CONFLICT is a 409, not the 500 default arm", () => {
    expect(errorCodeToHttpStatus("CONFLICT")).toBe(409);
    expect(errorCodeToLabel("CONFLICT")).toBe("CONFLICT");
  });

  it("OPEN_FAILED is a 500 with its own label, not the bare INTERNAL catch-all", () => {
    // The status half of this pin (`toBe(500)`) is unkillable on its own --
    // the unmapped default arm is ALSO 500, so deleting OPEN_FAILED's case
    // from `errorCodeToHttpStatus` entirely would still pass it. The label
    // assertion below IS killable (the default arm returns "INTERNAL"), and
    // the source check after this `it` pins the status arm structurally.
    expect(errorCodeToHttpStatus("OPEN_FAILED")).toBe(500);
    expect(errorCodeToLabel("OPEN_FAILED")).toBe("OPEN_FAILED");
  });

  it('errorCodeToHttpStatus has its own `case "OPEN_FAILED":` arm, not just a status equal to the default', () => {
    const source = readFileSync(SHARED_TS_PATH, "utf8");
    const fnStart = source.indexOf("export function errorCodeToHttpStatus");
    expect(fnStart, "errorCodeToHttpStatus not found in _shared.ts").toBeGreaterThan(-1);
    const fnEnd = source.indexOf("\n}", fnStart);
    const fnBody = source.slice(fnStart, fnEnd);
    expect(fnBody).toContain('case "OPEN_FAILED":');
  });

  it("PERMISSION_DENIED (convert's realpath classification) is a 403 with its own label", () => {
    // Distinct from the raw `EACCES` errno case, which already mapped to the
    // same status/label pair — this pins the second producer independently.
    expect(errorCodeToHttpStatus("PERMISSION_DENIED")).toBe(403);
    expect(errorCodeToLabel("PERMISSION_DENIED")).toBe("PERMISSION_DENIED");
  });
});

describe("isValidDocumentId — shared shape check (#1295 L2)", () => {
  it("accepts room-name ids and rejects traversal, separators and overlong input", () => {
    expect(isValidDocumentId("abc-123_x.md")).toBe(true);

    for (const bad of [
      "",
      "../etc/passwd",
      "a/b",
      "a\\b", // a real backslash — the Windows separator, not an escape
      "a b",
      "a:b",
      "x".repeat(257),
      undefined,
      null,
      42,
      {},
    ]) {
      expect(isValidDocumentId(bad)).toBe(false);
    }
  });

  it("is a SHAPE check only — a well-formed id is not proof the document is open", () => {
    // Documented explicitly because the destructive restore route relies on it:
    // callers must still call hasDoc(). A guard that conflated the two would
    // make "valid id" read as "safe target".
    expect(isValidDocumentId("not-currently-open")).toBe(true);
  });
});
