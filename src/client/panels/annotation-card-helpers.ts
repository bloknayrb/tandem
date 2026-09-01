import { HIGHLIGHT_COLOR_VARS, normalizeHighlightColor } from "../../shared/constants";
import type { AgentIdentity, Annotation } from "../../shared/types";

/**
 * Author label for an annotation. The agent ("claude") branch prefers the
 * specific authoring model's `agentIdentity.displayName` (#1123 M3 — the
 * local-model collaborator stamps it per record), then the user's active model
 * family label (#438, e.g. "Claude"/"GPT"), then a neutral "Assistant". While
 * BYO models are dark, `agentIdentity` is always absent so this is byte-
 * identical to the pre-M3 label. `import` and `user` are author roles, not the
 * agent, and are unaffected.
 */
export function getAuthorLabel(
  author: Annotation["author"],
  agentLabel?: string,
  agentIdentity?: AgentIdentity,
): string {
  if (author === "claude") return agentIdentity?.displayName ?? agentLabel ?? "Assistant";
  if (author === "import") return "Imported";
  return "You";
}

/**
 * Relative timestamp label for annotation chrome — "just now", "5m ago",
 * "3h ago", else the locale date. Shared by the card header and the reply
 * thread so both read identically.
 */
export function formatRelativeTime(timestamp: number): string {
  const diffMin = Math.floor((Date.now() - timestamp) / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * The four kinds a card can present as: the three stored `type` values plus
 * `replacement`, which is a comment carrying `suggestedText`.
 *
 * Narrowed from a bare `string` so `ANNOTATION_TYPE_GLYPHS` can be an
 * exhaustive `Record` over it. With `string` the icon lookup would need a
 * fallback branch, and a fallback is precisely how a missing glyph turns into
 * a silently-blank icon instead of a type error.
 */
export type AnnotationDisplayType = Annotation["type"] | "replacement";

export function getDisplayType(ann: Annotation): AnnotationDisplayType {
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

/**
 * Background tint for an annotation card, keyed on AUTHOR.
 *
 * Author is the tint axis and type is the icon axis — deliberately separate.
 * Tinting per card variant instead put a user comment and a user note on
 * different grounds while both carried the same authorship dot, so the rail
 * contradicted itself.
 *
 * Extracted rather than left inline in `AnnotationCard.svelte` so the `import`
 * branch is reachable from a unit test. The other two are pinned end-to-end by
 * `annotation-lifecycle.spec.ts`, but rendering an imported card needs a
 * `.docx` import, so that branch would otherwise be covered by nothing.
 *
 * The review-target override (`--tandem-accent-bg`) is NOT here: it is a state,
 * not a taxonomy row, and it belongs with the rest of the card's state styling.
 */
export function getCardTint(author: Annotation["author"]): string {
  if (author === "claude") return "var(--tandem-author-claude-bg)";
  if (author === "import") return "var(--tandem-author-import-bg)";
  return "var(--tandem-author-user-bg)";
}

/**
 * The colour to paint a highlight's filled type glyph.
 *
 * `normalizeHighlightColor` exists precisely to default a missing colour to
 * yellow, so this must NOT short-circuit on `!ann.color` before calling it.
 * The previous form did, and returned the user authorship token instead — so a
 * colourless highlight painted YELLOW in the document (`extensions/annotation.ts`
 * calls `normalizeHighlightColor` unguarded) while its card swatch painted
 * cobalt. That mattered little when this fed a faint 18%-mixed card wash; as an
 * opaque 13px swatch it is the loudest colour in the header, and an authorship
 * token appearing there is the exact collision the two-axis model forbids.
 *
 * The `type === "highlight"` half of the old guard was redundant too: the only
 * caller reaches this behind `glyph.filled`, which only `highlight` sets.
 */
export function getHighlightSwatchColor(ann: Annotation): string {
  return HIGHLIGHT_COLOR_VARS[normalizeHighlightColor(ann.color)];
}
