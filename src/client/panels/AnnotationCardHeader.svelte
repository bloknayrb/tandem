<script lang="ts">
import type { Snippet } from "svelte";
import type { Annotation } from "../../shared/types";
import { createAgentLabel } from "../hooks/useAgentLabel.svelte";
import { createTandemSettings } from "../hooks/useTandemSettings.svelte";
import { formatRelativeTime, getAuthorLabel, getDisplayType } from "./annotation-card-helpers";

interface Props {
  annotation: Annotation;
  isPending: boolean;
  isReviewTarget?: boolean;
  isEditing: boolean;
  canEdit: boolean;
  badgeBg: string;
  badgeFg: string;
  onEnterEdit: () => void;
  /** Optional extra pill rendered next to the type badge (e.g. Private pill on NoteCard). */
  extraPill?: Snippet;
}

let {
  annotation,
  isPending,
  isReviewTarget,
  isEditing,
  canEdit,
  badgeBg,
  badgeFg,
  onEnterEdit,
  extraPill,
}: Props = $props();

const agentLabel = createAgentLabel(createTandemSettings());
const displayType = $derived(getDisplayType(annotation));
const authorLabel = $derived(getAuthorLabel(annotation.author, agentLabel.family));
// 6px authorship dot before the author label. Only user/claude carry an
// author color (the two --tandem-author-* tokens); imports show the byline
// instead, so the dot is omitted for them in the markup below.
const dotColor = $derived(
  annotation.author === "claude" ? "var(--tandem-author-claude)" : "var(--tandem-author-user)",
);
</script>

<div class="ach-row">
  <span class="ach-type">
    <span
      class="ach-badge annotation-type-badge"
      style="background: {badgeBg}; color: {badgeFg};"
    >
      {displayType}
    </span>
    {#if extraPill}{@render extraPill()}{/if}
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
    {#if annotation.author !== "import"}
      <span class="ach-dot" aria-hidden="true" style="background: {dotColor};"></span>
    {/if}
    {authorLabel}
    <span class="ach-time" title={new Date(annotation.timestamp).toLocaleString()}>
      {formatRelativeTime(annotation.timestamp)}
    </span>
  </span>
</div>

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
  .ach-badge {
    font-family: var(--tandem-font-mono);
    font-size: var(--tandem-text-2xs);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 1px 7px;
    border-radius: var(--tandem-r-pill);
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
    .annotation-type-badge {
      border: 1px solid ButtonText;
    }
  }
</style>
