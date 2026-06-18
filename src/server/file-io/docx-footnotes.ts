// Footnote/endnote CAPTURE for the import honesty + reconstruction layers
// (Tier-A #3). mammoth flattens Word footnotes/endnotes to a trailing <ol> and
// emits NO warning, so the degradation is otherwise SILENT. This module reads
// the real notes directly from the .docx ZIP (the same JSZip + htmlparser2 path
// the comment importer uses) so the import path can BOTH surface an honest
// FidelityReport line AND — for footnotes — capture the body text so the export
// can re-emit a real `<w:footnote>` (PR 2 reconstruction).
//
// It only READS — no rels, no external refs, no writes (security posture
// identical to the comment path; ratified in the security review of
// .claude/plans/docx-footnote-honesty.md). Footnote BODY TEXT captured here is
// document content and is threaded into the Y.Doc, but is NEVER routed into
// `footnoteLossLines` (see the redaction note there).

import type { ChildNode, Element } from "domhandler";
import { parseDocument } from "htmlparser2";
import JSZip from "jszip";
import type { FootnoteBody } from "../../shared/types.js";
import { findAllByName, getAttr, getTextContent, isElement } from "./docx-walker.js";

/**
 * Footnote bodies (keyed by OOXML footnote id — the same id mammoth puts in its
 * `#footnote-N` href) plus the endnote count. Footnotes carry bodies (PR 2
 * reconstructs them); endnotes are count-only (still degrade to a list, honestly
 * reported — endnote reconstruction is a deferred fast-follow).
 */
export interface DocxNotes {
  footnotes: Record<string, FootnoteBody>;
  endnotes: number;
}

// Word ALWAYS embeds these structural sentinel notes in word/footnotes.xml and
// word/endnotes.xml even when the document has ZERO real footnotes (empirically
// confirmed: the docx package emits BOTH parts, each with a `separator` and a
// `continuationSeparator` note, for every document). A "real" note is one whose
// `w:type` is NONE of these — i.e. the attribute is absent (defaults to the
// "normal" type per OOXML ST_FtnEdn) or carries a non-structural value.
//
// We EXCLUDE this set rather than allow-list "normal"/absent so an unknown or
// future structural type is treated as a REAL note (over-warn) instead of being
// silently swallowed — honesty is the priority. A future OOXML structural type
// would surface a (harmless) "footnotes flattened" warning; do NOT "fix" that by
// flipping to an allowlist, which would risk silently dropping a real footnote.
const STRUCTURAL_NOTE_TYPES = new Set(["separator", "continuationSeparator", "continuationNotice"]);

// Body-formatting markers we DROP on import (the body is flattened to plain
// text in PR 2). Presence drives the count-only honesty line; rich-body
// fidelity is a deferred fast-follow. `<w:rStyle>` (the footnote-number style)
// is deliberately NOT here — it's structural, not body formatting.
const FORMATTING_ELEMENTS = new Set(["w:b", "w:i", "w:u", "w:hyperlink"]);

/**
 * Collect real (non-structural) note Elements from one notes part, or [] if the
 * part is absent/unreadable. Shared by footnote + endnote extraction.
 */
async function collectRealNotes(
  zip: JSZip,
  partPath: string,
  elementName: string,
): Promise<Element[]> {
  const file = zip.file(partPath);
  if (!file) return []; // Common clean case: a doc with no notes omits the part.
  try {
    const xml = await file.async("text");
    // xmlMode preserves the `w:` prefix on both element names and attributes
    // (same trusted parser as docx-walker / docx-apply); htmlparser2 does not
    // resolve DOCTYPE/external entities, so there is no XXE surface.
    const doc = parseDocument(xml, { xmlMode: true });
    return findAllByName(elementName, doc.children).filter((note) => {
      const type = getAttr(note, "w:type");
      return type === undefined || !STRUCTURAL_NOTE_TYPES.has(type);
    });
  } catch (err) {
    // Present but unreadable. Degrade to [] (never block import) but leave a
    // breadcrumb — an honesty feature must not silently conflate "couldn't read
    // the notes part" with "no notes". htmlparser2 is non-throwing, so this is
    // nearly unreachable (only a corrupt ZIP entry trips it) and the user still
    // sees the flattened content, so a user-facing line for this case is deferred.
    console.error(`[docx-footnotes] failed to analyze ${partPath}:`, err);
    return [];
  }
}

