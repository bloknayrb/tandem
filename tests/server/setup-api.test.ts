import { describe, expect, it } from "vitest";
import { isValidNodeBinary } from "../../src/server/mcp/api-routes.js";

describe("isValidNodeBinary", () => {
  it("accepts absolute path ending in node", () => {
    expect(isValidNodeBinary("/usr/local/bin/node")).toBe(true);
  });

  it("accepts absolute path ending in node.exe", () => {
    expect(isValidNodeBinary("C:\\Program Files\\node.exe")).toBe(true);
  });

  it("accepts path ending in node-sidecar", () => {
    expect(isValidNodeBinary("/Applications/Tandem.app/Contents/MacOS/node-sidecar")).toBe(true);
  });

  it("accepts path ending in node-sidecar.exe", () => {
    expect(isValidNodeBinary("C:\\Program Files\\Tandem\\node-sidecar.exe")).toBe(true);
  });

  it("accepts bare 'node' (dev mode)", () => {
    expect(isValidNodeBinary("node")).toBe(true);
  });

  it("accepts bare 'node.exe' (dev mode)", () => {
    expect(isValidNodeBinary("node.exe")).toBe(true);
  });

  it("rejects arbitrary executables", () => {
    expect(isValidNodeBinary("/usr/bin/python")).toBe(false);
    expect(isValidNodeBinary("calc.exe")).toBe(false);
    expect(isValidNodeBinary("/bin/sh")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidNodeBinary("")).toBe(false);
  });

  it("rejects path traversal attempts", () => {
    expect(isValidNodeBinary("../../../bin/sh")).toBe(false);
    expect(isValidNodeBinary("/tmp/evil/node/../../../bin/sh")).toBe(false);
  });
});
