// .docx import: mammoth.js → HTML → Y.Doc. Editing is held in the Y.Doc and
// written back on explicit save (#576); annotations persist via the session
// system.

import mammoth from "mammoth";
import * as Y from "yjs";
import type { Annotation } from "../../shared/types.js";
import { getElementText } from "../mcp/document-model.js";

// Re-export for backward compatibility — consumers can import from either module
export { htmlToYDoc, reconcileFootnoteIds } from "./docx-html.js";

/**
 * Convert a .docx buffer to HTML via mammoth.js.
 * Warnings logged to stderr (stdout reserved for MCP).
 */
export async function loadDocx(content: Buffer): Promise<string> {
  const { html } = await loadDocxWithWarnings(content);
  return html;
}

/**
 * Convert a .docx buffer to HTML via mammoth.js, returning both the HTML and a
 * deduped, human-readable summary of what mammoth could NOT faithfully import
 * (#576 fidelity warnings). mammoth is a lossy importer — it silently drops
 * footnotes, headers/footers, tracked changes, and unsupported styles. The
 * `.docx` write-back path can only re-export what mammoth preserved, so we
 * surface these so the user understands the round-trip ceiling BEFORE editing.
 *
 * Individual mammoth messages are still logged verbatim to stderr; the returned
 * `warnings` are a collapsed, user-facing subset (one line per distinct kind of
 * loss, capped so a pathological document can't flood the toast).
 */
export async function loadDocxWithWarnings(
  content: Buffer,
): Promise<{ html: string; warnings: string[]; moveWarnings: string[] }> {
  // styleMap is the SECOND arg of convertToHtml(input, options) — merging it into
  // the input object silently no-ops. mammoth IGNORES underline by default (its
  // docs: underline "can be easily confused with hyperlinks in HTML"), so without
  // this map a <w:u> run reaches htmlToYDoc as plain text and the underline mark
  // is lost on round-trip. "u => u" emits a literal <u> (which docx-html.ts maps
  // to the underline mark) — NOT "u => em", which would silently re-code underline
  // as italic. Additive: includeDefaultStyleMap stays true, so headings/bold/lists
  // still resolve via mammoth's defaults. (Underline style/color — double/dotted/
  // wavy/colored — is flattened to a boolean by mammoth upstream, so it round-trips
  // as a single black underline; an accepted import ceiling, undetectable to warn on.)
  const result = await mammoth.convertToHtml({ buffer: content }, { styleMap: ["u => u"] });

  for (const msg of result.messages) {
    console.error(`[mammoth] ${msg.type}: ${msg.message}`);
  }

  const { general, moves } = partitionMammothMessages(result.messages);
  return { html: result.value, warnings: general, moveWarnings: moves };
}

/** Max distinct fidelity warnings surfaced to the user (avoid toast flooding). */
const MAX_FIDELITY_WARNINGS = 8;

/**
 * Max characters per emitted warning line. The quote-stripping below redacts
 * the variable payload mammoth quotes (style names), but the report these feed
 * is now a PERSISTENT surface (#1145), not a 4s toast — so clamp each line as a
 * content-oracle backstop: a future mammoth message that surfaces user text
 * unquoted can leak at most this many chars, not an unbounded paragraph.
 */
const MAX_WARNING_LINE_LENGTH = 120;

/**
 * mammoth's unrecognised-element messages for the two halves of a Word "move"
 * revision (and their range markers). Partitioned out BEFORE the
 * MAX_FIDELITY_WARNINGS cap, not filtered after it: a document with moved
 * paragraphs produces up to six distinct normalized lines, which would eat six
 * of the eight slots and permanently discard the real style warnings the cap is
 * there to make room for. Filtering downstream cannot un-crowd a cap.
 *
 * mammoth's exact wording lives in this module, which owns every other regex
 * against it (see the redaction slots below) — a mammoth upgrade should break
 * one file, not a fidelity behaviour in the adapter.
 */
const MAMMOTH_MOVE_MESSAGE = /unrecognised element was ignored: \w*:?move/i;

/** What `summarizeMammothMessages` produces: the capped general set, plus the
 * move messages held apart so the caller can decide whether its own (more
 * specific) move line supersedes them. */
export interface MammothWarnings {
  general: string[];
  moves: string[];
}

/**
 * Collapse mammoth's per-occurrence messages into a small set of distinct,
 * user-readable phrases. mammoth emits one message PER dropped element (e.g. a
 * line per unrecognized style run), which would be unreadable surfaced raw.
 *
 * NOTE: this returns the GENERAL bucket only — move-revision messages are
 * partitioned out and are NOT in the result. If you want everything mammoth
 * said, call `partitionMammothMessages` and read both fields.
 */
export function summarizeMammothMessages(
  messages: Array<{ type: string; message: string }>,
): string[] {
  return partitionMammothMessages(messages).general;
}

/** As `summarizeMammothMessages`, but keeping the move messages separate so the
 * cap applies only to the general set. */
