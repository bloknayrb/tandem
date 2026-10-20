export type AnnotationComposerIntent = "comment" | "note" | null;

/**
 * The composer's primary audience. `aiDisabled` (the licence refuses the AI,
 * #1521) forces a private note whatever the intent — including the native
 * "Comment to AI" menu path, which sets `"comment"` directly. Required, so
 * every call site has to decide.
 */
export function defaultAnnotationIntent(
  intent: AnnotationComposerIntent,
  aiDisabled: boolean,
): "comment" | "note" {
  if (aiDisabled) return "note";
  return intent ?? "comment";
}

export function resolveAnnotationSubmission(
  intent: AnnotationComposerIntent,
  modifiers: { altKey: boolean; ctrlKey: boolean; metaKey: boolean },
  aiDisabled: boolean,
): "comment" | "note" | null {
  if (modifiers.altKey) return "note";
  if (modifiers.ctrlKey || modifiers.metaKey) return defaultAnnotationIntent(intent, aiDisabled);
  return null;
}
