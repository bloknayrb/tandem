/**
 * Post-write verification (#1123 Phase 0e). `verifyDocxRoundtrips` re-imports the
 * just-regenerated .docx bytes and decides whether the save preserved the live
 * doc's CONTENT before the bytes overwrite the user's file.
 *
 * The load-bearing properties under test:
 *   - BLOCK only on confirmed-broken output (won't re-open / gutted / gross text
 *     loss) — and the block is a RETURNED verdict that a verifier-internal error
 *     can never downgrade to advisory (the asymmetry; silent-failure H3).
 *   - ADVISORY (write + warn, never block) on soft signals (a comment/footnote
 *     that didn't survive, a soft text shortfall) — they can be benign drift.
 *   - NEVER false-block an honest save, and never mutate the live doc.
 *   - PRIVACY: no document/comment/footnote text leaks into the verdict, the
 *     advisory string, or the logs (every verdict field is a scalar/enum).
 */

import { Document, Packer, Paragraph } from "docx";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { prepareExportComments } from "../../src/server/file-io/docx-comment-export.js";
import {
  blockReasonMessage,
  integrityWarningLines,
  verifyDocxRoundtrips,
} from "../../src/server/file-io/docx-verify.js";
import { getAdapter } from "../../src/server/file-io/index.js";
import { extractText } from "../../src/server/mcp/document-model.js";
import {
  Y_MAP_ANNOTATIONS,
  Y_MAP_DOCUMENT_META,
  Y_MAP_FOOTNOTE_BODIES,
} from "../../src/shared/constants.js";
import { transactForTest } from "../../src/shared/origins.js";
import { buildComment, buildFootnote, buildHeadings } from "../helpers/docx-corpus.js";

// Wrap captureModel so one test can force a verifier-internal fault (the
// "verifier-confused → advisory" half of the asymmetry). Delegates to the real
// impl while the flag is off, so every other test runs the genuine path.
const ctl = vi.hoisted(() => ({ failCapture: false }));
vi.mock("../../src/server/file-io/docx-capture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/file-io/docx-capture.js")>();
  return {
    ...actual,
    captureModel: (doc: Y.Doc) => {
      if (ctl.failCapture) throw new Error("synthetic verifier fault");
      return actual.captureModel(doc);
    },
  };
});

afterEach(() => {
  ctl.failCapture = false;
  vi.restoreAllMocks();
});

const para = (text: string): Paragraph => new Paragraph(text);

/** Real .docx bytes from a list of single-paragraph strings (one block each). */
async function packDoc(paragraphs: string[]): Promise<Buffer> {
  const doc = new Document({ sections: [{ children: paragraphs.map(para) }] });
  return (await Packer.toBuffer(doc)) as Buffer;
}

/** Import .docx bytes into a live Y.Doc through the REAL adapter (parse + apply,
 * so annotations + footnote bodies populate — same path the editor uses). */
async function importToDoc(bytes: Buffer): Promise<Y.Doc> {
  const adapter = getAdapter("docx");
  const prepared = await adapter.parse(bytes);
  const doc = new Y.Doc();
  transactForTest(doc, () => adapter.apply(doc, prepared, { fileName: "fixture.docx" }));
  return doc;
}

async function exportBuffer(doc: Y.Doc): Promise<Buffer> {
  const adapter = getAdapter("docx");
  return Buffer.from(await adapter.saveBinary!(doc));
}

