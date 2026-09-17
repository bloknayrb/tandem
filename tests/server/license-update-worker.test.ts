import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import updateWorker, {
  _resetAlertThrottleForTests,
  handleUpdateRequest,
  isAlertable,
  type KvGetter,
  LICENSE_HEADER,
  type LogEntry,
} from "../../infra/license-update-worker/src/worker.js";
import type { LicenseEntitlement } from "../../src/server/license/license-types.js";

const MANIFEST = '{"version":"1.2.3","platforms":{}}';
const URL_LATEST = "https://example.com/latest.json";
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
/** A license id in the shape both mint sites produce; the alert path's UUID gate
 *  refuses anything else. */
const UUID = "3f7c1e2a-9b4d-4c8e-a1f5-0d6b2e9c7a13";
const HOOK = "https://hooks.example/tandem";

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

/** Drive the PURE handler and report what it answered plus the `reason` it
 *  logged. Shared by every reason/tombstone case — the alerting cases must use
 *  `viaFetch` instead, which drives the real default export. */
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

  it("revoked — the operator's own tombstone (deliberately NOT alertable)", async () => {
    const tomb = JSON.stringify({ updateWindowEnd: null, status: "revoked" });
    expect((await reasonFor("lic-1", { "lic-1": tomb })).reason).toBe("revoked");
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
      // The revocation tombstone (#1786). Byte-identity is the invariant this
      // file is built around, and a new branch outside it is the one way
      // `revoked` could leak an oracle — so the sixth reason joins this set
      // rather than getting its own test.
      await reasonFor("lic-rev", {
        "lic-rev": JSON.stringify({ updateWindowEnd: null, status: "revoked" }),
      }),
      await reasonFor("lic-1", { "lic-1": IN_WINDOW }, boom),
    ];
    // Six distinct reasons...
    expect(new Set(results.map((r) => r.reason)).size).toBe(6);
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

/**
 * The detector (#1786).
 *
 * `reason` alone was never one: `worker.ts` logged it with a bare `console.log`
 * into a Worker with no `[observability]`, so nothing retained it and nothing
 * notified anyone. A rising `unknown-id` count that no human can see is not a
 * signal. These pin the notification half — the retention half is a
 * `wrangler.toml` line and a §8 deployment step, and this suite deliberately
 * asserts nothing about a deployed Worker.
 *
 * TWO STRUCTURAL RULES, neither of which CI can see:
 *
 *  1. Anything asserting about ALERTING must drive `updateWorker.fetch`, never
 *     `reasonFor`/`handleUpdateRequest` — the pure handler holds no alert
 *     plumbing by design, so a "does not alert" assertion written against it is
 *     green whatever the implementation does.
 *  2. Every pair of cases sharing a throttle key sits in its own `it()`.
 *     `shouldAlert` returns false for five minutes on a repeated key and the
 *     reset is a `beforeEach`, so a second case in the same block is suppressed
 *     — "still 204" and "zero webhook POSTs" then both hold trivially.
 */
describe("the silent-no-update detector: alerting (#1786)", () => {
  beforeEach(() => {
    _resetAlertThrottleForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Drive the REAL default export, capturing the webhook POSTs, the log lines
   *  and `ctx.waitUntil`'s promise (which must be awaited before asserting —
   *  the alert is deliberately off the response path). */
  async function viaFetch(
    lid: string | undefined,
    kv: Record<string, string>,
    env: Record<string, unknown> = {},
  ): Promise<{
    status: number;
    body: string;
    posts: [string, RequestInit | undefined][];
    logs: Record<string, unknown>[];
  }> {
    const posts: [string, RequestInit | undefined][] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      posts.push([url, init]);
      // The upstream manifest fetch shares this stub; only the webhook is asserted.
      return new Response(url === HOOK ? "ok" : MANIFEST, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const logs: Record<string, unknown>[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(JSON.parse(line) as Record<string, unknown>);
    });
    const pending: Promise<unknown>[] = [];
    let res: Response;
    try {
      res = await updateWorker.fetch(
        req(lid),
        { LICENSE_KV: kvWith(kv), PUBLIC_LATEST_JSON_URL: URL_LATEST, ...env } as never,
        { waitUntil: (p: Promise<unknown>) => pending.push(p) } as never,
      );
      await Promise.all(pending);
    } finally {
      spy.mockRestore();
    }
    return { status: res.status, body: await res.text(), posts, logs };
  }

  const hookPosts = (posts: [string, RequestInit | undefined][]) =>
    posts.filter(([url]) => url === HOOK);

  it("isAlertable is exactly unknown-id and unparseable", () => {
    expect(isAlertable({ result: "no-update", ts: 0, reason: "unknown-id" })).toBe(true);
    expect(isAlertable({ result: "no-update", ts: 0, reason: "unparseable" })).toBe(true);
    // The discriminating half. `no-header` is most of the traffic; `expired`
    // is every out-of-window customer, forever; `revoked` is the operator's own
    // tombstone; `upstream` is a GitHub blip that would storm.
    expect(isAlertable({ result: "no-update", ts: 0, reason: "no-header" })).toBe(false);
    expect(isAlertable({ result: "no-update", ts: 0, reason: "expired" })).toBe(false);
    expect(isAlertable({ result: "no-update", ts: 0, reason: "revoked" })).toBe(false);
    expect(isAlertable({ result: "no-update", ts: 0, reason: "upstream" })).toBe(false);
    expect(isAlertable({ result: "served", ts: 0 })).toBe(false);
  });

  it("an unknown UUID id posts exactly one alert, carrying the reason and NOT the id", async () => {
    const out = await viaFetch(UUID, {}, { ALERT_WEBHOOK_URL: HOOK });
    const hooks = hookPosts(out.posts);
    expect(hooks).toHaveLength(1);
    const body = JSON.parse(hooks[0][1]?.body as string).text as string;
    expect(body).toContain("unknown-id");
    // The privacy pin. An alert channel must not become the per-customer update
    // history the log line is careful not to be.
    expect(body).not.toContain(UUID);
  });

  it("the unparseable alert names the RIGHT repair, not the unknown-id one", async () => {
    // `isAlertable` is true for both classes, so a single unconditional body
    // would send this operator hunting a missing key and a namespace-id
    // mismatch. Here the key is present and readable — the repair is to re-PUT
    // valid JSON over it, and nothing is missing.
    const out = await viaFetch(UUID, { [UUID]: "{not json" }, { ALERT_WEBHOOK_URL: HOOK });
    const body = JSON.parse(hookPosts(out.posts)[0][1]?.body as string).text as string;
    expect(body).toContain("unparseable");
    expect(body).toContain("re-PUT valid JSON over the existing key");
    expect(body).not.toContain("namespace-id mismatch");
    expect(body).not.toContain("nobody removed is gone");
    // The privacy pin holds on this arm too.
    expect(body).not.toContain(UUID);

    // And the unknown-id arm keeps the absence diagnosis it was written for.
    _resetAlertThrottleForTests();
    const missing = await viaFetch(UUID, {}, { ALERT_WEBHOOK_URL: HOOK });
    const missingBody = JSON.parse(hookPosts(missing.posts)[0][1]?.body as string).text as string;
    expect(missingBody).toContain("namespace-id mismatch");
    expect(missingBody).not.toContain("re-PUT valid JSON over the existing key");
  });

  it("a NON-UUID id logs unknown-id but never pages — the anti-flood gate", async () => {
    // This endpoint is unauthenticated: one KV get off a caller-supplied header
    // on a public host. Without the shape gate, scanner traffic pages the
    // operator on a healthy system, and a low-rate flood holds the throttle slot
    // and suppresses the genuine event.
    const out = await viaFetch("not-a-uuid", {}, { ALERT_WEBHOOK_URL: HOOK });
    expect(out.status).toBe(204);
    expect(out.logs.some((e) => e.reason === "unknown-id")).toBe(true);
    expect(hookPosts(out.posts)).toHaveLength(0);
  });

  it("alerting does not change the response bytes", async () => {
    const alerted = await viaFetch(UUID, {}, { ALERT_WEBHOOK_URL: HOOK });
    const silent = await viaFetch(UUID, {});
    expect(alerted.status).toBe(204);
    expect(alerted.status).toBe(silent.status);
    expect(alerted.body).toBe(silent.body);
    expect(alerted.body).toBe("");
  });

  // Two `it()` blocks, not two cases: both provoke `unknown-id` and share the
  // key `no-update:unknown-id`, so the second would be throttled into a
  // vacuous pass.
  it("a webhook that THROWS cannot fail the request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    const pending: Promise<unknown>[] = [];
    const res = await updateWorker.fetch(
      req(UUID),
      {
        LICENSE_KV: kvWith({}),
        PUBLIC_LATEST_JSON_URL: URL_LATEST,
        ALERT_WEBHOOK_URL: HOOK,
      } as never,
      { waitUntil: (p: Promise<unknown>) => pending.push(p) } as never,
    );
    await Promise.all(pending);
    expect(res.status).toBe(204);
  });

  it("a webhook that 404s cannot fail the request", async () => {
    // A retired Slack webhook 404s rather than throwing. The alert is lost
    // either way; the request must not be.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("gone", { status: 404 })),
    );
    const pending: Promise<unknown>[] = [];
    const res = await updateWorker.fetch(
      req(UUID),
      {
        LICENSE_KV: kvWith({}),
        PUBLIC_LATEST_JSON_URL: URL_LATEST,
        ALERT_WEBHOOK_URL: HOOK,
      } as never,
      { waitUntil: (p: Promise<unknown>) => pending.push(p) } as never,
    );
    await Promise.all(pending);
    expect(res.status).toBe(204);
  });

  it("throttles a repeat, and the KEY is result AND reason", async () => {
    await viaFetch(UUID, {}, { ALERT_WEBHOOK_URL: HOOK });
    const second = await viaFetch(UUID, {}, { ALERT_WEBHOOK_URL: HOOK });
    expect(hookPosts(second.posts)).toHaveLength(0); // suppressed
    _resetAlertThrottleForTests();
    const third = await viaFetch(UUID, {}, { ALERT_WEBHOOK_URL: HOOK });
    expect(hookPosts(third.posts)).toHaveLength(1);

    // THE DISCRIMINATING CASE. Every no-update logs `result: "no-update"`, so a
    // key built from `result` alone collapses `unknown-id` and `unparseable`
    // into one slot: an `unparseable` storm would then suppress the genuine
    // missing-entitlement alert. No reset between these two.
    _resetAlertThrottleForTests();
    const a = await viaFetch(UUID, {}, { ALERT_WEBHOOK_URL: HOOK });
    const b = await viaFetch(UUID, { [UUID]: "{not json" }, { ALERT_WEBHOOK_URL: HOOK });
    expect(hookPosts(a.posts)).toHaveLength(1);
    expect(hookPosts(b.posts)).toHaveLength(1);
  });

  it("no channel configured → no alert fetch, and an alert-undeliverable line", async () => {
    // Otherwise the throttle slot is burned with nothing recording that the
    // alert never landed.
    const out = await viaFetch(UUID, {});
    expect(hookPosts(out.posts)).toHaveLength(0);
    const undeliverable = out.logs.filter((e) => e.result === "alert-undeliverable");
    expect(undeliverable).toHaveLength(1);

    // Same UNIT as every other line in this Worker: epoch milliseconds. The two
    // lines land side by side in the retained log, and an operator correlating
    // one against the other must not see timestamps 1000x apart. Epoch seconds
    // is ~1.7e9 and fails both assertions.
    const noUpdate = out.logs.find((e) => e.result === "no-update");
    const ts = undeliverable[0].ts as number;
    expect(ts).toBeGreaterThan(1e12);
    expect(Math.abs(ts - (noUpdate?.ts as number))).toBeLessThan(5_000);
  });

  it("expired does NOT alert — the operator would be paged forever otherwise", async () => {
    const past = JSON.stringify({ updateWindowEnd: new Date(NOW - DAY).toISOString() });
    const out = await viaFetch(UUID, { [UUID]: past }, { ALERT_WEBHOOK_URL: HOOK });
    expect(out.status).toBe(204);
    expect(hookPosts(out.posts)).toHaveLength(0);
  });
});

