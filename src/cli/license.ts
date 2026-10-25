/**
 * `tandem activate <license-or-path>` and `tandem license` (#1116, ADR-040).
 *
 * `tandem activate` verifies the key locally first, then hands it to a Tandem
 * running at `TANDEM_URL` (default `http://127.0.0.1:3479`) through
 * `POST /api/license/activate` (#2205). That route writes the key into the
 * server's OWN app-data root — on desktop the Tauri root, not this CLI's — and
 * resumes a launcher the licence had stopped. When no Tandem answers there (or
 * whatever answers is not Tandem, or `TANDEM_URL` names another host), it falls
 * back to writing the LOCAL app-data store directly, as it always did; the
 * server re-resolves license state per dispatch (no cache), so that write takes
 * effect on a running server's next tool call / reconnect.
 *
 * `tandem license` stays local-only: it reads this CLI's app-data store.
 */
import fs from "fs";
import { LicenseActivationError } from "../server/license/activation.js";
import { GATE_ENABLED } from "../server/license/gate-flag.js";
import {
  activateLicense,
  resolveLicenseState,
  verifyActivationBlob,
} from "../server/license/license-state.js";
import type { LicenseState, SignatureVerified } from "../server/license/license-types.js";
import { resolveAppDataDir } from "../server/platform.js";
import { API_LICENSE_ACTIVATE } from "../shared/api-paths.js";
import { resolveTandemUrl } from "../shared/cli-runtime.js";
import { TANDEM_PURCHASE_URL, TRIAL_DAYS } from "../shared/constants.js";
import { ERROR_CODE_BAD_ORIGIN } from "../shared/integrations/contract.js";
import {
  activationErrorMessage,
  LICENSE_SAVED_STATE_UNREADABLE,
  unverifiableLicenseMessage,
} from "../shared/license-copy.js";

/**
 * Resolve the activate argument to a license blob. If it names a readable file
 * (e.g. a `.license` file emailed to a beta tester), read that file's contents;
 * otherwise treat the argument itself as the pasted blob. `fs.existsSync` never
 * throws — a base64 blob containing `/` simply isn't a real path and falls
 * through to the literal branch.
 */
export function resolveLicenseInput(
  arg: string,
  fileExists: (p: string) => boolean,
  readFile: (p: string) => string,
): string {
  // No normalization needed — `verifyLicenseSignature` repairs transport damage
  // at the crypto boundary, and `activateLicense` normalizes before persisting.
  if (fileExists(arg)) return readFile(arg).trim();
  return arg.trim();
}

/**
 * Greedy word-wrap for terminal output. The shared license copy is written as
 * prose sentences (it also renders in the GUI, where the browser wraps it), so
 * the CLI has to do its own wrapping rather than emitting one very long line.
 */
export function wrapForTerminal(text: string, width = 76): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Human-readable lines for `tandem license`. Pure (given an already-resolved
 * state) so the formatting is unit-testable without touching disk.
 */
