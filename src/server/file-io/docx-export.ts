// Y.Doc -> .docx export (#576: v1.0 body, #1068: v1.1 Word comments).
//
// Production write-back engine using the `docx` npm package. Walks
// `Y.Doc.getXmlFragment("default")` and maps Tiptap node names onto the
// `docx` package's Paragraph / Table constructors, flattening Y.XmlText
// deltas into TextRuns with marks.
//
// SCOPE: body content + Word comments. Tandem `comment`-type annotations are
// emitted as Word comments (`comments.xml` + CommentRangeStart/End markers).
// The privacy gate and range resolution live in `docx-comment-export.ts`
// (ADR-027: notes and highlights are NEVER exported). NOT exported here:
//   - Tracked changes — requires a Y.Doc authorship-diff layer (deferred).
//   - Threaded comment replies — docx@9.x has no `commentsExtended.xml`
//     support; exportable replies are flattened into the comment body.
//   - Inline images — degraded to alt text (mdast-ydoc imports images as
//     inline phrasing content, not top-level <image> nodes; see the docx-npm
//     spike). Top-level <image> nodes ARE exported when present.
//
// COMMENT ANCHORING. Comment ranges are flat-offset based (the annotation
// coordinate system: `extractText` semantics — heading prefixes count,
// top-level blocks join with \n, nested blocks separate with \n, hardBreak
// embeds count 1). The emitter threads a cursor (`EmitCtx.pos`) through the
// block walk that advances EXACTLY like `extractText`/`getElementText`, and
// splits TextRuns at comment boundaries so `w:commentRangeStart/End` land at
// offsets the import-side walker (`docx-walker.ts#walkDocumentBody`)
// recomputes identically. Content the exporter drops or rewrites (image alt
// placeholders, unknown nested blocks) still advances the cursor by its
// ORIGINAL flat length so later anchors stay aligned.
//
// TRUST BOUNDARY (must be preserved by any future change). A .docx Tandem
// produces must never carry hostile relationships out into the filesystem or
// network:
//   1. NO r:link external image references — only inline `data:` images are
//      embedded as raw bytes via `ImageRun({ data: Buffer })`. We never pass a
//      URL / remote-image reference to `docx`.
//   2. NO `<w:object>` embedded objects — `docx` has no public OLE API and we
//      never call any embed-object method.
//   3. NO `targetMode="External"` relationships pointing to `file://` or UNC
//      paths — hyperlinks are scrubbed to `http`/`https`/`mailto` only.
//   4. Unknown Y.XmlElement node names fall through to a text-only paragraph,
//      never to a passthrough that could inject markup.
//
// All Tiptap node-name strings in this file mirror those produced by
// `mdast-ydoc.ts` / `docx-html.ts` and consumed by the editor; they are NOT
// Y.Map keys, so they do not require the Y_MAP_* constants (Critical Rule #1).

import {
  AlignmentType,
  CommentRangeEnd,
  CommentRangeStart,
  CommentReference,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  type ICommentOptions,
  ImageRun,
  Packer,
  Paragraph,
  type ParagraphChild,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import * as Y from "yjs";
import { headingPrefixLength } from "../../shared/offsets.js";
import { extractText, getElementTextLength } from "../mcp/document-model.js";
import { type ExportComment, prepareExportComments } from "./docx-comment-export.js";

// -- Trust-boundary helpers ---------------------------------------------------

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Returns the URL if it is safe to embed as an ExternalHyperlink target,
 * otherwise null. Blocks `file://`, UNC paths, Windows drive paths, and any
 * non-http(s)/mailto scheme so no exported docx can carry a
 * `targetMode="External"` relationship pointing at a local filesystem resource.
 */
export function safeHyperlinkUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // UNC: `\\server\share\path`
  if (trimmed.startsWith("\\\\")) return null;
  // Windows drive paths: `C:\...`
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return null;
  try {
    const u = new URL(trimmed);
    if (!SAFE_LINK_PROTOCOLS.has(u.protocol)) return null;
    return u.toString();
  } catch {
    // Relative or malformed -- drop it (no implicit base).
    return null;
  }
}

/**
 * Image embed gate. Only inline `data:` URIs are accepted; everything else
 * (http, https, file, UNC, relative paths) is dropped so we never produce an
 * `r:link` external image reference.
 */
