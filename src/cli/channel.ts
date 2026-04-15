/**
 * Tandem channel subcommand — npm-delivered entry for the plugin
 * `tandem-channel` MCP server. Runs the unified preflight, then hands off to
 * the shared channel shim runtime in src/channel/run.ts.
 */

import { runChannel } from "../channel/run.js";
import { ensureTandemServer } from "./preflight.js";

export async function runChannelCli(): Promise<void> {
  await ensureTandemServer();
  await runChannel({ skipReachabilityLog: true });
}
