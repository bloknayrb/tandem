// Detection for the two Word features mammoth drops with NO warning at all
// (#1142 gate G3 — "no surprise loss, shown on open AND save"):
//
//   1. TRACKED CHANGES. mammoth traverses <w:ins> children and skips <w:del>
//      subtrees, so every insertion is silently ACCEPTED and every deletion is
//      silently DISCARDED. Measured, not assumed: a document reading
//      "Kept <ins>added</ins><del>removed</del> end." imports as
//      "Kept added end." with `warnings: []`. The document's MEANING changes
//      and nothing tells the user.
//   2. HEADERS / FOOTERS. mammoth never reads word/header*.xml / word/footer*.xml,
//      and `exportYDocToDocx` regenerates a single section with no Header/Footer,
//      so letterhead, logos and page numbers are destroyed on save. Also measured:
//      the text is absent from the imported HTML with `warnings: []`.
//
// This module only COUNTS. It reads the real package directly from the ZIP —
// the same JSZip + htmlparser2 path `docx-footnotes.ts` and `docx-comments.ts`
// use, and for the same reason: a converter's silence is not evidence of
// fidelity. It never throws (per-part AND per-archive catches), and it logs to
// stderr only (Critical Rule #3 — `console.log` would corrupt the MCP wire).
//
// PRIVACY / REDACTION CONTRACT (identical to `footnoteLossLines`, and the reason
// this module can bypass BOTH `summarizeMammothMessages`' redaction AND the
// MAX_WARNING_LINE_LENGTH clamp in docx.ts): every emitted line is a fixed
// string plus an integer count. The strongest form of the guarantee is
// structural rather than filtered — this module has NO code path that reads
// `w:author` (revision author names are PII) or header/footer TEXT (user
// content). It reads element NAMES and tests text for non-whitespace; the text
// itself is never captured, returned, or interpolated. If you ever need to name
// a thing here, you need a redaction pass first.
//
// Where these lines actually go: `FidelityReport.importLosses` is PERSISTENT and
// USER-visible (the open-time toast + the fidelity banner). It is deliberately
// NOT returned by any MCP tool — `tandem_save` surfaces only `exportDowngrades`
// and `integrityWarnings`. Keep it that way: the counts here are finer-grained
// than anything else the user-visible surfaces carry (a tracked-deletion count
// describes text that is NOT in the Y.Doc and so is otherwise unknowable), and
// routing them into a tool result would turn them into a content oracle.
//
// TANDEM'S OWN REVISIONS ARE REPORTED TOO — deliberately. `applyTrackedChanges`
// (docx-apply.ts) writes <w:ins>/<w:del> into the user's file, and on the next
// open we count and report them. That is correct, not noise: `exportYDocToDocx`
// emits no revision marks, so the next binary save destroys the tracked change
// Tandem itself created, along with the reviewer's ability to reject it.
// Suppressing them would require reading `w:author` (the PII field forbidden
// above), would be trivially spoofable by any producer, and would reintroduce
// the exact silent-loss class this module exists to close — for the one case
// where Tandem is the party responsible. Do not "optimize" it away.

import type { ChildNode } from "domhandler";
import { parseDocument } from "htmlparser2";
import JSZip from "jszip";
import { findAllByName, getAttr, getTextContent, isElement } from "./docx-walker.js";

/**
 * Revision-mark tallies, split three ways rather than collapsed into one
 * "N tracked changes" number. The three have different consequences and the
 * user needs them distinguished: a DELETION means text is already missing from
 * what they are reading, which is categorically worse than an insertion that
 * merely lost its revision marks.
 */
export interface RevisionCounts {
  /** `ins` — mammoth keeps the text, so the insertion is silently accepted. */
  insertions: number;
  /** `del` — mammoth skips the subtree, so the deleted text is silently gone. */
  deletions: number;
  /** `moveTo` — destination half of a move. Discarded by mammoth (see `tallyRevisions`). */
  moveTo: number;
  /** `moveFrom` — source half of a move. Also discarded. */
  moveFrom: number;
  /** Formatting/structure revisions — the change is applied, the record is lost. */
  formatting: number;
}

