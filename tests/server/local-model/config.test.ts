import { describe, expect, it } from "vitest";
import {
  type EndpointRejectCode,
  validateEndpoint,
} from "../../../src/server/local-model/config.js";

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
