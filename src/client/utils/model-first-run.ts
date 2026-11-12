/**
 * Pure predicate for whether the first-run model picker should show (#1123 M4).
 *
 * Extracted from `App.svelte` and — deliberately — takes NO tutorial input. M2b
 * mounted the picker by borrowing `tutorial.tutorialActive` as its existence
 * condition, which had two edges: a user with no/completed tutorial never saw
 * the picker, and a tutorial *replay* re-summoned it. Keying on the model
 * registry's own state instead (is a default configured yet?) decouples the two
 * concerns; the absence of a tutorial argument here is the structural proof.
 *
 * DARK: the caller leads with `BYO_MODELS_ENABLED &&` so the picker derived
 * short-circuits (and the registry reads below never evaluate) while dark — the
 * same convention `resolveDefaultModelChip` uses, so this predicate carries no
 * redundant build-flag arg of its own.
 */
export interface ModelFirstRunInput {
  /** The integration wizard is showing — it takes first-run precedence. */
  wizardShowing: boolean;
  /** The registry has a resolvable default model → setup already done. */
  hasConfiguredDefault: boolean;
  /** The user already skipped/completed the picker (persisted across launches). */
  dismissed: boolean;
  /** A registry load is in flight — wait rather than flash the picker. */
  loading: boolean;
  /**
   * This page is not Tandem's own window, by its own origin (#2404): the
   * server refuses every model write from it, so a picker would only collect
   * a form it cannot save. The Models tab says where to go instead. Static for
   * a page load, so it only decides whether the picker OPENS.
   */
  pageCannotChangeModels: boolean;
}

export function resolveModelFirstRunNeeded({
  wizardShowing,
  hasConfiguredDefault,
  dismissed,
  loading,
  pageCannotChangeModels,
}: ModelFirstRunInput): boolean {
  if (pageCannotChangeModels) return false;
  if (wizardShowing) return false;
  if (loading) return false;
  if (hasConfiguredDefault) return false;
  if (dismissed) return false;
  return true;
}
