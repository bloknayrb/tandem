import { describe, expect, it } from "vitest";
import { MODEL_SAVE_REASON, modelSaveReason } from "../../../src/client/utils/local-model-copy.js";
import {
  type EndpointRejectCode,
  validateEndpoint,
} from "../../../src/server/local-model/config.js";
import * as shared from "../../../src/shared/models/local-endpoint.js";

/**
 * The endpoint allowlist is the SSRF regression gate for the local-model
 * outbound surface (#1123, ADR-039 — loopback-only for v1.0). The cases that
 * actually break are the IPv6/bracket and alternate-IP-encoding forms, so they
 * are asserted explicitly. The security review verified (on this Node) that the
 * WHATWG URL parser normalizes alt-encodings to `127.0.0.1` and keeps IPv6
 * hostnames bracketed — these tests pin that behavior so a refactor of the
 * bracket-strip / lowercase compare can't silently widen or break the allowlist.
 */
describe("validateEndpoint — loopback allowlist (SSRF gate)", () => {
  const accepted = [
    ["plain 127.0.0.1 + port", "http://127.0.0.1:11434"],
    ["127.0.0.1 no port", "http://127.0.0.1"],
    ["localhost + port", "http://localhost:1234"],
    ["localhost + path", "http://localhost/v1/chat/completions"],
    ["uppercase host", "http://LOCALHOST:11434"],
    ["bracketed ::1 (the bracket-bug case)", "http://[::1]:11434"],
    ["expanded ipv6 loopback", "http://[0:0:0:0:0:0:0:1]:11434"],
    ["dotted-decimal short form", "http://127.1:11434"],
    ["decimal ip", "http://2130706433:11434"],
    ["octal ip", "http://0177.0.0.1:11434"],
    ["trailing-dot host", "http://127.0.0.1.:11434"],
  ] as const;

  it.each(accepted)("accepts %s", (_label, url) => {
    const r = validateEndpoint(url);
    expect(r.ok, `${url} should be accepted`).toBe(true);
  });

  const rejected: ReadonlyArray<readonly [string, string, EndpointRejectCode]> = [
    ["all-interfaces 0.0.0.0", "http://0.0.0.0:11434", "NON_LOOPBACK_HOST"],
    ["LAN address", "http://192.168.1.50:11434", "NON_LOOPBACK_HOST"],
    ["public hostname", "http://ollama.example.com:11434", "NON_LOOPBACK_HOST"],
    [
      "ipv4-mapped ipv6 (rejected by design)",
      "http://[::ffff:127.0.0.1]:11434",
      "NON_LOOPBACK_HOST",
    ],
    ["https scheme", "https://127.0.0.1:11434", "NON_HTTP"],
    ["ftp scheme", "ftp://127.0.0.1", "NON_HTTP"],
    ["userinfo bypass", "http://evil.com@127.0.0.1/", "HAS_CREDENTIALS"],
    ["password bypass", "http://user:pass@127.0.0.1/", "HAS_CREDENTIALS"],
    ["not a url", "not a url at all", "MALFORMED_URL"],
  ];

  it.each(rejected)("rejects %s", (_label, url, code) => {
    const r = validateEndpoint(url);
    expect(r.ok, `${url} should be rejected`).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
  });
});

// #1123, the add-model window's fields (R3.5): one rule. The server's import is
// the shared function itself, so the cases above are the parity proof.
describe("validateEndpoint — one rule, shared with the add-model window", () => {
  it("config.js re-exports the shared function, not a copy", () => {
    expect(validateEndpoint).toBe(shared.validateEndpoint);
  });
});

// R3.1 rows 2 to 6, the strings as literals (never built from the product's).
describe("modelSaveReason (R3.1, R5)", () => {
  const U1 = "Enter a Model ID to save.";
  const U2 = "Enter an Endpoint to save.";
  const U3 =
    "The Endpoint must start with http:// and name this computer as 127.0.0.1, localhost or [::1], with no user name or password.";
  const U4 =
    "The Endpoint is not a complete address. Check it, including the port number (for example http://127.0.0.1:11434).";
  const rows: ReadonlyArray<readonly [string, string, string | null]> = [
    ["", "http://127.0.0.1:1234", U1],
    ["   ", "http://127.0.0.1:1234", U1],
    ["", "http://192.168.1.5:11434", U1], // first match
    ["m", "", U2],
    ["m", "   ", U2],
    ["m", "http://127.0.0.1:99999", U4],
    ["m", "http://127.0.0.1:12a", U4],
    ["m", "http://", U4],
    ["m", " http://127.0.0.1:99999", U4],
    ["m", "HTTP://127.0.0.1:99999", U4],
    ["m", "127.0.0.1:1234", U3],
    ["m", "localhost:11434", U3],
    ["m", "https://127.0.0.1:1234", U3],
    ["m", "http://u:p@127.0.0.1:1234", U3],
    ["m", "http://192.168.1.5:11434", U3],
    ["m", "http://localhost.example:1", U3],
    ["m", "http://0.0.0.0:1", U3],
    ["m", "http://127.0.0.1:1234", null],
    ["m", "http://localhost:1234", null],
    ["m", "http://[::1]:1234", null],
    ["m", "  http://127.0.0.1:1  ", null],
  ];
  it.each(rows)("model %j, endpoint %j", (modelId, endpoint, reason) => {
    expect(modelSaveReason({ modelId, endpoint })).toBe(reason);
  });
  it("the exported strings are the literals", () => {
    expect(MODEL_SAVE_REASON).toEqual({
      noModelId: U1,
      noEndpoint: U2,
      notThisComputer: U3,
      incomplete: U4,
    });
  });
});
