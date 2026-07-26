import path from "path";
import { TRIAL_DAYS } from "../../shared/constants.js";

/** Trial length in days. Defined in `shared/constants.ts` so client-side copy
 *  ("N of 14 days left") can't drift from the clock the server enforces. */
export { TRIAL_DAYS };
/** Trial length in milliseconds — epoch math only, never calendar arithmetic. */
export const TRIAL_MS = TRIAL_DAYS * 86_400_000;

/** Path to the activated signed-license blob. */
export const licenseFilePath = (appDataDir: string): string =>
  path.join(appDataDir, "license.json");

/** Path to the soft on-device trial clock. */
export const trialFilePath = (appDataDir: string): string => path.join(appDataDir, "trial.json");
