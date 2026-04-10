import { describe, expect, it } from "vitest";
import { isKnownHocuspocusError } from "../../src/server/error-filter.js";

/** Helper: create an Error with a `.code` property, mimicking ws library errors */
function wsError(
  message: string,
  code: string,
  Ctor: ErrorConstructor | typeof RangeError = RangeError,
): Error {
  const err = new Ctor(message);
  (err as any).code = code;
  return err;
}

describe("isKnownHocuspocusError", () => {
  describe("should swallow (return true)", () => {
    it("ws RangeError with WS_ERR_UNEXPECTED_RSV_1", () => {
      expect(
        isKnownHocuspocusError(
          wsError("Invalid WebSocket frame: RSV1 must be clear", "WS_ERR_UNEXPECTED_RSV_1"),
        ),
      ).toBe(true);
    });

    it("ws RangeError with WS_ERR_INVALID_OPCODE", () => {
      expect(
        isKnownHocuspocusError(
          wsError("Invalid WebSocket frame: invalid opcode 5", "WS_ERR_INVALID_OPCODE"),
        ),
      ).toBe(true);
    });

    it("ws RangeError with WS_ERR_EXPECTED_MASK", () => {
      expect(
        isKnownHocuspocusError(
          wsError("Invalid WebSocket frame: MASK must be set", "WS_ERR_EXPECTED_MASK"),
        ),
      ).toBe(true);
    });

    it("ws Error (not RangeError) with WS_ERR_INVALID_UTF8", () => {
      expect(
        isKnownHocuspocusError(
          wsError("Invalid WebSocket frame: invalid UTF-8 sequence", "WS_ERR_INVALID_UTF8", Error),
        ),
      ).toBe(true);
    });

    it("ws 'WebSocket is not open' with readyState suffix", () => {
      expect(
        isKnownHocuspocusError(new Error("WebSocket is not open: readyState 0 (CONNECTING)")),
      ).toBe(true);
    });

    it("ws 'WebSocket is not open' with CLOSING state", () => {
      expect(
        isKnownHocuspocusError(new Error("WebSocket is not open: readyState 2 (CLOSING)")),
      ).toBe(true);
    });

    it("lib0 'Unexpected end of array' (defensive)", () => {
      expect(isKnownHocuspocusError(new Error("Unexpected end of array"))).toBe(true);
    });

    it("lib0 'Integer out of Range' (defensive)", () => {
      expect(isKnownHocuspocusError(new Error("Integer out of Range"))).toBe(true);
    });

    it("Hocuspocus unknown message type (defensive)", () => {
      expect(isKnownHocuspocusError(new Error("Received a message with an unknown type: 99"))).toBe(
        true,
      );
    });
  });

  describe("should crash (return false)", () => {
    it("TypeError", () => {
      expect(isKnownHocuspocusError(new TypeError("Cannot read properties of undefined"))).toBe(
        false,
      );
    });

    it("ENOENT file error", () => {
      expect(isKnownHocuspocusError(new Error("ENOENT: no such file or directory"))).toBe(false);
    });

    it("generic Error", () => {
      expect(isKnownHocuspocusError(new Error("random bug"))).toBe(false);
    });

    it("null", () => {
      expect(isKnownHocuspocusError(null)).toBe(false);
    });

    it("undefined", () => {
      expect(isKnownHocuspocusError(undefined)).toBe(false);
    });

    it("string reason", () => {
      expect(isKnownHocuspocusError("something went wrong")).toBe(false);
    });

    it("number reason", () => {
      expect(isKnownHocuspocusError(42)).toBe(false);
    });

    it("RangeError without .code property", () => {
      expect(isKnownHocuspocusError(new RangeError("index out of bounds"))).toBe(false);
    });

    it("RangeError with non-WS_ERR code", () => {
      expect(isKnownHocuspocusError(wsError("some range error", "ERR_OTHER"))).toBe(false);
    });
  });
});
