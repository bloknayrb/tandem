#!/usr/bin/env node
// Knowledge graph validator. Fails on:
//   - missing required frontmatter fields
//   - `source:` paths that don't exist (file refs only; doc anchors not checked)
//   - edge endpoints that don't resolve to a node
//   - duplicate node ids
// Warns on:
//   - last_verified older than 60 days

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const NODES_DIR = join(ROOT, ".claude/knowledge-graph/nodes");
const EDGES_PATH = join(ROOT, ".claude/knowledge-graph/edges.json");

const REQUIRED = ["id", "type", "name", "last_verified", "sources"];
const VALID_TYPES = new Set(["concept", "rule", "adr"]);
const VALID_EDGES = new Set([
  "governs",
  "decided_by",
  "supersedes",
  "implemented_in",
  "refines",
  "related",
  "enforced_by",
]);

const errors = [];
const warnings = [];

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;
  const fm = {};
  let currentKey = null;
  for (const line of match[1].split("\n")) {
    if (/^\s*-\s/.test(line) && currentKey) {
      const val = line.replace(/^\s*-\s*/, "").trim();
      if (!Array.isArray(fm[currentKey])) fm[currentKey] = [];
      fm[currentKey].push(val);
    } else {
      const kv = line.match(/^([a-z_]+):\s*(.*)$/);
      if (kv) {
        currentKey = kv[1];
        const v = kv[2].trim();
        fm[currentKey] = v === "" ? [] : v;
      }
    }
  }
  return fm;
}

const nodes = new Map();

for (const file of readdirSync(NODES_DIR)) {
  if (!file.endsWith(".md")) continue;
  const path = join(NODES_DIR, file);
  const text = readFileSync(path, "utf8");
  const fm = parseFrontmatter(text);
  if (!fm) {
    errors.push(`${file}: no parseable frontmatter`);
    continue;
  }
  for (const key of REQUIRED) {
    if (
      fm[key] === undefined ||
      fm[key] === "" ||
      (Array.isArray(fm[key]) && fm[key].length === 0)
    ) {
      errors.push(`${file}: missing required field "${key}"`);
    }
  }
  if (fm.id) {
    if (nodes.has(fm.id)) errors.push(`${file}: duplicate node id "${fm.id}"`);
    nodes.set(fm.id, { ...fm, _file: file });
  }
  if (fm.type && !VALID_TYPES.has(fm.type)) {
    errors.push(`${file}: invalid type "${fm.type}" (allowed: ${[...VALID_TYPES].join("|")})`);
  }
  if (fm.id && file !== `${fm.id}.md`) {
    errors.push(`${file}: filename should be "${fm.id}.md" to match id`);
  }
  for (const source of fm.sources || []) {
    const cleanPath = source.replace(/[#:].*$/, "");
    const absPath = resolve(ROOT, cleanPath);
    if (!existsSync(absPath)) {
      errors.push(`${file}: source path does not exist: ${source}`);
    }
  }
  if (fm.last_verified) {
    const verified = new Date(fm.last_verified);
    if (isNaN(verified.getTime())) {
      errors.push(`${file}: last_verified is not a valid date: ${fm.last_verified}`);
    } else {
      const days = (Date.now() - verified.getTime()) / 86400000;
      if (days > 60) {
        warnings.push(`${file}: last_verified is ${Math.round(days)} days old — re-read and bump`);
      }
    }
  }
}

const edgesData = JSON.parse(readFileSync(EDGES_PATH, "utf8"));
if (!Array.isArray(edgesData.edges)) {
  errors.push(`edges.json: missing "edges" array`);
} else {
  for (const [i, e] of edgesData.edges.entries()) {
    const loc = `edges[${i}]`;
    if (!e.from || !e.to || !e.type) {
      errors.push(`${loc}: missing from/to/type`);
      continue;
    }
    if (!VALID_EDGES.has(e.type)) {
      errors.push(`${loc}: invalid edge type "${e.type}"`);
    }
    if (!nodes.has(e.from)) errors.push(`${loc}: from "${e.from}" does not resolve`);
    if (!nodes.has(e.to)) errors.push(`${loc}: to "${e.to}" does not resolve`);
    if (e.from === e.to) errors.push(`${loc}: self-edge (${e.from} -> ${e.to})`);
  }
}

console.log(`Loaded ${nodes.size} nodes, ${edgesData.edges?.length ?? 0} edges`);

if (warnings.length) {
  console.warn(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.warn(`  ⚠  ${w}`);
}

if (errors.length) {
  console.error(`\n${errors.length} error(s):`);
  for (const e of errors) console.error(`  ✗  ${e}`);
  process.exit(1);
}

console.log("\nKnowledge graph OK ✓");
