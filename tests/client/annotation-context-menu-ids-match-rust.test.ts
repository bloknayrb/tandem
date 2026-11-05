import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ANNOTATION_CONTEXT_MENU_ACTION_IDS } from "../../src/client/panels/annotation-context-menu.js";

/**
 * The closed `ctx:annotation:*` id set exists twice: Rust emits the ids and the
 * webview validates them. An id Rust emits that the TS set lacks is dropped by
 * `isAnnotationContextMenuActionId`, giving a menu item that does nothing and a
 * test suite that stays green. Compare the two sets from source (#2360 added
 * `resolve` on both sides).
 */
describe("annotation context-menu action ids: Rust and TS agree", () => {
  const rust = readFileSync(join(__dirname, "../../src-tauri/src/context_menu.rs"), "utf8");
  // Only the production spec builder, not the test module's fixtures.
  const production = rust.slice(0, rust.indexOf("#[cfg(test)]"));
  const rustIds = [...new Set(production.match(/"ctx:annotation:[A-Za-z]+"/g) ?? [])]
    .map((s) => s.slice(1, -1))
    .sort();

  it("finds the ids at all (a zero-length set would satisfy the comparison)", () => {
    expect(rustIds.length).toBeGreaterThanOrEqual(7);
    expect(rustIds).toContain("ctx:annotation:resolve");
  });

  it("emits exactly the ids the webview accepts", () => {
    expect(rustIds).toEqual([...ANNOTATION_CONTEXT_MENU_ACTION_IDS].sort());
  });
});
