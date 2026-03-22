/** Generate a unique annotation ID. Used by both server and client. */
export function generateAnnotationId(): string {
  return `ann_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
