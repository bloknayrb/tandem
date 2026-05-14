// Spike (#576): prototype Y.Doc -> .docx converter using the `docx` npm package.
//
// NOT WIRED INTO MCP TOOLS. NOT WIRED INTO PRODUCTION SAVE PATH.
//
// This module is a prototype to evaluate whether `docx` is a viable
// write-back engine for Tandem's docx output. See
// docs/spikes/docx-npm-spike.md for the trust-boundary checklist and verdict.
//
// Trust-boundary rules applied here (must be preserved by any future
// production wiring):
//
//   1. NO r:link external image references -- we only emit images by
//      embedding raw bytes via `ImageRun({ data: Buffer })`. We never pass a
//      URL or remote-image reference to `docx`.
//   2. NO `<w:object>` embedded objects -- `docx` does not have a public API
//      for OLE objects, and we never call any internal embed.
//   3. NO `targetMode="External"` relationships pointing to `file://` or UNC
//      paths -- hyperlinks are scrubbed (`http`/`https`/`mailto` only).
//
// All Tiptap node-name strings in this file mirror those produced by
// `mdast-ydoc.ts` and consumed by the editor; they are NOT Y.Map keys, so
// they do not require the Y_MAP_* constants (Critical Rule #1).

import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import * as Y from "yjs";

// -- Trust-boundary helpers ---------------------------------------------------

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Returns the URL if it is safe to embed as an ExternalHyperlink target,
 * otherwise null. Blocks `file://`, UNC paths, and any non-http(s)/mailto
 * scheme so that no exported docx can carry a `targetMode="External"`
 * relationship pointing at a local filesystem resource.
 */
function safeHyperlinkUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // UNC: `\\\\server\\share\\path`
  if (trimmed.startsWith("\\\\")) return null;
  // Windows drive paths: `C:\\...`
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
 * Image embed gate. Only inline data: URIs are accepted; everything else
 * (http, https, file, UNC, relative paths) is dropped so we never produce
 * an `r:link` external image reference.
 */
function safeImageEmbed(
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

// -- Tiptap -> docx runtime conversion ----------------------------------------

interface MarkState {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
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
      };
      const link = attrs.link as { href?: string; title?: string } | undefined;
      if (link?.href) {
        marks.link = { href: link.href, ...(link.title ? { title: link.title } : {}) };
      }
      runs.push({ text: op.insert, marks });
    } else if (op.insert && typeof op.insert === "object") {
      // hardBreak embed -- represented as a `\n` so a subsequent TextRun can
      // pick it up via `break: 1`.
      runs.push({ text: "\n", marks: {} });
    }
  }
  return runs;
}

