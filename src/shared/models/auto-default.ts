/**
 * The automatic-default rule for the Models registry (#1123).
 *
 * One definition, shared: the client's Models store uses it to mark the
 * default when a write would otherwise leave none, and the server uses it to
 * decide whether a write's `autoDefaultId` marker is exactly what the rule
 * would have produced (`autoDefaultHonoured` in the local-model collaborator).
 * Pure, and imports only the wire contract, so both sides can load it.
 */
import { isLocalProvider, type ModelsEntry } from "./contract.js";

/**
 * The entry the rule makes the default, or `null` when it makes none.
 *
 * - A default that names an entry in `entries` (local, cloud or switched off)
 *   is left alone: `null`.
 * - Otherwise (no default, or one naming no entry) the one entry that is
 *   enabled and on a local provider; `null` when there is none, or several.
 */
export function autoDefaultFor(
  entries: readonly Pick<ModelsEntry, "id" | "provider" | "enabled">[],
  defaultModelId: string | null,
): string | null {
  if (defaultModelId !== null && entries.some((e) => e.id === defaultModelId)) return null;
  const candidates = entries.filter((e) => e.enabled && isLocalProvider(e.provider));
  return candidates.length === 1 ? candidates[0].id : null;
}
