/**
 * Tandem CLI — entry point for the `tandem` global command.
 * Shebang is added by tsup banner at build time.
 *
 * Usage:
 *   tandem            Start the Tandem server and open the browser
 *   tandem setup      Register Tandem MCP tools with Claude Code / Claude Desktop
 *   tandem setup --force  Register even if no Claude install is auto-detected
 *   tandem --help     Show this help
 *   tandem --version  Show version
 */

import updateNotifier from "update-notifier";

// Injected at build time by tsup define; declared here for TypeScript
declare const __TANDEM_VERSION__: string;
const version = typeof __TANDEM_VERSION__ !== "undefined" ? __TANDEM_VERSION__ : "0.0.0-dev";

// Check for updates in background (non-blocking, throttled to once/day)
updateNotifier({ pkg: { name: "tandem-editor", version } }).notify();

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`tandem v${version}

Usage:
  tandem                            Start Tandem server and open the browser
  tandem setup                      Register MCP tools with Claude Code / Claude Desktop
  tandem setup --force              Register to default paths regardless of detection
  tandem setup --with-channel-shim  Also register the stdio channel shim (legacy opt-in)
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