export function partitionMammothMessages(
  messages: Array<{ type: string; message: string }>,
): MammothWarnings {
  const seen = new Set<string>();
  const moves = new Set<string>();
  for (const msg of messages) {
    // Only warnings/errors matter for fidelity — mammoth has no "info" today,
    // but guard defensively so a future info-level message isn't surfaced.
    if (msg.type !== "warning" && msg.type !== "error") continue;
    // Normalize "Unrecognised paragraph style: 'Foo' (Style ID: Bar)" and
    // similar to a single bucket so 200 runs collapse to one line.
    // Redact every slot mammoth can put user-authored text in. Style/font
    // names can be sensitive (client names, project codenames, foundry-licensed
    // brand fonts), and these strings now feed a PERSISTENT banner (#1145), so
    // redaction must cover mammoth's actual message forms (enumerated from its
    // warning() emitters), not just the quoted one:
    //   - "Unrecognised paragraph style: 'Name' (Style ID: ID)" → quotes + (…)
    //   - "…style with ID ID was referenced but not defined…" → bare UNQUOTED
    //     `with ID <token>` slot.
    //   - "…w:sym… ignored: char F0A7 in font <Brand Font>" → the trailing
    //     `in font <name>` slot (a name CAN contain spaces, so anchor to EOL).
    // The MAX_WARNING_LINE_LENGTH clamp below is the forward backstop for any
    // slot a future mammoth version introduces.
    const normalized = msg.message
      .replace(/['"][^'"]*['"]/g, "…")
      .replace(/\(Style ID:[^)]*\)/gi, "")
      .replace(/\bwith ID \S+/gi, "with ID …")
      .replace(/\bin font \S.*$/i, "in font …")
      .replace(/\s+/g, " ")
      .trim();
    // Clamp per-line (defense-in-depth, see MAX_WARNING_LINE_LENGTH). Dedup on
    // the clamped form so two messages differing only past the cap collapse.
    const clamped =
      normalized.length > MAX_WARNING_LINE_LENGTH
        ? `${normalized.slice(0, MAX_WARNING_LINE_LENGTH - 1)}…`
        : normalized;
    if (MAMMOTH_MOVE_MESSAGE.test(clamped)) moves.add(clamped);
    else seen.add(clamped);
  }
  return { general: [...seen].slice(0, MAX_FIDELITY_WARNINGS), moves: [...moves] };
}

// -- Annotation export --

/**
 * Human-readable author label for the exported Markdown review summary (#438).
 *
 * The durable `author` enum (`"claude"`) is an internal role discriminator, not
 * a display label — emitting it verbatim leaks "(claude)" into a report a
 * GPT/Gemini user generated. The server has no access to the browser's Models
 * registry, so it can't name the specific model; it maps to a neutral
 * "Assistant" instead. Imported Word comments surface their real reviewer.
 */
function exportAuthorLabel(ann: Annotation): string {
  if (ann.author === "user") return "You";
  if (ann.author === "import") return ann.importSource?.author?.trim() || "Imported";
  return "Assistant";
}

/**
 * Generate a Markdown summary of all annotations, grouped by type.
 * Includes a text snippet from the document for context.
 */
export function exportAnnotations(doc: Y.Doc, annotations: Annotation[]): string {
  // Defense-in-depth (ADR-027): notes are user-private and must never appear in
  // an export, regardless of what the caller passes. The MCP tool already
  // filters them out, but this function is privacy-safe on its own.
  const visible = annotations.filter((a) => a.type !== "note");
  if (visible.length === 0) {
    // Deliberately NOT "No annotations found" — the caller may have filtered
    // Solo-held items out of `annotations` before calling, and asserting that
    // none EXIST would be a false statement rather than an incomplete one. The
    // caller discloses the withheld count separately (`heldFromExport`).
    return "# Document Review\n\nNo annotations available for export.";
  }

  const fragment = doc.getXmlFragment("default");
  const fullText = extractFullText(fragment);

  // Group by derived category using field presence, not raw type.
  // Notes are already filtered out above (ADR-027), so there is no notes group.
  type GroupKey = "highlights" | "comments" | "suggestions";
  const groups: Partial<Record<GroupKey, Annotation[]>> = {};
  for (const ann of visible) {
    let key: GroupKey;
    if (ann.type === "highlight") key = "highlights";
    else if (ann.suggestedText !== undefined) key = "suggestions";
    else key = "comments";
    if (!groups[key]) groups[key] = [];
    groups[key]?.push(ann);
  }

  const lines: string[] = ["# Document Review", ""];

  const groupLabels: Record<GroupKey, string> = {
    highlights: "Highlights",
    comments: "Comments",
    suggestions: "Suggestions",
  };

  const groupOrder: GroupKey[] = ["highlights", "comments", "suggestions"];

  for (const key of groupOrder) {
    const anns = groups[key];
    if (!anns) continue;
    lines.push(`## ${groupLabels[key]}`, "");

    for (const ann of anns) {
      const snippet = safeSlice(fullText, ann.range.from, ann.range.to);
      const truncated = snippet.length > 80 ? snippet.slice(0, 77) + "..." : snippet;

      lines.push(`- **"${truncated}"** (${exportAuthorLabel(ann)})`);

      if (ann.suggestedText !== undefined) {
        lines.push(`  - Replace with: "${ann.suggestedText}"`);
        if (ann.content) lines.push(`  - Reason: ${ann.content}`);
      } else if (ann.content) {
        lines.push(`  - ${ann.content}`);
      }

      if (ann.color) {
        lines.push(`  - Color: ${ann.color}`);
      }

      lines.push("");
    }
  }

  return lines.join("\n").trimEnd();
}

/** Extract full flat text from a Y.Doc fragment (simplified — no heading prefixes) */
function extractFullText(fragment: Y.XmlFragment): string {
  const parts: string[] = [];
  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (node instanceof Y.XmlElement) {
      parts.push(getElementText(node));
    }
  }
  return parts.join("\n");
}

/** Safe string slice that handles out-of-bounds gracefully */
function safeSlice(text: string, from: number, to: number): string {
  const start = Math.max(0, Math.min(from, text.length));
  const end = Math.max(start, Math.min(to, text.length));
  return text.slice(start, end);
}
