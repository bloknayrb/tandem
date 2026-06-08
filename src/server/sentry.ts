/**
 * Node sidecar crash reporting (#921).
 *
 * ## Privacy posture: OPT-IN, off by default
 *
 * Disabled unless `TANDEM_SENTRY_DSN` is set. The Tauri shell forwards this env
 * var to the sidecar (see `src-tauri/src/lib.rs` `start_sidecar`), so the
 * sidecar and the shell report to the SAME project as separate event sources,
 * exactly as the issue specifies. With no DSN, `initSidecarCrashReporting` does
 * nothing and `captureFatal` is an inert no-op — no `@sentry/node` is loaded.
 *
 * ## stdout safety (Critical Rule #3)
 *
 * `@sentry/node` ships events over HTTPS, not stdout, so it cannot corrupt the
 * MCP stdio wire. We additionally pass `debug: false` so the SDK never writes
 * diagnostic chatter that could leak to stdout in stdio mode.
 *
 * ## PII scrubbing
 *
 * A `beforeSend` hook scrubs absolute home-dir paths and obvious secrets from
 * messages/exception values before egress. We only ever capture `Error`s from
 * the fatal-error path — never document content or annotation bodies.
 */

import { APP_VERSION } from "./mcp/server.js";

const SENTRY_DSN_ENV = "TANDEM_SENTRY_DSN";

// Loaded lazily and only when a DSN is present, so a default launch never pulls
// `@sentry/node` into the process. Typed loosely to avoid a hard import.
type SentryNode = typeof import("@sentry/node");
let sentry: SentryNode | null = null;

function redactSecrets(input: string): string {
  return input
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "sk-[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, "Bearer [redacted]");
}

function redactHome(input: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  let out = input;
  // Guard against a degenerate root home (`/`) that would replace every
  // separator. Require a real path segment before doing the literal swap.
  if (home && home.length > 1) {
    out = out.split(home).join("~");
  }
  // Also collapse user segments not under $HOME (e.g. another account's path).
  return out
    .replace(/(\/Users\/)[^/\\]+/g, "$1[user]")
    .replace(/(\/home\/)[^/\\]+/g, "$1[user]")
    .replace(/([A-Za-z]:\\Users\\)[^\\]+/g, "$1[user]");
}

/** Exposed for unit tests — scrubbing is the privacy-load-bearing part. */
export function scrub(input: string): string {
  return redactHome(redactSecrets(input));
}

/**
 * Initialise sidecar crash reporting if `TANDEM_SENTRY_DSN` is set. Idempotent,
 * fire-and-forget, and never throws into startup — telemetry must not break the
 * server. Returns whether reporting was enabled (for logging/tests).
 */
export async function initSidecarCrashReporting(): Promise<boolean> {
  const dsn = process.env[SENTRY_DSN_ENV]?.trim();
  if (!dsn) return false;
  if (sentry) return true;

  try {
    const Sentry = await import("@sentry/node");
    Sentry.init({
      dsn,
      release: APP_VERSION,
      debug: false,
      sendDefaultPii: false,
      // We attach our own handlers and ship explicitly from handleFatalError;
      // don't let the SDK install duplicate global hooks that could double-ship
      // or alter the existing narrowed exception-handler contract.
      defaultIntegrations: false,
      beforeSend(event) {
        if (event.message) event.message = scrub(event.message);
        for (const exception of event.exception?.values ?? []) {
          if (exception.value) exception.value = scrub(exception.value);
        }
        return event;
      },
    });
    sentry = Sentry;
    // console.* is redirected to stderr in index.ts, so this is stdout-safe.
    console.error("[Tandem] Sidecar crash reporting enabled (TANDEM_SENTRY_DSN set)");
    return true;
  } catch (err) {
    console.error(
      `[Tandem] Sidecar crash reporting init failed (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}

/**
 * Ship a fatal error to Sentry and block (best-effort, bounded) on the flush so
 * the event is sent before `process.exit(1)`. No-op when reporting is disabled.
 *
 * @param flushMs upper bound on the flush wait; we never hang shutdown.
 */
export async function captureFatal(value: unknown, flushMs = 2000): Promise<void> {
  if (!sentry) return;
  try {
    if (value instanceof Error) {
      sentry.captureException(value);
    } else {
      sentry.captureMessage(`Non-Error fatal: ${scrub(String(value))}`, "fatal");
    }
    await sentry.flush(flushMs);
  } catch {
    // Never let telemetry throw inside the fatal-error path.
  }
}
