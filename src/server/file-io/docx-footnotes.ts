// Footnote/endnote DETECTION for the import honesty layer (Tier-A #3, PR 1 of 2).
//
// mammoth flattens Word footnotes/endnotes to a trailing <ol> and emits NO
// warning, so the degradation is SILENT: the user sees a mystery trailing list
// and, on save, loses the footnote semantic + reference links with no notice.
// This module detects real footnotes/endnotes directly from the .docx ZIP (the
// same JSZip + htmlparser2 path the comment importer uses) so the import path
// can add an honest line to the FidelityReport. It only READS and COUNTS — no
// rels, no external refs, no writes (security posture identical to the comment
// path; ratified in the security review of
// .claude/plans/docx-footnote-honesty.md).
//
// PR 2 (reconstruction) will extend this module to capture footnote BODIES and
// inline reference positions; PR 1 lands detection only.

import { parseDocument } from "htmlparser2";
import JSZip from "jszip";
import { findAllByName, getAttr } from "./docx-walker.js";

export interface FootnoteSummary {
  /** Real footnotes (excludes Word's structural separator notes). */
  footnotes: number;
  /** Real endnotes (same exclusion). */
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

/** Count real (non-structural) notes in one notes part, or 0 if the part is absent. */
async function countRealNotes(zip: JSZip, partPath: string, elementName: string): Promise<number> {
  const file = zip.file(partPath);
  if (!file) return 0; // Common clean case: a doc with no notes omits the part.
  try {
    const xml = await file.async("text");
    // xmlMode preserves the `w:` prefix on both element names and attributes
    // (same trusted parser as docx-walker / docx-apply); htmlparser2 does not
    // resolve DOCTYPE/external entities, so there is no XXE surface.
    const doc = parseDocument(xml, { xmlMode: true });
    return findAllByName(elementName, doc.children).filter((note) => {
      const type = getAttr(note, "w:type");
      return type === undefined || !STRUCTURAL_NOTE_TYPES.has(type);
    }).length;
  } catch (err) {
    // Present but unreadable. Degrade to 0 (never block import) but leave a
    // breadcrumb — an honesty feature must not silently conflate "couldn't read
    // the notes part" with "no notes". htmlparser2 is non-throwing, so this is
    // nearly unreachable (only a corrupt ZIP entry trips it) and the user still
    // sees the flattened content, so a user-facing line for this case is deferred.
    console.error(`[docx-footnotes] failed to analyze ${partPath}:`, err);
    return 0;
  }
}

/**
 * Detect real footnotes/endnotes in an UNTRUSTED .docx buffer. Read-and-count
 * only. Never throws: a non-ZIP/corrupt buffer degrades to {0,0} (mammoth, run
 * in parallel, surfaces a genuinely-broken file — footnote honesty is moot when
 * the import itself fails).
 */
export async function detectDocxFootnotes(buffer: Buffer): Promise<FootnoteSummary> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    console.error("[docx-footnotes] could not open .docx archive:", err);
    return { footnotes: 0, endnotes: 0 };
  }
  const [footnotes, endnotes] = await Promise.all([
    countRealNotes(zip, "word/footnotes.xml", "w:footnote"),
    countRealNotes(zip, "word/endnotes.xml", "w:endnote"),
  ]);
  return { footnotes, endnotes };
}

/**
 * Honest, user-facing FidelityReport lines for flattened notes.
 *
 * INPUTS ARE COUNTS ONLY — never thread parsed-XML or user text through here.
 * These lines bypass BOTH `summarizeMammothMessages`' redaction AND the
 * `MAX_WARNING_LINE_LENGTH` clamp (docx.ts), which is safe ONLY because every
 * line below is a fixed string plus an integer count. PR 2 reconstruction
 * threading footnote text through this function would reintroduce the
 * user-content-leak vector and would require summarizeMammothMessages-style
 * redaction.
 */
export function footnoteLossLines(summary: FootnoteSummary): string[] {
  const lines: string[] = [];
  if (summary.footnotes > 0) {
    const n = summary.footnotes;
    lines.push(
      `${n === 1 ? "1 footnote" : `${n} footnotes`} flattened to a trailing list — ` +
        `footnote markers and links aren't preserved on save`,
    );
  }
  if (summary.endnotes > 0) {
    const n = summary.endnotes;
    lines.push(
      `${n === 1 ? "1 endnote" : `${n} endnotes`} flattened to a trailing list — ` +
        `endnote markers and links aren't preserved on save`,
    );
  }
  return lines;
}
