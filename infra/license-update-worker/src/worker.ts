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
 *    describing OUR state, not the caller's identity. That invariant is about
 *    OUR OWN log line; what Cloudflare's platform-level invocation record holds
 *    is a separate question, unverified from here, and carried as a checklist
 *    line in docs/licensing-operations.md §8.
 */

/**
 * Why a request was answered with no-update. All six reasons return identical
 * bytes to the caller — this exists purely so the operator can tell them apart.
 *
 * It names the worst failure mode in the licensing system: a license whose
 * entitlement is missing is served 204, `tauri-plugin-updater` early-returns
 * `Ok(None)`, and the desktop app tells the user **"You're up to date."** —
 * permanently, while starved. That is indistinguishable from health at every
 * layer above this line.
 *
 * `reason` ALONE was never a detector, and calling it one is what #1786 fixed:
 * a log line nobody retains and nobody is notified about only makes evidence
 * readable to someone who already suspects. The detector is two halves, both
 * below, and both **inert until the Worker is redeployed**:
 *   - retention — `[observability]` in `wrangler.toml`;
 *   - notification — `sendOperatorAlert` on `ALERT_WEBHOOK_URL`, which must be
 *     set (docs/licensing-operations.md §8).
 */
export type NoUpdateReason =
  /** No `X-Tandem-License-Id` header — an unlicensed/public updater client. */
  | "no-header"
  /** Header present, but no KV entry: an entitlement WE DID NOT REMOVE is gone
   *  (a failed write, an eviction, a namespace-id mismatch). Alertable. */
  | "unknown-id"
  /** KV entry present but not parsable JSON. Alertable. */
  | "unparseable"
  /** Entitled, but past the update window. Expected and benign. */
  | "expired"
  /** A revocation TOMBSTONE — the operator's own refund (`applyRefund`) or a
   *  hand-run revocation (docs/licensing-operations.md §7). Deliberately NOT
   *  alertable: paging someone for their own deliberate action, on every check
   *  for the life of the blob, is how an alert channel gets muted. */
  | "revoked"
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

/** Cloudflare's `ctx`, structurally. Declared locally rather than imported —
 *  this is a separate Cloudflare build with no shared module and no
 *  `@cloudflare/workers-types` dependency, and the issuance Worker carries the
 *  identical declaration. That duplication, and the alerting duplication below,
 *  is deliberate for the same reason. */
export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
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
//
// The namespace holds TWO shapes now: entitlements, and revocation tombstones
// (`{updateWindowEnd: null, status: "revoked"}`). A tombstone is deliberately
// NOT a `LicenseEntitlement` — only `applyRefund` in the issuance Worker and a
// hand-run `kv key put` (docs/licensing-operations.md §7 / §9) write one.
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
  // across all six branches, so this cannot become an existence oracle.
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

  // PLACEMENT IS LOAD-BEARING: this runs immediately after the parse and BEFORE
  // the window comparison below, and each ordering has its own distinct failure.
  //
  //  - Omit it entirely and a `{updateWindowEnd: null}` tombstone is never
  //    `expired`, so it falls through to the upstream fetch and SERVES THE
  //    MANIFEST to a refunded customer. The null window is exactly what a
  //    grandfathered entitlement carries; that is the grandfathering hazard.
  //  - Put it AFTER the window comparison and a tombstone whose window has
  //    already passed reports `expired` instead of `revoked` — a mislabel, and
  //    `expired` is deliberately non-alertable, so the operator's own
  //    revocation and an ordinary out-of-window customer become the same line
  //    in the retained log. Nothing between the `expired` branch and the fetch
  //    below serves anything, so the wrong ORDER does not serve a manifest;
  //    only omitting the check does.
  if (entry.status === "revoked") return reject("revoked");

  // null updateWindowEnd ⇒ never expires (grandfathered). Otherwise compare epochs.
  const expired = entry.updateWindowEnd != null && new Date(entry.updateWindowEnd).getTime() < ts;
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
  /** Any incoming webhook (Slack/Discord/ntfy). Without it, retention is all
   *  there is and nothing reaches a human unprompted. */
  ALERT_WEBHOOK_URL?: string;
}

// ---------------------------------------------------------------------------
// Operator alerting.
//
// Mirrors the issuance Worker's plumbing (`infra/license-issuance-worker/`)
// rather than inventing a shape. The duplication is deliberate: the two are
// separate Cloudflare builds with no shared module, so an import is not
// available and a copied 40 lines beats a build-tooling dependency.
//
// There is NO `ALERT_EMAIL` here on purpose. This Worker has no Resend binding,
// and adding one would give the update endpoint — the one surface that must
// answer every anonymous updater — a reason to hold a mail secret.
// ---------------------------------------------------------------------------

/** Best-effort per-isolate throttle, same shape and window as the issuance
 *  Worker's. Isolates are short-lived, so this narrows a storm rather than
 *  eliminating it — the right trade for an alert you must not miss entirely. */
const ALERT_THROTTLE_MS = 5 * 60 * 1000;
const lastAlertAt = new Map<string, number>();

function shouldAlert(key: string, nowMs: number): boolean {
  const prev = lastAlertAt.get(key);
  if (prev !== undefined && nowMs - prev < ALERT_THROTTLE_MS) return false;
  lastAlertAt.set(key, nowMs);
  return true;
}

/** Test-only: clear the throttle so each case starts from a clean isolate.
 *  Without this the second test to provoke a given key is silently suppressed
 *  and every "does not alert" assertion passes vacuously. */
export function _resetAlertThrottleForTests(): void {
  lastAlertAt.clear();
}

