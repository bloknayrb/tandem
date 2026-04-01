#!/usr/bin/env node
/**
 * Tandem CLI — entry point for the `tandem` global command.
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

// Make this a module so top-level await is allowed
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

if (args[0] === "setup") {
  const { runSetup } = await import("./setup.js");
  await runSetup({ force: args.includes("--force") });
} else {
  const { runStart } = await import("./start.js");
  runStart();
}