export function formatLicenseStatus(state: LicenseState, enforcementOn: boolean): string[] {
  const lines: string[] = ["", "Tandem license", ""];
  lines.push(`  Enforcement:   ${enforcementOn ? "on" : "off (activates at v1.0)"}`);
  if (!enforcementOn && state.gateActive && state.status !== "licensed") {
    // `tandem license` forces `gateEnabled: true`, so a dark build reaches here
    // from any `trial.json`, stale or live. A dark build is a pre-1.0 beta, whose grant has
    // no time limit: the user is neither on a trial nor unlicensed, and is
    // offered nothing to buy. The trial clock is still shown, labelled, for
    // diagnosis.
    const which =
      state.licenseUnverifiable !== undefined ? "license not verified" : "no license key";
    const clock =
      state.status === "trial"
        ? ` (trial clock: ${state.trial.daysRemaining} of ${TRIAL_DAYS} days)`
        : "";
    lines.push(`  Status:        ${which} — nothing is enforced in this build${clock}`);
  } else if (state.gateActive && state.status === "trial") {
    lines.push(
      `  Status:        trial (${state.trial.daysRemaining} of ${TRIAL_DAYS} days remaining)`,
    );
  } else if (state.gateActive && state.status === "restricted") {
    // #1521: keyless means AI off, never read-only.
    const unverifiable = state.licenseUnverifiable !== undefined;
    if (unverifiable) {
      lines.push(
        "  Status:        license not verified — AI features off; the editor is unaffected",
      );
    } else {
      lines.push("  Status:        unlicensed — AI features off; the editor is unaffected");
    }
    // Never a purchase link for an installed licence that fails to verify:
    // that reader most likely already paid (ADR-040 decision 8). Their remedy
    // is the fix-or-reissue paragraph below.
    if (!unverifiable) lines.push(`  Buy a license: ${TANDEM_PURCHASE_URL}`);
  } else {
    // licensed (gate-active) — or the dark arm, which `tandem license` never
    // produces (it forces gateEnabled:true), but the union requires the branch.
    lines.push("  Status:        licensed");
    if (state.gateActive && state.status === "licensed") {
      lines.push(`  Licensee:      ${state.license.email} (${state.license.type})`);
      if (state.license.expiresAt === null) {
        // Every issued key since ADR-040's 2026-10-09 amendment (decision A5):
        // no window at all, so "current" with no date would understate it.
        lines.push("  Updates:       all future updates included");
      } else {
        // Only a key hand-signed with `--expires` still carries a dated window.
        const window = state.updateWindowCurrent ? "current" : "expired";
        lines.push(`  Update window: ${window} (through ${state.license.expiresAt.slice(0, 10)})`);
      }
      if (!state.updateWindowCurrent) {
        // The single most confusing state in the whole system: the app keeps
        // saying "You're up to date" because the update endpoint is returning
        // no-update, not because there is nothing to install.
        lines.push("                 (Tandem keeps running; new releases are no longer offered.)");
      }
    }
  }
  // A license file exists but doesn't verify. Its holder most likely paid, so
  // they must never read as unlicensed or be offered a purchase; this paragraph
  // is their remedy. The message is chosen by the code, so it names the actual
  // remedy rather than hedging across three.
  if (state.gateActive && state.status !== "licensed" && state.licenseUnverifiable) {
    lines.push("");
    for (const line of wrapForTerminal(unverifiableLicenseMessage(state.licenseUnverifiable))) {
      lines.push(`  ${line}`);
    }
  }
  lines.push("");
  return lines;
}

/**
 * `tandem license` — print the on-device license/trial state. Forces full
 * resolution (gateEnabled: true) so a beta tester can confirm an installed
 * license even while enforcement still ships dark; the "Enforcement" line
 * separately reports the real build flag.
 */
export async function runLicenseStatus(): Promise<void> {
  const state = resolveLicenseState({
    appDataDir: resolveAppDataDir(),
    now: () => Date.now(),
    gateEnabled: true,
  });
  for (const line of formatLicenseStatus(state, GATE_ENABLED)) console.log(line);
}

/**
 * `tandem activate <license-or-path>` — verify + persist a signed license.
 * Exits non-zero with a generic message on a bad license (no blob bytes echoed).
 */
