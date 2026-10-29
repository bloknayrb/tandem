/**
 * Precedence tests for `resolveInitialLauncherReason` (#1236, #1823).
 *
 * The ordering here is load-bearing, not cosmetic — see the doc comment on the
 * function itself. Both env rules it encodes have a security or recovery
 * consequence if inverted, and the transport arm (#1823) is what keeps an
 * ordinary HTTP boot from reading as "this runtime has no launcher".
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// NB: imported from its own module, NOT from `src/server/index.ts`. Importing
// that file executes `main()`, which calls `freePort()` and would kill whatever
// holds :3478/:3479 — i.e. the developer's running dev server.
import { resolveInitialLauncherReason } from "../../src/server/launcher/initial-reason.js";
import {
  isPromotableByStartRoute,
  isTransientlyUnavailable,
  type LauncherUnavailableReason,
} from "../../src/shared/launcher/contract.js";

const TRANSPORTS = ["http", "stdio"] as const;

describe("resolveInitialLauncherReason", () => {
  it("reads server-starting under HTTP with a clean environment (#1823)", () => {
    expect(resolveInitialLauncherReason({}, "http")).toBe("server-starting");
  });

  it("reads stdio-mode under stdio, and under any other transport string", () => {
    expect(resolveInitialLauncherReason({}, "stdio")).toBe("stdio-mode");
    // index.ts starts a launcher only under `=== "http"`, so anything else
    // really has none.
    expect(resolveInitialLauncherReason({}, "HTTP ")).toBe("stdio-mode");
    expect(resolveInitialLauncherReason({}, "")).toBe("stdio-mode");
  });

  for (const transport of TRANSPORTS) {
    it(`reports disabled-by-env for the operator kill switch (${transport})`, () => {
      expect(resolveInitialLauncherReason({ TANDEM_DISABLE_LAUNCHER: "1" }, transport)).toBe(
        "disabled-by-env",
      );
    });

    it(`lets TANDEM_DISABLE_LAUNCHER outrank the deferral (${transport})`, () => {
      // If the deferral won here, POST /api/launcher/start — which only accepts
      // `deferred-autostart` — would become an HTTP bypass of a kill switch that
      // is otherwise undefeatable remotely.
      expect(
        resolveInitialLauncherReason(
          {
            TANDEM_DISABLE_LAUNCHER: "1",
            TANDEM_DEFER_LAUNCHER: "1",
            TANDEM_TAURI_SIDECAR: "1",
          },
          transport,
        ),
      ).toBe("disabled-by-env");
    });
  }

  it("reports deferred-autostart under the Tauri sidecar, outranking server-starting", () => {
    expect(
      resolveInitialLauncherReason(
        {
          TANDEM_DEFER_LAUNCHER: "1",
          TANDEM_TAURI_SIDECAR: "1",
        },
        "http",
      ),
    ).toBe("deferred-autostart");
  });

  it("ignores TANDEM_DEFER_LAUNCHER when not spawned by the Tauri shell", () => {
    // `tandem start` inherits the shell environment. Without this gate an
    // exported var would permanently kill the auto-launcher on the npm
    // distribution, which has neither a toggle nor a presence trigger to
    // recover with.
    expect(resolveInitialLauncherReason({ TANDEM_DEFER_LAUNCHER: "1" }, "http")).toBe(
      "server-starting",
    );
    expect(
      resolveInitialLauncherReason(
        {
          TANDEM_DEFER_LAUNCHER: "1",
          TANDEM_TAURI_SIDECAR: "0",
        },
        "http",
      ),
    ).toBe("server-starting");
  });

  it('treats any value other than exactly "1" as unset', () => {
    for (const value of ["", "0", "true", "yes"]) {
      expect(
        resolveInitialLauncherReason(
          {
            TANDEM_DEFER_LAUNCHER: value,
            TANDEM_TAURI_SIDECAR: "1",
          },
          "http",
        ),
        `TANDEM_DEFER_LAUNCHER=${value}`,
      ).toBe("server-starting");
    }
  });
});

describe("index.ts resolves the initial reason against its transport (#1823)", () => {
  // Every behavioural test above passes a transport; without this pin a
  // refactor that dropped the argument at the one call site would fail only
  // the typecheck — and only while the parameter stays required.
  it("passes transportMode into the one call", () => {
    const index = fs.readFileSync(
      path.join(import.meta.dirname, "../../src/server/index.ts"),
      "utf8",
    );
    const calls = index.match(/resolveInitialLauncherReason\([^)]*\)/g) ?? [];
    expect(calls).toEqual(["resolveInitialLauncherReason(process.env, transportMode)"]);
    // Declared above the `let` that reads it, so it is defined at that point.
    expect(index.indexOf("const transportMode =")).toBeLessThan(
      index.indexOf("resolveInitialLauncherReason(process.env, transportMode)"),
    );
  });
});

describe("the two launcher-reason predicates (#1823)", () => {
  // A Record so a new reason fails to compile here until someone decides both
  // answers — the start route's gate must never widen by accident (ADR-046 §7).
  const EXPECTED: Record<LauncherUnavailableReason, { transient: boolean; promotable: boolean }> = {
    "stdio-mode": { transient: false, promotable: false },
    "server-starting": { transient: true, promotable: false },
    "disabled-by-env": { transient: false, promotable: false },
    "spawn-failed": { transient: false, promotable: false },
    "deferred-autostart": { transient: true, promotable: true },
    "not-configured": { transient: false, promotable: false },
  };

  for (const [reason, want] of Object.entries(EXPECTED) as [
    LauncherUnavailableReason,
    { transient: boolean; promotable: boolean },
  ][]) {
    it(`${reason}: transient=${want.transient}, promotable=${want.promotable}`, () => {
      expect(isTransientlyUnavailable(reason)).toBe(want.transient);
      expect(isPromotableByStartRoute(reason)).toBe(want.promotable);
    });
  }

  it("the redacted (undefined) reason is neither", () => {
    expect(isTransientlyUnavailable(undefined)).toBe(false);
    expect(isPromotableByStartRoute(undefined)).toBe(false);
  });
});
