<script lang="ts">
import type { Annotation, AnnotationReply } from "../../shared/types";
import { getVisibleReplies } from "../annotations/replies";
import { createAgentLabel } from "../hooks/useAgentLabel.svelte";
import { activationKeydown } from "../utils/keyboard-activate";
import AnnotationCardActions from "./AnnotationCardActions.svelte";
import AnnotationEditForm from "./AnnotationEditForm.svelte";
import { getCardLabel } from "./annotation-card-helpers";
import CommentCard from "./CommentCard.svelte";
import type { Density } from "./cardDensity";
import { cardEnter, cardExit } from "./cardMotion";
import HighlightCard from "./HighlightCard.svelte";
import ImportedCard from "./ImportedCard.svelte";
import NoteCard from "./NoteCard.svelte";
import ReplyThread from "./ReplyThread.svelte";
import SuggestionCard from "./SuggestionCard.svelte";

interface Props {
  annotation: Annotation;
  replies?: AnnotationReply[];
  isReviewTarget?: boolean;
  /**
   * #651: render an inline typing-dot indicator when Claude is executing an
   * MCP tool targeting this annotation. Subscribed once at the YjsSync layer
   * and forwarded as a plain boolean so each card doesn't observe the
   * awareness Y.Map itself.
   */
  claudeTyping?: boolean;
  onAccept?: (id: string) => void;
  onDismiss?: (id: string) => void;
  onUndo?: (id: string) => boolean;
  onEdit?: (id: string, newContent: string) => void;
  onReply?: (id: string, text: string) => Promise<boolean>;
  onRemove?: (id: string) => void;
  onSendToClaude?: (id: string) => void;
  /** Whether this annotation was recently resolved and can be undone */
  undoable?: boolean;
  onClick?: () => void;
  /** Batch-selection state — forwarded to ImportedCard only. */
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
  /**
   * Margin-view density. `full` (default) reproduces today's card; `compact`
   * (crowded anchors, full-width band) shows the header + a single-line body
   * teaser + the action row; `clamped` (narrow band) is the same minus the
   * action row; `stub` (stub band) collapses to a ~22px anchor pip.
   * `compact` vs `clamped` is height-pressure vs width-pressure — see
   * `cardDensity.ts`. Resolved against `isEditing` below
   * — editing always forces `full`. Only MarginColumn passes a non-default
   * value; the side panel leaves it `full`, so existing call sites are
   * unaffected.
   */
  density?: Density;
  /**
   * A4/A1/A10 (Phase 4 / #798). When true, the card root animates in on arrival
   * and out on resolve/removal via `cardMotion`. Only the pending side-panel
   * list opts in; the resolved list and margin view leave it `false` so those
   * cards never animate (the transition factories return `{ duration: 0 }`).
   */
  lifecycleMotion?: boolean;
  /** App reduce-motion setting, forwarded to the lifecycle transitions. */
  reduceMotion?: boolean;
  /**
   * Exit-direction ledger owned by SidePanel: accept → settle up, dismiss →
   * slide right, absent → neutral fade. Read+cleared inside `cardExit`.
   */
  exitModes?: Map<string, "accept" | "dismiss">;
  /**
   * #999: external open-request from the native context menu's Reply…/Edit…
   * items. The panel passes it ONLY to the targeted card; when `nonce` bumps,
   * open the in-card editor (`kind:"edit"`) or reply composer (`kind:"reply"`).
   */
  openRequest?: { kind: "edit" | "reply"; nonce: number } | null;
}

let {
  annotation,
  replies = [],
  isReviewTarget,
  claudeTyping = false,
  onAccept,
  onDismiss,
  onUndo,
  onEdit,
  onReply,
  onRemove,
  onSendToClaude,
  undoable,
  onClick,
  selected = false,
  onToggleSelect,
  density = "full",
  lifecycleMotion = false,
  reduceMotion = false,
  exitModes,
  openRequest = null,
}: Props = $props();

const agentLabel = createAgentLabel();

// Shared edit-mode state owned by the dispatcher; variants are presentational
// and never own state. The edit form replaces the variant body when isEditing.
let isEditing = $state(false);
let editText = $state("");
let editNewText = $state("");
let editReason = $state("");

