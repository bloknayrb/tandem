/**
 * `scripts/sign-license.ts` — the out-of-band issuance path.
 *
 * The defect this covers (D1): the script used to print a blob and stop. With
 * `--expires` optional, `expiresAt` stayed `null`, which downstream reads as
 * "update window never ends" — so `entitled_license_id()` returns the id,
 * `build_updater()` REPLACES the endpoint list with the license-checked one, KV
 * misses, the Worker returns 204, `tauri-plugin-updater` early-returns
 * `Ok(None)`, and the app says **"You're up to date."** permanently while
 * starved of updates.
 *
 * Both halves are tested here: the expiry default, and the entitlement write.
 */
import { describe, expect, it, vi } from "vitest";
import { resolveExpiresAt } from "../../scripts/sign-license.js";
import { writeLicenseEntitlement } from "../../src/server/license/kv-store.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

describe("resolveExpiresAt", () => {
  it("defaults a personal license to a 365-day update window, NOT null", () => {
    // The whole point: an omitted --expires must not mean "forever".
    const got = resolveExpiresAt(undefined, "personal", NOW);
    expect(got).not.toBeNull();
    expect(got).toBe(new Date("2027-01-01T00:00:00.000Z").toISOString());
  });

  it("treats a bare `--expires` flag (no value) as omitted", () => {
    // The arg parser stores a valueless flag as the string "true".
    expect(resolveExpiresAt("true", "personal", NOW)).toBe(
      resolveExpiresAt(undefined, "personal", NOW),
    );
  });

  it("gives a grandfathered license a null window — it never expires", () => {
    // Matches the issuance Worker: `updateWindowEnd = grandfathered ? null : …`.
    expect(resolveExpiresAt(undefined, "grandfathered", NOW)).toBeNull();
  });

  it("honours an explicit day count", () => {
    expect(resolveExpiresAt("30", "personal", NOW)).toBe(
      new Date("2026-01-31T00:00:00.000Z").toISOString(),
    );
  });

  it("honours an explicit `never`, including for a paid type", () => {
    expect(resolveExpiresAt("never", "personal", NOW)).toBeNull();
  });

  it("rejects nonsense rather than silently falling back to null", () => {
    // Silently defaulting to null here would reintroduce D1 through the back door.
    expect(() => resolveExpiresAt("soon", "personal", NOW)).toThrow(RangeError);
    expect(() => resolveExpiresAt("0", "personal", NOW)).toThrow(RangeError);
    expect(() => resolveExpiresAt("-5", "personal", NOW)).toThrow(RangeError);
  });
});

describe("writeLicenseEntitlement (the script's KV write)", () => {
  const config = { accountId: "acc", namespaceId: "ns", apiToken: "tok" };

  it("PUTs the entitlement under the licenseId", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    const res = await writeLicenseEntitlement(
      "lic-123",
      { updateWindowEnd: "2027-01-01T00:00:00.000Z", status: "personal", version: "1.0" },
      { config, fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(res.ok).toBe(true);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/storage/kv/namespaces/ns/values/lic-123");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      updateWindowEnd: "2027-01-01T00:00:00.000Z",
      status: "personal",
      version: "1.0",
    });
  });

  it("reports `skipped` when KV is unconfigured — the script must exit non-zero", async () => {
    const res = await writeLicenseEntitlement(
      "lic-123",
      { updateWindowEnd: null, status: "grandfathered", version: "1.0" },
      { config: null },
    );
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe(true);
  });

  it("reports failure (never throws) on an upstream error", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 403 }));
    const res = await writeLicenseEntitlement(
      "lic-123",
      { updateWindowEnd: null, status: "personal", version: "1.0" },
      { config, fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(res.ok).toBe(false);
    expect(res.skipped).toBeUndefined();
  });

  it("never puts the licensee's email in the KV value", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    await writeLicenseEntitlement(
      "lic-123",
      { updateWindowEnd: null, status: "personal", version: "1.0" },
      { config, fetchFn: fetchFn as unknown as typeof fetch },
    );
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body as string).not.toMatch(/@/);
  });
});
