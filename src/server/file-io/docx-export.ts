// Y.Doc -> .docx body export (#576, v1.0 body-export scope).
//
// Production write-back engine using the `docx` npm package. Walks
// `Y.Doc.getXmlFragment("default")` and maps Tiptap node names onto the
// `docx` package's Paragraph / Table constructors, flattening Y.XmlText
// deltas into TextRuns with marks.
//
// SCOPE (v1.0): body content only. NOT exported here:
//   - Word comments (annotations) — comment round-trip is v1.1 (see #576).
//   - Tracked changes — requires a Y.Doc authorship-diff layer (deferred).
//   - Inline images — degraded to alt text (mdast-ydoc imports images as
//     inline phrasing content, not top-level <image> nodes; see the docx-npm
//     spike). Top-level <image> nodes ARE exported when present.
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
      // hardBreak embed -- represented as `\n` so a subsequent TextRun can
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
        underline: r.marks.underline ? {} : undefined,
        superScript: r.marks.superscript,
        subScript: r.marks.subscript,
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
                  reference: kind === "number" ? NUMBERED_REF : BULLET_REF,
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
      // Unknown node name — emit text-only, never a passthrough (trust rule #4).
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

// -- Fidelity pre-flight ------------------------------------------------------

/**
 * Inspect the top-level document body and report fidelity concerns the caller
 * should surface to the user BEFORE overwriting their `.docx`. The v1 export is
 * body-only: anything mammoth dropped on import (footnotes, headers/footers,
 * tracked changes) is already gone from the Y.Doc and will not be re-exported,
 * and a couple of supported nodes are approximated. We flag:
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

/**
 * Convert a Tandem Y.Doc into a `.docx` byte buffer (body content only).
 *
 * External hyperlinks, file paths, and remote images are filtered by the
 * trust-boundary helpers so the output cannot exfiltrate references. Comments,
 * tracked changes, and authorship coloring are intentionally NOT emitted —
 * see the module header for v1.0 scope.
 */
export async function exportYDocToDocx(doc: Y.Doc): Promise<Buffer> {
  const fragment = doc.getXmlFragment("default");
  const children: Array<Paragraph | Table> = [];
  const ctx = emptyCtx();
  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (node instanceof Y.XmlElement) children.push(...blockToDocx(node, ctx));
  }

  // `docx` requires at least one section child; emit an empty paragraph for a
  // blank document so Packer doesn't produce a malformed file.
  if (children.length === 0) children.push(new Paragraph({ children: [] }));

  const document = new Document({
    creator: "Tandem",
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
