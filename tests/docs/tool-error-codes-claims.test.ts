/**
 * `ToolErrorCodeSchema` is the typed MCP wire vocabulary (#1851): `mcpError`
 * accepts nothing else. Its docblock tells a contributor to add a new code to
 * the Error Codes table in `docs/mcp-tools.md` as well, and that instruction is
 * the half a compiler cannot check. Five `tandem_rename` codes were in the
 * vocabulary with no table row when this test was written.
 *
 * Both directions: a schema code with no row is an undocumented code a client
 * meets on the wire; a row with no schema code documents a code no tool can
 * emit (the shape `ANNOTATION_NOT_PENDING` took after #1823 retired it).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ToolErrorCodeSchema } from "../../src/shared/types.js";

const DOC = fileURLToPath(new URL("../../docs/mcp-tools.md", import.meta.url));

function tableCodes(): string[] {
  const text = readFileSync(DOC, "utf8").replace(/\r\n/g, "\n");
  const start = text.indexOf("\n### Error Codes\n");
  expect(start, "docs/mcp-tools.md has no `### Error Codes` heading").toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n#{2,3} /);
  const section = next === -1 ? rest : rest.slice(0, next + 1);
  return [...section.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]);
}

describe("docs/mcp-tools.md Error Codes table mirrors ToolErrorCodeSchema (#1851)", () => {
  it("parses a non-trivial table", () => {
    // Guards the parser: an empty match set would pass both set checks below.
    expect(tableCodes().length).toBeGreaterThan(20);
  });

  it("lists each code once", () => {
    const codes = tableCodes();
    expect(codes.filter((c, i) => codes.indexOf(c) !== i)).toEqual([]);
  });

  it("every schema code has a row", () => {
    const rows = new Set(tableCodes());
    expect(ToolErrorCodeSchema.options.filter((c) => !rows.has(c))).toEqual([]);
  });

  it("every row names a schema code", () => {
    const schema = new Set<string>(ToolErrorCodeSchema.options);
    expect(tableCodes().filter((c) => !schema.has(c))).toEqual([]);
  });
});
