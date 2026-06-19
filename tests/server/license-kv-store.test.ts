import { describe, expect, it, vi } from "vitest";
import {
  kvValueUrl,
  readKvConfig,
  writeLicenseEntitlement,
} from "../../src/server/license/kv-store.js";

const CONFIG = { accountId: "acct", namespaceId: "ns", apiToken: "tok" };

describe("readKvConfig", () => {
  it("returns null when any var is missing", () => {
    expect(readKvConfig({})).toBeNull();
    expect(readKvConfig({ TANDEM_CF_ACCOUNT_ID: "a", TANDEM_CF_KV_NAMESPACE_ID: "n" })).toBeNull();
  });

  it("returns the config when all three vars are present", () => {
    expect(
      readKvConfig({
        TANDEM_CF_ACCOUNT_ID: "a",
        TANDEM_CF_KV_NAMESPACE_ID: "n",
        TANDEM_CF_KV_API_TOKEN: "t",
      }),
    ).toEqual({ accountId: "a", namespaceId: "n", apiToken: "t" });
  });
});

describe("kvValueUrl", () => {
  it("builds the Cloudflare KV REST PUT URL with an encoded key", () => {
    expect(kvValueUrl(CONFIG, "lic 1")).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct/storage/kv/namespaces/ns/values/lic%201",
    );
  });
});

describe("writeLicenseEntitlement", () => {
  const entry = { updateWindowEnd: null, status: "grandfathered", version: "1.0" };

  it("skips (never calls fetch) when KV is not configured", async () => {
    const fetchFn = vi.fn();
    const r = await writeLicenseEntitlement("lic-1", entry, { config: null, fetchFn });
    expect(r).toEqual({ ok: false, skipped: true });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("PUTs the entitlement with the bearer token and JSON body", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true }) as Response);
    const r = await writeLicenseEntitlement("lic-1", entry, { config: CONFIG, fetchFn });
    expect(r.ok).toBe(true);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain("/values/lic-1");
    expect((init as RequestInit).method).toBe("PUT");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(entry);
  });

  it("returns ok:false on a non-2xx response (non-fatal) AND logs loudly with the id only", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500 }) as Response);
    expect(
      await writeLicenseEntitlement("lic-1", { ...entry, email: "buyer@example.com" } as never, {
        config: CONFIG,
        fetchFn,
      }),
    ).toEqual({ ok: false });
    // A dropped entitlement write is observable (the only signal — the caller
    // fires it with `void`), and the buyer email never reaches the log.
    expect(spy).toHaveBeenCalled();
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).toContain("lic-1");
    expect(logged).not.toContain("buyer@example.com");
    spy.mockRestore();
  });

  it("never throws when fetch rejects — returns ok:false AND logs the id only", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      writeLicenseEntitlement("lic-1", entry, { config: CONFIG, fetchFn }),
    ).resolves.toEqual({ ok: false });
    expect(spy).toHaveBeenCalled();
    expect(JSON.stringify(spy.mock.calls)).toContain("lic-1");
    spy.mockRestore();
  });

  it("skip path logs that it skipped (observable non-config)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await writeLicenseEntitlement("lic-1", entry, { config: null, fetchFn: vi.fn() });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
