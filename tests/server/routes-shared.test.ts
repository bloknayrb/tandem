import { describe, expect, it } from "vitest";
import { isValidNodeBinary } from "../../src/server/mcp/routes/_shared.js";

// `isValidNodeBinary` outlived the /api/setup route (deleted in #477 PR
// 3c-ii-c) — it's still used by src/server/integrations/existing-config.ts to
// validate stdio `tandem`/`tandem-channel` commands surfaced by the wizard.
// These cases were relocated from the deleted tests/server/setup-api.test.ts.
describe("isValidNodeBinary", () => {
  it("accepts a plain node path", () => {
    expect(isValidNodeBinary("/usr/local/bin/node")).toBe(true);
  });
  it("accepts a Windows node.exe path", () => {
    expect(isValidNodeBinary("C:\\Program Files\\node.exe")).toBe(true);
  });
  it("accepts a bundled node-sidecar binary", () => {
    expect(isValidNodeBinary("/Applications/Tandem.app/Contents/MacOS/node-sidecar")).toBe(true);
  });
  it("accepts a Windows node-sidecar.exe", () => {
    expect(isValidNodeBinary("C:\\Program Files\\Tandem\\node-sidecar.exe")).toBe(true);
  });
  it("accepts a bare node command", () => {
    expect(isValidNodeBinary("node")).toBe(true);
  });
  it("accepts a bare node.exe command", () => {
    expect(isValidNodeBinary("node.exe")).toBe(true);
  });
  it("accepts target-triple-suffixed sidecar names", () => {
    expect(
      isValidNodeBinary("C:\\Program Files\\Tandem\\node-sidecar-x86_64-pc-windows-msvc.exe"),
    ).toBe(true);
    expect(isValidNodeBinary("/usr/lib/tandem/node-sidecar-x86_64-unknown-linux-gnu")).toBe(true);
  });
  it("rejects non-node executables", () => {
    expect(isValidNodeBinary("/usr/bin/python")).toBe(false);
    expect(isValidNodeBinary("calc.exe")).toBe(false);
    expect(isValidNodeBinary("/bin/sh")).toBe(false);
  });
  it("rejects empty input", () => {
    expect(isValidNodeBinary("")).toBe(false);
  });
  it("rejects path traversal", () => {
    expect(isValidNodeBinary("../../../bin/sh")).toBe(false);
    expect(isValidNodeBinary("/tmp/evil/node/../../../bin/sh")).toBe(false);
    expect(isValidNodeBinary("../../node")).toBe(false);
  });
  it("rejects UNC paths (NTLM hash leak surface)", () => {
    expect(isValidNodeBinary("\\\\attacker.com\\share\\node.exe")).toBe(false);
    expect(isValidNodeBinary("//attacker.com/share/node.exe")).toBe(false);
  });
});
