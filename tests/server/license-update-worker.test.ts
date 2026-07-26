import { describe, expect, it, vi } from "vitest";
import {
  handleUpdateRequest,
  type KvGetter,
  LICENSE_HEADER,
  type LogEntry,
} from "../../infra/license-update-worker/src/worker.js";
import type { LicenseEntitlement } from "../../src/server/license/license-types.js";

const MANIFEST = '{"version":"1.2.3","platforms":{}}';
const URL_LATEST = "https://example.com/latest.json";
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function kvWith(map: Record<string, string>): KvGetter {
  return { get: async (k) => (k in map ? map[k] : null) };
}

function req(lid?: string): Request {
  const headers = new Headers();
  if (lid) headers.set(LICENSE_HEADER, lid);
  return new Request(URL_LATEST, { headers });
}

function okFetch(): typeof fetch {
  return vi.fn(async () => new Response(MANIFEST, { status: 200 })) as unknown as typeof fetch;
}

describe("handleUpdateRequest (license-update Worker)", () => {
  it("serves the manifest to an entitled, in-window license", async () => {
    const fetchFn = okFetch();
    const res = await handleUpdateRequest(req("lic-1"), {
      kv: kvWith({
        "lic-1": JSON.stringify({ updateWindowEnd: new Date(NOW + DAY).toISOString() }),
      }),
      latestJsonUrl: URL_LATEST,
      fetchFn,
      now: () => NOW,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(MANIFEST);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("serves a grandfathered license (updateWindowEnd: null) forever", async () => {
    const res = await handleUpdateRequest(req("lic-gf"), {
      kv: kvWith({ "lic-gf": JSON.stringify({ updateWindowEnd: null }) }),
      latestJsonUrl: URL_LATEST,
      fetchFn: okFetch(),
      now: () => NOW + 9999 * DAY,
    });
    expect(res.status).toBe(200);
  });

  it("returns 204 no-update for an unknown id WITHOUT fetching upstream", async () => {
    const fetchFn = okFetch();
    const res = await handleUpdateRequest(req("nope"), {
      kv: kvWith({}),
      latestJsonUrl: URL_LATEST,
      fetchFn,
      now: () => NOW,
    });
    expect(res.status).toBe(204);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns 204 no-update for an expired window WITHOUT fetching upstream", async () => {
    const fetchFn = okFetch();
    const res = await handleUpdateRequest(req("lic-old"), {
      kv: kvWith({
        "lic-old": JSON.stringify({ updateWindowEnd: new Date(NOW - DAY).toISOString() }),
      }),
      latestJsonUrl: URL_LATEST,
      fetchFn,
      now: () => NOW,
    });
    expect(res.status).toBe(204);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns 204 when the license header is absent", async () => {
    const res = await handleUpdateRequest(req(), {
      kv: kvWith({ "lic-1": JSON.stringify({ updateWindowEnd: null }) }),
      latestJsonUrl: URL_LATEST,
      fetchFn: okFetch(),
      now: () => NOW,
    });
    expect(res.status).toBe(204);
  });

  it("unknown-id, expired-window, AND malformed-entry responses are byte-identical (no oracle)", async () => {
    const deps = { latestJsonUrl: URL_LATEST, fetchFn: okFetch(), now: () => NOW };
    const unknown = await handleUpdateRequest(req("nope"), { ...deps, kv: kvWith({}) });
    const expired = await handleUpdateRequest(req("old"), {
      ...deps,
      kv: kvWith({ old: JSON.stringify({ updateWindowEnd: new Date(NOW - DAY).toISOString() }) }),
    });
    // Third rejection reason: a corrupt KV entry (JSON.parse throws → reject()).
    // It must be indistinguishable from a non-existent id (no "does this id have
    // a broken entry" oracle).
    const malformed = await handleUpdateRequest(req("broken"), {
      ...deps,
      kv: kvWith({ broken: "{not json" }),
    });
    expect(unknown.status).toBe(expired.status);
    expect(expired.status).toBe(malformed.status);
    const u = await unknown.text();
    expect(await expired.text()).toBe(u);
    expect(await malformed.text()).toBe(u); // all empty
  });

  it("logs only { result, ts } — never the license id", async () => {
    const log = vi.fn();
    await handleUpdateRequest(req("secret-license-id"), {
      kv: kvWith({ "secret-license-id": JSON.stringify({ updateWindowEnd: null }) }),
      latestJsonUrl: URL_LATEST,
      fetchFn: okFetch(),
      now: () => NOW,
      log,
    });
    expect(log).toHaveBeenCalledWith({ result: "served", ts: NOW });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-license-id");
  });

  it("degrades to 204 when the upstream manifest fetch returns non-ok", async () => {
    const fetchFn = vi.fn(
      async () => new Response("nope", { status: 500 }),
    ) as unknown as typeof fetch;
    const res = await handleUpdateRequest(req("lic-1"), {
      kv: kvWith({ "lic-1": JSON.stringify({ updateWindowEnd: null }) }),
      latestJsonUrl: URL_LATEST,
      fetchFn,
      now: () => NOW,
    });
    expect(res.status).toBe(204);
  });

  it("degrades to a byte-identical 204 when the upstream fetch THROWS (no 500 oracle)", async () => {
    // A thrown fetch (DNS/reset/timeout) is reached ONLY for an entitled, in-window
    // id. If it escaped as a CF 500, the 500-vs-204 split would be an entitlement
    // oracle. It must collapse to the same 204 as every other rejection (#1116 H2).
    const throwingFetch = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const res = await handleUpdateRequest(req("lic-1"), {
      kv: kvWith({ "lic-1": JSON.stringify({ updateWindowEnd: null }) }),
      latestJsonUrl: URL_LATEST,
      fetchFn: throwingFetch,
      now: () => NOW,
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe(""); // byte-identical to the unknown-id 204
    const unknown = await handleUpdateRequest(req("nope"), {
      kv: kvWith({}),
      latestJsonUrl: URL_LATEST,
      fetchFn: okFetch(),
      now: () => NOW,
    });
    expect(res.status).toBe(unknown.status);
  });

  it("reads the canonical writer entitlement shape (kv-store ↔ worker parity)", async () => {
    // The writer (`writeLicenseEntitlement`) emits `LicenseEntitlement`; the
    // Worker keeps a separate local reader view. Feed a value of the canonical
    // writer type and assert the Worker reads it as entitled — a drift guard
    // without coupling the two builds.
    const entitlement: LicenseEntitlement = {
      updateWindowEnd: new Date(NOW + DAY).toISOString(),
      status: "personal",
      version: "1.0",
    };
    const res = await handleUpdateRequest(req("lic-1"), {
      kv: kvWith({ "lic-1": JSON.stringify(entitlement) }),
      latestJsonUrl: URL_LATEST,
      fetchFn: okFetch(),
      now: () => NOW,
    });
    expect(res.status).toBe(200);
  });
});

/**
 * The no-update `reason` is the ONLY detector for the worst failure mode in the
 * licensing system: a license with no KV entitlement is served 204, the Tauri
 * updater early-returns `Ok(None)`, and the app reports "You're up to date"
 * forever while starved. From every layer above this Worker, that is
 * indistinguishable from health.
 */
describe("no-update reasons (the silent-failure detector)", () => {
  async function reasonFor(
    lid: string | undefined,
    kv: Record<string, string>,
    fetchFn: typeof fetch = okFetch(),
  ): Promise<{ status: number; body: string; reason: string | undefined }> {
    const entries: LogEntry[] = [];
    const res = await handleUpdateRequest(req(lid), {
      kv: kvWith(kv),
      latestJsonUrl: URL_LATEST,
      fetchFn,
      now: () => NOW,
      log: (e) => entries.push(e),
    });
    return { status: res.status, body: await res.text(), reason: entries.at(-1)?.reason };
  }

  const IN_WINDOW = JSON.stringify({ updateWindowEnd: new Date(NOW + DAY).toISOString() });

  it("no-header — an unlicensed/public updater client", async () => {
    expect((await reasonFor(undefined, {})).reason).toBe("no-header");
  });

  it("unknown-id — a license with NO entitlement. This is the alertable one", async () => {
    expect((await reasonFor("lic-missing", {})).reason).toBe("unknown-id");
  });

  it("unparseable — a corrupt KV value", async () => {
    expect((await reasonFor("lic-1", { "lic-1": "not json" })).reason).toBe("unparseable");
  });

  it("expired — entitled but past the update window (expected and benign)", async () => {
    const past = JSON.stringify({ updateWindowEnd: new Date(NOW - DAY).toISOString() });
    expect((await reasonFor("lic-1", { "lic-1": past })).reason).toBe("expired");
  });

  it("upstream — entitled and in-window, but the manifest fetch failed", async () => {
    const boom = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    expect((await reasonFor("lic-1", { "lic-1": IN_WINDOW }, boom)).reason).toBe("upstream");
  });

  it("logs a reason on `served` too — as undefined, not a value", async () => {
    const entries: LogEntry[] = [];
    await handleUpdateRequest(req("lic-1"), {
      kv: kvWith({ "lic-1": IN_WINDOW }),
      latestJsonUrl: URL_LATEST,
      fetchFn: okFetch(),
      now: () => NOW,
      log: (e) => entries.push(e),
    });
    expect(entries.at(-1)).toMatchObject({ result: "served" });
    expect(entries.at(-1)?.reason).toBeUndefined();
  });

  it("NEVER leaks the reason to the caller — all rejections stay byte-identical", async () => {
    // The privacy invariant this Worker exists to hold: unknown-id and expired
    // must not be distinguishable from outside, or the endpoint becomes an
    // entitlement oracle. The reason is an operator-side log field only.
    const boom = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const past = JSON.stringify({ updateWindowEnd: new Date(NOW - DAY).toISOString() });
    const results = [
      await reasonFor(undefined, {}),
      await reasonFor("lic-missing", {}),
      await reasonFor("lic-1", { "lic-1": "not json" }),
      await reasonFor("lic-1", { "lic-1": past }),
      await reasonFor("lic-1", { "lic-1": IN_WINDOW }, boom),
    ];
    // Five distinct reasons...
    expect(new Set(results.map((r) => r.reason)).size).toBe(5);
    // ...one indistinguishable response.
    expect(new Set(results.map((r) => `${r.status}:${r.body}`)).size).toBe(1);
    expect(results[0].status).toBe(204);
  });

  it("logs no license id — a per-customer update log would be telemetry", async () => {
    const entries: LogEntry[] = [];
    await handleUpdateRequest(req("lic-secret-id"), {
      kv: kvWith({}),
      latestJsonUrl: URL_LATEST,
      fetchFn: okFetch(),
      now: () => NOW,
      log: (e) => entries.push(e),
    });
    expect(JSON.stringify(entries)).not.toContain("lic-secret-id");
  });
});
