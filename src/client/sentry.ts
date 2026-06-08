/**
 * Client-side crash reporting (#921).
 *
 * ## Privacy posture: OPT-IN, off by default
 *
 * The WebView only reports to Sentry when the Tauri shell registered the
 * `tauri-plugin-sentry` plugin, which it does **only** when the operator set
 * `TANDEM_SENTRY_DSN` (see `src-tauri/src/sentry_reporting.rs`). When the plugin
 * is absent — every plain-browser (`tandem-editor` npm) launch, and every Tauri
 * launch with no DSN — `Sentry.init` is never called, so `captureException`
 * et al. are inert no-ops. No DSN ever lives in the client bundle: events route
 * through the plugin's Tauri-IPC transport to the Rust SDK, which holds the DSN.
 *
 * ## Why gate on the `sentry_enabled` command
 *
 * The transport from `tauri-plugin-sentry-api`'s `defaultOptions` issues a Tauri
 * `invoke` to hand events to the Rust process. In a plain browser there is no
 * Tauri IPC, and in a Tauri launch with no DSN the plugin is unregistered — in
 * both cases initializing `@sentry/browser` would be pointless (the transport
 * would silently drop or throw). We therefore ask the shell via the
 * `sentry_enabled` command whether reporting is actually on, and only init when
 * it returns `true`. This is the deterministic source of truth (the WebView
 * can't read `TANDEM_SENTRY_DSN`, and a `window.eval` injection would race page
 * load).
 *
 * ## PII scrubbing (`beforeSend` / `beforeBreadcrumb`)
 *
 * Even though the operator opted in, we scrub aggressively before anything
 * leaves the WebView:
 * - absolute home-dir paths in messages → `~/…` (mirrors the Rust scrubber)
 * - request/console breadcrumbs that could contain document content or API
 *   keys are dropped or redacted
 * - `sendDefaultPii` is left off
 *
 * Document content and annotation bodies are never attached to events by us;
 * this module captures only `Error` objects (stack + message), never editor
 * state.
 */

import type * as SentryBrowser from "@sentry/browser";

let sentry: typeof SentryBrowser | null = null;

/** True inside the Tauri WebView (where the IPC transport is available). */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Crude redaction of anything that looks like a long opaque secret (API keys,
 * bearer tokens) embedded in a string. Anthropic keys start `sk-ant-`; we also
 * catch generic `sk-…` and long base64-ish runs. Conservative: false positives
 * only cost a `[redacted]` in a crash report, never correctness.
 */
function redactSecrets(input: string): string {
  return input
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "sk-[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, "Bearer [redacted]");
}

/**
 * Replace absolute home-dir prefixes with `~`. The WebView can't read `$HOME`,
 * but file paths surfaced in error messages typically embed a recognizable
 * `/Users/<name>/`, `/home/<name>/`, or `C:\Users\<name>\` segment. Collapse
 * the user segment so a crash report can't fingerprint the OS account.
 */
function redactPaths(input: string): string {
  return input
    .replace(/(\/Users\/)[^/\\]+/g, "$1[user]")
    .replace(/(\/home\/)[^/\\]+/g, "$1[user]")
    .replace(/([A-Za-z]:\\Users\\)[^\\]+/g, "$1[user]");
}

function scrub(input: string): string {
  return redactPaths(redactSecrets(input));
}

/**
 * Initialise client-side crash reporting. Safe to call unconditionally and
 * exactly once (from `main.ts`): it self-gates on the Tauri WebView and on the
 * plugin being present, and becomes a no-op everywhere else.
 *
 * Failures here are swallowed — telemetry must never break app startup.
 */
export async function initCrashReporting(): Promise<void> {
  if (!isTauri()) return;

  try {
    // Ask the shell whether opt-in crash reporting is actually enabled (DSN
    // configured + plugin registered). False/throw → stay a no-op. Done before
    // loading the SDK so a default (telemetry-off) launch never even imports it.
    const { invoke } = await import("@tauri-apps/api/core");
    const enabled = await invoke<boolean>("sentry_enabled").catch(() => false);
    if (!enabled) return;

    // Dynamic imports so the plain-browser bundle can tree-shake / lazy-load
    // these and so a missing optional dep never hard-fails the app.
    const Sentry = await import("@sentry/browser");
    const { defaultOptions } = await import("tauri-plugin-sentry-api");

    Sentry.init({
      ...defaultOptions,
      // No DSN here on purpose: the plugin's transport (in `defaultOptions`)
      // forwards events to the Rust SDK over IPC, which owns the DSN. If the
      // shell did NOT register the plugin (operator left `TANDEM_SENTRY_DSN`
      // unset), the IPC command is unregistered and events are dropped by the
      // transport — a harmless no-op, matching the opt-in posture.
      sendDefaultPii: false,
      beforeSend: (event) => {
        if (event.message) event.message = scrub(event.message);
        for (const exception of event.exception?.values ?? []) {
          if (exception.value) exception.value = scrub(exception.value);
        }
        // Drop request bodies / query strings — these can carry doc content.
        if (event.request) {
          event.request.data = undefined;
          if (event.request.url) event.request.url = scrub(event.request.url);
        }
        return event;
      },
      beforeBreadcrumb: (breadcrumb) => {
        // `console`/`fetch`/`xhr` breadcrumbs can capture document text or auth
        // headers. Scrub their messages and drop their data payloads.
        if (breadcrumb.message) breadcrumb.message = scrub(breadcrumb.message);
        if (breadcrumb.category === "fetch" || breadcrumb.category === "xhr") {
          breadcrumb.data = undefined;
        }
        return breadcrumb;
      },
    });

    sentry = Sentry;

    // Capture truly-global failures that bypass the Svelte ErrorBoundary
    // (event handlers, async callbacks, promise rejections).
    window.addEventListener("error", (e) => {
      reportError(e.error ?? e.message, { source: "window.onerror" });
    });
    window.addEventListener("unhandledrejection", (e) => {
      reportError(e.reason, { source: "unhandledrejection" });
    });

    console.info("[sentry] client crash reporting initialised");
  } catch (err) {
    console.warn("[sentry] client init failed (non-fatal):", err);
  }
}

/**
 * Whether client crash reporting is active (Tauri WebView + operator-configured
 * DSN). Used by the Settings → About status row so users can see at a glance
 * whether telemetry is on, without exposing a toggle (the DSN env var is the
 * single source of truth — opt-in, off by default).
 */
export function isCrashReportingEnabled(): boolean {
  return sentry !== null;
}

/**
 * Report an error to Sentry if crash reporting is active; otherwise a no-op.
 * Safe to call from any surface (ErrorBoundary, global handlers) in any
 * environment — guarded so plain-browser builds never touch Sentry.
 */
export function reportError(error: unknown, context?: Record<string, unknown>): void {
  if (!sentry) return;
  try {
    sentry.captureException(error, context ? { extra: context } : undefined);
  } catch {
    // Never let telemetry throw into the app's error path.
  }
}

/** Exposed for unit tests — the scrubbing is the privacy-load-bearing part. */
export const __test = { scrub, redactSecrets, redactPaths };