/** Build docx TextRun(s) for InlineRuns, honoring marks + hyperlinks. */
function runsToDocxChildren(runs: InlineRun[]): Array<TextRun | ExternalHyperlink> {
  const out: Array<TextRun | ExternalHyperlink> = [];
  for (const r of runs) {
    // Split on embedded `\n` so we can emit `break: 1` runs without losing marks.
    const parts = r.text.split("\n");
    parts.forEach((part, idx) => {
      const isBreakAfter = idx < parts.length - 1;
      if (part.length === 0 && !isBreakAfter) return;
      const textRun = new TextRun({
        text: part,
        bold: r.marks.bold,
        italics: r.marks.italic,
        strike: r.marks.strike,
        // `docx` lacks a first-class inline-code style; approximate with a
        // monospace font + light shading.
        font: r.marks.code ? "Consolas" : undefined,
        shading: r.marks.code
          ? { type: ShadingType.CLEAR, color: "auto", fill: "F1F3F5" }
          : undefined,
        break: isBreakAfter ? 1 : undefined,
      });
      if (r.marks.link) {
        const safeUrl = safeHyperlinkUrl(r.marks.link.href);
        if (safeUrl) {
          out.push(new ExternalHyperlink({ children: [textRun], link: safeUrl }));
        } else {
          // Drop unsafe hyperlink, keep the text.
          out.push(textRun);
        }
      } else {
        out.push(textRun);
      }
    });
  }
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

interface BlockCtx {
  numberingDepth: number;
  blockquoteDepth: number;
}

function emptyCtx(): BlockCtx {
  return { numberingDepth: 0, blockquoteDepth: 0 };
}

function blockToDocx(el: Y.XmlElement, ctx: BlockCtx): Array<Paragraph | Table> {
  const name = el.nodeName;
  switch (name) {
    case "heading": {
      const level = Number(el.getAttribute("level") ?? 1);
      const heading = HEADING_BY_LEVEL[level] ?? HeadingLevel.HEADING_1;
      const runs = collectInlineRuns(el);
      return [new Paragraph({ heading, children: runsToDocxChildren(runs) })];
    }
    case "paragraph": {
      const runs = collectInlineRuns(el);
      return [
        new Paragraph({
          children: runsToDocxChildren(runs),
          indent: ctx.blockquoteDepth > 0 ? { left: 720 * ctx.blockquoteDepth } : undefined,
        }),
      ];
    }
    case "blockquote": {
      const out: Array<Paragraph | Table> = [];
      const child = { ...ctx, blockquoteDepth: ctx.blockquoteDepth + 1 };
      for (let i = 0; i < el.length; i++) {
        const c = el.get(i);
        if (c instanceof Y.XmlElement) out.push(...blockToDocx(c, child));
      }
      return out;
    }
    case "bulletList":
    case "orderedList": {
      const kind: "bullet" | "number" = name === "orderedList" ? "number" : "bullet";
      const out: Array<Paragraph | Table> = [];
      for (let i = 0; i < el.length; i++) {
        const item = el.get(i);
        if (!(item instanceof Y.XmlElement) || item.nodeName !== "listItem") continue;
        for (let j = 0; j < item.length; j++) {
          const child = item.get(j);
          if (!(child instanceof Y.XmlElement)) continue;
          if (child.nodeName === "paragraph") {
            const runs = collectInlineRuns(child);
            out.push(
              new Paragraph({
                children: runsToDocxChildren(runs),
                numbering: {
                  reference: kind === "number" ? "spike-numbered" : "spike-bullet",
                  level: ctx.numberingDepth,
                },
              }),
            );
          } else if (child.nodeName === "bulletList" || child.nodeName === "orderedList") {
            out.push(
              ...blockToDocx(child, {
                ...ctx,
                numberingDepth: ctx.numberingDepth + 1,
              }),
            );
          } else {
            out.push(...blockToDocx(child, ctx));
          }
        }
      }
      return out;
    }
    case "codeBlock": {
      const inner = readXmlTextChild(el);
      const lines = inner.split("\n");
      return lines.map(
        (line) =>
          new Paragraph({
            children: [
              new TextRun({
                text: line,
                font: "Consolas",
                shading: { type: ShadingType.CLEAR, color: "auto", fill: "F1F3F5" },
              }),
            ],
          }),
      );
    }
    case "horizontalRule": {
      return [
        new Paragraph({
          border: { bottom: { color: "auto", space: 1, style: "single", size: 6 } },
        }),
      ];
    }
    case "image": {
      const src = el.getAttribute("src");
      const embed = safeImageEmbed(src);
      if (!embed) {
        // Trust boundary: drop image rather than emit r:link.
        const alt = el.getAttribute("alt") ?? "";
        return [
          new Paragraph({
            children: [new TextRun({ text: alt ? `[image: ${alt}]` : "[image]", italics: true })],
          }),
        ];
      }
      return [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
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
      return [tableToDocx(el)];
    default: {
      const runs = collectInlineRuns(el);
      return [new Paragraph({ children: runsToDocxChildren(runs) })];
    }
  }
}

function tableToDocx(tableEl: Y.XmlElement): Table {
  const rows: TableRow[] = [];
  for (let i = 0; i < tableEl.length; i++) {
    const row = tableEl.get(i);
    if (!(row instanceof Y.XmlElement) || row.nodeName !== "tableRow") continue;
    const cells: TableCell[] = [];
    for (let j = 0; j < row.length; j++) {
      const cell = row.get(j);
      if (!(cell instanceof Y.XmlElement)) continue;
      const cellChildren: Paragraph[] = [];
      for (let k = 0; k < cell.length; k++) {
        const c = cell.get(k);
        if (c instanceof Y.XmlElement && c.nodeName === "paragraph") {
          const runs = collectInlineRuns(c);
          cellChildren.push(new Paragraph({ children: runsToDocxChildren(runs) }));
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

function collectInlineRuns(el: Y.XmlElement): InlineRun[] {
  const runs: InlineRun[] = [];
  for (let i = 0; i < el.length; i++) {
    const c = el.get(i);
    if (c instanceof Y.XmlText) runs.push(...flattenXmlText(c));
  }
  return runs;
}

// -- Public API ---------------------------------------------------------------

export interface SpikeExportOptions {
  /** Reserved for future use; spike ignores annotations entirely. */
  ignored?: never;
}

/**
 * Convert a Tandem Y.Doc into a .docx byte buffer.
 *
 * Spike scope: body content only (no tracked changes, no comments, no
 * authorship coloring). External hyperlinks, file paths, and remote images
 * are filtered by the trust-boundary helpers so the output cannot exfiltrate
 * references.
 */
export async function exportYDocToDocx(
  doc: Y.Doc,
  _opts: SpikeExportOptions = {},
): Promise<Buffer> {
  const fragment = doc.getXmlFragment("default");
  const children: Array<Paragraph | Table> = [];
  const ctx = emptyCtx();
  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (node instanceof Y.XmlElement) children.push(...blockToDocx(node, ctx));
  }

  const document = new Document({
    creator: "Tandem (spike-docx-export)",
    description: "Spike output -- not for production use.",
    numbering: {
      config: [
        {
          reference: "spike-bullet",
          levels: [0, 1, 2, 3, 4, 5].map((lvl) => ({
            level: lvl,
            format: "bullet",
            text: "*",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720 * (lvl + 1), hanging: 360 } } },
          })),
        },
        {
          reference: "spike-numbered",
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

// Re-export trust-boundary helpers for testing only.
export const __spikeInternals = { safeHyperlinkUrl, safeImageEmbed };
