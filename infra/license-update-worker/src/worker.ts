/**
 * Tandem license-checked update endpoint (Cloudflare Worker) — L3 of the
 * licensing system (#1116, ADR-040 §7).
 *
 * GET /latest.json with an `X-Tandem-License-Id` header. The Worker looks the id
 * up in KV (written by the issuance webhook) and, if the caller is entitled and
 * inside their update window, proxies the signed public `latest.json` (the
 * minisign signature is unchanged and still verified client-side by Tauri's
 * pubkey — the Worker only gates access). Otherwise it returns a no-update.
 *
 * Privacy invariants:
 *  - Unknown id AND expired window return a BYTE-IDENTICAL no-update response
 *    (HTTP 204, empty body) — no existence oracle.
 *  - Logs only `{ result, ts }` — never the license id (per-customer
 *    update-check logs would be telemetry).
 */

/** Minimal structural view of a Cloudflare KV namespace (read side). */
export interface KvGetter {
  get(key: string): Promise<string | null>;
}

export interface UpdateDeps {
  kv: KvGetter;
  latestJsonUrl: string;
  fetchFn: typeof fetch;
  now: () => number;
  log?: (entry: { result: "served" | "no-update"; ts: number }) => void;
}

export const LICENSE_HEADER = "X-Tandem-License-Id";

interface Entitlement {
  updateWindowEnd: string | null;
  status?: string;
  version?: string;
}

/** The single no-update response. Identical bytes for every rejection reason. */
function noUpdate(): Response {
  return new Response(null, { status: 204 });
}

/**
 * Pure request handler — all I/O injected, so it runs under vitest with a mock
 * KV and a mock fetch (no Cloudflare runtime needed).
 */
export async function handleUpdateRequest(request: Request, deps: UpdateDeps): Promise<Response> {
  const { kv, latestJsonUrl, fetchFn, now, log } = deps;
  const ts = now();
  const reject = (): Response => {
    log?.({ result: "no-update", ts });
    return noUpdate();
  };

  const lid = request.headers.get(LICENSE_HEADER);
  if (!lid) return reject();

  const raw = await kv.get(lid);
  if (!raw) return reject();

  let entry: Entitlement;
  try {
    entry = JSON.parse(raw) as Entitlement;
  } catch {
    return reject();
  }

  // null updateWindowEnd ⇒ never expires (grandfathered). Otherwise compare epochs.
  const expired =
    entry.updateWindowEnd != null && new Date(entry.updateWindowEnd).getTime() < ts;
  if (expired) return reject();

  // Entitled — proxy the signed public manifest. A failed upstream fetch
  // degrades to no-update (the user just isn't offered an update this round).
  const upstream = await fetchFn(latestJsonUrl, { headers: { Accept: "application/json" } });
  if (!upstream.ok) return reject();
  const body = await upstream.text();
  log?.({ result: "served", ts });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
}

interface WorkerEnv {
  LICENSE_KV: KvGetter;
  PUBLIC_LATEST_JSON_URL: string;
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return handleUpdateRequest(request, {
      kv: env.LICENSE_KV,
      latestJsonUrl: env.PUBLIC_LATEST_JSON_URL,
      fetchFn: fetch,
      now: () => Date.now(),
      // JSON line; deliberately carries no license id.
      log: (entry) => console.log(JSON.stringify(entry)),
    });
  },
};
