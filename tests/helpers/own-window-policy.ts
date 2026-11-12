import {
  type BoundAddress,
  createOwnWindowPolicy,
  type OwnWindowPolicy,
} from "../../src/server/models/own-window.js";

/**
 * The policy of a server that IS the desktop app's sidecar and is not
 * listening: only the three desktop-window origins are Tandem's own window
 * (#2404). For suites whose "own window" request carries `http://tauri.localhost`.
 */
export function desktopSidecarPolicy(allowance: string | null = null): OwnWindowPolicy {
  return createOwnWindowPolicy({ getBound: () => null, allowance, desktop: true });
}

/**
 * The policy of an npm install's server: no desktop window, so the desktop
 * origins are NOT its own. Only `http://127.0.0.1:<bound port>` is.
 */
export function npmServerPolicy(
  bound: BoundAddress | null = null,
  allowance: string | null = null,
): OwnWindowPolicy {
  return createOwnWindowPolicy({ getBound: () => bound, allowance, desktop: false });
}
