/**
 * Is this page one the server lets change the local-model settings (#2404)?
 *
 * `POST /api/models` and `POST /api/models/local-settings` accept a request
 * only from Tandem's own window: the page Tandem's own server serves
 * (`http://127.0.0.1:<port>`) or the desktop app's window. A page anywhere else
 * is refused — and a page at `http://localhost:<port>` cannot even READ the
 * refusal, because the server's CORS allowlist has excluded `localhost` since
 * #477. So the client decides for itself, from its own page origin, instead of
 * waiting for an answer that may never be readable.
 *
 * Three answers:
 *  - `own`: the origin is exactly one the server accepts;
 *  - `foreign`: it is not, and the server's answer could not change that. The
 *    Models tab says so once, at the top, and shows its controls as unavailable;
 *  - `unknown`: another `127.0.0.1` port (the Vite dev client, a test harness)
 *    or a desktop window whose origin string is not one of the expected forms.
 *    The server decides: it accepts such a page only when started with
 *    `TANDEM_MODELS_DEV_ORIGIN` naming it, which this page cannot see. Its
 *    refusal IS readable there, and the first one switches the tab to the same
 *    unavailable state.
 *
 * Pure: no `window`, no store. Compared as raw strings — `new URL(
 * "tauri://localhost").origin` is the string "null".
 */

import { TAURI_HOSTNAME, TAURI_LINUX_ORIGIN } from "../../shared/constants";
import {
  isLoopbackDevOrigin,
  MODELS_DEV_ORIGIN_ENV,
  OWN_WINDOW_ONLY_MESSAGE,
} from "../../shared/models/contract";

export type ModelsWriteAccess = "own" | "unknown" | "foreign";

const TAURI_ORIGINS: readonly string[] = [
  `http://${TAURI_HOSTNAME}`,
  `https://${TAURI_HOSTNAME}`,
  TAURI_LINUX_ORIGIN,
];

const LOOPBACK_PAGE = /^http:\/\/127\.0\.0\.1(:\d{1,5})?$/;

export function modelsWriteAccess(
  /** `window.location.origin`, or null where there is no window. */
  pageOrigin: string | null,
  /** Is this the desktop app's window? */
  isTauri: boolean,
  /** The address Tandem's own server serves its page at. */
  ownAddress: string,
): ModelsWriteAccess {
  if (pageOrigin === null) return "unknown";
  if (pageOrigin === ownAddress || TAURI_ORIGINS.includes(pageOrigin)) return "own";
  if (isTauri || LOOPBACK_PAGE.test(pageOrigin)) return "unknown";
  return "foreign";
}

const BASE_NOTICE = OWN_WINDOW_ONLY_MESSAGE.replace("Local-model settings", "These settings");

/**
 * What the Models tab says when the settings cannot be changed from this page.
 *  - A page that is plainly somewhere else is told where to go.
 *  - A page on another `127.0.0.1` port that the server refused is a
 *    development setup, and is told about the variable — but ONLY when its
 *    origin has the exact form the server accepts for that variable. Suggesting
 *    a value the server would refuse (`http://127.0.0.1` on port 80, or the
 *    string "null") would send the developer in a circle.
 *  - Anything else that was refused (a desktop window with an unexpected origin
 *    string, or Tandem's own address refused all the same) gets the plain
 *    sentence: there is nothing more specific that is known to be true.
 */
export function ownWindowNotice(
  access: ModelsWriteAccess,
  pageOrigin: string | null,
  ownAddress: string,
): string {
  if (access === "foreign") {
    return `${BASE_NOTICE} Open Tandem at ${ownAddress}, or use the Tandem desktop app.`;
  }
  if (
    access === "unknown" &&
    pageOrigin !== null &&
    pageOrigin !== ownAddress &&
    isLoopbackDevOrigin(pageOrigin)
  ) {
    return `${BASE_NOTICE} This page is served from ${pageOrigin}. In a development setup, start Tandem's server with ${MODELS_DEV_ORIGIN_ENV}=${pageOrigin}, then reload this page.`;
  }
  return BASE_NOTICE;
}
