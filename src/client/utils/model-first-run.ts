/**
 * When the first-run "Add a local model (optional)" window is offered (#1123,
 * ADR-039 item 21, as amended by Bryan's pick W1 of 2026-11-17: "Cheaper: tied
 * to the setup wizard").
 *
 * The decision is made ONCE, when the integration wizard closes (App's
 * `closeIntegrationWizard`), and never again in that page: once offered, the
 * window stays until its own close, whatever the model list does. Both helpers
 * here are pure; App captures the wizard's state at the top of its close
 * handler and calls `shouldOfferModelPicker` after its writes.
 *
 * DARK: the caller leads with `BYO_MODELS_ENABLED &&`, so nothing here runs
 * while the flag is off.
 */
import type { ApplyItemResult } from "../../shared/integrations/contract.js";

/** Why the integration wizard closed, as it tells App. */
export type WizardCloseReason = "claude-set-up" | "other";

/** The fields of a wizard pick the close reason reads. */
interface PickedKind {
  id: string;
  config: { kind: string };
}

/**
 * "claude-set-up" exactly when the wizard is on its Done screen and at least
 * one result row is "applied" for a Claude Code or Claude Desktop pick (joined
 * by id, as the Done screen's labels are); anything else — another step, only
 * other MCP clients, a Claude row skipped or failed — is "other". The wizard
 * computes it BEFORE its `reset()` clears all three inputs.
 */
export function wizardCloseReason(
  step: string,
  applyResults: readonly ApplyItemResult[],
  picked: readonly PickedKind[],
): WizardCloseReason {
  if (step !== "done") return "other";
  const claudeApplied = applyResults.some((r) => {
    if (r.status !== "applied") return false;
    const kind = picked.find((p) => p.id === r.id)?.config.kind;
    return kind === "claude-code" || kind === "claude-desktop";
  });
  return claudeApplied ? "claude-set-up" : "other";
}

export interface ModelPickerOfferInput {
  /** The wizard's own close reason. */
  reason: WizardCloseReason;
  /** The wizard opened by itself because setup was needed (captured at the
   *  top of the close handler, before its writes). */
  autoOpened: boolean;
  /** The wizard was opened or taken over by hand (captured likewise). */
  manuallyReopened: boolean;
  /** It was the v1.0 walkthrough (captured likewise). */
  walkthrough: boolean;
  /** The model list has loaded in this page. */
  loaded: boolean;
  /** Saved models of any provider (RW-1: any saved model, not only a default). */
  savedModelCount: number;
  /** Read AFTER the close handler's writes, so the closing wizard reads false. */
  wizardShowing: boolean;
  settingsOpen: boolean;
  helpOpen: boolean;
  paletteOpen: boolean;
  fileOpenDialogOpen: boolean;
  /** `tandem:modelPickerDismissed` is "1" (or its in-memory copy). */
  dismissed: boolean;
  /**
   * This page is not Tandem's own window, by its own origin (#2404): the
   * server refuses every model write from it, so the window would only collect
   * a form it cannot save. Static for a page load.
   */
  pageCannotChangeModels: boolean;
}

export function shouldOfferModelPicker(i: ModelPickerOfferInput): boolean {
  if (i.reason !== "claude-set-up") return false;
  if (!i.autoOpened || i.manuallyReopened || i.walkthrough) return false;
  if (!i.loaded || i.savedModelCount > 0) return false;
  if (i.wizardShowing || i.settingsOpen || i.helpOpen || i.paletteOpen || i.fileOpenDialogOpen) {
    return false;
  }
  if (i.dismissed) return false;
  if (i.pageCannotChangeModels) return false;
  return true;
}
