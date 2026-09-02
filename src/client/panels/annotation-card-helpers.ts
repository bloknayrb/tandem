import { HIGHLIGHT_COLOR_VARS, normalizeHighlightColor } from "../../shared/constants";
import type { AgentIdentity, Annotation } from "../../shared/types";

/**
 * Whether a record should PRESENT as an import — either because it carries a
 * `.docx` reviewer's name that survived whatever happened to `author`, or
 * because it is simply still stored as one.
 *
 * `promotedAnnotation` rewrites `author: "import" -> "user"` so the user can
 * edit, reply to and remove a colleague's comment they took ownership of, and
 * `...rest` carries `importSource` through verbatim. Every display surface that
 * branched on `author === "import"` therefore stopped recognising it: the card
 * left `ImportedCard`, the header painted the "You" dot and `getAuthorLabel`
 * said "You" — over a third party's unedited words (#1714).
 *
 * Trimmed and non-empty, because an `importSource` with a blank author names
 * nobody and there is no byline to show.
 */
export function presentsAsImport(ann: Annotation): boolean {
  // A plain disjunction: either fact alone is sufficient and the order carries
  // no precedence. The second term is what keeps a genuine import whose Word
  // comment carried no author name presenting as an import — it just has no
  // byline to draw.
  return (ann.importSource?.author ?? "").trim() !== "" || ann.author === "import";
}

/**
 * The author role a card should PRESENT as, which is not always `ann.author`.
 *
 * The split is the fix for #1714 and it is the whole design: `author` is the
 * STORAGE role and governs what the user may DO. This is the DISPLAY role and
 * governs what the user is TOLD. Presenting a colleague's words as your own is
 * the bug; being able to act on words you promoted is the feature.
 *
 * The predicates promotion actually moves are `canEdit`/`canRemove` (which it
 * turns ON, the point of the rewrite) and `canAccept`/`canDismiss` (which it
 * turns OFF, since those are `author !== "user"`) — all four in
 * `annotation-context-menu.ts`, all four deliberately left on the raw field.
 * `canReply` is not author-keyed at all and never participated.
 *
 * ATTRIBUTION is what reads this: the header's dot, label and reviewer byline,
 * the card ground tint, the peek dot, the margin leader, and the author filter
 * chips. What a record IS does not — the card VARIANT stays on the raw author,
 * because a promoted import is an ordinary editable comment and `ImportedCard`
 * can render neither markdown nor a suggestion diff. One further non-reader is
 * deliberate and worth naming: `buildDecorations` in
 * `editor/extensions/annotation.ts` still emits `data-annotation-author` from
 * the stored field. Nothing reads that attribute today and `user`/`import`
 * share one underline branch, so it is inert rather than wrong — but it is not
 * covered by "every attribution surface".
 */
export function getDisplayAuthor(ann: Annotation): Annotation["author"] {
  return presentsAsImport(ann) ? "import" : ann.author;
}

/**
 * Author label for an annotation. The agent ("claude") branch prefers the
 * specific authoring model's `agentIdentity.displayName` (#1123 M3 — the
 * local-model collaborator stamps it per record), then the user's active model
 * family label (#438, e.g. "Claude"/"GPT"), then a neutral "Assistant". While
 * BYO models are dark, `agentIdentity` is always absent so this is byte-
 * identical to the pre-M3 label. `import` and `user` are author roles, not the
 * agent, and are unaffected.
 *
 * Callers pass `getDisplayAuthor(ann)`, not `ann.author` — see #1714. The
 * parameter stays the bare role rather than the annotation so this remains a
 * total function over three cases with nothing to misread.
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
 *
 * Callers pass `getDisplayAuthor(ann)` (#1714): a promoted import keeps the
 * muted import ground, because the card above it still says whose words those
 * are.
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