/** What a `.docx` package carries that the import silently drops. */
export interface DocxLostFeatures {
  revisions: RevisionCounts;
  /** Content-bearing `word/header*.xml` parts. */
  headers: number;
  /** Content-bearing `word/footer*.xml` parts. */
  footers: number;
  /**
   * True when the main document part could not be located or read, so the
   * revision tallies mean "couldn't check", NOT "none found". Reported as its
   * own honest line — silently returning zero here would reintroduce exactly
   * the silent loss this module exists to close.
   */
  revisionScanFailed: boolean;
}

/**
 * A fresh all-zeros scan. A FACTORY, not a shared constant: the adapter's
 * last-resort `.catch` and this module's own degradation paths must not be able
 * to hand out aliases of one mutable object.
 */
export const noLostFeatures = (): DocxLostFeatures => ({
  revisions: { insertions: 0, deletions: 0, moveTo: 0, moveFrom: 0, formatting: 0 },
  headers: 0,
  footers: 0,
  revisionScanFailed: false,
});

// ---------------------------------------------------------------------------
// Element matching
// ---------------------------------------------------------------------------

/**
 * Match on the LOCAL name, not the prefixed one.
 *
 * `w:` is a convention, not a guarantee: OOXML binds the WordprocessingML
 * namespace by URI, so a producer may legitimately declare
 * `xmlns:x="…/wordprocessingml/2006/main"` and emit `<x:ins>`. Measured: mammoth
 * imports such a package identically (its office-xml reader maps URIs to
 * canonical prefixes), silently applying every revision — so prefix-matching
 * here would return a confident all-clear on a document that IS losing content.
 * On an honesty surface a false all-clear is the worst possible failure.
 *
 * Matching bare local names is the over-warn direction this module commits to:
 * there is no `ins`/`del`/`moveTo`/`*Change` element in another OOXML namespace
 * that would false-positive, and an extra line costs nothing next to a missed
 * loss. (Tandem's other OOXML readers do assume `w:`; there the consequence is a
 * missing comment, not a false assurance.)
 */
const localName = (name: string): string => name.slice(name.lastIndexOf(":") + 1);

/**
 * Local element name → tally. One table rather than a set-per-bucket plus a
 * branch chain: adding an element name is a single edit, and a reader sees at a
 * glance that there are four buckets, not five sets.
 */
const REVISION_BUCKET: Record<string, keyof RevisionCounts> = {
  ins: "insertions",
  del: "deletions",
  moveTo: "moveTo",
  moveFrom: "moveFrom",
  // Formatting-revision elements that do NOT carry the `*Change` suffix.
  cellIns: "formatting",
  cellDel: "formatting",
  cellMerge: "formatting",
};

/**
 * Formatting revisions are ALSO matched by FAMILY (`…Change`) rather than by an
 * allow-list of the nine known members (`rPrChange`, `pPrChange`, `sectPrChange`,
 * `tblPrChange`, `tblPrExChange`, `tblGridChange`, `tcPrChange`, `trPrChange`,
 * `numberingChange`). Same reasoning as `STRUCTURAL_NOTE_TYPES` in
 * docx-footnotes.ts, in the same direction: an unknown or future revision
 * element costs one over-warned line, whereas an allow-list would silently
 * swallow it. Honesty is the priority — do NOT "tighten" this into an
 * enumeration. (Measured: the whole family is silent under mammoth, because the
 * parents that carry them — rPr/pPr/tcPr/trPr/tblPr/sectPr — are all in its
 * ignoreElements map, so it never descends far enough to warn.)
 */
const bucketFor = (local: string): keyof RevisionCounts | undefined =>
  REVISION_BUCKET[local] ?? (local.endsWith("Change") ? "formatting" : undefined);

/** How many MOVES a scan found. One in-document move emits both a `moveFrom`
 * and a `moveTo`, so `max` counts moves rather than double-counting halves,
 * while still reporting a package that carries only one half. Shared so the
 * "are there moves?" question has ONE definition (the adapter's mammoth-warning
 * filter asks it too). */
export const moveCount = (r: RevisionCounts): number => Math.max(r.moveTo, r.moveFrom);

