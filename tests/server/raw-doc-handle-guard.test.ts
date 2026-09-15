/**
 * A guard against a NEW raw `Y.Doc` / `Y.Map` handle (#1700, its second
 * acceptance checkbox only).
 *
 * **WHY THIS EXISTS.** `document-store-surface.test.ts` pins what `YDocStore`
 * and `AnnotationLifecycle` expose, and its header says what it cannot see: a
 * third file growing a raw handle. `requireDocument` (`documents/registry.ts`,
 * re-exported by `mcp/document-service.ts`) already returns a raw `Y.Doc` to
 * twelve call sites in three files — seven in `mcp/document.ts`, one in
 * `mcp/docx-apply.ts` and four in `local-model/collaborator.ts`. This file moves
 * none of them. It makes the set stop growing without anyone deciding to grow
 * it.
 *
 * Two checks, both inside `check` because the gate is the test, as with
 * `tests/scripts/audit-origins.test.ts`:
 *
 *   1. The files that mention `requireDocument` outside a comment equal
 *      `REQUIRE_DOCUMENT_FILES` exactly. By FILE, not by call count, so an
 *      unrelated edit to a handler in an allowlisted file does not go red.
 *   2. No class in a `.ts` file under `src/server/` or `src/shared/` declares a
 *      PUBLIC property, get accessor, method or constructor parameter property
 *      whose type annotation names `Y.Doc` or `Y.Map`.
 *
 * **WHAT IT DOES NOT CLAIM.** The scan is syntactic. A member with no type
 * annotation that still reaches the doc, an aliased import (`import { Doc }
 * from "yjs"`), an interface field and an exported function returning a raw doc
 * are all invisible to it. It reports rather than confines: moving the existing
 * `requireDocument` callers behind a seam is #1700's first checkbox, and it is
 * not done here.
 */

import ts from "typescript";
import { describe, expect, it } from "vitest";
import { filesMentioning, SRC_FILES } from "../helpers/src-tree.js";

/**
 * Every file under `src/` that names `requireDocument` outside a comment. The
 * definition, the re-exporting facade, and the three files whose handlers bind
 * the raw doc today. Adding a row is a decision, and this edit is where it is
 * made.
 */
const REQUIRE_DOCUMENT_FILES: readonly string[] = [
  "src/server/documents/registry.ts",
  "src/server/local-model/collaborator.ts",
  "src/server/mcp/document-service.ts",
  "src/server/mcp/document.ts",
  "src/server/mcp/docx-apply.ts",
];

/** `file#Class.member` entries allowed to stay public. None today. */
const ALLOWED_PUBLIC_RAW_MEMBERS: readonly string[] = [];

const RAW_TYPE = /\bY\.(Doc|Map)\b/;

/** `Class.member` for every public class member whose type annotation names a raw handle. */
function detect(src: string): string[] {
  const sf = ts.createSourceFile("probe.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];

  const isPublic = (node: ts.Node, name: ts.Node): boolean => {
    if (ts.isPrivateIdentifier(name)) return false;
    const modifiers = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
    return !modifiers.some(
      (m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword,
    );
  };
  const names = (type: ts.TypeNode | undefined): boolean =>
    type !== undefined && RAW_TYPE.test(type.getText(sf));

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const cls = node.name?.text ?? "<anonymous>";
      for (const member of node.members) {
        if (
          ts.isPropertyDeclaration(member) ||
          ts.isGetAccessorDeclaration(member) ||
          ts.isMethodDeclaration(member)
        ) {
          if (isPublic(member, member.name) && names(member.type)) {
            found.push(`${cls}.${member.name.getText(sf)}`);
          }
        } else if (ts.isConstructorDeclaration(member)) {
          for (const param of member.parameters) {
            if (!ts.isParameterPropertyDeclaration(param, member)) continue;
            if (isPublic(param, param.name) && names(param.type)) {
              found.push(`${cls}.${param.name.getText(sf)}`);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const SCANNED = [...SRC_FILES.keys()].filter((rel) => /^src\/(server|shared)\/.+\.ts$/.test(rel));

describe("raw doc handle guard (#1700)", () => {
  it("the files that mention requireDocument are exactly REQUIRE_DOCUMENT_FILES", () => {
    expect(
      filesMentioning("requireDocument"),
      "A file started or stopped naming requireDocument, which hands out a raw Y.Doc. " +
        "Edit REQUIRE_DOCUMENT_FILES in tests/server/raw-doc-handle-guard.test.ts deliberately (#1700).",
    ).toEqual([...REQUIRE_DOCUMENT_FILES].sort());
  });

  it("detector control: a public readonly Y.Doc member is reported", () => {
    expect(detect("class A { readonly doc: Y.Doc }")).toEqual(["A.doc"]);
  });

  it("detector control: #private and private members are not reported", () => {
    expect(detect("class B { #doc: Y.Doc; private m: Y.Map<unknown> }")).toEqual([]);
  });

  it("no class under src/server or src/shared grows a public raw Y.Doc / Y.Map member", () => {
    // The walk reaches the file holding the store's private raw fields, so an
    // empty result is a scan of the place the answer would be, not of nothing.
    expect(SCANNED).toContain("src/server/mcp/document-store.ts");
    const found = SCANNED.flatMap((rel) =>
      detect(SRC_FILES.get(rel) as string).map((entry) => `${rel}#${entry}`),
    );
    expect(
      found,
      "A class exposes a raw Y.Doc / Y.Map publicly. Route the caller through the store seam " +
        "instead, or add the entry to ALLOWED_PUBLIC_RAW_MEMBERS with a reason (#1700).",
    ).toEqual([...ALLOWED_PUBLIC_RAW_MEMBERS]);
  });
});