export function safeImageEmbed(
  src: string | null | undefined,
): { data: Buffer; type: "png" | "jpg" | "gif" | "bmp" } | null {
  if (!src) return null;
  const match = /^data:image\/(png|jpe?g|gif|bmp);base64,([A-Za-z0-9+/=]+)$/.exec(src.trim());
  if (!match) return null;
  const rawType = match[1].toLowerCase();
  const type = (rawType === "jpeg" ? "jpg" : rawType) as "png" | "jpg" | "gif" | "bmp";
  try {
    const data = Buffer.from(match[2], "base64");
    if (data.length === 0) return null;
    return { data, type };
  } catch {
    return null;
  }
}

// -- Comment marker events ------------------------------------------------------

/**
 * A comment range marker scheduled at a flat-text offset. `order` breaks ties
 * at equal offsets: real range ends (0) close before new ranges open (1);
 * collapsed (zero-width) ranges keep start-before-end (their end sorts at 2).
 */
interface CommentEvent {
  offset: number;
  order: 0 | 1 | 2;
  components: ParagraphChild[];
}

/**
 * Mutable emission context threaded through the block walk. `pos` is the
 * flat-text cursor (extractText coordinates); `events` is sorted by
 * (offset, order); `idx` is the next unflushed event.
 */
interface EmitCtx {
  pos: number;
  events: CommentEvent[];
  idx: number;
}

function buildCommentEvents(comments: ExportComment[]): CommentEvent[] {
  const events: CommentEvent[] = [];
  for (const c of comments) {
    events.push({ offset: c.from, order: 1, components: [new CommentRangeStart(c.id)] });
    events.push({
      offset: c.to,
      order: c.from === c.to ? 2 : 0,
      // OOXML requires the reference run (which binds the comment bubble to
      // the range) immediately after the range end marker.
      components: [
        new CommentRangeEnd(c.id),
        new TextRun({ children: [new CommentReference(c.id)] }),
      ],
    });
  }
  events.sort((a, b) => a.offset - b.offset || a.order - b.order);
  return events;
}

/** Emit every pending marker whose offset the cursor has reached. */
function flushCommentEvents(emit: EmitCtx, out: ParagraphChild[]): void {
  while (emit.idx < emit.events.length && emit.events[emit.idx].offset <= emit.pos) {
    out.push(...emit.events[emit.idx].components);
    emit.idx++;
  }
}

// -- Tiptap -> docx runtime conversion ----------------------------------------

interface MarkState {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  underline?: boolean;
  superscript?: boolean;
  subscript?: boolean;
  link?: { href: string; title?: string } | null;
}

interface InlineRun {
  text: string;
  marks: MarkState;
}

/** Walk a Y.XmlText, flattening deltas into typed runs. */
function flattenXmlText(xt: Y.XmlText): InlineRun[] {
  const runs: InlineRun[] = [];
  const delta = xt.toDelta() as Array<{
    insert?: string | Record<string, unknown>;
    attributes?: Record<string, unknown>;
  }>;
  for (const op of delta) {
    if (typeof op.insert === "string") {
      const attrs = op.attributes ?? {};
      const marks: MarkState = {
        bold: attrs.bold != null,
        italic: attrs.italic != null,
        strike: attrs.strike != null,
        code: attrs.code != null,
        underline: attrs.underline != null,
        superscript: attrs.superscript != null,
        subscript: attrs.subscript != null,
      };
      const link = attrs.link as { href?: string; title?: string } | undefined;
      if (link?.href) {
        marks.link = { href: link.href, ...(link.title ? { title: link.title } : {}) };
      }
      runs.push({ text: op.insert, marks });
    } else if (op.insert && typeof op.insert === "object") {
      // hardBreak embed -- represented as `\n`; the emitter turns it into a
      // dedicated `<w:br/>` run (1 flat character).
      runs.push({ text: "\n", marks: {} });
    }
  }
  return runs;
}

function makeTextRun(text: string, marks: MarkState): TextRun {
  return new TextRun({
    text,
    bold: marks.bold,
    italics: marks.italic,
    strike: marks.strike,
    underline: marks.underline ? {} : undefined,
    superScript: marks.superscript,
    subScript: marks.subscript,
    // `docx` lacks a first-class inline-code style; approximate with a
    // monospace font + light shading.
    font: marks.code ? "Consolas" : undefined,
    shading: marks.code ? { type: ShadingType.CLEAR, color: "auto", fill: "F1F3F5" } : undefined,
  });
}

