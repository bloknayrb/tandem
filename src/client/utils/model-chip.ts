/**
 * Pure derivation for the titlebar default-model chip (#1123 M4).
 *
 * Extracted from `App.svelte` so the loading-gate is unit-testable: inline in a
 * component `$derived` there is no reachable test, and the whole point of M4's
 * chip change — that the chip stays hidden while a registry load is in flight,
 * killing the empty→label pop on a lit boot — can only be proven against a pure
 * function.
 */

/** The minimal fields the chip needs from a registry entry. */
export interface ChipModelEntry {
  id: string;
  displayName: string;
}

export interface DefaultModelChipInput {
  defaultModelId: string | null;
  models: readonly ChipModelEntry[];
  loading: boolean;
}

/**
 * The label for the titlebar default-model chip, or `null` when the chip must
 * be hidden: while a load is in flight (avoids the empty→label pop), when there
 * is no configured default, or when the default id resolves to no entry.
 */
export function resolveDefaultModelChip({
  defaultModelId,
  models,
  loading,
}: DefaultModelChipInput): string | null {
  if (loading) return null;
  if (defaultModelId === null) return null;
  const entry = models.find((m) => m.id === defaultModelId);
  return entry ? entry.displayName : null;
}
