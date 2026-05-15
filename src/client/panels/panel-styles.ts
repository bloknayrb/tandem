/**
 * Shared inline style string for annotation text areas.
 * Used by AnnotationEditForm.svelte and ReplyThread.svelte.
 * Mirrors TEXTAREA_STYLE from AnnotationCard.tsx.
 */
export const TEXTAREA_STYLE =
  "width: 100%; padding: 4px 6px; font-size: var(--tandem-text-xs); border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-1); resize: vertical; font-family: inherit; min-height: 40px; box-sizing: border-box; background: var(--tandem-surface); color: var(--tandem-fg);";

/**
 * Shared style for small secondary buttons in the reply thread overlay
 * (Cancel + idle Reply). The primary Send button has dynamic colors so it
 * stays inline.
 */
export const SECONDARY_BUTTON_STYLE =
  "padding: 4px 10px; font-size: var(--tandem-text-xs); border: 1px solid var(--tandem-border-strong); border-radius: var(--tandem-r-1); background: var(--tandem-surface); color: var(--tandem-fg-muted); cursor: pointer;";
