<script lang="ts">
import type { Snippet } from "svelte";
import type { Annotation } from "../../shared/types";
import { getAuthorLabel, getDisplayType } from "./annotation-card-helpers";

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

const displayType = $derived(getDisplayType(annotation));
const authorLabel = $derived(getAuthorLabel(annotation.author));
</script>

<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; gap: 8px;">
  <span
    style="font-weight: 600; text-transform: capitalize; display: flex; align-items: center; gap: 6px; color: var(--tandem-fg-muted); font-size: 11px;"
  >
    <span
      class="annotation-type-badge"
      style="font-family: var(--tandem-font-mono); font-size: var(--tandem-text-2xs); letter-spacing: 0.04em; text-transform: uppercase; padding: 1px 7px; border-radius: var(--tandem-r-pill); background: {badgeBg}; color: {badgeFg};"
    >
      {displayType}
    </span>
    {#if extraPill}{@render extraPill()}{/if}
    {#if !isPending}
      <span
        style="margin-left: 6px; font-size: 10px; color: {annotation.status === 'accepted'
          ? 'var(--tandem-success)'
          : 'var(--tandem-error)'}; font-weight: 600;"
      >
        {annotation.status}
      </span>
    {/if}
    {#if isPending && canEdit && !isReviewTarget && !isEditing}
      <button
        data-testid="edit-btn-{annotation.id}"
        onclick={(e) => {
          e.stopPropagation();
          onEnterEdit();
        }}
        style="padding: 1px 4px; font-size: 11px; border: none; background: none; color: var(--tandem-fg-subtle); cursor: pointer; line-height: 1;"
        title="Edit this annotation's content"
      >
        ✎ Edit
      </button>
    {/if}
  </span>
  <span
    style="font-size: 11px; color: var(--tandem-fg-subtle); display: flex; align-items: center; gap: 4px;"
  >
    {#if annotation.editedAt}
      <span style="font-style: italic; font-size: 10px; color: var(--tandem-fg-subtle);">
        (edited)
      </span>
    {/if}
    {authorLabel}
  </span>
</div>

<style>
  @media (forced-colors: active) {
    .annotation-type-badge {
      border: 1px solid ButtonText;
    }
  }
</style>