/**
 * Tally revision marks in one parsed part. A single recursive walk with a name
 * dispatch, not one `findAllByName` pass per element type.
 *
 * MOVE semantics — the reason moves are NOT folded into insertions/deletions.
 * Measured against mammoth: `w:ins` content is kept (silently accepted) and
 * `w:del` content is dropped (silently discarded), but `w:moveTo` and
 * `w:moveFrom` are in NEITHER mammoth's element-reader map nor its
 * ignore-list, so BOTH subtrees are discarded entirely. A moved passage is
 * therefore simply MISSING. Calling a `moveTo` an "insertion" would tell the
 * user text is present and about to be made permanent when it has already
 * vanished — a false statement pointing in the dangerous direction, which on
 * this surface is worse than saying nothing.
 *
 * Local-name matching gives two exclusions for free, and both are wanted:
 *   - `delText` / `delInstrText` are the PAYLOAD inside a `del` (counting them
 *     would multiply one deletion by its run count), and
 *   - `moveFromRangeStart/End`, `moveToRangeStart/End`,
 *     `customXmlInsRangeStart/End`, `customXmlDelRangeStart/End` are
 *     bookkeeping markers around content that is already counted.
 *
 * KNOWN OVER-COUNT, deliberately not "fixed": a paragraph-mark revision
 * (`<w:pPr><w:rPr><w:ins/></w:rPr></w:pPr>`) and a table-row revision
 * (`<w:trPr><w:ins/></w:trPr>`) both tally as insertions, so our totals can
 * exceed the number Word's review pane shows. Those ARE real revisions that get
 * silently applied; over-warning beats under-warning.
 *
 * Nested revisions (an `ins` inside a `del` — Word's "inserted, then deleted")
 * tally in both buckets. Also correct: both revisions exist.
 */
function tallyRevisions(nodes: ChildNode[], into: RevisionCounts): void {
  for (const node of nodes) {
    if (!isElement(node)) continue;
    const bucket = bucketFor(localName(node.name));
    if (bucket) into[bucket]++;
    tallyRevisions(node.children, into);
  }
}

// ---------------------------------------------------------------------------
// Headers / footers
// ---------------------------------------------------------------------------

// Non-text markers that make a header/footer part content-bearing. Clause (3)
// of the predicate — the field markers — is the load-bearing one: a page-number
// footer contains NO literal text at all, only
// `<w:fldChar/><w:instrText> PAGE </w:instrText><w:fldChar/>`, so a text-only
// check would miss precisely the loss this feature exists to surface.
const HEADER_CONTENT_ELEMENTS = new Set([
  "drawing", // inline/anchored image — a letterhead logo
  "pict", // legacy VML picture
  "object", // embedded object
  "fldSimple", // simple field (PAGE, NUMPAGES, DATE…)
  "instrText", // complex-field instruction
  "fldChar", // complex-field begin/separate/end
  "sym", // symbol glyph — a Wingdings logo mark carries no w:t at all
  "tbl", // a borderless layout table is page furniture the user notices
]);

// Text-carrying elements. `delText` is included so a header whose only text
// sits inside a tracked deletion still counts as content-bearing.
const HEADER_TEXT_ELEMENTS = new Set(["t", "delText"]);

/**
 * Whether a header/footer part carries anything the user would notice missing.
 *
 * Content-based rather than existence-based, which is deliberately the OPPOSITE
 * posture from `docx-footnotes.ts`. Notes have structural sentinels to exclude;
 * headers do not — but Word routinely emits EMPTY even-page/first-page header
 * and footer parts whenever "different first page" or "different odd & even" is
 * enabled. An existence check would therefore fire on documents with genuinely
 * nothing in the header, which is a trust-destroying false positive on exactly
 * the "no surprise loss" gate this is built for. The over-warn budget is spent
 * inside the content test instead (the field clause above).
 *
 * Only ever asks "is there a non-whitespace character?" — the text itself is
 * never captured or returned. See the privacy contract in the module header.
 */
