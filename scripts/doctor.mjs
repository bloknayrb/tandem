#!/usr/bin/env node

/**
 * Tandem Doctor — standalone shim for `npm run doctor`.
 *
 * The diagnostics logic lives in `src/cli/doctor.ts` (a single source of truth
 * shared with the bundled `tandem doctor` CLI subcommand). This shim only
 * parses `--json`, delegates to `runDoctorCli`, and applies the exit code.
 *
 * Run via tsx (see the `doctor` script in package.json) so the TypeScript
 * module loads directly in dev without requiring a prior build. The bundled
 * CLI path (`tandem doctor`) imports the same module from `dist/cli`.
 */

import { runDoctorCli } from "../src/cli/doctor.ts";

// The only recognized flag is --json; reject anything else up-front so a typo
// like `--jsoon` doesn't silently produce TTY output a caller can't parse.
const cliArgs = process.argv.slice(2);
const unknownArgs = cliArgs.filter((arg) => arg !== "--json");
if (unknownArgs.length > 0) {
  console.error(`tandem doctor: unknown argument(s): ${unknownArgs.join(", ")}`);
  console.error(`Usage: npm run doctor [--json]`);
  process.exit(2);
}

const exitCode = await runDoctorCli({ json: cliArgs.includes("--json") });
if (exitCode !== 0) process.exit(exitCode);
