export function applyAnnotationPatterns(
  enabled: boolean,
  root: HTMLElement = document.documentElement,
): () => void {
  if (enabled) {
    root.setAttribute("data-annotation-patterns", "true");
  } else {
    root.removeAttribute("data-annotation-patterns");
  }
  return () => root.removeAttribute("data-annotation-patterns");
}