export async function runActivate(args: string[]): Promise<void> {
  const input = args[1];
  if (!input) {
    console.error("Usage: tandem activate <license-string-or-path>");
    process.exit(1);
    // `process.exit` is typed `never`, so TS is satisfied without this — but
    // under a spied `exit` (which does not terminate) the function falls
    // through, and the next lines then run with `input` undefined.
    return;
  }
  // Its OWN try, a SIBLING of the one below and never nested (#1789).
  // `resolveLicenseInput` sat outside any handler: `existsSync` says yes for a
  // DIRECTORY, `readFileSync` throws EISDIR, and the buyer got a raw stack trace
  // instead of the per-cause copy the activation catch prints. Nesting it inside
  // that catch instead would print the generic "License activation failed." line
  // on top — the double message, reintroduced by structure.
  //
  // Echoing `input` is safe: this branch is reachable only once
  // `fileExists(input)` returned true, so it is a path, not blob bytes.
  let blob: string;
  try {
    blob = resolveLicenseInput(input, fs.existsSync, (p) => fs.readFileSync(p, "utf-8"));
  } catch (err) {
    // Bind the error and print its message (review round 1). A bare `catch`
    // reported EVERY read failure with folder-specific advice: an EACCES on a
    // readable-looking file, or an EIO on a disconnected share, told the buyer
    // to check whether their file was a folder while the errno that actually
    // named the cause was discarded. `err.message` from `readFileSync` carries
    // the errno and the path — never blob bytes, since this branch is reachable
    // only once `fileExists(input)` returned true.
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `\n[Tandem] Could not read a license from ${input}.\n` +
        "If that's a folder, point at the .license file inside it — or paste the license " +
        `key itself as the argument.\nReason: ${reason}\n`,
    );
    process.exit(1);
    return;
  }

  // 1. Verify locally, before anything is sent anywhere (#2205). A junk
  // argument is refused here with the per-cause copy and never reaches the
  // network.
  let verified: { blob: string; meta: SignatureVerified };
  try {
    verified = verifyActivationBlob(blob);
  } catch (err) {
    printActivationFailure(err);
    process.exit(1);
    return;
  }

  // 2. Hand it to a running Tandem, which writes its own app-data root and
  // resumes a launcher the licence had stopped.
  const outcome = await activateViaRunningServer(verified.blob, { url: resolveTandemUrl() });

  if (outcome.kind === "activated") {
    const extra = ["  Tandem is running, so it picked the license up straight away."];
    if (outcome.cliSharesRoot === false) {
      extra.push(
        "  `tandem license` here reads a separate store and will not list it; Settings → License in Tandem shows it.",
      );
    }
    for (const line of formatActivationSuccess(verified.meta, extra)) console.log(line);
    // No `process.exit` on success: the fetch's handles drain on their own, as
    // the direct path's always did.
    return;
  }

  if (outcome.kind === "saved-unconfirmed") {
    // Tandem wrote the key, then could not read its licence state back. The key
    // is installed, so this is not a failure, and a local write on top would
    // change nothing.
    for (const line of formatActivationSuccess(verified.meta, [`  ${outcome.message}`])) {
      console.log(line);
    }
    return;
  }

  if (outcome.kind === "refused") {
    // The server is up and decided. Writing locally on top would install a key
    // the running Tandem just refused, so there is no fallback here.
    console.error(`\n[Tandem] License activation failed.\n${outcome.message}\n`);
    process.exit(1);
    // Required, not decorative: under a non-throwing `exit` spy, falling
    // through would reach the direct write below.
    return;
  }

  // 3. No Tandem took it — today's direct write.
  try {
    const state = await activateLicense(resolveAppDataDir(), blob);
    const lic = state.gateActive && state.status === "licensed" ? state.license : null;
    const extra: string[] = [];
    if (outcome.reason === "timeout") {
      extra.push(
        "  Tandem didn't confirm it took the key, so it was saved here as well. If Tandem's Claude stays stopped, use Restart in the app.",
      );
    } else if (outcome.reason === "origin-refused") {
      extra.push(
        "  The running Tandem didn't take the key directly (it may be an older version). If it doesn't show as licensed, paste the key in Settings → License, or restart Tandem.",
      );
    }
    for (const line of formatActivationSuccess(lic, extra)) console.log(line);
  } catch (err) {
    printActivationFailure(err);
    process.exit(1);
    return;
  }
}

/** Same per-cause copy the HTTP route uses — one taxonomy, two transports. */
function printActivationFailure(err: unknown): void {
  const code = err instanceof LicenseActivationError ? err.code : "UNKNOWN";
  console.error(`\n[Tandem] License activation failed.\n${activationErrorMessage(code)}\n`);
}