function hasVisibleContent(nodes: ChildNode[]): boolean {
  for (const node of nodes) {
    if (!isElement(node)) continue;
    const local = localName(node.name);
    if (HEADER_CONTENT_ELEMENTS.has(local)) return true;
    if (HEADER_TEXT_ELEMENTS.has(local) && /\S/.test(getTextContent(node))) return true;
    if (hasVisibleContent(node.children)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Part resolution
// ---------------------------------------------------------------------------

const REL_NS_MAIN = "/relationships/officeDocument";

/**
 * Read one part and hand its parsed children to `use`. Returns false when the
 * part is absent, unreadable, or unparseable so the caller can decide the
 * degradation direction — which differs by concern (see `scanDocxLostFeatures`).
 *
 * `xmlMode` preserves namespace prefixes on element names, and htmlparser2
 * resolves no DOCTYPE or external entities, so there is no XXE surface (same
 * parser and same posture as docx-walker / docx-footnotes / docx-apply).
 */
async function withPart(
  zip: JSZip,
  partPath: string,
  use: (children: ChildNode[]) => void,
): Promise<boolean> {
  const file = zip.file(partPath);
  if (!file) return false; // Common clean case: the part simply isn't there.
  try {
    const doc = parseDocument(await file.async("text"), { xmlMode: true });
    use(doc.children);
    return true;
  } catch (err) {
    console.error(`[docx-lost-features] failed to analyze ${partPath}:`, err);
    return false;
  }
}

/** Normalize an OPC relationship target to a package-root-relative entry name. */
function resolveTarget(baseDir: string, target: string): string {
  const clean = target.replace(/\\/g, "/").trim();
  if (clean.startsWith("/")) return clean.slice(1); // package-absolute
  return baseDir ? `${baseDir}/${clean}` : clean;
}

/** First relationship whose Type ends with `suffix`, resolved against `baseDir`. */
function relationshipTarget(
  children: ChildNode[],
  baseDir: string,
  suffix: string,
): string | undefined {
  for (const rel of findAllByName("Relationship", children)) {
    const type = getAttr(rel, "Type");
    const target = getAttr(rel, "Target");
    if (!type || !target) continue;
    // External relationships point outside the package; we never follow those.
    if (getAttr(rel, "TargetMode") === "External") continue;
    if (type.endsWith(suffix)) return resolveTarget(baseDir, target);
  }
  return undefined;
}

/**
 * Locate the parts whose revisions we count, the way the IMPORTER locates them.
 *
 * `word/document.xml` is a convention, not a rule: OPC names the main part in
 * `_rels/.rels` via the `officeDocument` relationship, and mammoth resolves it
 * that way with `word/document.xml` only as a fallback. Measured: a package
 * whose main part is `word/document2.xml` (Word itself emits this after some
 * repair/save cycles, and third-party generators do it routinely) imports
 * perfectly — silently applying every revision — while a hardcoded path finds
 * nothing and reports a confident "no tracked changes". That is the silent loss
 * this module exists to close, reintroduced by the detector itself.
 *
 * Footnote/endnote parts are resolved relative to the main part's directory for
 * the same reason. Header/footer parts are deliberately NOT resolved through
 * rels — they are matched by path in the scan below, because an UNREFERENCED
 * header part is still content the user will not get back, and because the
 * over-warn direction is correct there.
 *
 * Returns `undefined` for the main part when it cannot be located at all, which
 * the caller escalates to `revisionScanFailed` rather than a silent zero.
 */
async function resolveRevisionParts(
  zip: JSZip,
): Promise<{ main: string | undefined; notes: string[] }> {
  let main: string | undefined;
  await withPart(zip, "_rels/.rels", (children) => {
    main = relationshipTarget(children, "", REL_NS_MAIN);
  });
  // Fallback matches mammoth's own: a package with no readable root rels but a
  // conventionally-named main part is still worth scanning.
  if (!main || !zip.file(main))
    main = zip.file("word/document.xml") ? "word/document.xml" : undefined;
  if (!main) return { main: undefined, notes: [] };

  const slash = main.lastIndexOf("/");
  const baseDir = slash === -1 ? "" : main.slice(0, slash);
  const base = main.slice(slash + 1);
  const notes: string[] = [];
  await withPart(zip, `${baseDir ? `${baseDir}/` : ""}_rels/${base}.rels`, (children) => {
    for (const suffix of ["/relationships/footnotes", "/relationships/endnotes"]) {
      const target = relationshipTarget(children, baseDir, suffix);
      if (target) notes.push(target);
    }
  });
  // Conventional fallback when the rels part is absent/unreadable.
  if (notes.length === 0) {
    for (const p of [`${baseDir}/footnotes.xml`, `${baseDir}/endnotes.xml`]) {
      if (zip.file(p)) notes.push(p);
    }
  }
  return { main, notes };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Upper bound on header/footer parts we will inflate. OOXML allows at most
 * three headers and three footers per section, so 32 is already far beyond any
 * real document — this is a resource guard, not a fidelity limit.
 *
 * It exists because this is the ONE place in the docx read path whose read
 * COUNT is attacker-controlled: every other read targets a fixed literal path.
 * Without the cap, an archive naming 20,000 `word/headerN.xml` entries — well
 * under the 50 MB input limit when each is highly compressible — would have us
 * inflate all of them. Parts beyond the cap are COUNTED (over-warn) but not
 * read, so the guard can never hide a loss. Reads are sequential for the same
 * reason: peak memory stays one part, not their sum.
 *
 * Per-part decompressed size is bounded best-effort below. Note the remaining
 * gap is pre-existing and shared with every other read here (a single hostile
 * `document.xml` inflates unbounded today) — a general ratio/entry cap for the
 * whole docx read path is tracked separately; this only refuses to ADD a new
 * multiplier.
 */
const MAX_HEADER_FOOTER_PARTS = 32;

/** Generous ceiling for a page header/footer part. Best-effort: JSZip exposes
 * the central directory's uncompressed size, which a crafted archive may lie
 * about, so this is a cheap first line rather than a guarantee. */
const MAX_HEADER_FOOTER_BYTES = 2 * 1024 * 1024;

/** OPC part names compare case-insensitively, so match lowercased. `\d*` also
 * covers the no-digit `word/header.xml` form some producers emit. Anchored at
 * both ends, so nested or lookalike paths (`word/header1.xml/x`,
 * `word/media/header1.xml`) cannot match. */
const HEADER_FOOTER_PART = /^word\/(header|footer)\d*\.xml$/;

/** Best-effort declared uncompressed size, or undefined when JSZip doesn't
 * expose it (never trusted for correctness — only to skip an obvious bomb). */
function declaredSize(file: unknown): number | undefined {
  const size = (file as { _data?: { uncompressedSize?: unknown } })?._data?.uncompressedSize;
  return typeof size === "number" ? size : undefined;
}

/**
 * Count the silently-dropped features in an UNTRUSTED `.docx` buffer.
 *
 * Never throws: a non-ZIP or corrupt buffer degrades to all-zeros (mammoth,
 * run in parallel by the adapter, surfaces a genuinely broken file — loss
 * honesty is moot when the import itself fails).
 */
export async function scanDocxLostFeatures(buffer: Buffer): Promise<DocxLostFeatures> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    console.error("[docx-lost-features] could not open .docx archive:", err);
    return noLostFeatures();
  }
  const out = noLostFeatures();

  // Revisions. A part that exists but won't parse degrades to "none found" for
  // that part — inventing a count we can't stand behind would be its own kind of
  // dishonesty. But failing to find the MAIN part at all is a different claim:
  // it means "couldn't check", and it gets its own line rather than a silent zero.
  const { main, notes } = await resolveRevisionParts(zip);
  if (!main) {
    out.revisionScanFailed = true;
    console.error("[docx-lost-features] no main document part; cannot check for tracked changes");
  } else {
    for (const part of [main, ...notes]) {
      const read = await withPart(zip, part, (children) => tallyRevisions(children, out.revisions));
      // Only the MAIN part failing invalidates the claim; a missing/unreadable
      // notes part just means no note revisions were counted.
      if (!read && part === main) {
        out.revisionScanFailed = true;
        console.error(`[docx-lost-features] ${part} unreadable; cannot check for tracked changes`);
      }
    }
  }

  // Headers/footers: an unreadable part counts as content-bearing. The OPPOSITE
  // direction from revisions above, and deliberately so — here the question is
  // binary ("does this part hold something?") and we cannot prove an unreadable
  // part is empty. An honesty feature must never conflate "couldn't read it"
  // with "nothing was there". (This also diverges from `collectRealNotes`'s
  // degrade-to-empty in docx-footnotes.ts, where the failure mode is symmetric.)
  const matches: Array<{ name: string; kind: "headers" | "footers" }> = [];
  for (const name of Object.keys(zip.files)) {
    const group = HEADER_FOOTER_PART.exec(name.toLowerCase())?.[1];
    // Classified ONCE, from the same match that admitted the part — a second
    // independent `startsWith` would silently mis-bucket if the regex widened.
    if (group) matches.push({ name, kind: group === "header" ? "headers" : "footers" });
  }
  if (matches.length > MAX_HEADER_FOOTER_PARTS) {
    console.error(
      `[docx-lost-features] ${matches.length} header/footer parts exceeds the ` +
        `${MAX_HEADER_FOOTER_PARTS} cap; counting the remainder unread`,
    );
  }
  for (const [i, { name, kind }] of matches.entries()) {
    // `undefined` = we did not understand this part, which is NOT the same as
    // "it was empty" and must count. Over the cap, or implausibly large, we
    // never look — so it stays undefined and counts, and the resource guard can
    // never hide a loss.
    let counts: boolean | undefined;
    const oversized = (declaredSize(zip.file(name)) ?? 0) > MAX_HEADER_FOOTER_BYTES;
    if (i < MAX_HEADER_FOOTER_PARTS && !oversized) {
      await withPart(zip, name, (children) => {
        // htmlparser2 is deliberately forgiving and essentially never throws —
        // it parses garbage into a bare text node. So "the callback ran" is not
        // evidence the part was understood. A genuine header/footer part always
        // has at least a root element (`<w:hdr>`), so zero elements means we
        // did not understand it.
        if (children.some(isElement)) counts = hasVisibleContent(children);
      });
      if (counts === undefined) {
        console.error(`[docx-lost-features] ${name} unreadable; counting it as content-bearing`);
      }
    }
    if (counts ?? true) out[kind]++;
  }

  return out;
}

/**
 * The ONE line shape this module emits: an integer, a singular/plural subject
 * (verb included, since a parenthetical often sits between noun and verb), and
 * a fixed tail. Keeping every line on one idiom is what makes the allowlist test
 * meaningful — and it is where a "1 headers weren't" mismatch would otherwise
 * creep in, since half the lines need the verb inside the subject.
 */
const line = (n: number, one: string, many: string, tail: string): string =>
  `${n} ${n === 1 ? one : many} ${tail}`;

/**
 * Honest, user-facing `FidelityReport.importLosses` lines.
 *
 * COUNTS ONLY — see the privacy contract in the module header. These lines
 * bypass both `summarizeMammothMessages`' redaction and the
 * `MAX_WARNING_LINE_LENGTH` clamp, which is safe ONLY because every one of them
 * is a fixed string plus an integer. Interpolating anything else here
 * reintroduces the user-content-leak vector those two mechanisms exist to close.
 *
 * Ordered most-destructive first: a tracked deletion is the only entry in the
 * whole fidelity report where the text the user is reading is not the text the
 * author wrote.
 */
export function lostFeatureLossLines(scan: DocxLostFeatures): string[] {
  const lines: string[] = [];
  const { insertions, deletions, formatting } = scan.revisions;

  if (scan.revisionScanFailed) {
    lines.push(
      "Tandem couldn't check this file for tracked changes — if it has any, they won't be " +
        "preserved on save",
    );
  }
  if (deletions > 0) {
    lines.push(
      line(
        deletions,
        "tracked deletion was",
        "tracked deletions were",
        "applied automatically — the deleted text is already missing, and saving " +
          "drops it from the file",
      ),
    );
  }
  if (insertions > 0) {
    lines.push(
      line(
        insertions,
        "tracked insertion was",
        "tracked insertions were",
        "accepted automatically — saving makes that permanent",
      ),
    );
  }
  // Moves are content LOSS, not insertions — mammoth discards both halves (see
  // `tallyRevisions`). `moveCount` collapses the two halves of one move.
  const moves = moveCount(scan.revisions);
  if (moves > 0) {
    lines.push(
      line(
        moves,
        'moved passage (Word "move" revisions) wasn\'t',
        'moved passages (Word "move" revisions) weren\'t',
        "imported — the moved text is missing from this document",
      ),
    );
  }
  if (formatting > 0) {
    lines.push(
      line(
        formatting,
        "tracked formatting change was",
        "tracked formatting changes were",
        "applied automatically — the revision record isn't preserved on save",
      ),
    );
  }
  if (scan.headers > 0) {
    lines.push(
      line(
        scan.headers,
        "page header (letterhead, logos, or running titles) wasn't",
        "page headers (letterhead, logos, or running titles) weren't",
        "imported and will be dropped from the file on save",
      ),
    );
  }
  if (scan.footers > 0) {
    lines.push(
      line(
        scan.footers,
        "page footer (page numbers or confidentiality notices) wasn't",
        "page footers (page numbers or confidentiality notices) weren't",
        "imported and will be dropped from the file on save",
      ),
    );
  }
  return lines;
}
