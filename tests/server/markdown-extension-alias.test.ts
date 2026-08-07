/**
 * `.markdown` is the long-form spelling of `.md` and Tandem registers it as an
 * OS file association (#1306). Passing the extension allowlist is necessary but
 * not sufficient: an alias that reaches the server and then routes to the
 * PLAINTEXT adapter would open a markdown file with its syntax rendered as
 * literal text, and — worse — save it back through `extractText` rather than
 * `saveMarkdown`, rewriting the user's file. So the alias has to be pinned at
 * three points, not one.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { getAdapter } from "../../src/server/file-io/index.js";
import { detectFormat } from "../../src/server/mcp/document-model.js";
import { AUTO_SAVE_FORMATS, SUPPORTED_EXTENSIONS } from "../../src/shared/constants.js";

describe(".markdown is a first-class alias for .md", () => {
  it("passes the server's open-time extension allowlist", () => {
    expect(SUPPORTED_EXTENSIONS.has(".markdown")).toBe(true);
  });

  it("detects as the md format, not the txt fallback", () => {
    expect(detectFormat("/tmp/notes.markdown")).toBe("md");
    expect(detectFormat("C:\\Users\\me\\Notes.MARKDOWN")).toBe("md");
    // Control: an unrelated extension still lands on the plaintext fallback,
    // so the assertion above is about `.markdown` and not about the default.
    expect(detectFormat("/tmp/notes.rtf")).toBe("txt");
  });

  it("routes to the markdown adapter, which round-trips syntax as structure", async () => {
    const format = detectFormat("/tmp/notes.markdown");
    const adapter = getAdapter(format);
    const doc = new Y.Doc();
    try {
      const prepared = await adapter.parse("# Heading\n\nBody text.\n");
      expect(prepared.format).toBe("md");
      adapter.apply(doc, prepared);
      // The markdown adapter builds a heading node; the plaintext adapter would
      // have produced a paragraph whose text still carries the literal "# ".
      const fragment = doc.getXmlFragment("default");
      const first = fragment.get(0) as Y.XmlElement;
      expect(first.nodeName).toBe("heading");
      expect(adapter.save?.(doc)).toContain("# Heading");
    } finally {
      doc.destroy();
    }
  });

  it("is auto-saved in place, so a .markdown file keeps its extension", () => {
    // Auto-save is format-keyed, and the write target is the doc's own
    // filePath — so "md" here is what makes an edited .markdown file persist
    // to `notes.markdown` rather than being silently skipped or renamed.
    expect(AUTO_SAVE_FORMATS.has(detectFormat("/tmp/notes.markdown"))).toBe(true);
  });
});
