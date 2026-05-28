// .docx review-only mode: mammoth.js → HTML → Y.Doc
// Editing disabled; annotations persist via session system

import mammoth from "mammoth";
import * as Y from "yjs";
import type { Annotation } from "../../shared/types.js";
import { getElementText } from "../mcp/document-model.js";

// Re-export for backward compatibility — consumers can import from either module
export { htmlToYDoc } from "./docx-html.js";

/**
 * Convert a .docx buffer to HTML via mammoth.js.
 * Warnings logged to stderr (stdout reserved for MCP).
 */
export async function loadDocx(content: Buffer): Promise<string> {
  const result = await mammoth.convertToHtml({ buffer: content });

  for (const msg of result.messages) {
    console.error(`[mammoth] ${msg.type}: ${msg.message}`);
  }

  return result.value;
}

// -- Annotation export --

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
    return "# Document Review\n\nNo annotations found.";
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

      lines.push(`- **"${truncated}"** (${ann.author})`);

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
