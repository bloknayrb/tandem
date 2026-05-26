import type { TandemNotification } from "../../shared/types.js";

/**
 * Severity-glyph path data (24×24 viewBox, stroke vocabulary) shared by the
 * transient `ToastContainer` pop and the persistent `ActivityTray` rows. The
 * codebase inlines SVGs per-component rather than shipping an icon component;
 * centralizing only the path strings keeps the two activity-center surfaces
 * visually identical without introducing a new shared component.
 */
export const SEVERITY_GLYPHS: Record<TandemNotification["severity"], string[]> = {
  info: ["M12 3a9 9 0 100 18 9 9 0 000-18z", "M12 11v6", "M12 8h.01"],
  warning: [
    "M10.3 3.86 1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z",
    "M12 9v4",
    "M12 17h.01",
  ],
  error: ["M12 3a9 9 0 100 18 9 9 0 000-18z", "M15 9l-6 6", "M9 9l6 6"],
};

/**
 * Compact relative-time label for an activity row. `now` is injected so the
 * tray's 30s clock can drive ageing deterministically (and tests can pin it).
 * Extends the bundle's seconds/minutes formatter with hours/days because the
 * tray is persisted and can surface events from previous sessions.
 */
export function relativeTime(timestamp: number, now: number = Date.now()): string {
  // Floor (not round) — elapsed-time labels read as "1h" only after a full
  // hour has passed, so a 90-minute-old event shows "1h", never "2h".
  const s = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
