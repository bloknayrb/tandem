#!/usr/bin/env node
// Knowledge graph query CLI. See .claude/knowledge-graph/README.md for the
// schema and kill criterion.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const NODES_DIR = join(ROOT, ".claude/knowledge-graph/nodes");
const EDGES_PATH = join(ROOT, ".claude/knowledge-graph/edges.json");

// Minimal YAML subset: handles `key: value` and `- item` only. Does not handle
// quoted strings with colons, multi-line scalars, or nested maps. Sufficient
// for the current node schema; swap for the `yaml` package if the schema grows.
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
  return { frontmatter: fm, body: match[2] };
}

function loadNodes() {
  const nodes = new Map();
  for (const file of readdirSync(NODES_DIR)) {
    if (!file.endsWith(".md")) continue;
    const text = readFileSync(join(NODES_DIR, file), "utf8");
    const parsed = parseFrontmatter(text);
    if (!parsed) continue;
    const id = parsed.frontmatter.id;
    if (!id) continue;
    nodes.set(id, { ...parsed.frontmatter, _body: parsed.body, _path: file });
  }
  return nodes;
}

function loadEdges() {
  return JSON.parse(readFileSync(EDGES_PATH, "utf8")).edges;
}

function fmt(node) {
  return `${node.id.padEnd(36)}  [${node.type}] ${node.name}`;
}

function cmdList(nodes, args) {
  const filter = args[0];
  for (const node of [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (filter && node.type !== filter) continue;
    console.log(fmt(node));
  }
}

function cmdShow(nodes, args) {
  const id = args[0];
  const node = nodes.get(id);
  if (!node) {
    console.error(`No node: ${id}`);
    process.exit(1);
  }
  console.log(`# ${node.name}\n`);
  console.log(`id: ${node.id}`);
  console.log(`type: ${node.type}`);
  console.log(`last_verified: ${node.last_verified}`);
  console.log(`\nsources:`);
  for (const s of node.sources || []) console.log(`  - ${s}`);
  console.log(`\n${node._body.trim()}`);
}

function cmdNeighbors(nodes, edges, args) {
  const id = args[0];
  if (!nodes.has(id)) {
    console.error(`No node: ${id}`);
    process.exit(1);
  }
  const out = edges.filter((e) => e.from === id);
  const inc = edges.filter((e) => e.to === id);
  console.log(`# Neighbors of ${id}\n`);
  if (out.length) {
    console.log("Outgoing:");
    for (const e of out) {
      const target = nodes.get(e.to);
      const tname = target ? target.name : "(unknown)";
      console.log(`  --${e.type}--> ${e.to.padEnd(36)} ${tname}${e.note ? `  (${e.note})` : ""}`);
    }
  }
  if (inc.length) {
    console.log("\nIncoming:");
    for (const e of inc) {
      const src = nodes.get(e.from);
      const sname = src ? src.name : "(unknown)";
      console.log(
        `  ${e.from.padEnd(36)} --${e.type}--> ${id} ${sname ? `(${sname})` : ""}${e.note ? `  [${e.note}]` : ""}`,
      );
    }
  }
  if (!out.length && !inc.length) console.log("(no edges)");
}

function cmdRulesFor(nodes, edges, args) {
  const target = args[0];
  // Two modes: (a) target is a node id → list rules with `governs` edge to it
  // (b) target is a file path → list rules whose `sources` include that path
  const ruleIds = new Set();
  if (nodes.has(target)) {
    for (const e of edges) {
      if (e.to === target && e.type === "governs") {
        ruleIds.add(e.from);
      }
    }
  } else {
    for (const node of nodes.values()) {
      if (node.type !== "rule") continue;
      for (const s of node.sources || []) {
        if (target.includes(s) || s.includes(target)) {
          ruleIds.add(node.id);
          break;
        }
      }
    }
    // Also: rules governing concepts whose sources match
    for (const node of nodes.values()) {
      if (node.type !== "concept") continue;
      const matches = (node.sources || []).some((s) => target.includes(s) || s.includes(target));
      if (!matches) continue;
      for (const e of edges) {
        if (e.to === node.id && e.type === "governs") ruleIds.add(e.from);
      }
    }
  }
  if (!ruleIds.size) {
    console.log(`No rules found governing ${target}`);
    return;
  }
  console.log(`# Rules governing ${target}\n`);
  for (const rid of ruleIds) {
    const r = nodes.get(rid);
    if (r) console.log(`- ${r.name}  (${rid})`);
  }
}

function cmdSearch(nodes, args) {
  const q = (args[0] || "").toLowerCase();
  if (!q) {
    console.error("Usage: kg search <query>");
    process.exit(1);
  }
  for (const node of nodes.values()) {
    const hay = `${node.id} ${node.name} ${node._body}`.toLowerCase();
    if (hay.includes(q)) console.log(fmt(node));
  }
}

function help() {
  console.log(`Tandem knowledge graph query CLI

Usage:
  kg list [<type>]              list all nodes (optional filter: concept|rule|adr)
  kg show <id>                  show full node body
  kg neighbors <id>             show edges into and out of a node
  kg rules-for <id-or-file>     list rules governing a concept (by id) or file path
  kg search <text>              substring search across all nodes
`);
}

const [, , cmd, ...args] = process.argv;
const nodes = loadNodes();
const edges = loadEdges();

switch (cmd) {
  case "list":
    cmdList(nodes, args);
    break;
  case "show":
    cmdShow(nodes, args);
    break;
  case "neighbors":
  case "n":
    cmdNeighbors(nodes, edges, args);
    break;
  case "rules-for":
    cmdRulesFor(nodes, edges, args);
    break;
  case "search":
    cmdSearch(nodes, args);
    break;
  default:
    help();
    process.exit(cmd ? 1 : 0);
}
