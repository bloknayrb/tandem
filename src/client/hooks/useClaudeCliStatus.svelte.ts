import { onDestroy } from "svelte";

import {
  API_INTEGRATIONS_CLAUDE_CLI_STATUS,
  API_INTEGRATIONS_INSTALL_CLAUDE_CODE,
  type ClaudeCliPresence,
  type ClaudeCliStatusResponse,
  type InstallClaudeCodeResponse,
} from "../../shared/integrations/contract.js";

export interface ClaudeCliStatusState {
  readonly presence: ClaudeCliPresence | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly installing: boolean;
  readonly installError: string | null;
  /**
   * Trigger the one-click install. Resolves to the resulting presence (or
   * `null` on failure / after unmount). Callers MUST branch on the returned
   * value, not a post-await `presence` getter read — the install resolves in
   * 30–120s, during which the modal may have closed.
   */
  install: () => Promise<ClaudeCliPresence | null>;
  refetch: () => Promise<void>;
}

/**
 * Probe (and optionally install) the `claude` CLI for the integration wizard's
 * empty state.
 *
 * Unlike {@link createCoworkStatus} there is **no polling** — binary presence
 * only changes on an explicit install or a user-initiated "Check again", so the
 * status is fetched once per activation and on `refetch()`.
 *
 * Svelte-5 contract:
 * - `getActive` is PURE — it reads only externals (`open`, `wizard.step`),
 *   never this hook's own `$state`, or the fetch `$effect` (which writes that
 *   state) would self-trigger `effect_update_depth_exceeded`.
 * - Per-mount `$state` (NOT a module singleton) so unmount clears it.
 * - `mounted` / `cancelled` are plain `let`s, not `$state` — a `$state` flag the
 *   fetch effect both reads and writes would re-fire it.
 *
 * `install()` carries its own `mounted` guard (the `$effect`'s `cancelled` flag
 * does NOT cover it — the modal stays interactive during the long install, so
 * Close/Escape can unmount mid-await).
 */
export function createClaudeCliStatus(
  getActive: () => boolean,
  baseUrl = "",
  fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
): ClaudeCliStatusState {
  let presence = $state<ClaudeCliPresence | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let installing = $state(false);
  let installError = $state<string | null>(null);

  let mounted = true;
  onDestroy(() => {
    mounted = false;
  });

  // `isStale` lets the active-fetch bail if its $effect was superseded; both
  // it and `mounted` gate every state write after an await.
  const runStatusFetch = async (isStale: () => boolean): Promise<void> => {
    try {
      const res = await fetchFn(`${baseUrl}${API_INTEGRATIONS_CLAUDE_CLI_STATUS}`);
      if (!mounted || isStale()) return;
      if (!res.ok) {
        error = `Could not check for Claude (status ${res.status}).`;
        return;
      }
      const body = (await res.json()) as ClaudeCliStatusResponse;
      if (!mounted || isStale()) return;
      presence = body.presence;
      error = null;
    } catch (err) {
      if (!mounted || isStale()) return;
      error = err instanceof Error ? err.message : String(err);
    } finally {
      if (mounted && !isStale()) loading = false;
    }
  };

  const refetch = async (): Promise<void> => {
    if (!mounted) return;
    loading = true;
    // Clear a prior install failure: "Check again" routes here, and a stale
    // install-error banner would otherwise persist next to the (still-shown)
    // install CTA while presence is still NOT_INSTALLED.
    installError = null;
    await runStatusFetch(() => false);
  };

  const install = async (): Promise<ClaudeCliPresence | null> => {
    if (!mounted) return null;
    installing = true;
    installError = null;
    try {
      const res = await fetchFn(`${baseUrl}${API_INTEGRATIONS_INSTALL_CLAUDE_CODE}`, {
        method: "POST",
      });
      if (!mounted) return null;
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        if (!mounted) return null;
        installError = formatInstallError(res.status, body);
        return null;
      }
      const body = (await res.json()) as InstallClaudeCodeResponse;
      if (!mounted) return null;
      presence = body.presence;
      return body.presence;
    } catch (err) {
      if (!mounted) return null;
      installError = err instanceof Error ? err.message : String(err);
      return null;
    } finally {
      if (mounted) installing = false;
    }
  };

  $effect(() => {
    if (!getActive()) {
      loading = false;
      return;
    }
    let cancelled = false;
    loading = true;
    void runStatusFetch(() => cancelled);
    return () => {
      cancelled = true;
    };
  });

  return {
    get presence() {
      return presence;
    },
    get loading() {
      return loading;
    },
    get error() {
      return error;
    },
    get installing() {
      return installing;
    },
    get installError() {
      return installError;
    },
    install,
    refetch,
  };
}

interface InstallErrorBody {
  code?: string;
  message?: string;
  stderrTail?: string;
  exitCode?: number | null;
}

/** Map an install error response to a user-facing line. */
function formatInstallError(status: number, body: unknown): string {
  const b = (body ?? null) as InstallErrorBody | null;
  if (b?.code === "UNSUPPORTED_PLATFORM") {
    return "Automatic install isn't available on this operating system. Install Claude Code manually, then check again.";
  }
  if (b?.code === "INSTALL_IN_PROGRESS") {
    return "An install is already in progress.";
  }
  const tail = b?.stderrTail?.trim();
  if (tail) {
    const exit = typeof b?.exitCode === "number" ? b.exitCode : "?";
    return `Install failed (exit ${exit}). ${tail}`;
  }
  return b?.message ?? `Install failed (status ${status}).`;
}
