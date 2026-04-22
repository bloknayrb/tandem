/**
 * Tandem CLI — entry point for the `tandem` global command.
 * Shebang is added by tsup banner at build time.
 *
 * Usage:
 *   tandem            Start the Tandem server and open the editor
 *   tandem setup      Register Tandem MCP tools with Claude Code / Claude Desktop
 *   tandem setup --force  Register even if no Claude install is auto-detected
 *   tandem --help     Show this help
 *   tandem --version  Show version
 */

import updateNotifier from "update-notifier";

process.once("uncaughtException", (err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  try {
    process.stderr.write(`[tandem cli] uncaughtException: ${msg}\n`);
  } catch {
    /* EPIPE */
  }
  process.exit(1);
});
process.once("unhandledRejection", (reason: unknown) => {
  const detail = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`[tandem cli] unhandledRejection: ${detail}\n`);
  process.exit(1);
});

// Injected at build time by tsup define; declared here for TypeScript
declare const __TANDEM_VERSION__: string;
const version = typeof __TANDEM_VERSION__ !== "undefined" ? __TANDEM_VERSION__ : "0.0.0-dev";

const args = process.argv.slice(2);

// Skip the update notifier for stdio subcommands — the output is machine-consumed
// by Claude Desktop's plugin loader, and any incidental write risks corrupting
// the MCP wire or producing log noise no human will ever read.
const isStdioMode = args[0] === "mcp-stdio" || args[0] === "channel";
if (!isStdioMode) {
  updateNotifier({ pkg: { name: "tandem-editor", version } }).notify();
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`tandem v${version}

Usage:
  tandem                            Start Tandem server and open the editor
  tandem setup                      Register MCP tools with Claude Code / Claude Desktop
  tandem setup --force              Register to default paths regardless of detection
  tandem setup --with-channel-shim  Also register the stdio channel shim (legacy opt-in)
  tandem rotate-token               Rotate the auth token with a 60-second grace window
  tandem mcp-stdio                  Run as a stdio MCP server proxying to local HTTP
                                    (used by the plugin's Cowork bridge; requires
                                    tandem server running on the host)
  tandem channel                    Run the Tandem channel shim (stdio MCP)
                                    (used by the plugin's tandem-channel entry)
  tandem --version
  tandem --help
`);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(version);
  process.exit(0);
}

try {
  if (args[0] === "setup") {
    const { runSetup } = await import("./setup.js");
    await runSetup({
      force: args.includes("--force"),
      withChannelShim: args.includes("--with-channel-shim"),
    });
  } else if (args[0] === "mcp-stdio") {
    const { runMcpStdio } = await import("./mcp-stdio.js");
    await runMcpStdio();
  } else if (args[0] === "channel") {
    const { runChannelCli } = await import("./channel.js");
    await runChannelCli();
  } else if (args[0] === "rotate-token") {
    const { rotateToken } = await import("./rotate-token.js");
    await rotateToken();
  } else if (!args[0] || args[0] === "start") {
    const { runStart } = await import("./start.js");
    runStart();
  } else {
    console.error(`Unknown command: ${args[0]}`);
    console.error("Run 'tandem --help' for usage.");
    process.exit(1);
  }
} catch (err) {
  console.error(`\n[Tandem] Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  console.error("If this persists, try reinstalling: npm install -g tandem-editor\n");
  process.exit(1);
}