/**
 * The success lines `tandem activate` prints, one `console.log` call per
 * element. The first element carries its own leading newline so the direct
 * path stays byte-identical, call for call, with what it printed before #2205.
 */
export function formatActivationSuccess(
  meta: { email: string; type: string; expiresAt: string | null } | null,
  extra: string[] = [],
): string[] {
  const who = meta ? `${meta.email} (${meta.type})` : "this device";
  const lines = [`\n✓ License activated for ${who}.`];
  if (meta?.expiresAt) {
    lines.push(`  Updates included through ${meta.expiresAt.slice(0, 10)}.`);
  } else if (meta) {
    lines.push("  All future updates are included.");
  }
  lines.push(...extra, "");
  return lines;
}

export type ServerActivateOutcome =
  | { kind: "activated"; cliSharesRoot?: boolean }
  | { kind: "refused"; status: number; message: string }
  | { kind: "saved-unconfirmed"; message: string }
  | {
      kind: "unavailable";
      reason: "non-loopback-url" | "unreachable" | "timeout" | "not-tandem" | "origin-refused";
    };

/**
 * The activate route's closed error vocabulary: `sendActivationError` in
 * `src/server/mcp/routes/license.ts` (INVALID_LICENSE, LICENSE_WRITE_FAILED),
 * its `license is required` 400 (BAD_REQUEST), `rejectOversizeLicenseBody` in
 * `src/server/mcp/api-routes.ts` (PAYLOAD_TOO_LARGE), and the body-parser
 * error mapper in `src/server/mcp/server.ts` (BAD_REQUEST, PAYLOAD_TOO_LARGE).
 * Only an answer in this set, at one of {@link TANDEM_REFUSAL_STATUSES}, counts
 * as Tandem refusing the key. A new route error code must join this set, or
 * the CLI reads it as "not Tandem" and falls back to the local write. The one
 * non-refusal code, `LICENSE_SAVED_STATE_UNREADABLE`, is matched before it.
 */
const TANDEM_ACTIVATE_ERRORS = new Set([
  "BAD_REQUEST",
  "INVALID_LICENSE",
  "LICENSE_WRITE_FAILED",
  "PAYLOAD_TOO_LARGE",
]);
const TANDEM_REFUSAL_STATUSES = new Set([400, 413, 500]);

/** A signed license is ~650 bytes and its success wire well under 2 KB. */
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_REFUSAL_MESSAGE_CHARS = 500;

/**
 * Strip what a terminal would act on rather than print: C0/C1 controls
 * (ESC, CSI) become a space, and Unicode bidi controls are dropped so an
 * answer cannot visually reorder the failure line. The bidi class is the one
 * `sanitizeForLog` (`src/server/log-sanitize.ts`) strips \u2014 embeddings,
 * overrides and isolates, plus the LRM/RLM/ALM marks \u2014 and must stay in step
 * with it. Controls become a space here rather than vanishing as they do there,
 * so words either side of one stay apart.
 */
function sanitizeServerMessage(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\u061c]/g, "");
  return cleaned.length > MAX_REFUSAL_MESSAGE_CHARS
    ? `${cleaned.slice(0, MAX_REFUSAL_MESSAGE_CHARS)}…`
    : cleaned;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Read at most {@link MAX_RESPONSE_BYTES} of a response body. `null` means it
 * ran over (the stream is cancelled), which no Tandem answer does.
 */
async function readCappedBody(res: Response): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * POST a verified blob to a running Tandem's `/api/license/activate` (#2205).
 *
 * Only a literal `http://127.0.0.1:<port>` URL is ever contacted:
 * - the route refuses a non-loopback caller anyway, and the server binds
 *   127.0.0.1;
 * - `isHostAllowed` 403s `Host: localhost` and `[::1]`;
 * - a `localhost` name goes through getaddrinfo and can be remapped off this
 *   machine by a hosts file;
 * - `resolveTandemUrl`'s default is `http://127.0.0.1:<port>`;
 * - https is refused too: a loopback Tandem never serves TLS.
 *
 * The request URL is built from the PARSED URL's origin, so the host checked is
 * provably the host fetched, and any userinfo, path, query or fragment in
 * `TANDEM_URL` is dropped. No `Origin` and no `Authorization` are sent: the
 * route admits an absent Origin, and loopback bypasses `authMiddleware`.
 *
 * Anything that is not recognisably Tandem's answer maps to `unavailable`, so
 * the caller falls back to the direct write: a redirect, a 2xx without the
 * licence wire, any status or body outside the route's closed vocabulary.
 */
