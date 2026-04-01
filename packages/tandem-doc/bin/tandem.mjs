#!/usr/bin/env node
/**
 * tandem-doc → delegates to tandem-editor's CLI.
 * Install either package to get the `tandem` command.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// tandem-editor's "main" field points to dist/cli/index.js
const cliPath = require.resolve("tandem-editor");
await import(cliPath);