/**
 * Emit `text` as one or more TextRuns, splitting at comment marker offsets.
 * Advances the cursor by `text.length`. Hyperlinked segments each get their
 * own ExternalHyperlink wrapper (matches the pre-#1068 one-wrapper-per-run
 * behavior; a split link still navigates from every segment).
 */
function emitTextSegments(
  text: string,
  marks: MarkState,
  emit: EmitCtx,
  out: ParagraphChild[],
): void {
  let s = text;
  while (s.length > 0) {
    flushCommentEvents(emit, out);
    const nextOffset = emit.idx < emit.events.length ? emit.events[emit.idx].offset : Infinity;
    // flush guarantees nextOffset > pos, so take >= 1 and the loop terminates.
    const take = Math.min(s.length, nextOffset - emit.pos);
    const run = makeTextRun(s.slice(0, take), marks);
    if (marks.link) {
      const safeUrl = safeHyperlinkUrl(marks.link.href);
      if (safeUrl) {
        out.push(new ExternalHyperlink({ children: [run], link: safeUrl }));
      } else {
        // Drop unsafe hyperlink, keep the text.
        out.push(run);
      }
    } else {
      out.push(run);
    }
    emit.pos += take;
    s = s.slice(take);
  }
}

/**
 * Emit InlineRuns, honoring marks, hyperlinks, hardBreaks, and comment
 * markers. A hardBreak (`\n`) becomes a dedicated `<w:br/>` run AFTER the
 * preceding text — `TextRun({ text, break: 1 })` renders the break BEFORE its
 * text, which inverted hardBreak order in the v1.0 exporter (fixed here).
 */
function emitInlineRuns(runs: InlineRun[], emit: EmitCtx, out: ParagraphChild[]): void {
  for (const r of runs) {
    const parts = r.text.split("\n");
    parts.forEach((part, idx) => {
      if (idx > 0) {
        // The `\n` occupies one flat character; markers at its offset go
        // before the <w:br/> run.
        flushCommentEvents(emit, out);
        out.push(new TextRun({ break: 1 }));
        emit.pos += 1;
      }
      emitTextSegments(part, r.marks, emit, out);
    });
  }
  flushCommentEvents(emit, out);
}

/**
 * Build the ParagraphChild list for a leaf inline container (paragraph,
 * heading, …). Direct Y.XmlText children are emitted; nested Y.XmlElement
 * children are NOT exported at inline level (pre-existing behavior) but the
 * cursor still advances past their flat text (+ the 1-char separator
 * `getElementText` would insert) so later comment anchors stay aligned.
 */
function inlineChildren(el: Y.XmlElement, emit: EmitCtx): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  let hasPrior = false;
  for (let i = 0; i < el.length; i++) {
    const c = el.get(i);
    if (c instanceof Y.XmlText) {
      emitInlineRuns(flattenXmlText(c), emit, out);
      hasPrior = true;
    } else if (c instanceof Y.XmlElement) {
      if (hasPrior) emit.pos += 1;
      emit.pos += getElementTextLength(c);
      hasPrior = true;
    }
  }
  flushCommentEvents(emit, out);
  return out;
}

const HEADING_BY_LEVEL: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

/**
 * Node names this exporter knows how to serialize faithfully. Used by the
 * fidelity pre-flight (`detectExportFidelityIssues`) so the caller can warn
 * the user before overwriting their `.docx` with content we'd downgrade.
 * `image` is "known" structurally but degrades to alt text unless the src is
 * an inline `data:` URI — the fidelity check flags that separately.
 */
const KNOWN_BLOCK_NODES = new Set([
  "heading",
  "paragraph",
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "codeBlock",
  "horizontalRule",
  "image",
  "table",
  "tableRow",
  "tableCell",
  "tableHeader",
]);

const BULLET_REF = "tandem-bullet";
const NUMBERED_REF = "tandem-numbered";

interface BlockCtx {
  numberingDepth: number;
  blockquoteDepth: number;
}

