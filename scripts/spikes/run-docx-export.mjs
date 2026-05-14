#!/usr/bin/env node
// Spike runner (#576): markdown -> Y.Doc -> .docx via the `docx` npm package.
//
// Usage:
//   node scripts/spikes/run-docx-export.mjs [input.md] [output.docx]
// Defaults to scripts/spikes/fixtures/sample-input.md ->
// scripts/spikes/fixtures/sample-output.docx.
//
// This is a spike-only script. It uses tsx to load the TS module directly so
// no build step is required.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const runner = path.resolve(__dirname, "run-docx-export.runner.ts");

const args = process.argv.slice(2);
const tsxBin = path.resolve(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);

// On Windows, .cmd shims must be invoked through the shell.
const child = spawn(tsxBin, [runner, ...args], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
});
child.on("exit", (code) => process.exit(code ?? 0));
