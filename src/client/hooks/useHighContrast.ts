export function applyHighContrast(
  enabled: boolean,
  root: HTMLElement = document.documentElement,
): () => void {
  if (enabled) {
    root.setAttribute("data-high-contrast", "true");
  } else {
    root.removeAttribute("data-high-contrast");
  }
  return () => root.removeAttribute("data-high-contrast");
}
