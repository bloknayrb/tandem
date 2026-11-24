#!/usr/bin/env node
// Prints what the review model did (#1831): tool names with counts, how many
// calls were denied, turns and duration. Never tool inputs or results: the
// repo is public, so this log is too, and denial records carry the paths the
// model asked for. Holds no token. Node built-ins only.
//
// Usage: node observe.mjs <stream.jsonl>

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Pure summary of a stream-json transcript. */
export function summarize(streamText) {
  const tools = {};
  let denials = 0;
  let turns = null;
  let durationMs = null;
  for (const line of streamText.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === "tool_use" && typeof block.name === "string") {
          // Tool names are model-chosen only within the fixed tool set, but
          // keep them to a safe character class before printing anyway.
          const name = block.name.replace(/[^\w.-]/g, "?").slice(0, 64);
          tools[name] = (tools[name] ?? 0) + 1;
        }
      }
    }
    if (event?.type === "result") {
      denials = Array.isArray(event.permission_denials) ? event.permission_denials.length : 0;
      turns = Number.isInteger(event.num_turns) ? event.num_turns : null;
      durationMs = Number.isFinite(event.duration_ms) ? event.duration_ms : null;
    }
  }
  return { tools, denials, turns, durationMs };
}

function main() {
  const [streamPath] = process.argv.slice(2);
  let text = "";
  try {
    text = readFileSync(streamPath, "utf8");
  } catch {
    console.log("no stream");
    return;
  }
  const s = summarize(text);
  for (const [name, count] of Object.entries(s.tools).sort()) console.log(`tool ${name} x${count}`);
  console.log(`denials ${s.denials}`);
  console.log(`turns ${s.turns ?? "-"} duration_ms ${s.durationMs ?? "-"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
