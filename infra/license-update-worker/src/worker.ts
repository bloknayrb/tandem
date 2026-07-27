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
 *  - Logs only `{ result, reason, ts }` — never the license id (per-customer
 *    update-check logs would be telemetry). The `reason` is a closed enum
 *    describing OUR state, not the caller's identity.
 */

/**
 * Why a request was answered with no-update. All five reasons return identical
 * bytes to the caller — this exists purely so the operator can tell them apart.
 *
 * It is the single detector for the worst failure mode in the licensing system:
 * a license whose entitlement is missing is served 204, `tauri-plugin-updater`
 * early-returns `Ok(None)`, and the desktop app tells the user **"You're up to
 * date."** — permanently, while starved. That is indistinguishable from health
 * at every layer above this line. A rising `unknown-id` count is the only
 * evidence that licenses are being issued without entitlements (a broken
 * issuance path, a KV namespace-id mismatch between the two wrangler.toml
 * files, an eviction, or a refund).
 */
export type NoUpdateReason =
  /** No `X-Tandem-License-Id` header — an unlicensed/public updater client. */
  | "no-header"
  /** Header present, but no KV entry. THE alert-worthy one. */
  | "unknown-id"
  /** KV entry present but not parsable JSON. */
  | "unparseable"
  /** Entitled, but past the update window. Expected and benign. */
  | "expired"
  /** Entitled and in-window, but the upstream manifest fetch failed. */
  | "upstream";

/** Minimal structural view of a Cloudflare KV namespace (read side). */
export interface KvGetter {
  get(key: string): Promise<string | null>;
}

export interface LogEntry {
  result: "served" | "no-update";
  ts: number;
  /** Present on `no-update` only. */
  reason?: NoUpdateReason;
}

export interface UpdateDeps {
  kv: KvGetter;
  latestJsonUrl: string;
  fetchFn: typeof fetch;
  now: () => number;
  log?: (entry: LogEntry) => void;
}

export const LICENSE_HEADER = "X-Tandem-License-Id";

// Reader view of the KV value written by `writeLicenseEntitlement`. The canonical
// (writer) shape is `LicenseEntitlement` in `src/server/license/license-types.ts`;
// this is a separate Cloudflare build so it keeps a minimal local copy (only
// `updateWindowEnd` is read) — kept in lockstep by the parity test in
// tests/server/license-update-worker.test.ts. `status`/`version` are optional
// here because the Worker tolerates entries that omit them.
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
  // The `reason` is logged, never returned — the response stays byte-identical
  // across all five branches, so this cannot become an existence oracle.
  const reject = (reason: NoUpdateReason): Response => {
    log?.({ result: "no-update", ts, reason });
    return noUpdate();
  };

  const lid = request.headers.get(LICENSE_HEADER);
  if (!lid) return reject("no-header");

  const raw = await kv.get(lid);
  if (!raw) return reject("unknown-id");

  let entry: Entitlement;
  try {
    entry = JSON.parse(raw) as Entitlement;
  } catch {
    return reject("unparseable");
  }

  // null updateWindowEnd ⇒ never expires (grandfathered). Otherwise compare epochs.
  const expired =
    entry.updateWindowEnd != null && new Date(entry.updateWindowEnd).getTime() < ts;
  if (expired) return reject("expired");

  // Entitled — proxy the signed public manifest. A failed upstream fetch
  // degrades to no-update (the user just isn't offered an update this round).
  // Both a non-ok response AND a thrown fetch (DNS/reset/timeout) must collapse
  // to the byte-identical 204 — otherwise a thrown fetch escapes as a CF 500,
  // and since this point is reached only for an entitled, in-window id, the
  // 500-vs-204 split is an entitlement oracle (defeats the no-existence-oracle
  // invariant in this file's header). So catch the throw too.
  let upstream: Response;
  try {
    upstream = await fetchFn(latestJsonUrl, { headers: { Accept: "application/json" } });
  } catch {
    return reject("upstream");
  }
  if (!upstream.ok) return reject("upstream");
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
      // JSON line; carries the coarse reason but deliberately no license id.
      log: (entry) => console.log(JSON.stringify(entry)),
    });
  },
};
