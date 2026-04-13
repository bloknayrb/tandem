#!/usr/bin/env node
// Normalizes CRLF → LF and ensures a trailing newline for file types
// that Biome 2.x doesn't format (YAML, Markdown). Used by lint-staged.
import { readFileSync, writeFileSync } from "fs";

for (const file of process.argv.slice(2)) {
  const original = readFileSync(file, "utf8");
  const normalized = original.replace(/\r\n/g, "\n").trimEnd() + "\n";
  if (normalized !== original) {
    writeFileSync(file, normalized, "utf8");
  }
}
