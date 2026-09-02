<script lang="ts">
import type { Snippet } from "svelte";
import type { Annotation } from "../../shared/types";
import { createAgentLabel } from "../hooks/useAgentLabel.svelte";
import { agentColor } from "../utils/agent-color";
import {
  formatRelativeTime,
  getAuthorLabel,
  getDisplayAuthor,
  getDisplayType,
  getHighlightSwatchColor,
} from "./annotation-card-helpers";
import { ANNOTATION_TYPE_GLYPHS } from "./annotation-type-icon";

interface Props {
  annotation: Annotation;
  isPending: boolean;
  isReviewTarget?: boolean;
  isEditing: boolean;
  canEdit: boolean;
  onEnterEdit: () => void;
  /** Optional extra pill rendered next to the type badge (e.g. Private pill on NoteCard). */
  extraPill?: Snippet;
}

let { annotation, isPending, isReviewTarget, isEditing, canEdit, onEnterEdit, extraPill }: Props =
  $props();

const agentLabel = createAgentLabel();
const displayType = $derived(getDisplayType(annotation));
// The DISPLAY author, not the stored one. A promoted import reads "user" here
// and would say "You" over a colleague's unedited words (#1714).
const authorLabel = $derived(
  getAuthorLabel(getDisplayAuthor(annotation), agentLabel.family, annotation.agentIdentity),
);
// 6px authorship dot before the author label. `user` carries the fixed user
// token; `claude` carries the per-agent color (#1123 M4) — `agentColor` falls
// back to the exact --tandem-author-claude token when no agentIdentity is
// present, so this is byte-identical while dark. Imports show the byline
// instead, so the dot is omitted for them in the markup below.
const dotColor = $derived(
  annotation.author === "claude"
    ? agentColor(annotation.agentIdentity)
    : "var(--tandem-author-user)",
);
// Both MUST be $derived. As plain consts they freeze at mount with no type
// error and no failing test: recolour a highlight and the swatch keeps the old
// colour; edit a suggestion to drop suggestedText and the icon stays
// "replacement" forever. `displayType` above is already reactive, which is
// exactly what makes a plain-const lookup off it stale.
const glyph = $derived(ANNOTATION_TYPE_GLYPHS[displayType]);
// Highlights carry the user's chosen colour on the icon itself — the one place
// that colour still appears now that the card body is tinted by author.
const glyphFill = $derived(glyph.filled ? getHighlightSwatchColor(annotation) : "none");
</script>

