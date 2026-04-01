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

// Injected at build time by tsup define; declared here for TypeScript
declare const __TANDEM_VERSION__: string;
const version = typeof __TANDEM_VERSION__ !== "undefined" ? __TANDEM_VERSION__ : "0.0.0-dev";

// TypeScript needs a top-level export to treat this as a module (enabling top-level await)
export {};

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`tandem v${version}

Usage:
  tandem                  Start Tandem server and open the browser
  tandem setup            Register MCP tools with Claude Code / Claude Desktop
  tandem setup --force    Register to default paths regardless of detection
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
    await runSetup({ force: args.includes("--force") });
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
