#!/usr/bin/env node
// Writes the numbered diff the review model reads (#1831): every added or
// context line prefixed with its line number in the new file, so findings
// cite real file lines and land as inline comments. The raw diff is kept
// separately for post.mjs's line mapping. No npm dependencies.
//
// Usage: node number-diff.mjs <pr.diff> > numbered.diff

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { numberDiff } from "./post.mjs";

function main() {
  const [diffPath] = process.argv.slice(2);
  if (!diffPath) {
    console.error("usage: number-diff.mjs <pr.diff>");
    process.exit(64);
  }
  process.stdout.write(numberDiff(readFileSync(diffPath, "utf8")));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
