/**
 * Shared preflight check for stdio MCP subcommands.
 *
 * Both `tandem mcp-stdio` and `tandem channel` need a live Tandem server on
 * localhost before they can do anything useful. Two flavors:
 *
 * - `ensureTandemServer` — fail fast via stderr + exit(1) when the server
 *   isn't reachable. Used by `tandem channel`, whose stdio transport can't
 *   meaningfully respond on its own.
 * - `probeTandemServer` — returns a result without side effects. Used by
 *   `tandem mcp-stdio`, which starts its stdio transport before preflight
 *   so it can synthesize -32000 JSON-RPC errors for any in-flight request
 *   before exiting (issue #336).
 */

import { resolveTandemUrl } from "../shared/cli-runtime.js";

const DEFAULT_TIMEOUT_MS = 2000;

export interface PreflightOptions {
  url?: string;
  timeoutMs?: number;
}

export type PreflightProbe = { ok: true } | { ok: false; url: string; reason: string };

export async function probeTandemServer(opts: PreflightOptions = {}): Promise<PreflightProbe> {
  const url = resolveTandemUrl(opts.url);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${url}/health`, { signal: controller.signal });
    if (!res.ok) {
      return { ok: false, url, reason: `health endpoint returned HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, url, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function ensureTandemServer(opts: PreflightOptions = {}): Promise<void> {
  const probe = await probeTandemServer(opts);
  if (!probe.ok) {
    process.stderr.write(
      `[tandem] Tandem server not reachable at ${probe.url} (${probe.reason}).\n` +
        `[tandem] Start the Tauri app or run \`tandem start\` on the host, then retry.\n`,
    );
    process.exit(1);
  }
}
