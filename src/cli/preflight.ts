/**
 * Shared preflight check for stdio MCP subcommands.
 *
 * Both `tandem mcp-stdio` and `tandem channel` need a live Tandem server on
 * localhost before they can do anything useful. If the server isn't running,
 * fail fast with a single clear error on stderr and exit 1 — otherwise
 * repeated handshake failures surface as reconnect-loop noise.
 */

import { resolveTandemUrl } from "../shared/cli-runtime.js";

const DEFAULT_TIMEOUT_MS = 2000;

export interface PreflightOptions {
  url?: string;
  timeoutMs?: number;
}

export async function ensureTandemServer(opts: PreflightOptions = {}): Promise<void> {
  const url = resolveTandemUrl(opts.url);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${url}/health`, { signal: controller.signal });
    if (!res.ok) {
      fail(url, `health endpoint returned HTTP ${res.status}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(url, msg);
  } finally {
    clearTimeout(timer);
  }
}

function fail(url: string, detail: string): never {
  process.stderr.write(
    `[tandem] Tandem server not reachable at ${url} (${detail}).\n` +
      `[tandem] Start the Tauri app or run \`tandem start\` on the host, then retry.\n`,
  );
  process.exit(1);
}
