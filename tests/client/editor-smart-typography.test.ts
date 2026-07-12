import { type AnyExtension, Editor } from "@tiptap/core";
import Typography from "@tiptap/extension-typography";
import { afterEach, describe, expect, it } from "vitest";
import { buildSchemaExtensions } from "../../src/client/editor/editor-extensions";

/**
 * A4 (smart typography) + A5 (spellcheck) — editor-level checks.
 *
 * Editor.svelte wires these via a `$derived` boolean read inside its rebuild
 * `$effect` (Typography, since toggling it must tear down/rebuild the
 * editor to add/remove the extension) and a `makeEditorProps` factory passed
 * to `editor.setOptions` (spellcheck, no rebuild needed). Driving a reactive
 * settings-backed Editor.svelte instance in happy-dom is awkward (needs a
 * real Y.Doc + HocuspocusProvider), so this test exercises the underlying
 * mechanism directly: constructing a Tiptap `Editor` with the exact
 * extension-list / editorProps shape `Editor.svelte` produces, at both
 * settings values. Manual E2E coverage (typing "--" + space and observing
 * the en/em dash; toggling and checking the DOM `spellcheck` attribute)
 * lives in `tests/e2e/settings-modal.spec.ts`.
 */

const mounted: Array<{ editor: Editor; container: HTMLDivElement }> = [];

function mount(extensions: AnyExtension[], editorProps?: Record<string, unknown>): Editor {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const editor = new Editor({
    element: container,
    extensions,
    editorProps,
  });
  mounted.push({ editor, container });
  return editor;
}

afterEach(() => {
  for (const { editor, container } of mounted.splice(0)) {
    editor.destroy();
    container.remove();
  }
});

describe("A4: smart typography extension presence", () => {
  it("Typography extension IS registered when smartTypography is true", () => {
    const smartTypography = true;
    const editor = mount([...buildSchemaExtensions(), ...(smartTypography ? [Typography] : [])]);
    expect(editor.extensionManager.extensions.some((e) => e.name === "typography")).toBe(true);
  });

  it("Typography extension is ABSENT when smartTypography is false (default)", () => {
    const smartTypography = false;
    const editor = mount([...buildSchemaExtensions(), ...(smartTypography ? [Typography] : [])]);
    expect(editor.extensionManager.extensions.some((e) => e.name === "typography")).toBe(false);
  });
});

describe("A5: spellcheck editorProps attribute", () => {
  function makeEditorProps(spellcheckOn: boolean) {
    return {
      attributes: {
        class: "tandem-editor",
        spellcheck: String(spellcheckOn),
      },
    };
  }

  it('emits spellcheck="true" on the editor root when spellcheck is on (default)', () => {
    const editor = mount(buildSchemaExtensions(), makeEditorProps(true));
    expect(editor.view.dom.getAttribute("spellcheck")).toBe("true");
  });

  it('emits spellcheck="false" on the editor root when spellcheck is off', () => {
    const editor = mount(buildSchemaExtensions(), makeEditorProps(false));
    expect(editor.view.dom.getAttribute("spellcheck")).toBe("false");
  });

  it("setOptions swaps the attribute without destroying the editor", () => {
    const editor = mount(buildSchemaExtensions(), makeEditorProps(true));
    expect(editor.view.dom.getAttribute("spellcheck")).toBe("true");

    editor.setOptions({ editorProps: makeEditorProps(false) });
    expect(editor.isDestroyed).toBe(false);
    expect(editor.view.dom.getAttribute("spellcheck")).toBe("false");
  });
});
