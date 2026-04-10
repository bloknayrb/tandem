/**
 * Client-local UI state describing the current side-panel arrangement.
 *
 * Discriminated union so `left` is present if and only if the layout is
 * three-panel — illegal states ("tabbed with a left width") cannot exist.
 *
 * Purely in-memory: widths still persist individually via `PANEL_WIDTH_KEYS`
 * in localStorage. Keeping this client-side (not in `src/shared/types.ts`)
 * avoids overlap with the parallel Annotation type refactor (#233).
 */
export type PanelLayout =
  | { kind: "tabbed"; right: number }
  | { kind: "three-panel"; left: number; right: number };
