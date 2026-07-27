/**
 * Precedence tests for `resolveInitialLauncherReason` (#1236).
 *
 * The ordering here is load-bearing, not cosmetic — see the doc comment on the
 * function itself. Both rules it encodes have a security or recovery
 * consequence if inverted.
 */

import { describe, expect, it } from "vitest";

// NB: imported from its own module, NOT from `src/server/index.ts`. Importing
// that file executes `main()`, which calls `freePort()` and would kill whatever
// holds :3478/:3479 — i.e. the developer's running dev server.
import { resolveInitialLauncherReason } from "../../src/server/launcher/initial-reason.js";

describe("resolveInitialLauncherReason", () => {
  it("defaults to stdio-mode with a clean environment", () => {
    expect(resolveInitialLauncherReason({})).toBe("stdio-mode");
  });

  it("reports disabled-by-env for the operator kill switch", () => {
    expect(resolveInitialLauncherReason({ TANDEM_DISABLE_LAUNCHER: "1" })).toBe("disabled-by-env");
  });

  it("reports deferred-autostart under the Tauri sidecar", () => {
    expect(
      resolveInitialLauncherReason({
        TANDEM_DEFER_LAUNCHER: "1",
        TANDEM_TAURI_SIDECAR: "1",
      }),
    ).toBe("deferred-autostart");
  });

  it("lets TANDEM_DISABLE_LAUNCHER outrank the deferral", () => {
    // If the deferral won here, POST /api/launcher/start — which only accepts
    // `deferred-autostart` — would become an HTTP bypass of a kill switch that
    // is otherwise undefeatable remotely.
    expect(
      resolveInitialLauncherReason({
        TANDEM_DISABLE_LAUNCHER: "1",
        TANDEM_DEFER_LAUNCHER: "1",
        TANDEM_TAURI_SIDECAR: "1",
      }),
    ).toBe("disabled-by-env");
  });

  it("ignores TANDEM_DEFER_LAUNCHER when not spawned by the Tauri shell", () => {
    // `tandem start` inherits the shell environment. Without this gate an
    // exported var would permanently kill the auto-launcher on the npm
    // distribution, which has neither a toggle nor a presence trigger to
    // recover with.
    expect(resolveInitialLauncherReason({ TANDEM_DEFER_LAUNCHER: "1" })).toBe("stdio-mode");
    expect(
      resolveInitialLauncherReason({
        TANDEM_DEFER_LAUNCHER: "1",
        TANDEM_TAURI_SIDECAR: "0",
      }),
    ).toBe("stdio-mode");
  });

  it('treats any value other than exactly "1" as unset', () => {
    for (const value of ["", "0", "true", "yes"]) {
      expect(
        resolveInitialLauncherReason({
          TANDEM_DEFER_LAUNCHER: value,
          TANDEM_TAURI_SIDECAR: "1",
        }),
        `TANDEM_DEFER_LAUNCHER=${value}`,
      ).toBe("stdio-mode");
    }
  });
});
