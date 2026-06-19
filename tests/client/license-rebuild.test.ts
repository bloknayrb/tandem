import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #1116 Surface A engagement guard. The mid-session restricted/licensed
 * transition MUST re-run the server's `onAuthenticate` on already-open docs.
 * In @hocuspocus/provider 3.x `connect()`/`reconnect()` are no-ops on a live
 * socket, so the ONLY way to force re-auth is teardown + re-bootstrap (fresh
 * sockets). The original implementation regressed exactly here — and a future
 * "simplify it back to provider.connect()" would compile, pass every existing
 * test, and silently stop engaging the gate.
 *
 * The function closes over the whole yjsSync provider machinery (Y.Docs,
 * HocuspocusProviders, generation), so a true behavioural test would mean
 * mounting all of it. This is the proportionate guard the crdt reviewer endorsed:
 * assert the MECHANISM in the method body (teardown+rebuild, never connect()).
 */

const SRC = readFileSync(
  join(import.meta.dirname, "../../src/client/hooks/yjsSync.svelte.ts"),
  "utf-8",
);

describe("rebuildForLicenseChange mechanism (#1116)", () => {
  const idx = SRC.indexOf("rebuildForLicenseChange()");
  // Slice FORWARD from the method name so the explanatory comment ABOVE it
  // (which mentions connect/reconnect/disconnect) is excluded from the body scan.
  const body = SRC.slice(idx, idx + 400);

  it("the method exists", () => {
    expect(idx).toBeGreaterThan(-1);
  });

  it("forces re-auth via teardown + re-bootstrap, not connect()/reconnect()", () => {
    expect(body).toContain("teardownAllTabs");
    expect(body).toContain("startBootstrap");
    // A live-socket connect()/reconnect() would be a no-op → the gate never
    // re-evaluates. It must NOT be the mechanism.
    expect(body).not.toMatch(/\.(connect|reconnect)\(/);
  });
});