function emptyCtx(): BlockCtx {
  return { numberingDepth: 0, blockquoteDepth: 0 };
}

function blockToDocx(el: Y.XmlElement, ctx: BlockCtx, emit: EmitCtx): Array<Paragraph | Table> {
  const name = el.nodeName;
  switch (name) {
    case "heading": {
      const level = Number(el.getAttribute("level") ?? 1);
      const heading = HEADING_BY_LEVEL[level] ?? HeadingLevel.HEADING_1;
      // Flat offsets include the markdown-style heading prefix ("## ").
      // Markers can't render inside the virtual prefix; any event there
      // flushes at the heading text start (the import walker also counts the
      // prefix before the first run, so a clamp is the closest valid anchor).
      emit.pos += headingPrefixLength(level >= 1 && level <= 6 ? level : 1);
      return [new Paragraph({ heading, children: inlineChildren(el, emit) })];
    }
    case "paragraph": {
      return [
        new Paragraph({
          children: inlineChildren(el, emit),
          indent: ctx.blockquoteDepth > 0 ? { left: 720 * ctx.blockquoteDepth } : undefined,
        }),
      ];
    }
    case "blockquote": {
      const out: Array<Paragraph | Table> = [];
      const childCtx = { ...ctx, blockquoteDepth: ctx.blockquoteDepth + 1 };
      let hasPrior = false;
      for (let i = 0; i < el.length; i++) {
        const c = el.get(i);
        if (c instanceof Y.XmlText) {
          // Direct text inside a blockquote isn't exported (pre-existing);
          // advance the cursor past it.
          emit.pos += c.length;
          hasPrior = true;
        } else if (c instanceof Y.XmlElement) {
          if (hasPrior) emit.pos += 1;
          out.push(...blockToDocx(c, childCtx, emit));
          hasPrior = true;
        }
      }
      return out;
    }
    case "bulletList":
    case "orderedList": {
      const kind: "bullet" | "number" = name === "orderedList" ? "number" : "bullet";
      const out: Array<Paragraph | Table> = [];
      let hasPriorItem = false;
      for (let i = 0; i < el.length; i++) {
        const item = el.get(i);
        if (item instanceof Y.XmlText) {
          emit.pos += item.length;
          hasPriorItem = true;
          continue;
        }
        if (!(item instanceof Y.XmlElement)) continue;
        if (hasPriorItem) emit.pos += 1;
        hasPriorItem = true;
        if (item.nodeName !== "listItem") {
          // Skipped in output (pre-existing); cursor still advances.
          emit.pos += getElementTextLength(item);
          continue;
        }
        let hasPriorChild = false;
        for (let j = 0; j < item.length; j++) {
          const child = item.get(j);
          if (child instanceof Y.XmlText) {
            emit.pos += child.length;
            hasPriorChild = true;
            continue;
          }
          if (!(child instanceof Y.XmlElement)) continue;
          if (hasPriorChild) emit.pos += 1;
          hasPriorChild = true;
          if (child.nodeName === "paragraph") {
            out.push(
              new Paragraph({
                children: inlineChildren(child, emit),
                numbering: {
                  reference: kind === "number" ? NUMBERED_REF : BULLET_REF,
                  level: ctx.numberingDepth,
                },
              }),
            );
          } else if (child.nodeName === "bulletList" || child.nodeName === "orderedList") {
            out.push(
              ...blockToDocx(child, { ...ctx, numberingDepth: ctx.numberingDepth + 1 }, emit),
            );
          } else {
            out.push(...blockToDocx(child, ctx, emit));
          }
        }
      }
      return out;
    }
    case "codeBlock": {
      const inner = readXmlTextChild(el);
      const lines = inner.split("\n");
      const codeMarks: MarkState = { code: true };
      return lines.map((line, idx) => {
        if (idx > 0) emit.pos += 1; // the `\n` between lines
        const children: ParagraphChild[] = [];
        emitTextSegments(line, codeMarks, emit, children);
        flushCommentEvents(emit, children);
        return new Paragraph({ children });
      });
    }
    case "horizontalRule": {
      const children: ParagraphChild[] = [];
      flushCommentEvents(emit, children);
      return [
        new Paragraph({
          border: { bottom: { color: "auto", space: 1, style: "single", size: 6 } },
          children,
        }),
      ];
    }
    case "image": {
      // Images contribute 0 flat characters (no XmlText); flush any markers
      // due at this position into the emitted paragraph.
      const markers: ParagraphChild[] = [];
      flushCommentEvents(emit, markers);
      const src = el.getAttribute("src");
      const embed = safeImageEmbed(src);
      if (!embed) {
        // Trust boundary: drop image rather than emit r:link.
        const alt = el.getAttribute("alt") ?? "";
        return [
          new Paragraph({
            children: [
              ...markers,
              new TextRun({ text: alt ? `[image: ${alt}]` : "[image]", italics: true }),
            ],
          }),
        ];
      }
      return [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            ...markers,
            new ImageRun({
              data: embed.data,
              transformation: { width: 480, height: 360 },
              type: embed.type,
            }),
          ],
        }),
      ];
    }
    case "table":
      return [tableToDocx(el, emit)];
    default: {
      // Unknown node name — emit text-only, never a passthrough (trust rule #4).
      return [new Paragraph({ children: inlineChildren(el, emit) })];
    }
  }
}