const isPending = $derived(annotation.status === "pending");
const hasSuggestedText = $derived(annotation.suggestedText !== undefined);
const canEdit = $derived(onEdit !== undefined);
const cardLabel = $derived(getCardLabel(annotation));
// Privacy: getVisibleReplies returns [] for non-comment annotations, so
// note/highlight cards never surface the reply disclosure (A13 #798 — the
// toggle, count, and replies block all gate on this inside ReplyThread).
const visibleReplies = $derived(getVisibleReplies(annotation, replies));

// `stub` wins over everything: the ~28px stub track can't hold an edit form any
// more than it can hold a full card, so a card that is mid-edit when the
// viewport shrinks to the stub band collapses to a pip (the edit state persists
// in the parent and the form reappears when the viewport widens). In the
// narrow/full bands editing forces `full` — the edit form needs the body, and
// the dispatcher is the only place `isEditing` is known (the pure `cardDensity`
// helper MarginColumn calls passes `isEditing: false`). This keeps the render in
// lockstep with `cardDensity`, whose stub-geometry rule already ignores editing.
const resolvedDensity = $derived<Density>(
  density === "stub" ? "stub" : isEditing ? "full" : density,
);

// #999: react to the native context menu's Reply…/Edit… request. Plain-`let`
// last-value guards PER KIND so the effect no-ops on mount (openRequest is null /
// nonce unchanged) and fires exactly once per genuine bump. `replyOpenNonce` is
// forwarded to ReplyThread, which opens its composer on a bump (its own
// untrack-seeded guard ignores the mount value).
let lastEditNonce = -1;
let lastReplyNonce = -1;
let replyOpenNonce = $state(0);
$effect(() => {
  const req = openRequest;
  if (!req) return;
  if (req.kind === "edit") {
    if (req.nonce === lastEditNonce) return;
    lastEditNonce = req.nonce;
    if (onEdit) enterEditMode();
  } else {
    if (req.nonce === lastReplyNonce) return;
    lastReplyNonce = req.nonce;
    replyOpenNonce = req.nonce;
  }
});
// Tint is AUTHOR, always — three values, one per author role. Type is carried
// by the header's icon instead (`annotation-type-icon.ts`).
//
// This replaces a six-branch derivation that mixed the two axes: it tinted by
// type for note/highlight/suggestion and by author for everything else, so one
// colour was asked to answer two questions and answered neither cleanly. A
// Claude-authored highlight looked identical to a user-authored one — and the
// tutorial seeds highlights as `author: "claude"`, so that collision was on the
// first card every new user meets. Meanwhile the margin leader lines pointing
// AT these cards were already author-keyed (`leaderColorForAuthor`), so the
// rail contradicted itself.
//
// The highlight's picked colour is not lost — it moved to the type icon, which
// is the one place it still means something.
const cardTint = $derived(
  annotation.author === "claude"
    ? "var(--tandem-author-claude-bg)"
    : annotation.author === "import"
      ? "var(--tandem-author-import-bg)"
      : "var(--tandem-author-user-bg)",
);

// Review-target override wins over the type tint; the accent ring is applied
// via the .is-review-target class (see the style block below) so it composes
// with the hover shadow.
const cardBg = $derived(isReviewTarget ? "var(--tandem-accent-bg)" : cardTint);

function enterEditMode() {
  if (hasSuggestedText) {
    editNewText = annotation.suggestedText ?? "";
    editReason = annotation.content;
  } else {
    editText = annotation.content;
  }
  isEditing = true;
}

function handleSave() {
  const newContent = hasSuggestedText
    ? JSON.stringify({ suggestedText: editNewText, content: editReason })
    : editText;
  onEdit?.(annotation.id, newContent);
  isEditing = false;
}