/** Whether a note subtree carries body formatting we flatten to plain text. */
function noteHadFormatting(note: Element): boolean {
  let paragraphs = 0;
  let formatted = false;
  const walk = (nodes: ChildNode[]): void => {
    for (const node of nodes) {
      if (!isElement(node)) continue;
      if (node.name === "w:p") paragraphs++;
      if (FORMATTING_ELEMENTS.has(node.name)) formatted = true;
      walk(node.children);
    }
  };
  walk(note.children);
  return formatted || paragraphs > 1;
}

/**
 * Parse real footnote bodies + count real endnotes from an UNTRUSTED .docx
 * buffer. Never throws: a non-ZIP/corrupt buffer degrades to empty (mammoth, run
 * in parallel, surfaces a genuinely-broken file — note honesty is moot when the
 * import itself fails).
 */
export async function parseDocxFootnotes(buffer: Buffer): Promise<DocxNotes> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    console.error("[docx-footnotes] could not open .docx archive:", err);
    return { footnotes: {}, endnotes: 0 };
  }
  const [footnoteEls, endnoteEls] = await Promise.all([
    collectRealNotes(zip, "word/footnotes.xml", "w:footnote"),
    collectRealNotes(zip, "word/endnotes.xml", "w:endnote"),
  ]);
  const footnotes: Record<string, FootnoteBody> = {};
  for (const note of footnoteEls) {
    const id = getAttr(note, "w:id");
    if (id === undefined) continue; // a real footnote always carries an id
    footnotes[id] = { text: getTextContent(note), hadFormatting: noteHadFormatting(note) };
  }
  return { footnotes, endnotes: endnoteEls.length };
}

/**
 * The reconstruction partition for the captured footnotes (from
 * `reconcileFootnoteIds`): ids that WILL reconstruct as real footnotes vs ids
 * that won't (an orphaned definition with no inline ref, or a mammoth-format
 * drift). Drives an honest loss line per outcome.
 */
export interface FootnoteReconciliation {
  reconstructed: string[];
  dropped: string[];
}

/**
 * Honest, user-facing FidelityReport lines for notes.
 *
 * INPUTS ARE COUNTS/FLAGS/IDS ONLY — never thread the captured footnote body
 * text through here. These lines bypass BOTH `summarizeMammothMessages`'
 * redaction AND the `MAX_WARNING_LINE_LENGTH` clamp (docx.ts), which is safe
 * ONLY because every line below is a fixed string plus an integer count.
 * Threading body text would reintroduce the user-content-leak vector.
 *
 * Post-PR-2 contract (HIGH-2): footnotes that RECONSTRUCT round-trip as real
 * `<w:footnote>` parts, so they get NO structural-loss line — at most a
 * count-only body-FORMATTING line (we store plain text). A footnote that fails
 * reconciliation degrades (orphan → absent; drift → trailing list), so it gets
 * an honest structural line rather than being silently claimed "preserved" — the
 * partition is computed pre-`apply` from the same reconciliation `htmlToYDoc`
 * runs. Endnotes always degrade to a trailing list (reconstruction deferred).
 */
export function footnoteLossLines(
  notes: DocxNotes,
  reconciliation: FootnoteReconciliation,
): string[] {
  const lines: string[] = [];
  // Reconstructed footnotes whose body carried formatting we flattened.
  const formattingFlattened = reconciliation.reconstructed.filter(
    (id) => notes.footnotes[id]?.hadFormatting,
  ).length;
  if (formattingFlattened > 0) {
    const n = formattingFlattened;
    lines.push(
      `${n === 1 ? "1 footnote" : `${n} footnotes`} preserved, but body formatting ` +
        `(bold/italic/links or multiple paragraphs) was simplified to plain text`,
    );
  }
  // Captured footnotes that won't reconstruct — degraded, NOT preserved.
  if (reconciliation.dropped.length > 0) {
    const n = reconciliation.dropped.length;
    lines.push(
      `${n === 1 ? "1 footnote" : `${n} footnotes`} couldn't be reconstructed and ` +
        `won't be preserved as footnotes on save`,
    );
  }
  if (notes.endnotes > 0) {
    const n = notes.endnotes;
    lines.push(
      `${n === 1 ? "1 endnote" : `${n} endnotes`} flattened to a trailing list — ` +
        `endnote markers and links aren't preserved on save`,
    );
  }
  return lines;
}
