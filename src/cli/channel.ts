/**
 * Tandem channel subcommand — npm-delivered entry for the plugin
 * `tandem-channel` MCP server. Hands straight off to the shared channel shim
 * runtime in src/channel/run.ts.
 *
 * No preflight (#1890). The plugin spawns this as an MCP server the moment
 * Claude Code starts, which is routinely before Tandem is up — the desktop app
 * still booting, or the user opening Claude Code first. A fatal `/health` probe
 * here killed the host before `runChannel` installed the never-exiting consumer
 * #1804 shipped, and the push path was then gone for the rest of the session.
 * Reachability is the consumer's: reported once on stderr, never fatal.
 *
 * Narrowing, recorded: the two probes are not equivalent. `ensureTandemServer`
 * distinguished an UNHEALTHY server (non-2xx `/health`) from an unreachable
 * one; `runChannel`'s surviving `checkServerReachable` is a raw TCP connect and
 * resolves true for anything listening on the port, wedged Tandem included. So
 * what survives covers the DOWN case only.
 */

import { runChannel } from "../channel/run.js";

export async function runChannelCli(): Promise<void> {
  await runChannel();
}