/**
 * Does this log entry warrant waking the operator?
 *
 * ENUMERATED, and the four it excludes are the discriminating half:
 *   - `no-header` — an ordinary unlicensed client, i.e. most of the traffic.
 *   - `expired` — expected and benign; alerting would page for every
 *     out-of-window customer, forever.
 *   - `revoked` — the operator's own tombstone. Same, and worse: it is their
 *     own action being reported back to them.
 *   - `upstream` — a GitHub-side blip that would storm.
 */
export function isAlertable(entry: LogEntry): boolean {
  return entry.reason === "unknown-id" || entry.reason === "unparseable";
}

/** A license id as both mint sites produce one: the issuance Worker's
 *  `globalThis.crypto.randomUUID()` and the out-of-band
 *  `scripts/sign-license.ts`. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Alert text. Carries `reason` and the repair pointer and NOTHING else — the
 *  license id never enters it, so an alert channel is not a per-customer update
 *  history by another route. */
function alertBody(entry: LogEntry): string {
  // ONE ARM PER `isAlertable` CLASS, the way the issuance Worker's `alertBody`
  // splits — because the two classes are reached by different failures and
  // repaired differently. `unknown-id` is an ABSENCE. `unparseable` is a key
  // that is present and readable and holds malformed JSON (most plausibly the
  // hand-run `wrangler kv key put` tombstone in §7, with shell-mangled
  // quoting), so sending that operator to hunt a missing key and a
  // namespace-id mismatch aims them at a repair that does not apply.
  const diagnosis =
    entry.reason === "unparseable"
      ? [
          "A KV entry for this license EXISTS and is readable, but is not valid",
          "JSON — most likely a hand-run `wrangler kv key put` (§7) whose quoting",
          "was mangled by the shell. Nothing is missing.",
          "Repair: re-PUT valid JSON over the existing key. See",
          "docs/licensing-operations.md §7 (tombstone) or §3 (entitlement).",
        ]
      : [
          "An entitlement nobody removed is gone (a failed KV write, an eviction, or a",
          "namespace-id mismatch between the two wrangler.toml files).",
          "Repair: re-PUT the entitlement from the ledger record — it is fully",
          "derivable, so nothing needs re-issuing. See docs/licensing-operations.md §3.",
        ];
  return [
    "Tandem update endpoint: a licensed install was refused an update for a",
    "reason that should not occur.",
    `result=${entry.result} reason=${entry.reason ?? "-"}`,
    "",
    'Affected installs are told "You\'re up to date" forever while starved.',
    ...diagnosis,
  ].join("\n");
}

async function sendOperatorAlert(env: WorkerEnv, entry: LogEntry): Promise<void> {
  if (env.ALERT_WEBHOOK_URL) {
    try {
      const resp = await fetch(env.ALERT_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: alertBody(entry) }),
      });
      // A non-ok response is a failure, not a delivery: a retired Slack webhook
      // 404s rather than throwing, and treating that as success loses the alert
      // silently — in the one piece of code whose whole purpose is not to be
      // missed.
      if (resp.ok) return;
    } catch {
      // fall through
    }
  }
  // The channel is absent or exhausted. Say so, or the throttle slot is
  // consumed and nothing records that the alert never landed.
  //
  // `ts` is epoch MILLISECONDS, matching every other line this Worker emits
  // (`handleUpdateRequest`'s `now()` is wired to `Date.now()`). These sit side
  // by side in the retained log, and an operator correlating an undeliverable
  // line against the `unknown-id` line that produced it would otherwise read
  // timestamps 1000x apart — a 1970 date next to a 2026 one.
  console.log(
    JSON.stringify({
      result: "alert-undeliverable",
      ts: Date.now(),
      ...(entry.reason ? { reason: entry.reason } : {}),
    }),
  );
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx?: ExecutionContext): Promise<Response> {
    // `ctx` is always supplied by the real runtime; optional so the two-arg
    // test harness still calls this.
    const lid = request.headers.get(LICENSE_HEADER);
    return handleUpdateRequest(request, {
      kv: env.LICENSE_KV,
      latestJsonUrl: env.PUBLIC_LATEST_JSON_URL,
      fetchFn: fetch,
      now: () => Date.now(),
      // JSON line; carries the coarse reason but deliberately no license id.
      log: (entry) => {
        console.log(JSON.stringify(entry));
        // A SECOND precondition, deliberately here rather than inside
        // `isAlertable`: the id must be UUID-shaped. This endpoint is
        // unauthenticated — one KV `get` off a caller-supplied header, on a
        // public host — so scanner traffic would otherwise page the operator on
        // a perfectly healthy system, and a low-rate flood would hold the
        // throttle slot and suppress the genuine event. Both mint sites produce
        // UUIDs today (the issuance Worker's `randomUUID()` and
        // `scripts/sign-license.ts`); a future generator must stay UUID-shaped
        // or the alert silently stops covering its cohort. Non-UUID input still
        // LOGS `unknown-id`, it just never pages.
        //
        // RESIDUAL, stated rather than fixed: a UUID-shaped flood still reaches
        // the channel and consumes the slot. A KV counter is the only way to
        // bound that on a stateless Worker, and it is not worth a write per
        // request. See docs/licensing-operations.md §5c.
        if (!isAlertable(entry) || !lid || !UUID_SHAPE.test(lid)) return;
        // Keyed on result AND reason. `result` alone collapses `unknown-id` and
        // `unparseable` into one slot — every no-update logs the same result —
        // so an `unparseable` storm would suppress the genuine event.
        if (!shouldAlert(`${entry.result}:${entry.reason ?? "-"}`, Date.now())) return;
        // Off the response path entirely: the alert must never delay the
        // request or change the response bytes.
        const pending = sendOperatorAlert(env, entry).catch(() => {});
        if (ctx) ctx.waitUntil(pending);
      },
    });
  },
};