describe("the revocation tombstone (#1786)", () => {
  it("a null-window tombstone is refused, NOT grandfathered into a served manifest", async () => {
    // This row pins the check's EXISTENCE. `updateWindowEnd: null` is what a
    // grandfathered entitlement carries, so with no `status` check at all the
    // tombstone is never `expired`, falls through to the upstream fetch, and
    // serves the manifest to a refunded customer.
    const out = await reasonFor("lic-rev", {
      "lic-rev": JSON.stringify({ updateWindowEnd: null, status: "revoked" }),
    });
    expect(out.reason).toBe("revoked");
    // 204, so the manifest was not served — the whole point of the branch.
    expect(out.status).toBe(204);
  });

  it("a PAST-window tombstone reports revoked, not expired", async () => {
    // This row pins the ORDER, and it is the only one that can: a check placed
    // after the window comparison returns the identical 204 + `revoked` for the
    // null-window row above, so that row passes either way. Here the tombstone
    // is already out of window, so a late check reports the non-alertable
    // `expired` and the operator's own revocation becomes indistinguishable
    // from an ordinary lapsed customer in the retained log.
    const out = await reasonFor("lic-rev2", {
      "lic-rev2": JSON.stringify({
        updateWindowEnd: new Date(NOW - DAY).toISOString(),
        status: "revoked",
      }),
    });
    expect(out.reason).toBe("revoked");
  });

  it("a tombstone does not alert", async () => {
    // Placement-blind by construction (`revoked` is non-alertable whichever
    // branch reports it), so this pins non-alerting only — the order is the
    // past-window row's job alone.
    _resetAlertThrottleForTests();
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        posts.push(String(input));
        return new Response(MANIFEST, { status: 200 });
      }),
    );
    const pending: Promise<unknown>[] = [];
    try {
      const res = await updateWorker.fetch(
        req(UUID),
        {
          LICENSE_KV: kvWith({
            [UUID]: JSON.stringify({ updateWindowEnd: null, status: "revoked" }),
          }),
          PUBLIC_LATEST_JSON_URL: URL_LATEST,
          ALERT_WEBHOOK_URL: HOOK,
        } as never,
        { waitUntil: (p: Promise<unknown>) => pending.push(p) } as never,
      );
      await Promise.all(pending);
      expect(res.status).toBe(204);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(posts.filter((u) => u === HOOK)).toHaveLength(0);
  });
});
