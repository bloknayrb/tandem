import { onDestroy } from "svelte";

import type {
  ClaudeCliPresence,
  ClaudeCliStatusResponse,
  InstallClaudeCodeResponse,
} from "../../shared/integrations/contract.js";

export interface CliStatusState {
  readonly presence: ClaudeCliPresence | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly installing: boolean;
  readonly installError: string | null;
  install: () => Promise<ClaudeCliPresence | null>;
  refetch: () => Promise<void>;
}

export interface CliStatusConfig {
  name: string;
  statusPath: string;
  installPath: string;
}

/** Provider-neutral binary status/install state machine. */
export function createCliStatus(
  getActive: () => boolean,
  baseUrl: string,
  fetchFn: typeof fetch,
  config: CliStatusConfig,
): CliStatusState {
  let presence = $state<ClaudeCliPresence | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let installing = $state(false);
  let installError = $state<string | null>(null);
  let mounted = true;

  onDestroy(() => {
    mounted = false;
  });

  const runStatusFetch = async (isStale: () => boolean): Promise<void> => {
    try {
      const res = await fetchFn(`${baseUrl}${config.statusPath}`);
      if (!mounted || isStale()) return;
      if (!res.ok) {
        error = `Could not check for ${config.name} (status ${res.status}).`;
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
    installError = null;
    await runStatusFetch(() => false);
  };

  const install = async (): Promise<ClaudeCliPresence | null> => {
    if (!mounted) return null;
    installing = true;
    installError = null;
    try {
      const res = await fetchFn(`${baseUrl}${config.installPath}`, { method: "POST" });
      if (!mounted) return null;
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        if (!mounted) return null;
        installError = formatInstallError(config.name, res.status, body);
        return null;
      }
      const body = (await res.json()) as InstallClaudeCodeResponse;
      if (!mounted) return null;
      presence = body.presence;
      if (body.presence === "NOT_INSTALLED") {
        installError =
          `The installer finished but ${config.name} wasn't detected yet. Open a new terminal and ` +
          `click "Check again", or install ${config.name} manually.`;
      }
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

function formatInstallError(name: string, status: number, body: unknown): string {
  const b = (body ?? null) as InstallErrorBody | null;
  if (b?.code === "UNSUPPORTED_PLATFORM") {
    return `Automatic install isn't available on this operating system. Install ${name} manually, then check again.`;
  }
  if (b?.code === "INSTALL_IN_PROGRESS") return "An install is already in progress.";
  const tail = b?.stderrTail?.trim();
  if (tail) {
    const exit = typeof b?.exitCode === "number" ? b.exitCode : "?";
    return `Install failed (exit ${exit}). ${tail}`;
  }
  return b?.message ?? `Install failed (status ${status}).`;
}
