/**
 * The whole decision for the title bar's model chip (#1123, ADR-039 Label
 * decision L2: "Shown only while chat is set to the local model").
 *
 * The chip shows only while the chat setting (App's `localChatSetting`, the
 * status pill's own input) is `"local"`, the licence does not refuse AI, the
 * saved list has loaded, and the saved Default is an enabled local model; it
 * then names that model, and its hover and accessible text say chat is set to
 * it. Flag-free and pure: App passes `null` to the title bar while
 * `BYO_MODELS_ENABLED` is off, and the chat setting is itself `null` there.
 * Extracted from `App.svelte` so every row is unit-testable.
 */

import { isLocalProvider, type ModelProvider } from "../../shared/models/contract.js";
import type { LocalChatSetting } from "../hooks/useChatAnswerer.svelte.js";

/** The fields the chip needs from a registry entry. */
export interface ChipModelEntry {
  id: string;
  displayName: string;
  provider: ModelProvider;
  enabled: boolean;
}

export interface DefaultModelChipInput {
  defaultModelId: string | null;
  models: readonly ChipModelEntry[];
  /** The Models store has completed a load (never cleared afterwards). */
  loaded: boolean;
  /** App's `localChatSetting`: `null` while chat is not set to the local model. */
  chatSetting: LocalChatSetting | null;
  /** The licence refuses AI (the status pill reads "AI off"). */
  aiOff: boolean;
}

/** The name shown for a local Default whose name is blank (AL-7's fallback). */
export const LOCAL_MODEL_CHIP_FALLBACK = "Local model";

/**
 * The chip's label, or `null` when it is hidden. First match wins:
 * licence refuses AI → hidden (CT-1); chat not set to the local model, or set
 * to it but no local model can be used (`"unusable"`) → hidden; list not yet
 * loaded → hidden (CT-3: a later reload keeps the last values, so no blink);
 * no Default, or one naming no entry → hidden; a cloud or switched-off
 * Default → hidden (DD1); otherwise the Default's name, trimmed, or
 * "Local model" when blank (CT-2).
 */
export function resolveDefaultModelChip({
  defaultModelId,
  models,
  loaded,
  chatSetting,
  aiOff,
}: DefaultModelChipInput): string | null {
  if (aiOff) return null;
  if (chatSetting !== "local") return null;
  if (!loaded) return null;
  if (defaultModelId === null) return null;
  const entry = models.find((m) => m.id === defaultModelId);
  if (!entry) return null;
  if (!isLocalProvider(entry.provider)) return null;
  if (!entry.enabled) return null;
  const name = entry.displayName.trim();
  return name === "" ? LOCAL_MODEL_CHIP_FALLBACK : name;
}
