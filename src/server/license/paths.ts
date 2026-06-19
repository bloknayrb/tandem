import path from "path";

/** Trial length in days (ADR-040 §5: under the 30-day BUSL eval ceiling). */
export const TRIAL_DAYS = 14;
/** Trial length in milliseconds — epoch math only, never calendar arithmetic. */
export const TRIAL_MS = TRIAL_DAYS * 86_400_000;

/** Path to the activated signed-license blob. */
export const licenseFilePath = (appDataDir: string): string =>
  path.join(appDataDir, "license.json");

/** Path to the soft on-device trial clock. */
export const trialFilePath = (appDataDir: string): string => path.join(appDataDir, "trial.json");
