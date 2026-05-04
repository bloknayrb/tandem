export function applyAccentHue(
  hue: number,
  root: HTMLElement = document.documentElement,
): () => void {
  const clamped = Math.max(0, Math.min(360, Math.round(hue)));
  root.style.setProperty("--tandem-accent-h", `${clamped}deg`);
  return () => root.style.removeProperty("--tandem-accent-h");
}