<div class="ach-row">
  <span class="ach-type">
    <!-- Type icon. Explicit width/height are REQUIRED — a viewBox alone leaves
         an <svg> with no intrinsic size, so it resolves to 300x150 and blows
         out the header (worst in the 160px narrow margin band). -->
    <span
      class="ach-badge annotation-type-badge"
      role="img"
      aria-label={glyph.label}
      title={glyph.label}
    >
      <svg
        viewBox="0 0 16 16"
        width="13"
        height="13"
        fill={glyphFill}
        stroke="currentColor"
        stroke-width="1.2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        {#each glyph.paths as d (d)}
          <path {d} />
        {/each}
      </svg>
      <!-- The type WORD, hidden in normal rendering and revealed under
           forced-colors. In High Contrast every authorship tint collapses to
           Canvas, so the card's background stops distinguishing anything — and
           with the word gone the type would have no carrier at all. (Author
           still reads: `.ach-author` renders "You"/"Assistant"/"Imported" as
           real text.)

           This is a VISUAL fallback only, not an accessibility one — the
           obvious reading of a clip-path-hidden span is wrong here. The
           wrapper is `role="img"` with an `aria-label`, which makes its whole
           subtree presentational: a screen reader announces the label and never
           reaches this span. That is the intended behaviour (the name is
           already there, and reading it twice would be worse), but it means
           deleting the span costs sighted High Contrast users everything and
           costs AT users nothing, so an a11y audit will not catch it. The
           forced-colors e2e assertion is the only thing that does.

           It also does not paint at every density: at stub density the whole
           `.ach-type` group is `display: none` from AnnotationCard, so under
           forcing the type has no carrier there either. That is a deliberate
           narrow-margin tradeoff, not a gap this span can close. -->
      <span class="ach-badge-word">{glyph.label}</span>
    </span>
    {#if extraPill}{@render extraPill()}{/if}
    {#if annotation.heldInSolo}
      <span
        class="ach-held-pill"
        data-testid="annotation-held-pill-{annotation.id}"
        title="Held while you're in Solo mode. Your AI will see this when you switch back to Tandem."
      >
        Held
      </span>
    {/if}
    {#if !isPending}
      <span
        class="ach-status"
        class:is-accepted={annotation.status === "accepted"}
        class:is-rejected={annotation.status !== "accepted"}
      >
        {annotation.status}
      </span>
    {/if}
    {#if isPending && canEdit && !isReviewTarget && !isEditing}
      <button
        class="ach-edit-btn"
        data-testid="edit-btn-{annotation.id}"
        onclick={(e) => {
          e.stopPropagation();
          onEnterEdit();
        }}
        title="Edit this annotation's content"
      >
        ✎ Edit
      </button>
    {/if}
  </span>
  <span class="ach-author">
    {#if annotation.editedAt}
      <span class="ach-edited">(edited)</span>
    {/if}
    <!-- The actual "You" dot gate, and the site the first draft of this fix
         missed: this header is shared by EVERY card variant, so re-keying only
         the card dispatch would have left the dot painted inside whichever
         variant the record landed in. -->
    {#if getDisplayAuthor(annotation) !== "import"}
      <span
        class="ach-dot"
        data-testid="annotation-author-dot-{annotation.id}"
        aria-hidden="true"
        style="background: {dotColor}; border-color: {dotColor};"
      ></span>
    {/if}
    {authorLabel}
    <span class="ach-time" title={new Date(annotation.timestamp).toLocaleString()}>
      {formatRelativeTime(annotation.timestamp)}
    </span>
  </span>
</div>

<!-- Reviewer attribution byline. Imports carry the original Word commenter's
     name; surfacing it lets the user decide which reviewer's comments to
     promote without opening the source file.

     It lives in the shared header rather than in `ImportedCard` because of
     #1714: a PROMOTED import still carries the reviewer's name but renders as
     `CommentCard` or `SuggestionCard`, and a byline only `ImportedCard` could
     draw would have been the one attribution surface the fix still missed.
     Gated on the name itself, not on `presentsAsImport` — a provenance record
     that names nobody has no byline to draw. -->
{#if annotation.importSource?.author}
  <div
    data-testid="annotation-import-byline-{annotation.id}"
    style="font-size: var(--tandem-text-2xs); color: var(--tandem-fg-subtle); margin-bottom: 4px;"
  >
    From: <span style="font-weight: 500;">{annotation.importSource.author}</span>
  </div>
{/if}

<style>
  /* Card header — type badge + (optional pill) + (optional status) +
     (optional edit) on the left, edited marker + author dot + author label
     on the right. Dynamic tokens (badge bg/fg, dot color) stay inline; the
     rest is class-driven so hover/focus-visible states are expressible. */
  .ach-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
    gap: 8px;
    overflow: hidden;
  }
  .ach-type {
    font-weight: 600;
    text-transform: capitalize;
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--tandem-fg-muted);
    font-size: 11px;
  }
  /* Icon badge. The old text-pill recipe (mono font, uppercase, letter-spacing,
     `padding: 1px 7px`, pill radius) is gone deliberately: four of those were
     inert on an SVG, but padding is NOT — it applies to replaced elements, so
     keeping it would render a 13px glyph inside a wide empty pill. */
  .ach-badge {
    display: inline-flex;
    align-items: center;
    color: var(--tandem-fg-muted);
    flex-shrink: 0;
  }
  /* Visually hidden, but revealed in forced-colors below — NOT `display: none`,
     which would take it out of the box the reveal needs. */
  .ach-badge-word {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  /* WS-A2: amber "Held" pill — matches the held-annotation banner token family
     (--tandem-warning-*). Signals a Solo-created comment the AI hasn't seen yet. */
  .ach-held-pill {
    font-size: var(--tandem-text-2xs);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 1px 7px;
    border-radius: var(--tandem-r-pill);
    color: var(--tandem-warning-fg-strong);
    background: var(--tandem-warning-bg);
    border: 1px solid var(--tandem-warning-border);
  }
  .ach-status {
    margin-left: 6px;
    font-size: 10px;
    font-weight: 600;
  }
  .ach-status.is-accepted {
    color: var(--tandem-success);
  }
  .ach-status.is-rejected {
    color: var(--tandem-error);
  }
  .ach-edit-btn {
    padding: 1px 4px;
    font-size: 11px;
    border: none;
    background: none;
    color: var(--tandem-fg-subtle);
    cursor: pointer;
    line-height: 1;
    border-radius: var(--tandem-r-2);
  }
  .ach-edit-btn:hover,
  .ach-edit-btn:focus-visible {
    color: var(--tandem-fg);
    background: var(--tandem-surface-sunk);
    outline: none;
  }
  .ach-author {
    font-size: 11px;
    color: var(--tandem-fg-subtle);
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .ach-edited {
    font-style: italic;
    font-size: 10px;
    color: var(--tandem-fg-subtle);
  }
  /* Creation time — mono + faint, echoing the design's `.card-time`. Hover
     title carries the absolute timestamp. */
  .ach-time {
    font-family: var(--tandem-font-mono);
    font-size: var(--tandem-text-2xs);
    color: var(--tandem-fg-faint);
    white-space: nowrap;
  }
  .ach-dot {
    width: 6px;
    height: 6px;
    border-radius: var(--tandem-r-circle);
    flex-shrink: 0;
  }

  @media (forced-colors: active) {
    /* In High Contrast the three authorship tints all become Canvas, so the
       card ground can no longer say who wrote it and the icon's own colours
       are force-adjusted. Swap to the word: it is the only carrier of type
       that survives. */
    .annotation-type-badge svg {
      display: none;
    }
    /* MEASURED, not precautionary. `.ach-row` is `space-between` with
       `overflow: hidden` and `.ach-badge` is `flex-shrink: 0`, so once the
       13px glyph becomes a padded word the row cannot give anywhere: at the
       side panel's 250px the content wanted 278px and the right-hand 28px —
       the tail of `.ach-author`, i.e. the timestamp — was silently cut off.
       That was with "Private note"; "Suggested replacement" is 75% wider.
       Wrapping is the only fix that costs nothing: shrinking the badge would
       truncate the ONLY type carrier that survives forcing, and shortening the
       labels would throw away the accessible name. Height is cheap here and
       clipping is not. `flex-wrap` is the load-bearing half and is pinned by
       forced-colors.spec.ts's headerClipped assertion — drop it and that goes
       red. `row-gap` is cosmetic (it keeps the wrapped lines off each other)
       and is NOT pinned by anything. */
    .ach-row,
    .ach-type {
      flex-wrap: wrap;
      row-gap: 4px;
    }
    .ach-badge-word {
      position: static;
      width: auto;
      height: auto;
      overflow: visible;
      clip-path: none;
      font-family: var(--tandem-font-mono);
      font-size: var(--tandem-text-2xs);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      padding: 1px 7px;
      border: 1px solid ButtonText;
      border-radius: var(--tandem-r-pill);
    }
  }
</style>