function tableToDocx(tableEl: Y.XmlElement, emit: EmitCtx): Table {
  const rows: TableRow[] = [];
  let hasPriorRow = false;
  for (let i = 0; i < tableEl.length; i++) {
    const row = tableEl.get(i);
    if (row instanceof Y.XmlText) {
      emit.pos += row.length;
      hasPriorRow = true;
      continue;
    }
    if (!(row instanceof Y.XmlElement)) continue;
    if (hasPriorRow) emit.pos += 1;
    hasPriorRow = true;
    if (row.nodeName !== "tableRow") {
      emit.pos += getElementTextLength(row);
      continue;
    }
    const cells: TableCell[] = [];
    let hasPriorCell = false;
    for (let j = 0; j < row.length; j++) {
      const cell = row.get(j);
      if (cell instanceof Y.XmlText) {
        emit.pos += cell.length;
        hasPriorCell = true;
        continue;
      }
      if (!(cell instanceof Y.XmlElement)) continue;
      if (hasPriorCell) emit.pos += 1;
      hasPriorCell = true;
      const cellChildren: Paragraph[] = [];
      let hasPriorBlock = false;
      for (let k = 0; k < cell.length; k++) {
        const c = cell.get(k);
        if (c instanceof Y.XmlText) {
          emit.pos += c.length;
          hasPriorBlock = true;
          continue;
        }
        if (!(c instanceof Y.XmlElement)) continue;
        if (hasPriorBlock) emit.pos += 1;
        hasPriorBlock = true;
        if (c.nodeName === "paragraph") {
          cellChildren.push(new Paragraph({ children: inlineChildren(c, emit) }));
        } else {
          // Skipped in output (pre-existing); cursor still advances.
          emit.pos += getElementTextLength(c);
        }
      }
      if (cellChildren.length === 0) cellChildren.push(new Paragraph({ children: [] }));
      cells.push(new TableCell({ children: cellChildren }));
    }
    rows.push(new TableRow({ children: cells }));
  }
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
}

function readXmlTextChild(el: Y.XmlElement): string {
  let out = "";
  for (let i = 0; i < el.length; i++) {
    const c = el.get(i);
    if (c instanceof Y.XmlText) out += c.toString();
  }
  return out;
}

// -- Fidelity pre-flight ------------------------------------------------------

/**
 * Inspect the top-level document body and report fidelity concerns the caller
 * should surface to the user BEFORE overwriting their `.docx`. The export is
 * body + comments: anything mammoth dropped on import (footnotes,
 * headers/footers, tracked changes) is already gone from the Y.Doc and will
 * not be re-exported, and a couple of supported nodes are approximated. We
 * flag:
 *
 *   - unknown node names (downgraded to plain text)
 *   - non-`data:` images (downgraded to alt text — trust rule #1)
 *
 * Returns a deduped, human-readable list of warnings (empty = clean export).
 */