function handleCancel() {
  isEditing = false;
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.stopPropagation();
    handleCancel();
  }
}
/**
 * Card activation, declining clicks that started on a link.
 *
 * A rendered Claude body (#1626) can contain anchors. Without this, following a
 * link both navigates AND scrolls the document to the annotation.
 *
 * The check lives HERE, on the element that owns `onClick`, rather than as a
 * `stopPropagation` in `AnnotationBody`. That version worked, but only because
 * Svelte 5 delegates `click` and its simulated walk breaks on `cancelBubble` —
 * so converting either handler to a `use:` action or an explicit
 * `addEventListener` would silently disable the guard with no type error and no
 * failing test. Reading the target is order-independent. It also avoids
 * re-adding the `a11y_click_events_have_key_events` suppression that #1184
 * deliberately removed project-wide.
 *
 * The keyboard path needs no equivalent: `activationKeydown(..., {selfOnly:
 * true})` already declines when the event target is an inner element, and
 * activating a focused anchor synthesizes a click that lands here.
 */
function onCardClick(event: MouseEvent) {
  if ((event.target as HTMLElement | null)?.closest("a")) return;
  onClick?.();
}
</script>

<!-- Keyboard activation on the card root uses plain tabindex, not roving —
     the card is a heavyweight composite with inner tabbables (reply/accept
     buttons), so `selfOnly` keeps Enter in the reply composer and Space on
     inner buttons from re-triggering onClick. Alt+]/Alt+[ registry navigation
     (SidePanel) is unrelated. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="tandem-annotation-card"
  class:is-review-target={isReviewTarget}
  class:is-density-compact={resolvedDensity === "compact"}
  class:is-density-clamped={resolvedDensity === "clamped"}
  class:is-density-stub={resolvedDensity === "stub"}
  in:cardEnter={{ enabled: lifecycleMotion, reduceMotion }}
  out:cardExit={{ enabled: lifecycleMotion, reduceMotion, id: annotation.id, modes: exitModes }}
  onclick={onCardClick}
  onkeydown={activationKeydown(() => onClick?.(), { selfOnly: true })}
  tabindex={onClick ? 0 : undefined}
  data-testid="annotation-card-{annotation.id}"
  data-annotation-id={annotation.id}
  data-annotation-type={annotation.type}
  data-density={resolvedDensity}
  data-claude-typing={claudeTyping ? "true" : undefined}
  role="listitem"
  aria-label={cardLabel}
  aria-current={isReviewTarget ? "true" : undefined}
  style="background: {cardBg}; opacity: {isPending ? 1 : 0.6}; cursor: {onClick
    ? 'pointer'
    : 'default'};"
