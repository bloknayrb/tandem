/**
 * Line-ending preservation (#1448 W2).
 *
 * The repo corpus structurally cannot cover this: `.gitattributes` pins
 * `*.md text eol=lf`, so a CRLF fixture committed to git arrives as LF and the
 * test would pass on the wrong input. Every input here is synthesized.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { getAdapter } from "../../../src/server/file-io/index.js";
import {
  detectLineEnding,
  restoreBom,
  restoreLineEndings,
  stripBom,
  toLf,
} from "../../../src/server/file-io/line-endings.js";
import { loadMarkdown, saveMarkdown } from "../../../src/server/file-io/markdown.js";
import { extractText } from "../../../src/server/mcp/document-model.js";
import { anchoredRange } from "../../../src/server/positions.js";
import { Y_MAP_BOM, Y_MAP_DOCUMENT_META } from "../../../src/shared/constants.js";
import { toFlatOffset } from "../../../src/shared/positions/types.js";

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

/**
 * UTF-8 BOM preservation (#1823). Synthesized in the spec, never a fixture:
 * `.gitattributes` normalization makes a committed BOM fixture unreliable in
 * exactly the way this file's header already documents for CRLF.
 */
describe("markdown documents keep (or keep out) a UTF-8 BOM", () => {
  const BOM = "\uFEFF";

  function roundTrip(input: string): { out: string; doc: Y.Doc } {
    const doc = new Y.Doc();
    loadMarkdown(doc, input);
    return { out: saveMarkdown(doc), doc };
  }

  it("a BOM survives a round trip", () => {
    const input = `${BOM}# Title\n`;
    expect(roundTrip(input).out).toBe(input);
  });

  it("a file without a BOM does not gain one", () => {
    // Kills a `restoreBom` that reads a missing key as truthy.
    expect(roundTrip("# Title\n").out).toBe("# Title\n");
  });

  it("a BOM and CRLF endings survive together — a Windows editor's .md", () => {
    const input = `${BOM}# Title\r\n\r\nBody.\r\n`;
    expect(roundTrip(input).out).toBe(input);
  });

  it("the BOM lands OFF the body and shifts no offset", () => {
    // The discriminating spec. A "fix" that kept the BOM in the doc and
    // stripped it at save time passes all three above and silently shifts
    // every annotation offset by one.
    const withBom = roundTrip(`${BOM}# Title\n\nBody.\n`);
    const without = roundTrip("# Title\n\nBody.\n");
    expect(withBom.doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_BOM)).toBe(true);
    expect(without.doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_BOM)).toBe(false);
    const flat = extractText(withBom.doc);
    expect(flat.startsWith("#")).toBe(true);
    expect(flat).toBe(extractText(without.doc));

    const range = anchoredRange(withBom.doc, toFlatOffset(2), toFlatOffset(7), "Title");
    const twin = anchoredRange(without.doc, toFlatOffset(2), toFlatOffset(7), "Title");
    expect(range.ok).toBe(true);
    expect(range.ok && range.range).toEqual(twin.ok && twin.range);
  });

  /**
   * Review round 1: the BOM `saveMarkdown` re-attaches also flows into
   * `GET /api/document/raw`, where it is invisible in the source-view textarea
   * — so a caret at offset 0 lands in FRONT of it and the commit silently
   * de-BOMs the file while leaving a stray U+FEFF in the body.
   */
  it("the raw-source view is served without the BOM, and the commit re-attaches it", () => {
    const input = `${BOM}# Title\n\nBody.\n`;
    const doc = new Y.Doc();
    loadMarkdown(doc, input);

    // What `GET /api/document/raw` hands the source view.
    const served = stripBom(saveMarkdown(doc));
    expect(served.startsWith(BOM), "an invisible BOM in the textarea").toBe(false);
    expect(served).toBe("# Title\n\nBody.\n");

    // The user types at offset 0 — in front of where the BOM used to be — and
    // commits. `reloadDocumentFromMarkdown` re-attaches the recorded BOM before
    // the reparse, so the round trip keeps it and gains no stray U+FEFF.
    const edited = `X${served}`;
    const committed = restoreBom(doc, edited);
    const reloaded = new Y.Doc();
    loadMarkdown(reloaded, committed);

    const out = saveMarkdown(reloaded);
    expect(out.startsWith(BOM), "the file lost its BOM").toBe(true);
    expect(out.slice(1).includes(BOM), "a stray U+FEFF landed in the body").toBe(false);
    expect(extractText(reloaded).startsWith("X#")).toBe(true);
  });

  it("restoreBom does not double a BOM the submitted string already carries", () => {
    // The source-view commit path feeds `restoreBom` a USER-supplied string. A
    // second BOM would not be an encoding mark — it would be a character at
    // offset 0 of the body, shifting every annotation offset by one.
    const doc = new Y.Doc();
    loadMarkdown(doc, `${BOM}# Title\n`);
    expect(restoreBom(doc, `${BOM}# Pasted\n`)).toBe(`${BOM}# Pasted\n`);
  });

  it("stripBom leaves a BOM-less string untouched", () => {
    expect(stripBom("# Title\n")).toBe("# Title\n");
  });
});

describe("plaintext documents keep (or keep out) a UTF-8 BOM", () => {
  // A second call-site pair: a fix applied only to `markdown.ts` passes every
  // markdown spec above and drops the BOM from every `.txt` / `.html`.
  const BOM = "\uFEFF";
  const adapter = getAdapter("other");

  async function roundTrip(input: string): Promise<{ out: string; doc: Y.Doc }> {
    const doc = new Y.Doc();
    adapter.apply(doc, await adapter.parse(input));
    return { out: adapter.save?.(doc) ?? "", doc };
  }

  it("a BOM survives", async () => {
    expect((await roundTrip(`${BOM}one\ntwo`)).out).toBe(`${BOM}one\ntwo`);
  });

  it("a file without a BOM does not gain one", async () => {
    expect((await roundTrip("one\ntwo")).out).toBe("one\ntwo");
  });

  it("the BOM lands off the body and shifts no offset", async () => {
    const withBom = await roundTrip(`${BOM}one\ntwo`);
    const without = await roundTrip("one\ntwo");
    expect(withBom.doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_BOM)).toBe(true);
    expect(extractText(withBom.doc)).toBe(extractText(without.doc));
    expect(extractText(withBom.doc).startsWith("one")).toBe(true);
  });
});

describe("the session-restore fallback mirror carries `bom` (#1823)", () => {
  it("`bom` is in the mirrored key set, alongside the other adapter-written keys", () => {
    // `cloneFallbackIntoDoc` set/deletes exactly the adapter-written
    // `documentMeta` keys, precisely so a copy-when-present clone cannot leave
    // the WINNER's value live over the FALLBACK's fragment. A `bom` missing
    // there writes a U+FEFF into a file that never had one — or drops a real
    // one — and nothing at the loadMarkdown/saveMarkdown level can see it.
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../../src/server/documents/open.ts"),
      "utf-8",
    );
    const block =
      /for \(const key of \[([^\]]*)\] as const\) \{\s*if \(scratchMeta\.has\(key\)\)/.exec(src);
    expect(block).not.toBeNull();
    const mirrored = (block?.[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(new Set(mirrored)).toEqual(
      new Set(["Y_MAP_FOOTNOTE_BODIES", "Y_MAP_FIDELITY_REPORT", "Y_MAP_LINE_ENDING", "Y_MAP_BOM"]),
    );
  });
});
