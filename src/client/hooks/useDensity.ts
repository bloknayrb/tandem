import type { Density } from "./useTandemSettings.js";

export function applyDensity(
  density: Density,
  root: HTMLElement = document.documentElement,
): () => void {
  root.setAttribute("data-density", density);
  return () => root.removeAttribute("data-density");
}
