import { HIGHLIGHT_COLOR_VARS, normalizeHighlightColor } from "../../shared/constants";
import type { Annotation } from "../../shared/types";

export function getAuthorLabel(author: Annotation["author"]): string {
  if (author === "claude") return "Claude";
  if (author === "import") return "Imported";
  return "You";
}

export function getDisplayType(ann: Annotation): string {
  if (ann.suggestedText !== undefined) return "replacement";
  return ann.type;
}

export function truncate(text: string | undefined, max: number): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max - 3) + "..." : text;
}

export function getCardLabel(ann: Annotation): string {
  const displayType = getDisplayType(ann);
  const trunc = truncate(ann.content, 60);
  const isPrivate = ann.type === "note";
  return `${isPrivate ? "private " : ""}${displayType} annotation${trunc ? ": " + trunc : ""}, ${ann.status}`;
}

export function getHighlightBorder(ann: Annotation): string {
  if (ann.type === "highlight" && ann.color) {
    return HIGHLIGHT_COLOR_VARS[normalizeHighlightColor(ann.color)];
  }
  return "var(--tandem-author-user)";
}
