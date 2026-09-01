import type { AnnotationDisplayType } from "./annotation-card-helpers";

/**
 * Type glyphs for the annotation card header, keyed by `getDisplayType()`.
 *
 * Since the author-tint change, a card's BACKGROUND says who wrote it (user /
 * claude / import) and this icon says what KIND it is. Before that, one colour
 * tried to carry both and could carry neither cleanly — a Claude-authored
 * highlight and a user-authored one looked identical, while a note and a
 * comment by the same person did not.
 *
 * Path data lives here and the SVG is inlined by `AnnotationCardHeader`,
 * matching the codebase's existing convention (`components/activityCenter.ts`
 * states it outright: "the codebase inlines SVGs per-component rather than
 * shipping an icon component"; `editor/slash-menu/commands.ts` does the same).
 *
 * All paths are authored for a **16x16 viewBox**. The consumer MUST set
 * explicit `width`/`height` — a viewBox alone gives an `<svg>` no intrinsic
 * size, so it resolves to the 300x150 replaced-element default and blows out
 * the header. The slash menu gets away with omitting them only because
 * `index.html` carries a sizing rule for its icons; there is no such rule here.
 */
export interface AnnotationTypeGlyph {
  /** Accessible name — becomes the icon's `aria-label` and `title`. */
  label: string;
  /** `<path d>` values, drawn with `stroke="currentColor"`, `fill="none"`. */
  paths: string[];
  /**
   * When true the glyph is a filled swatch rather than a stroked outline, and
   * the consumer paints it with the annotation's own highlight colour. Only
   * `highlight` sets this: it is the one type whose colour is user-chosen and
   * therefore worth showing.
   */
  filled?: boolean;
}

export const ANNOTATION_TYPE_GLYPHS: Record<AnnotationDisplayType, AnnotationTypeGlyph> = {
  // Speech bubble — the outbound, Claude-visible annotation.
  comment: {
    label: "Comment",
    paths: ["M2.5 3.5h11v8h-6l-3 2.5v-2.5h-2z"],
  },
  // Lock over a page — privacy is the whole point of a note, so the glyph
  // leads with it rather than showing yet another sheet of paper.
  note: {
    label: "Private note",
    paths: ["M4 7V5.5a4 4 0 018 0V7", "M3 7h10v6.5H3z"],
  },
  // Rounded swatch. FILLED, not stroked, and it keeps a 1px outline: the four
  // highlight colours are pale washes, and a hairline stroke in
  // --tandem-highlight-yellow on an authorship tint is close to invisible. A
  // filled shape with a token border reads at any colour on either theme, and
  // WCAG 1.4.11's 3:1 then applies to the border, which is built to clear it.
  highlight: {
    label: "Highlight",
    paths: ["M2.5 4.5h11v7h-11z"],
    filled: true,
  },
  // Arrow into a bar — a substitution, not a remark. This is the only card
  // whose Accept button edits the document, so its glyph is deliberately the
  // least like the speech bubble.
  replacement: {
    label: "Suggested replacement",
    paths: ["M2 8h7", "M6.5 5l3 3-3 3", "M12.5 3.5v9"],
  },
};
