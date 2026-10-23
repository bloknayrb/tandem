/**
 * #1822 item 1: unit-level pin of the sanitizer's character classes; the
 * route-level spec is channel-error-log-sanitization.test.ts.
 *
 * The route spec feeds ESC, BEL, CR, LF and U+202E but no C1 character and no
 * DEL, so narrowing the strip to `[\x00-\x1f\x7f]` or `[\x00-\x1f]` would leave
 * it green while 8-bit CSI (U+009B) and OSC (U+009D) reach the operator's
 * terminal again. Every control character below is written as an escape, never
 * a literal.
 */
import { describe, expect, it } from "vitest";
import { LOG_FIELD_MAX, sanitizeForLog } from "../../src/server/log-sanitize.js";

describe("sanitizeForLog character classes (#1822)", () => {
  it("strips C1 escape-sequence introducers", () => {
    // 8-bit CSI
    expect(sanitizeForLog("a\u009b31mb")).toBe("a31mb");
    // 8-bit OSC ... ST
    expect(sanitizeForLog("a\u009d0;x\u009cb")).toBe("a0;xb");
    // NEL: a C1 line break
    expect(sanitizeForLog("\u0085")).toBe("");
  });

  it("strips DEL", () => {
    expect(sanitizeForLog("a\u007fb")).toBe("ab");
  });

  it("keeps the characters just outside the stripped ranges", () => {
    expect(sanitizeForLog("~")).toBe("~");
    expect(sanitizeForLog(" ")).toBe(" ");
  });

  it("clamps above LOG_FIELD_MAX and not at it", () => {
    expect(sanitizeForLog("x".repeat(LOG_FIELD_MAX))).toBe("x".repeat(LOG_FIELD_MAX));
    expect(sanitizeForLog("x".repeat(LOG_FIELD_MAX + 1))).toBe(`${"x".repeat(LOG_FIELD_MAX)}…`);
  });

  it("strips before it clamps", () => {
    expect(sanitizeForLog(`${"\u001b".repeat(LOG_FIELD_MAX)}ok`)).toBe("ok");
  });

  it("stringifies non-strings and survives an unstringifiable object", () => {
    expect(sanitizeForLog(42)).toBe("42");
    expect(sanitizeForLog(JSON.parse('{"toString":1,"valueOf":2}'))).toBe("[unstringifiable]");
  });
});
