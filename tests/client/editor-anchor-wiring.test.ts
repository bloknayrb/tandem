/**
 * Wiring pin for the #1420 anchor intercept.
 *
 * The unit tests in `anchor-intercept.test.ts` prove the decision function is
 * correct; they cannot see whether it is bound to the right element, on the
 * right events, or whether the aux handler also falls through into annotation
 * handling. That is the seam the extraction can break, and nothing else in the
 * suite watches it: a component test would have to mount the whole Tiptap +
 * Y.Doc editor, and the E2E only exercises Chromium.
 *
 * It PARSES rather than greps, deliberately. A substring search for
 * `onauxclick=` matches anywhere in a 470-line component — including a comment
 * — and would not notice the handler moving off the editor root. Walking the
 * AST for the element whose `data-testid` is `editor-root` and asserting on
 * THAT NODE is the same shape as `tests/docs/loopback-gate-claims.test.ts`,
 * which scopes its match to a delimited passage rather than the whole file.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "svelte/compiler";
import { describe, expect, it } from "vitest";

const EDITOR_PATH = path.resolve(__dirname, "../../src/client/editor/Editor.svelte");
const source = readFileSync(EDITOR_PATH, "utf8");

type Node = { type?: string; [key: string]: unknown };

function walk(node: unknown, visit: (n: Node) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const n = node as Node;
  if (typeof n.type === "string") visit(n);
  for (const key of Object.keys(n)) {
    if (key === "parent") continue;
    walk(n[key], visit);
  }
}

function attributeText(attr: Node): string {
  const value = attr.value;
  if (Array.isArray(value)) {
    return value.map((v) => String((v as Node).raw ?? (v as Node).data ?? "")).join("");
  }
  return String(value ?? "");
}

/** The `<div data-testid="editor-root">` node, found by parsing the component. */
function editorRootElement(): Node {
  const ast = parse(source, { modern: true }) as unknown as Node;
  const matches: Node[] = [];
  walk(ast.fragment, (n) => {
    if (n.type !== "RegularElement") return;
    const attrs = ((n.attributes as Node[]) ?? []).filter((a) => a.type === "Attribute");
    const testid = attrs.find((a) => a.name === "data-testid");
    if (testid && attributeText(testid) === "editor-root") matches.push(n);
  });
  expect(matches, 'exactly one element carries data-testid="editor-root"').toHaveLength(1);
  return matches[0] as Node;
}

/** The source text of a top-level `function <name>(…) {…}` in the instance script. */
function functionBody(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} is declared in Editor.svelte`).toBeGreaterThan(-1);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`could not find the end of ${name}`);
}

describe("the editor root's anchor-gesture wiring (#1420)", () => {
  it("binds BOTH onclick and onauxclick", () => {
    const root = editorRootElement();
    const names = ((root.attributes as Node[]) ?? [])
      .filter((a) => a.type === "Attribute")
      .map((a) => String(a.name));
    // `onclick` alone was the whole defect: a middle click fires `auxclick`, so
    // the intercept — and therefore `openHref` — was unreachable from it.
    expect(names).toContain("onclick");
    expect(names).toContain("onauxclick");
  });

  it("routes both handlers through the one shared intercept", () => {
    expect(functionBody("handleEditorClick")).toContain("interceptAnchorGesture");
    expect(functionBody("handleEditorAuxClick")).toContain("interceptAnchorGesture");
  });

  it("keeps annotation handling out of the aux path", () => {
    // The seam, not the spelling: reusing `handleEditorClick` wholesale for
    // `auxclick` would make a middle click select or clear an annotation. That
    // is the reason the anchor branch was extracted rather than the handler
    // reused, so it is worth a red test rather than a comment.
    const aux = functionBody("handleEditorAuxClick");
    expect(aux).not.toContain("onAnnotationClick");
    expect(aux).not.toContain("onClearAnnotation");
    // And the click path must still do both jobs.
    expect(functionBody("handleEditorClick")).toContain("onClearAnnotation");
  });
});