export function detectExportFidelityIssues(doc: Y.Doc): string[] {
  const warnings = new Set<string>();
  const fragment = doc.getXmlFragment("default");
  const walk = (el: Y.XmlElement): void => {
    if (!KNOWN_BLOCK_NODES.has(el.nodeName)) {
      warnings.add(`unsupported "${el.nodeName}" block (exported as plain text)`);
    }
    if (el.nodeName === "image") {
      const src = el.getAttribute("src");
      if (!safeImageEmbed(src)) {
        warnings.add("an image without embedded data (exported as a text placeholder)");
      }
    }
    for (let i = 0; i < el.length; i++) {
      const c = el.get(i);
      if (c instanceof Y.XmlElement) walk(c);
    }
  };
  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (node instanceof Y.XmlElement) walk(node);
  }
  return [...warnings];
}

// -- Public API ---------------------------------------------------------------

function toCommentOptions(c: ExportComment): ICommentOptions {
  return {
    id: c.id,
    author: c.author,
    initials: c.initials,
    date: c.date,
    children: c.bodyParagraphs.map(
      (text) => new Paragraph({ children: text.length > 0 ? [new TextRun(text)] : [] }),
    ),
  };
}

/**
 * Convert a Tandem Y.Doc into a `.docx` byte buffer (body + Word comments).
 *
 * `comment`-type annotations stored in the doc's annotation map are emitted
 * as Word comments anchored to their CURRENT ranges (relRange-first
 * resolution; see `docx-comment-export.ts` for the ADR-027 privacy gate —
 * notes and highlights are never exported). External hyperlinks, file paths,
 * and remote images are filtered by the trust-boundary helpers so the output
 * cannot exfiltrate references. Tracked changes and authorship coloring are
 * intentionally NOT emitted — see the module header.
 *
 * READ-ONLY on the Y.Doc: no Y.Map writes, no transactions.
 */
export async function exportYDocToDocx(doc: Y.Doc): Promise<Buffer> {
  const comments = prepareExportComments(doc);
  const emit: EmitCtx = { pos: 0, events: buildCommentEvents(comments), idx: 0 };

  const fragment = doc.getXmlFragment("default");
  const children: Array<Paragraph | Table> = [];
  const ctx = emptyCtx();
  let first = true;
  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (!(node instanceof Y.XmlElement)) continue;
    if (!first) emit.pos += 1; // top-level \n separator (extractText join)
    first = false;
    children.push(...blockToDocx(node, ctx, emit));
  }

  // Defensive drain: prepareExportComments bounds-checks every range against
  // the document length, so leftovers indicate cursor drift. Emit them in a
  // trailing paragraph anyway — a comment listed in comments.xml without its
  // body markers would be structurally broken — and warn loudly.
  if (emit.idx < emit.events.length) {
    const leftovers: ParagraphChild[] = [];
    while (emit.idx < emit.events.length) {
      leftovers.push(...emit.events[emit.idx].components);
      emit.idx++;
    }
    console.error(
      `[docx-export] ${leftovers.length} comment marker component(s) fell past the end of ` +
        "the document; appended to a trailing paragraph. Comment anchors may be misplaced.",
    );
    children.push(new Paragraph({ children: leftovers }));
  }

  // Cheap invariant check (only when anchoring mattered): the emission cursor
  // must land exactly on the flat-text length, or anchors drifted.
  if (comments.length > 0) {
    const expected = extractText(doc).length;
    if (emit.pos !== expected) {
      console.error(
        `[docx-export] comment-anchor cursor drift: walked ${emit.pos} chars but the ` +
          `document flat text is ${expected} — exported comment anchors may be misplaced`,
      );
    }
  }

  // `docx` requires at least one section child; emit an empty paragraph for a
  // blank document so Packer doesn't produce a malformed file.
  if (children.length === 0) children.push(new Paragraph({ children: [] }));

  const document = new Document({
    creator: "Tandem",
    ...(comments.length > 0 ? { comments: { children: comments.map(toCommentOptions) } } : {}),
    numbering: {
      config: [
        {
          reference: BULLET_REF,
          levels: [0, 1, 2, 3, 4, 5].map((lvl) => ({
            level: lvl,
            format: "bullet",
            text: "•",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720 * (lvl + 1), hanging: 360 } } },
          })),
        },
        {
          reference: NUMBERED_REF,
          levels: [0, 1, 2, 3, 4, 5].map((lvl) => ({
            level: lvl,
            format: "decimal",
            text: `%${lvl + 1}.`,
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720 * (lvl + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ properties: {}, children }],
  });

  return Packer.toBuffer(document);
}
