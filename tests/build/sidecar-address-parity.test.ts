/**
 * The desktop shell's sidecar address agrees with the server's defaults (#1825).
 *
 * `src-tauri/src/lib.rs` spells the sidecar's bind host and MCP port once, in
 * the `sidecar_bind_host!` / `sidecar_mcp_port!` macros, and every URL the shell
 * sends to its own sidecar expands from them. Rust cannot read the TypeScript
 * constants, so this compares the two halves: a port changed in
 * `src/shared/constants.ts` alone would move the browser and npm builds while
 * the desktop shell kept spawning, polling and POSTing on the old one, and
 * nothing else would fail.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_BIND_HOST, DEFAULT_MCP_PORT } from "../../src/shared/constants";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIB_RS = readFileSync(path.join(ROOT, "src-tauri/src/lib.rs"), "utf8");

/** The single token a zero-argument `macro_rules!` expands to. */
function macroBody(name: string): string | undefined {
  const re = new RegExp(
    `macro_rules!\\s+${name}\\s*\\{\\s*\\(\\)\\s*=>\\s*\\{\\s*([^\\s;}]+)\\s*\\};?\\s*\\}`,
  );
  return re.exec(LIB_RS)?.[1];
}

describe("sidecar address parity, Rust and TypeScript (#1825)", () => {
  it("sidecar_mcp_port! equals DEFAULT_MCP_PORT", () => {
    expect(
      macroBody("sidecar_mcp_port"),
      "sidecar_mcp_port! in lib.rs (undefined: macro not found)",
    ).toBe(String(DEFAULT_MCP_PORT));
  });

  it("sidecar_bind_host! equals DEFAULT_BIND_HOST", () => {
    expect(
      macroBody("sidecar_bind_host"),
      "sidecar_bind_host! in lib.rs (undefined: macro not found)",
    ).toBe(JSON.stringify(DEFAULT_BIND_HOST));
  });
});