describe("verifyDocxRoundtrips", () => {
  it("passes a faithful round-trip (ok)", async () => {
    const live = await importToDoc(await buildHeadings());
    const verdict = await verifyDocxRoundtrips(await exportBuffer(live), live, { docId: "ok" });
    expect(verdict.kind).toBe("ok");
    live.destroy();
  });

  it("blocks a non-docx buffer (reimport-failed) — confirmed-broken output", async () => {
    const live = await importToDoc(await buildHeadings());
    const verdict = await verifyDocxRoundtrips(Buffer.from("not a docx zip at all"), live, {
      docId: "corrupt",
    });
    expect(verdict).toMatchObject({ kind: "blocked", reason: "reimport-failed" });
    live.destroy();
  });

  it("blocks a valid-but-empty reimport while live had content (degenerate-model)", async () => {
    const live = await importToDoc(await buildHeadings());
    const emptyBuffer = await exportBuffer(await importToDoc(await packDoc([""])));
    const verdict = await verifyDocxRoundtrips(emptyBuffer, live, { docId: "degenerate" });
    expect(verdict).toMatchObject({ kind: "blocked", reason: "degenerate-model" });
    live.destroy();
  });

  it("never blocks a legitimate tiny (1-block) doc (degenerate negative control)", async () => {
    const live = await importToDoc(await packDoc(["Just one short sentence here."]));
    const verdict = await verifyDocxRoundtrips(await exportBuffer(live), live, { docId: "tiny" });
    expect(verdict.kind).toBe("ok");
    live.destroy();
  });

  it("blocks gross text loss without a block-count collapse (gross-text-loss)", async () => {
    // 4 blocks both sides (so the degenerate block-count branch can't fire), but
    // each reimport block reduced to one word → ~1/6 retention.
    const live = await importToDoc(
      await packDoc([
        "alpha bravo charlie delta echo foxtrot",
        "golf hotel india juliet kilo lima",
        "mike november oscar papa quebec romeo",
        "sierra tango uniform victor whiskey xray",
      ]),
    );
    const thin = await exportBuffer(
      await importToDoc(await packDoc(["alpha", "golf", "mike", "sierra"])),
    );
    const verdict = await verifyDocxRoundtrips(thin, live, { docId: "gross" });
    expect(verdict).toMatchObject({ kind: "blocked", reason: "gross-text-loss" });
    live.destroy();
  });

  it("advises (not blocks) a soft text-retention shortfall (soft-text-loss)", async () => {
    const live = await importToDoc(
      await packDoc(["alpha bravo charlie delta echo foxtrot golf hotel india juliet"]),
    );
    // 6/10 tokens → 0.6: below the soft band, above the gross floor.
    const soft = await exportBuffer(
      await importToDoc(await packDoc(["alpha bravo charlie delta echo foxtrot"])),
    );
    const verdict = await verifyDocxRoundtrips(soft, live, { docId: "soft" });
    expect(verdict.kind).toBe("advisory");
    if (verdict.kind === "advisory") expect(verdict.reasons).toContain("soft-text-loss");
    live.destroy();
  });

  it("passes when an exported comment survives the round-trip (ok)", async () => {
    const live = await importToDoc(await buildComment());
    expect(prepareExportComments(live).length).toBeGreaterThan(0);
    const verdict = await verifyDocxRoundtrips(await exportBuffer(live), live, { docId: "cok" });
    expect(verdict.kind).toBe("ok");
    live.destroy();
  });

  it("advises when an exported comment doesn't survive (comment-loss, gate-keyed)", async () => {
    const live = await importToDoc(await buildComment());
    // Same visible text, no comment → high text retention, but the gate's
    // expected comment has no match in the reimport.
    const noComment = await packDoc([extractText(live).trim()]);
    const verdict = await verifyDocxRoundtrips(noComment, live, { docId: "cl" });
    expect(verdict.kind).toBe("advisory");
    if (verdict.kind === "advisory") expect(verdict.reasons).toContain("comment-loss");
    live.destroy();
  });

  it("advises when a footnote body doesn't survive (footnote-loss), body never logged", async () => {
    const live = await importToDoc(await buildFootnote());
    const bodies = live.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_FOOTNOTE_BODIES) as Record<
      string,
      { text: string }
    >;
    const fnText = Object.values(bodies)[0]?.text ?? "";
    expect(fnText.length).toBeGreaterThan(0);
    // The footnote body lives off-fragment, so the marker text alone (no footnote
    // definition) reimports with zero footnote bodies.
    const noFootnote = await packDoc([extractText(live).trim()]);
    const verdict = await verifyDocxRoundtrips(noFootnote, live, { docId: "fl" });
    expect(verdict.kind).toBe("advisory");
    if (verdict.kind === "advisory") expect(verdict.reasons).toContain("footnote-loss");
    expect(JSON.stringify(verdict)).not.toContain(fnText);
    expect(integrityWarningLines(verdict).join(" ")).not.toContain(fnText);
    live.destroy();
  });

  it("degrades a verifier-internal error to advisory, NEVER a block (asymmetry)", async () => {
    ctl.failCapture = true;
    const live = await importToDoc(await buildHeadings());
    const verdict = await verifyDocxRoundtrips(await exportBuffer(live), live, { docId: "ve" });
    expect(verdict.kind).toBe("advisory");
    if (verdict.kind === "advisory") expect(verdict.reasons).toContain("verifier-error");
    live.destroy();
  });

  it("skips the reimport above the size ceiling, relying on the snapshot (ok, skipped)", async () => {
    const live = await importToDoc(await buildHeadings());
    const buffer = await exportBuffer(live);
    const verdict = await verifyDocxRoundtrips(buffer, live, { docId: "big", maxBytes: 10 });
    expect(verdict.kind).toBe("ok");
    if (verdict.kind === "ok") {
      expect(verdict.metrics.skipped).toBe(true);
      // reimportBlockCount stays 0 → proves the reimport never ran.
      expect(verdict.metrics.reimportBlockCount).toBe(0);
    }
    live.destroy();
  });

  it("never mutates the live doc (annotation map + footnote bodies unchanged)", async () => {
    const live = await importToDoc(await buildComment());
    const annBefore = live.getMap(Y_MAP_ANNOTATIONS).size;
    const fnBefore = JSON.stringify(
      live.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_FOOTNOTE_BODIES) ?? {},
    );
    await verifyDocxRoundtrips(await exportBuffer(live), live, { docId: "imm" });
    expect(live.getMap(Y_MAP_ANNOTATIONS).size).toBe(annBefore);
    expect(JSON.stringify(live.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_FOOTNOTE_BODIES) ?? {})).toBe(
      fnBefore,
    );
    live.destroy();
  });

  it("never leaks document/comment text into the advisory, verdict, or logs (privacy)", async () => {
    const live = await importToDoc(await buildComment());
    const docText = extractText(live).trim();
    const commentBody = prepareExportComments(live)[0]?.bodyParagraphs.join(" ") ?? "";
    const secrets = [docText, commentBody].filter((s) => s.trim().length > 3);
    expect(secrets.length).toBeGreaterThan(0);

    const logged: string[] = [];
    const capture = (...a: unknown[]) =>
      logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    vi.spyOn(console, "error").mockImplementation(capture);
    vi.spyOn(console, "warn").mockImplementation(capture);

    const verdict = await verifyDocxRoundtrips(await packDoc([docText]), live, { docId: "priv" });

    const surfaces = [
      integrityWarningLines(verdict).join(" "),
      JSON.stringify(verdict),
      logged.join(" "),
    ];
    for (const secret of secrets) {
      for (const surface of surfaces) expect(surface).not.toContain(secret);
    }
    // Sanity: we actually exercised a reportable (advisory) path.
    expect(verdict.kind).toBe("advisory");
    live.destroy();
  });
});

describe("blockReasonMessage", () => {
  it("is content-free and reassures the original file was left unchanged", () => {
    for (const reason of ["reimport-failed", "degenerate-model", "gross-text-loss"] as const) {
      const msg = blockReasonMessage(reason);
      expect(msg).toContain("left unchanged");
      expect(msg).not.toMatch(/[A-Z]:\\/); // no Windows absolute path
    }
  });
});