export async function activateViaRunningServer(
  blob: string,
  opts: { url: string; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<ServerActivateOutcome> {
  const { fetchImpl = fetch, timeoutMs = 30_000 } = opts;
  let target: URL;
  try {
    const parsed = new URL(opts.url);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
      return { kind: "unavailable", reason: "non-loopback-url" };
    }
    target = new URL(API_LICENSE_ACTIVATE, parsed.origin);
  } catch {
    return { kind: "unavailable", reason: "non-loopback-url" };
  }

  let res: Response;
  let body: unknown;
  try {
    res = await fetchImpl(target.href, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license: blob }),
      // Node/undici defaults to `follow`, which re-POSTs this body — the
      // buyer's signed key and email — to a 307/308 `Location`, wherever it
      // points. Never follow; a redirect is not Tandem's answer.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (
      res.type === "opaqueredirect" ||
      res.status === 0 ||
      (res.status >= 300 && res.status < 400)
    ) {
      await res.body?.cancel().catch(() => {});
      return { kind: "unavailable", reason: "not-tandem" };
    }
    const text = await readCappedBody(res);
    if (text === null) return { kind: "unavailable", reason: "not-tandem" };
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  } catch (err) {
    const name = err instanceof Error || err instanceof DOMException ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { kind: "unavailable", reason: "timeout" };
    }
    return { kind: "unavailable", reason: "unreachable" };
  }

  if (res.status >= 200 && res.status < 300) {
    // The real wire always carries more than `gateActive`: a dark build answers
    // the `status: "licensed"` sentinel plus `licenseInstalled`, an armed one
    // `status: "licensed"` after a good activation.
    if (
      isPlainObject(body) &&
      typeof body.gateActive === "boolean" &&
      (body.licenseInstalled === true || body.status === "licensed")
    ) {
      return typeof body.cliActivateEffective === "boolean"
        ? { kind: "activated", cliSharesRoot: body.cliActivateEffective }
        : { kind: "activated" };
    }
    return { kind: "unavailable", reason: "not-tandem" };
  }

  if (res.status === 403) {
    // A pre-#2205 Tandem refuses an Origin-less caller with this code. So do
    // both loopback refusals (`assertLoopbackForMutation`,
    // `enforceLoopbackMutation`) — which a 127.0.0.1 socket cannot reach today,
    // but a port-forward (Docker, WSL2) could — hence the neutral wording of the
    // hint the caller prints. Either way the local write is the safe fallback.
    if (isPlainObject(body) && body.code === ERROR_CODE_BAD_ORIGIN) {
      return { kind: "unavailable", reason: "origin-refused" };
    }
    return { kind: "unavailable", reason: "not-tandem" };
  }

  if (
    res.status === 500 &&
    isPlainObject(body) &&
    body.error === LICENSE_SAVED_STATE_UNREADABLE &&
    typeof body.message === "string"
  ) {
    return { kind: "saved-unconfirmed", message: sanitizeServerMessage(body.message) };
  }

  if (
    TANDEM_REFUSAL_STATUSES.has(res.status) &&
    isPlainObject(body) &&
    typeof body.error === "string" &&
    TANDEM_ACTIVATE_ERRORS.has(body.error) &&
    typeof body.message === "string"
  ) {
    return { kind: "refused", status: res.status, message: sanitizeServerMessage(body.message) };
  }

  return { kind: "unavailable", reason: "not-tandem" };
}
