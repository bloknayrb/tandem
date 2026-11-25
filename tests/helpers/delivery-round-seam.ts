/**
 * The delivery-round seam as `src/server/index.ts` wires it (#2358, the
 * delivery-rounds PR; ownership design §6.7), for the suites that drive
 * ownership and poll `tandem_checkInbox` (the flip-blocker row "Flag-on
 * suites that drive ownership but read no delivery-round state run with the
 * delivery-round seam unwired", closed by wiring them).
 *
 * Unwired, every poll runs master's one global round, which no flag-on server
 * runs. Wired, a flag-on poll opens and closes keyed rounds (by document, by
 * message), the only combination a real server is in; flag off the seam
 * answers false, so master's round, whatever is wired.
 *
 * {@link expectDeliveryRoundsLive} is the live check: called where a suite
 * polls, it fails when the seam is not what `index.ts` wires (rounds not keyed
 * while the ownership flag is on, or keyed while it is off). It reads the flag
 * only through ownership's own `keyedDeliveryRounds`, the function the seam is
 * wired to, so no test here keys on the flag (`ownership-module-seam.test.ts`).
 */

import { afterEach, beforeEach, expect } from "vitest";
import {
  deliveryRoundsKeyed,
  setDeliveryRoundSeam,
} from "../../src/server/events/delivery-state.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { keyedDeliveryRounds } from "../../src/server/sessions/ownership.js";

/** Install the seam exactly as `index.ts` does at boot. */
export function wireDeliveryRoundSeam(): void {
  setDeliveryRoundSeam({
    keyed: keyedDeliveryRounds,
    isDocumentOpen: (documentId) => getOpenDocs().has(documentId),
  });
}

/**
 * Wire the seam before each test and unwire it after, at a suite file's top
 * level. A suite that builds its world inside a test may call
 * {@link wireDeliveryRoundSeam} again; it is idempotent.
 */
export function useKeyedDeliveryRounds(): void {
  beforeEach(() => {
    wireDeliveryRoundSeam();
  });
  afterEach(() => {
    setDeliveryRoundSeam(undefined);
  });
}

/**
 * The live check: the rounds a poll runs now are keyed exactly when the
 * ownership flag is on, as on a real server.
 */
export function expectDeliveryRoundsLive(): void {
  expect(
    deliveryRoundsKeyed(),
    "delivery rounds are keyed exactly when ownership is on (the seam index.ts wires)",
  ).toBe(keyedDeliveryRounds());
}
