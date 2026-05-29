/**
 * Conflict detection + persisted-override validation for customizable keyboard
 * shortcuts (ADR-041).
 *
 * The override-first loop in `matchShortcut` wins over the legacy chain, so a
 * remapped chord can silently STEAL whatever a fixed (non-remappable) branch
 * would otherwise do. The protection must therefore know every chord a fixed
 * branch claims — including the loose branches (`find`/`find-nav` ignore Alt,
 * `pick-tab` ignores Alt+Shift, the `?` help branch has no modifier gate at
 * all). Rather than hand-transcribe that gating (which is exactly the drift
 * that motivated this fix), `claimedByFixedShortcut` asks the matcher itself:
 * synthesize an event from the chord, run `matchShortcut` with NO overrides,
 * and treat any non-remappable result as a conflict. The matcher is the single
 * source of truth; there is no second copy to drift.
 *
 * This module lives apart from `keybindings.ts` because it imports
 * `matchShortcut` (from `useAppShortcuts.ts`, which itself imports
 * `keybindings.ts`) — keeping these functions here avoids a circular import.
 */

import {
  type KeyboardEventLike,
  matchShortcut,
  type ShortcutId,
} from "../hooks/useAppShortcuts.js";
import {
  chordsEqual,
  effectiveChord,
  isBindableChord,
  isRemappableShortcutId,
  isValidChord,
  REMAPPABLE_LABELS,
  REMAPPABLE_SHORTCUT_IDS,
  RESERVED_CHORDS,
  type RemappableShortcutId,
  type ShortcutChord,
} from "./keybindings.js";

/**
 * Synthesize the `key` a chord would produce, for the matcher's `e.key`-based
 * branches (help `?`/`/`, accept/dismiss `Enter`). A chord carries only
 * `e.code`; this derivation is the one irreducible US-layout assumption
 * (`Shift+Slash` → `?`, `Slash` → `/`). Non-US layouts where `?`/`/` sit on a
 * different physical key keep the matcher's pre-existing layout quirk.
 */
function keyForChord(chord: ShortcutChord): string {
  if (chord.code === "Slash") return chord.shift ? "?" : "/";
  if (chord.code === "Enter" || chord.code === "NumpadEnter") return "Enter";
  return "";
}

function synthEvent(chord: ShortcutChord): KeyboardEventLike {
  return {
    key: keyForChord(chord),
    code: chord.code,
    ctrlKey: chord.ctrlOrMeta,
    metaKey: false,
    altKey: chord.alt,
    shiftKey: chord.shift,
    isComposing: false,
  };
}

/** Human label for a fixed (non-remappable) shortcut id, refined by the
 * matcher's context (shift / tab index) so conflict messages are precise. */
function fixedLabel(
  id: ShortcutId,
  context: { shift?: boolean; tabIndex?: number } | undefined,
): string {
  switch (id) {
    case "toggle-help":
      return "Show keyboard shortcuts";
    case "select-all":
      return "Select all";
    case "find":
      return context?.shift ? "Find in open tabs" : "Find / Replace";
    case "find-nav":
      return context?.shift ? "Find previous" : "Find next";
    case "annotation-accept-or-dismiss":
      return context?.shift ? "Dismiss annotation" : "Accept annotation";
    case "pick-tab":
      return context?.tabIndex ? `Jump to tab ${context.tabIndex}` : "Jump to tab";
    default:
      // A remappable id (or one with no fixed label) — not a fixed conflict.
      return "";
  }
}

/**
 * Label of the fixed (non-remappable) function a chord would be claimed by, or
 * `null` if no fixed branch claims it. Reuses `matchShortcut` (no overrides) as
 * the authority, so it tracks the matcher's exact gating — including loose
 * branches — automatically. Returns `null` when the chord merely equals a
 * remappable default (that collision is `findConflict`'s remappable-loop job).
 */
export function claimedByFixedShortcut(chord: ShortcutChord): string | null {
  const match = matchShortcut(synthEvent(chord));
  if (!match) return null;
  if (isRemappableShortcutId(match.id)) return null;
  return fixedLabel(match.id, match.context) || null;
}

/**
 * Find what currently owns `chord`, or `null` if free. Checks every remappable
 * id's *effective* binding (override ?? default) except `excludeId`, then the
 * fixed matcher branches (via the matcher itself), then the non-matcher
 * reserved set. Returns the owner's human label.
 */
export function findConflict(
  chord: ShortcutChord,
  overrides: ReadonlyMap<RemappableShortcutId, ShortcutChord>,
  excludeId: RemappableShortcutId,
): string | null {
  for (const id of REMAPPABLE_SHORTCUT_IDS) {
    if (id === excludeId) continue;
    if (chordsEqual(effectiveChord(id, overrides), chord)) return REMAPPABLE_LABELS[id];
  }
  const fixed = claimedByFixedShortcut(chord);
  if (fixed) return fixed;
  for (const reserved of RESERVED_CHORDS) {
    if (chordsEqual(reserved.chord, chord)) return reserved.label;
  }
  return null;
}

function isReserved(chord: ShortcutChord): boolean {
  return RESERVED_CHORDS.some((r) => chordsEqual(r.chord, chord));
}

/**
 * Validate a persisted `customShortcuts` blob, dropping any entry that:
 *  - isn't keyed by a remappable id, or isn't a well-formed chord;
 *  - isn't actually bindable (no primary modifier, Numpad/Tab/Escape/… — the
 *    same gate the recording UI applies, so a hand-edited blob can't smuggle in
 *    e.g. plain `Shift+A`, which the override loop would otherwise fire on every
 *    keystroke);
 *  - collides with a fixed matcher branch or a reserved chord (would otherwise
 *    shadow it via the override-first loop);
 *  - duplicates a chord already kept by a higher-priority id (the override loop
 *    iterates `REMAPPABLE_SHORTCUT_IDS`, so the earliest id wins — keep that one
 *    and drop the rest, matching runtime behavior instead of silently dead ids).
 */
export function parseCustomShortcuts(raw: unknown): Record<string, ShortcutChord> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const valid: Partial<Record<RemappableShortcutId, ShortcutChord>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isRemappableShortcutId(key)) continue;
    if (!isValidChord(value)) continue;
    if (!isBindableChord(value)) continue;
    if (isReserved(value)) continue;
    if (claimedByFixedShortcut(value)) continue;
    valid[key] = value;
  }
  // Dedupe by chord, keeping the entry earliest in REMAPPABLE_SHORTCUT_IDS order
  // (the same order the matcher's override loop resolves), so the kept id is the
  // one that actually fires at runtime.
  const out: Record<string, ShortcutChord> = {};
  const kept: ShortcutChord[] = [];
  for (const id of REMAPPABLE_SHORTCUT_IDS) {
    const chord = valid[id];
    if (!chord) continue;
    if (kept.some((c) => chordsEqual(c, chord))) continue;
    kept.push(chord);
    out[id] = chord;
  }
  return out;
}

/**
 * Build the runtime override map from the persisted `customShortcuts` record.
 * Returns a fresh Map each call (cheap — ≤17 entries).
 */
export function buildOverrides(
  customShortcuts: Record<string, unknown> | undefined,
): ReadonlyMap<RemappableShortcutId, ShortcutChord> {
  const out = new Map<RemappableShortcutId, ShortcutChord>();
  for (const [key, value] of Object.entries(parseCustomShortcuts(customShortcuts))) {
    out.set(key as RemappableShortcutId, value);
  }
  return out;
}