>
  {#if claudeTyping}
    <!--
      #651: Claude typing-presence indicator. Renders as a three-dot pulse in
      the top-right corner of the card while the targeting MCP tool runs.
      `aria-live="polite"` so screen readers announce the transition without
      interrupting; `role="status"` keeps it out of the listitem accessibility
      tree as a child semantic region.
    -->
    <div
      data-testid="claude-typing-indicator-{annotation.id}"
      class="tandem-claude-typing"
      role="status"
      aria-live="polite"
      aria-label="{agentLabel.family} is working on this annotation"
      title="{agentLabel.family} is working on this annotation"
    >
      <span class="tandem-claude-typing-dot"></span>
      <span class="tandem-claude-typing-dot"></span>
      <span class="tandem-claude-typing-dot"></span>
    </div>
  {/if}
  {#if annotation.author === "import"}
    <ImportedCard
      annotation={annotation as Annotation & { author: "import" }}
      {isPending}
      {isReviewTarget}
      {isEditing}
      {canEdit}
      onEnterEdit={enterEditMode}
      {selected}
      {onToggleSelect}
    />
  {:else if annotation.type === "highlight"}
    <HighlightCard
      {annotation}
      {isPending}
      {isReviewTarget}
      {isEditing}
      {canEdit}
      onEnterEdit={enterEditMode}
    />
  {:else if annotation.type === "note"}
    <NoteCard
      {annotation}
      {isPending}
      {isReviewTarget}
      {isEditing}
      {canEdit}
      onEnterEdit={enterEditMode}
    />
  {:else if annotation.suggestedText !== undefined}
    <SuggestionCard
      annotation={annotation as Annotation & { type: "comment"; suggestedText: string }}
      {isPending}
      {isReviewTarget}
      {isEditing}
      {canEdit}
      onEnterEdit={enterEditMode}
    />
  {:else}
    <CommentCard
      annotation={annotation as Annotation & { type: "comment"; suggestedText?: undefined }}
      {isPending}
      {isReviewTarget}
      {isEditing}
      {canEdit}
      onEnterEdit={enterEditMode}
    />
  {/if}

  {#if isEditing}
    <AnnotationEditForm
      annotationId={annotation.id}
      {hasSuggestedText}
      {editText}
      {editNewText}
      {editReason}
      onChangeEditText={(v) => (editText = v)}
      onChangeEditNewText={(v) => (editNewText = v)}
      onChangeEditReason={(v) => (editReason = v)}
      onKeyDown={handleKeyDown}
      onSave={handleSave}
      onCancel={handleCancel}
    />
  {/if}

  <AnnotationCardActions
    annotationId={annotation.id}
    annotationType={annotation.type}
    {isPending}
    {isEditing}
    {undoable}
    {onAccept}
    {onDismiss}
    {onUndo}
    {onRemove}
    {onSendToClaude}
  />
  <!-- A13 (#798): the inline disclosure in ReplyThread is now the reply reader;
       it replaced the former "Expand thread" → portaled ReplyThreadOverlay
       (Bryan decision 2026-06-01 — overlay retired). -->
  <ReplyThread
    {annotation}
    replies={visibleReplies}
    {isPending}
    {isEditing}
    {onReply}
    {reduceMotion}
    openNonce={replyOpenNonce}
  />
</div>

<style>
  /* Static chrome lives here (not inline) so :hover can raise the shadow —
     an inline style= attribute would beat a class-based :hover on box-shadow.
     The dynamic background tint / opacity / cursor stay inline on the element.
     position: relative anchors the #651 Claude typing indicator. */
  .tandem-annotation-card {
    position: relative;
    padding: var(--tandem-space-3);
    margin-bottom: var(--tandem-space-2);
    border: 1px solid var(--tandem-border);
    border-radius: var(--tandem-r-5);
    font-size: var(--tandem-text-base);
    box-shadow: var(--tandem-shadow-1);
    transition: background 0.15s ease, box-shadow 0.15s ease;
  }
  /* Reduced motion: the card still recolors (selection tint) and still raises
     its shadow on hover/focus — only the 0.15s ramps are cut. No `!important`:
     the inline style= above sets background/opacity/cursor but never
     `transition`, and the A4/A1/A10 lifecycle motion is a JS transition that
     already opts out via `motionOff()` in cardMotion.ts, so nothing outranks
     these two declarations. Dual mechanism, matching the typing-dot guard
     below. */
  :global(body.tandem-reduce-motion) .tandem-annotation-card {
    transition: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .tandem-annotation-card {
      transition: none;
    }
  }
  .tandem-annotation-card:hover {
    box-shadow: var(--tandem-shadow-2);
  }
  /* Keyboard-activation focus ring (C2). Placed BEFORE .is-review-target below
     so, at equal specificity (both are two-class-weight selectors), source
     order gives the review-target ring priority when a card is both focused
     and the active review target — the two rings would otherwise fight. */
  .tandem-annotation-card:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--tandem-accent-border), var(--tandem-shadow-2);
  }
  /* Placed after :hover so the focused-card ring wins at equal specificity.
     Selected state is a CONTRASTING accent ring + a soft glow that persists —
     the old `0 0 0 3px var(--tandem-accent-bg)` used the same color as the card
     fill (also accent-bg), so once the one-shot flash faded it read as a flat,
     hard-edged stroke rather than a "selected" glow. A crisp 1.5px accent-border
     edge gives definition; the blurred accent halo carries the glow language of
     the flash so the transition settles instead of snapping to a flat border. */
  .tandem-annotation-card.is-review-target {
    box-shadow:
      0 0 0 1.5px var(--tandem-accent-border),
      0 0 10px -2px color-mix(in srgb, var(--tandem-accent) 30%, transparent),
      var(--tandem-shadow-2);
  }
  /* #651 Claude typing-presence indicator: three pulsing dots in the
     card's top-right corner, colored with the Claude authorship token so
     the affordance reads as "Claude is here" at a glance. */
  .tandem-claude-typing {
    position: absolute;
    top: var(--tandem-space-2);
    right: var(--tandem-space-2);
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 2px 6px;
    border-radius: var(--tandem-r-pill);
    background: var(--tandem-claude-focus-bg);
    pointer-events: none;
  }
  .tandem-claude-typing-dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--tandem-author-claude);
    animation: tandem-claude-typing-pulse 1.2s ease-in-out infinite;
  }
  .tandem-claude-typing-dot:nth-child(2) {
    animation-delay: 0.15s;
  }
  .tandem-claude-typing-dot:nth-child(3) {
    animation-delay: 0.3s;
  }
  @keyframes tandem-claude-typing-pulse {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.85); }
    40% { opacity: 1; transform: scale(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .tandem-claude-typing-dot {
      animation: none;
      opacity: 0.7;
    }
  }
  :global(body.tandem-reduce-motion) .tandem-claude-typing-dot {
    animation: none;
    opacity: 0.7;
  }
  @media (forced-colors: active) {
    .tandem-claude-typing-dot {
      outline: 1px solid ButtonText;
      outline-offset: 1px;
    }
  }

  /* ───────────────── Density variants (Stage C-2) ─────────────────
     Margin-view density modifiers layered over the existing dispatcher (NOT a
     flat data-kind bubble). A clamped/stub card is inactive by construction —
     active or editing resolves to `full` in cardDensity — so these classes are
     never present on a focused card; no `:not(.is-review-target)` qualifier is
     needed. The collapse pierces child-component boundaries via `:global()`:
     `.aca-body` (variant body), `[data-testid^="annotation-snippet-"]`
     (AnnotationSnippet), `.aca-row`/`.aca-undo-row`/`.aca-standalone`
     (AnnotationCardActions), `.art-root` (ReplyThread), and the header pieces
     `.ach-row`/`.ach-type`/`.ach-author`/`.ach-dot` (AnnotationCardHeader). */

  /* Minimized cards — `clamped` (WIDTH pressure, narrow band) and `compact`
     (HEIGHT pressure, crowded anchors at full width) share everything except the
     action row. Both keep the full header, hide the snippet and replies, and show
     a single-line body teaser.

     The full `-webkit-box` recipe is required — `-webkit-line-clamp` alone is a
     no-op — and it is hand-written deliberately: per the two-CSS-pipeline rule,
     lightningcss will NOT add `-webkit-line-clamp` for you (unlike
     `backdrop-filter`, where hand-writing the prefixed form collapses the
     declaration to an inert `-webkit-` only). Keeping ONE copy of this recipe is
     the point of sharing the selector list — a second copy is exactly the drift
     that produced #1189. `overflow: clip` (not `hidden`) avoids creating a
     focus-autoscroll scroll container (`feedback_overflow_hidden_vs_clip`). */
  .is-density-clamped :global(.aca-body),
  .is-density-compact :global(.aca-body) {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 1;
    line-clamp: 1;
    overflow: clip;
  }
  /* Markdown bodies (#1626) render BLOCK children — `<p>`, `<pre>`, `<li>` —
     and each one opens its own line box, so the `-webkit-line-clamp: 1` above
     collapses to one line per block rather than one line total. A two-paragraph
     Claude comment would show two lines in a card sized for one, overflowing the
     clamped band. Flattening the descendants to inline is what makes the teaser
     single-line again; formatting is irrelevant at this size, and the full
     rendering returns as soon as the card expands. */
  .is-density-clamped :global(.aca-body .tandem-markdown *),
  .is-density-compact :global(.aca-body .tandem-markdown *) {
    display: inline;
    margin: 0;
    padding: 0;
    border: none;
    background: none;
    /* `<pre>` carries `white-space: pre-wrap`, which keeps honouring the
       literal newlines in a fenced block even once the box is inline — so
       without this a code block still renders one line per line of code. */
    white-space: normal;
  }
  /* `<br>` is the other half, and the more common one: `renderMarkdown` turns
     every single newline into one, so a bullet list — the likeliest thing
     Claude writes into a comment — emits a `<br>` between every item. `display:
     inline` is a `<br>`'s NORMAL value and does not stop it breaking the line;
     `none` is what does. */
  .is-density-clamped :global(.aca-body .tandem-markdown br),
  .is-density-compact :global(.aca-body .tandem-markdown br) {
    display: none;
  }

  .is-density-clamped :global([data-testid^="annotation-snippet-"]),
  .is-density-clamped :global(.art-root),
  .is-density-compact :global([data-testid^="annotation-snippet-"]),
  .is-density-compact :global(.art-root) {
    display: none;
  }

  /* The ONE difference: `clamped` also drops the action row, because a 160px
     narrow column cannot fit accept/dismiss. A `compact` card is full-width and
     has the room, so it keeps them — that is why the variant exists at all, and
     it is what makes a crowd-minimized card actionable without expanding first. */
  .is-density-clamped :global(.aca-row),
  .is-density-clamped :global(.aca-undo-row),
  .is-density-clamped :global(.aca-standalone) {
    display: none;
  }

  /* PRIVACY SIGNAL — a note's author dot is a ring, not a disc.

     Under author-tint a note and a comment by the same person share a card
     ground, so the amber that used to mean "private" is gone. The Private pill
     covers the full/compact/clamped bands, but it lives inside `.ach-type`,
     which stub hides outright — and it is `aria-hidden`, so it was never the
     accessibility answer either. At stub density the tint WAS the only
     surviving note signal.

     A hollow dot costs zero width, so it cannot disturb the stub scrollWidth
     gate the way a larger glyph would; it needs no new markup, because
     `data-annotation-type` is already on the card root; and it survives
     forced-colors, where a CanvasText border is still a border.

     Keyed on `type === "note"`, deliberately NOT on `audience`. Notes are what
     ADR-027 actually defends; `audience: "private"` is the muddled field —
     user highlights carry it and are still returned to Claude (#1710). */
  /* The whole selector must sit inside one `:global(...)` — `.ach-dot` belongs
     to AnnotationCardHeader, so a Svelte-scoped trailing class gets this
     component's hash appended and matches nothing. */
  :global([data-annotation-type="note"] .ach-dot) {
    background: transparent !important;
    border: 1.5px solid var(--tandem-author-user);
  }

  /* Stub (stub band, inactive): a ~22px anchor pip — the 6px author dot only.
     The stub column is ~28px wide; the card's default 12px padding + the
     header's badge/author text would overflow ~100px and clip at the window
     edge (the bug the continuum exposed). Shrinking the padding, collapsing the
     header chrome, and `overflow: clip` keep the card's footprint inside the
     column — verified by the E2E scrollWidth gate. */
  .is-density-stub {
    padding: var(--tandem-space-1);
    min-height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: clip;
  }
  .is-density-stub :global([data-testid^="annotation-snippet-"]),
  .is-density-stub :global(.aca-body),
  .is-density-stub :global(.aca-row),
  .is-density-stub :global(.aca-undo-row),
  .is-density-stub :global(.aca-standalone),
  .is-density-stub :global(.art-root),
  .is-density-stub :global(.ach-type) {
    display: none;
  }
  .is-density-stub :global(.ach-row) {
    margin-bottom: 0;
    justify-content: center;
    gap: 0;
  }
  /* font-size:0 collapses the author label + "(edited)" text to nothing; the
     6px `.ach-dot` keeps its explicit dimensions, so the dot survives as the
     pip. (Imports never reach stub density — see cardDensity — and carry no
     dot, so this only ever shows a user/claude dot.) */
  .is-density-stub :global(.ach-author) {
    font-size: 0;
    gap: 0;
  }
  /* `.ach-time` carries an explicit font-size that overrides the parent's
     `font-size: 0`, so it must be hidden directly in stub mode — otherwise
     the timestamp text renders at 10px and pushes scrollWidth past
     clientWidth (the C-2 E2E scrollWidth gate). */
  .is-density-stub :global(.ach-time) {
    display: none;
  }
</style>
