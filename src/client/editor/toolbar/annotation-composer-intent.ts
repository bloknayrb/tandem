export type AnnotationComposerIntent = "comment" | "note" | null;

export function defaultAnnotationIntent(intent: AnnotationComposerIntent): "comment" | "note" {
  return intent ?? "comment";
}

export function resolveAnnotationSubmission(
  intent: AnnotationComposerIntent,
  modifiers: { altKey: boolean; ctrlKey: boolean; metaKey: boolean },
): "comment" | "note" | null {
  if (modifiers.altKey) return "note";
  if (modifiers.ctrlKey || modifiers.metaKey) return defaultAnnotationIntent(intent);
  return null;
}
