/**
 * Line-ending preservation (#1448 W2).
 *
 * The repo corpus structurally cannot cover this: `.gitattributes` pins
 * `*.md text eol=lf`, so a CRLF fixture committed to git arrives as LF and the
 * test would pass on the wrong input. Every input here is synthesized.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { getAdapter } from "../../../src/server/file-io/index.js";
import {
  detectLineEnding,
  restoreLineEndings,
  toLf,
} from "../../../src/server/file-io/line-endings.js";
import { loadMarkdown, saveMarkdown } from "../../../src/server/file-io/markdown.js";
import { extractText } from "../../../src/server/mcp/document-model.js";

describe("detectLineEnding", () => {
  it("reads a pure CRLF file as CRLF", () => {
    expect(detectLineEnding("a\r\nb\r\nc\r\n")).toBe("\r\n");
  });

  it("reads a pure LF file as LF", () => {
    expect(detectLineEnding("a\nb\nc\n")).toBe("\n");
  });

  it("resolves a tie to LF", () => {
    expect(detectLineEnding("a\r\nb\nc")).toBe("\n");
  });

  it("resolves a file with no newlines at all to LF", () => {
    expect(detectLineEnding("just one line")).toBe("\n");
  });

  it("does not count a CRLF twice", () => {
    // A naive implementation counts every `\n` as a lone LF, so a pure CRLF
    // file reads as a tie and loses.
    expect(detectLineEnding("a\r\nb\r\n")).toBe("\r\n");
  });

  it("reads a pure lone-CR file (classic Mac) as CR", () => {
    // The form `LineEnding` could not express before. `toLf` collapses `\r` like
    // any other ending, so a file that could not be NAMED could not be restored
    // — it came back with every line ending rewritten to LF, silently.
    expect(detectLineEnding("a\rb\rc\r")).toBe("\r");
  });

  it("does not count a CRLF as a lone CR either", () => {
    // The symmetric mistake to the one above: `\r\n` matches `/\r/` too, so an
    // uncorrected CR count ties with CRLF on a pure-CRLF file.
    expect(detectLineEnding("a\r\nb\r\nc\r\n")).toBe("\r\n");
  });
});

describe("toLf", () => {
  it("collapses a lone CR (classic Mac) as well as CRLF", () => {
    expect(toLf("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });
});

describe("restoreLineEndings", () => {
  it("is a no-op for a doc that recorded nothing", () => {
    const doc = new Y.Doc();
    try {
      expect(restoreLineEndings(doc, "a\nb\n")).toBe("a\nb\n");
    } finally {
      doc.destroy();
    }
  });

  it("never produces \\r\\r\\n from output that already carries a CRLF", () => {
    // Reachable through verbatim `markdownRaw` content, which the serializer
    // emits byte-for-byte.
    const doc = new Y.Doc();
    try {
      loadMarkdown(doc, "a\r\nb\r\n");
      expect(restoreLineEndings(doc, "x\r\ny\n")).toBe("x\r\ny\r\n");
    } finally {
      doc.destroy();
    }
  });
});

describe("markdown documents keep the endings they arrived with", () => {
  const LF = "# Title\n\nSoft-wrapped\nacross two lines.\n\n- a\n- b\n";

  it("CRLF in, CRLF out — every ending, not just some", () => {
    const doc = new Y.Doc();
    try {
      const crlf = LF.replace(/\n/g, "\r\n");
      loadMarkdown(doc, crlf);
      expect(saveMarkdown(doc)).toBe(crlf);
    } finally {
      doc.destroy();
    }
  });

  it("the MODEL stays LF regardless, so offsets are unaffected", () => {
    // A `\r` inside a Y.XmlText would be a character every coordinate system
    // counts and no editor shows.
    const doc = new Y.Doc();
    try {
      loadMarkdown(doc, LF.replace(/\n/g, "\r\n"));
      expect(extractText(doc)).not.toContain("\r");
    } finally {
      doc.destroy();
    }
  });

  it("flat offsets are identical for the CRLF and LF forms of one document", () => {
    const lfDoc = new Y.Doc();
    const crlfDoc = new Y.Doc();
    try {
      loadMarkdown(lfDoc, LF);
      loadMarkdown(crlfDoc, LF.replace(/\n/g, "\r\n"));
      expect(extractText(crlfDoc)).toBe(extractText(lfDoc));
    } finally {
      lfDoc.destroy();
      crlfDoc.destroy();
    }
  });
});

describe("plaintext documents keep the endings they arrived with", () => {
  const adapter = getAdapter("other");

  async function roundTrip(input: string): Promise<string> {
    const doc = new Y.Doc();
    try {
      adapter.apply(doc, await adapter.parse(input));
      return adapter.save?.(doc) ?? "";
    } finally {
      doc.destroy();
    }
  }

  it("CRLF in, CRLF out", async () => {
    expect(await roundTrip("one\r\ntwo\r\nthree")).toBe("one\r\ntwo\r\nthree");
  });

  it("LF in, LF out", async () => {
    expect(await roundTrip("one\ntwo\nthree")).toBe("one\ntwo\nthree");
  });

  it("lone CR in, lone CR out", async () => {
    expect(await roundTrip("one\rtwo\rthree")).toBe("one\rtwo\rthree");
  });
});

describe("markdown documents keep a lone-CR ending too", () => {
  it("CR in, CR out", () => {
    // Both adapters route through the same pair, but they are wired separately,
    // so a fix applied to one is not evidence about the other.
    const doc = new Y.Doc();
    try {
      const cr = "# Title\r\rBody text.\r";
      loadMarkdown(doc, cr);
      expect(saveMarkdown(doc)).toBe(cr);
    } finally {
      doc.destroy();
    }
  });
});
