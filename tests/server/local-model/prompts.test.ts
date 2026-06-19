import { afterEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";
import { buildUserPrompt } from "../../../src/server/local-model/prompts.js";
import { makeMarkdownDoc } from "../../helpers/ydoc-factory.js";

let doc: Y.Doc | undefined;
afterEach(() => {
  doc?.destroy();
  doc = undefined;
});

// The SYSTEM_PROMPT is a frozen verbatim port (not tested by design). buildUserPrompt
// is the only logic in prompts.ts and carries the ADR-039 §4 context-window branch.
describe("buildUserPrompt", () => {
  it("inlines the full document text when includeText is true", () => {
    doc = makeMarkdownDoc("# Title\n\nHello world.\n");
    const p = buildUserPrompt(doc, "Improve this.", true);
    expect(p).toContain("<document>");
    expect(p).toContain("Hello world.");
    expect(p).toContain("Task: Improve this.");
  });

  it("omits the document and points at the read tools when includeText is false", () => {
    doc = makeMarkdownDoc("# Title\n\nHello world.\n");
    const p = buildUserPrompt(doc, "Improve this.", false);
    expect(p).not.toContain("<document>");
    expect(p).not.toContain("Hello world.");
    expect(p).toContain("get_outline");
    expect(p).toContain("read_section");
  });
});
