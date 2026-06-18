import { describe, expect, it, vi } from "vitest";
import {
  handleUpdateRequest,
  type KvGetter,
  LICENSE_HEADER,
} from "../../infra/license-update-worker/src/worker.js";

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

  it("unknown-id and expired-window responses are byte-identical (no oracle)", async () => {
    const deps = { latestJsonUrl: URL_LATEST, fetchFn: okFetch(), now: () => NOW };
    const unknown = await handleUpdateRequest(req("nope"), { ...deps, kv: kvWith({}) });
    const expired = await handleUpdateRequest(req("old"), {
      ...deps,
      kv: kvWith({ old: JSON.stringify({ updateWindowEnd: new Date(NOW - DAY).toISOString() }) }),
    });
    expect(unknown.status).toBe(expired.status);
    expect(await unknown.text()).toBe(await expired.text()); // both empty
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

  it("degrades to 204 when the upstream manifest fetch fails", async () => {
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
});
