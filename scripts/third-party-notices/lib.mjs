/**
 * Pure helpers for scripts/third-party-notices/generate.mjs.
 *
 * Kept free of process/argv/cwd so tests/scripts/third-party-notices.test.ts
 * can drive them against a fixture tree. Every function here must be
 * deterministic: the same inputs produce byte-identical output, because the
 * notices file is regenerated on every build and a diff in it should only ever
 * mean the shipped set changed.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A file in a package or crate root that carries licence or notice text.
 * Matches LICENSE, LICENCE.md, LICENSE-MIT, license-apache-2.0, COPYING,
 * NOTICE, COPYRIGHT and the like. Case-insensitive because the `windows`
 * crates ship lower-case names.
 */
export const LICENCE_FILE_RE =
  /^(?!.*\.(?:[cm]?[jt]sx?|json|map|d\.ts|rs|py|html?|css)$)(un)?(licen[cs]e|copying|notice|copyright)([.\-_].*)?$/i;
// (The lookahead keeps code out: jszip ships lib/license_header.js.)

/** Code-unit comparison: `localeCompare` varies with the machine's ICU data. */
export function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** CRLF → LF, strip a BOM and trailing whitespace, so the same text dedups. */
export function normalizeText(text) {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/**
 * The package root a bundled module came from: the LAST `node_modules/<name>`
 * (or `node_modules/@scope/<name>`) segment of its path. Not the nearest
 * package.json, because packages ship `{"type":"module"}` marker files in
 * subdirectories that carry no name or licence.
 *
 * Returns `{ root, name }`, or null when the path is not inside node_modules
 * (first-party source).
 */
export function packageRootOf(modulePath) {
  const parts = modulePath.replace(/\\/g, "/").split("/");
  const idx = parts.lastIndexOf("node_modules");
  if (idx === -1 || idx + 1 >= parts.length) return null;
  const first = parts[idx + 1];
  const nameParts = first.startsWith("@") ? parts.slice(idx + 1, idx + 3) : [first];
  if (nameParts.length === 0 || (first.startsWith("@") && nameParts.length < 2)) return null;
  return {
    root: parts.slice(0, idx + 1 + nameParts.length).join("/"),
    name: nameParts.join("/"),
  };
}

/** Licence/notice files directly in `dir`, sorted, as `{ file, text }`. */
export function readLicenceFiles(dir, extraFiles = []) {
  const names = new Set();
  for (const entry of readdirSync(dir)) {
    if (LICENCE_FILE_RE.test(entry) && statSync(join(dir, entry)).isFile()) names.add(entry);
  }
  for (const extra of extraFiles) {
    if (extra && existsSync(join(dir, extra)) && statSync(join(dir, extra)).isFile()) {
      names.add(extra.replace(/\\/g, "/"));
    }
  }
  return [...names].sort(byCodeUnit).map((file) => ({
    file,
    text: normalizeText(readFileSync(join(dir, file), "utf8")),
  }));
}

/**
 * An aggregate notices file a package ships for code it vendored, e.g.
 * @sentry/server-utils' build/THIRD-PARTY-LICENSES.txt.
 */
export const BUNDLED_NOTICES_RE = /^third[-_ ]?party[-_ ]?(licen[cs]es?|notices?)(\.(txt|md))?$/i;

/**
 * Licence files that cover code a package or crate VENDORED rather than its
 * own: an aggregate third-party notices file anywhere, a root file whose name
 * says third-party (LICENSE-THIRD-PARTY), and any licence-shaped file BELOW the
 * root (tracing-core's src/spin/LICENSE, regex-syntax's
 * src/unicode_tables/LICENSE-UNICODE, ring's third_party/fiat/LICENSE). That
 * code ships, so these texts are reproduced; they never count as the
 * component's own licence. Searched four levels deep, never into node_modules.
 */
export function findVendoredLicenceFiles(root, depth = 4, prefix = "") {
  const found = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (depth > 1 && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        found.push(...findVendoredLicenceFiles(root, depth - 1, rel));
      }
    } else if (
      BUNDLED_NOTICES_RE.test(entry.name) ||
      (prefix === "" && /third[-_ ]?party/i.test(entry.name) && LICENCE_FILE_RE.test(entry.name)) ||
      (prefix !== "" && LICENCE_FILE_RE.test(entry.name))
    ) {
      found.push(rel);
    }
  }
  return found.sort(byCodeUnit);
}

/**
 * A component's licence texts: its root licence files plus `extraFiles`
 * (own), and every vendored licence file, marked `vendored: true`.
 */
export function readComponentTexts(root, extraFiles = []) {
  const vendored = new Set(findVendoredLicenceFiles(root));
  return readLicenceFiles(root, [...extraFiles, ...vendored]).map((t) =>
    vendored.has(t.file) ? { ...t, vendored: true } : t,
  );
}

/** Read an npm package's identity and licence material from its root. */
export function readNpmPackage(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  let license = pkg.license;
  if (license && typeof license === "object") license = license.type;
  if (!license && Array.isArray(pkg.licenses)) {
    license = pkg.licenses
      .map((l) => (typeof l === "string" ? l : l?.type))
      .filter(Boolean)
      .join(" OR ");
  }
  let repository = pkg.repository;
  if (repository && typeof repository === "object") repository = repository.url;
  return {
    name: pkg.name,
    version: pkg.version,
    license: license || "UNKNOWN",
    repository: repository || pkg.homepage || "",
    texts: readComponentTexts(root),
  };
}

// ── SPDX classification ─────────────────────────────────────────────────────

/**
 * Licences that only ask for the notice to be kept. Anything else (copyleft,
 * weak copyleft, unknown, custom) is reported for a human decision.
 */
export const PERMISSIVE = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-1-Clause",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSL-1.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "Python-2.0",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "Unlicense",
  "WTFPL",
  "Zlib",
]);

function tokenize(expr) {
  return expr
    .replace(/\s*\/\s*/g, " OR ") // old crates.io syntax: "MIT/Apache-2.0"
    .replace(/[()]/g, " $& ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Parse an SPDX expression into a tree of { op: "OR"|"AND", args } and
 * { id } leaves. `WITH <exception>` folds into its licence (an exception only
 * grants more), and a trailing `+` is dropped. Throws on malformed input so the
 * caller can classify it as unknown rather than guess.
 */
export function parseSpdx(expr) {
  const tokens = tokenize(expr);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function primary() {
    const tok = next();
    if (tok === undefined) throw new Error(`unexpected end of "${expr}"`);
    if (tok === "(") {
      const inner = orExpr();
      if (next() !== ")") throw new Error(`unbalanced "${expr}"`);
      return inner;
    }
    if (tok === ")" || /^(AND|OR|WITH)$/i.test(tok))
      throw new Error(`unexpected ${tok} in "${expr}"`);
    const id = tok.replace(/\+$/, "");
    // An exception only widens the grant, so classification follows the base licence.
    if (peek() && /^WITH$/i.test(peek())) {
      next();
      if (!next()) throw new Error(`dangling WITH in "${expr}"`);
    }
    return { id };
  }
  function andExpr() {
    const args = [primary()];
    while (peek() && /^AND$/i.test(peek())) {
      next();
      args.push(primary());
    }
    return args.length === 1 ? args[0] : { op: "AND", args };
  }
  function orExpr() {
    const args = [andExpr()];
    while (peek() && /^OR$/i.test(peek())) {
      next();
      args.push(andExpr());
    }
    return args.length === 1 ? args[0] : { op: "OR", args };
  }
  const tree = orExpr();
  if (pos !== tokens.length) throw new Error(`trailing tokens in "${expr}"`);
  return tree;
}

/** True when the licensee can satisfy the expression using permissive terms only. */
function satisfiablePermissively(node) {
  if (node.id) return PERMISSIVE.has(node.id);
  if (node.op === "AND") return node.args.every(satisfiablePermissively);
  return node.args.some(satisfiablePermissively);
}

/** True when every way of satisfying the expression is permissive. */
function whollyPermissive(node) {
  if (node.id) return PERMISSIVE.has(node.id);
  return node.args.every(whollyPermissive);
}

/**
 * - "permissive": every option is permissive.
 * - "permissive-option": a dual/multi licence where a permissive choice exists
 *   (e.g. "MIT OR GPL-3.0-or-later") — still reported, marked as such.
 * - "not-allowlisted": no way to comply using only PERMISSIVE licences. That
 *   includes copyleft (MPL, LGPL, GPL) and also permissive-in-spirit licences
 *   nobody has added to the allowlist yet (CDLA-Permissive-2.0).
 * - "unknown": missing, UNLICENSED, SEE LICENSE IN, or unparseable.
 */
export function classifyLicence(expr) {
  if (!expr || /^(UNKNOWN|UNLICENSED|NONE)$/i.test(expr.trim()) || /^SEE LICEN[CS]E/i.test(expr)) {
    return "unknown";
  }
  let tree;
  try {
    tree = parseSpdx(expr);
  } catch {
    return "unknown";
  }
  if (whollyPermissive(tree)) return "permissive";
  if (satisfiablePermissively(tree)) return "permissive-option";
  return "not-allowlisted";
}

// ── Licence text presence ───────────────────────────────────────────────────

/**
 * Phrases that occur only in the FULL text of a licence, by licence family. A
 * COPYING file that just says "licensed under MIT or Apache-2.0, see
 * LICENSE-MIT" (siphasher), or a package whose only licence-shaped file is the
 * notices of code IT vendored (@sentry/server-utils), carries none of them.
 */
export const LICENCE_FINGERPRINTS = [
  // Not "permission is hereby granted": the Unicode and Boost licences say that too.
  ["mit", /to\s+deal\s+in\s+the\s+software\s+without\s+restriction/i],
  ["apache", /terms and conditions for use,? reproduction,? and distribution/i],
  ["isc", /permission to use,? copy,? modify,? and\/or distribute this software/i],
  ["bsd", /redistribution and use in source and binary forms/i],
  ["mpl", /mozilla public license,? version 2\.0/i],
  ["zlib", /provided ['‘’]as[- ]is['‘’],? without any express or implied/i],
  ["unlicense", /this is free and unencumbered software released into the public domain/i],
  ["cc0", /cc0 1\.0 universal|creative commons legal code/i],
  ["bsl", /boost software license/i],
  ["unicode", /unicode license v3|unicode,? inc\.? license agreement/i],
  ["cdla", /community data license agreement/i],
  ["blueoak", /blue oak model license/i],
  ["wtfpl", /do what the fuck you want to/i],
  ["python", /python software foundation license/i],
];

/**
 * Which family's text satisfies an SPDX id. For an id not listed here,
 * licenceCovered accepts any full text and licenceFullyCovered accepts none.
 */
const ID_FAMILY = {
  MIT: "mit",
  "MIT-0": "mit",
  "Apache-2.0": "apache",
  ISC: "isc",
  "0BSD": "isc",
  "BSD-1-Clause": "bsd",
  "BSD-2-Clause": "bsd",
  "BSD-3-Clause": "bsd",
  "MPL-2.0": "mpl",
  Zlib: "zlib",
  Unlicense: "unlicense",
  "CC0-1.0": "cc0",
  "BSL-1.0": "bsl",
  "Unicode-3.0": "unicode",
  "Unicode-DFS-2016": "unicode",
  "CDLA-Permissive-2.0": "cdla",
  "BlueOak-1.0.0": "blueoak",
  WTFPL: "wtfpl",
  "Python-2.0": "python",
};

/** Families whose full text appears in the component's OWN (non-vendored) texts. */
function ownFamilies(texts) {
  const found = new Set();
  for (const t of texts) {
    if (t.vendored) continue;
    for (const [family, re] of LICENCE_FINGERPRINTS) if (re.test(t.text)) found.add(family);
  }
  return found;
}

export function hasFullLicenceText(texts) {
  return ownFamilies(texts).size > 0;
}

/**
 * Like licenceCovered, but every OR option too. Overrides are held to this:
 * reproducing one option of "MIT OR Apache-2.0" would choose a licence on the
 * project's behalf, and that choice is the owner's, not the build's.
 */
export function licenceFullyCovered(expr, texts) {
  const families = ownFamilies(texts);
  let tree;
  try {
    tree = parseSpdx(expr);
  } catch {
    return families.size > 0;
  }
  const walk = (node) => {
    if (node.id) {
      const family = ID_FAMILY[node.id];
      // An id with no known family cannot be shown reproduced, so it fails.
      return family !== undefined && families.has(family);
    }
    return node.args.every(walk);
  };
  return walk(tree);
}

/**
 * True when the component's own texts reproduce a licence for every term the
 * expression requires: each term of an AND, at least one option of an OR.
 * "(MIT AND Zlib)" with only an MIT file is NOT covered. An unparseable or
 * unknown expression needs at least one full text.
 */
export function licenceCovered(expr, texts) {
  const families = ownFamilies(texts);
  if (families.size === 0) return false;
  let tree;
  try {
    tree = parseSpdx(expr);
  } catch {
    return true;
  }
  const walk = (node) => {
    if (node.id) {
      const family = ID_FAMILY[node.id];
      return family === undefined || families.has(family);
    }
    return node.op === "AND" ? node.args.every(walk) : node.args.some(walk);
  };
  return walk(tree);
}

// ── Rendering ───────────────────────────────────────────────────────────────

/**
 * Render one section. `key` prefixes the licence-text labels ("npm text 3"),
 * so the sections of one file never share a label. `components` are
 * `{ name, version, license, includedIn: string[], repository, texts: [{file, text}], textSource?, notes? }`.
 *
 * Licence texts are deduplicated by exact (normalised) content and numbered in
 * first-appearance order over the sorted index, so hundreds of crates carrying
 * the identical Apache-2.0 text print it once.
 */
export function renderSection(key, title, components) {
  const sorted = [...components].sort(
    (a, b) => byCodeUnit(a.name, b.name) || byCodeUnit(a.version, b.version),
  );
  const textIds = new Map(); // text -> id
  const textUsers = new Map(); // id -> [label]
  const lines = [];
  lines.push("=".repeat(78));
  lines.push(`${title} (${sorted.length})`);
  lines.push("=".repeat(78));
  lines.push("");
  for (const c of sorted) {
    const label = `${c.name}@${c.version}`;
    const refs = [];
    const vendoredRefs = [];
    for (const t of c.texts) {
      if (!textIds.has(t.text)) {
        const id = `${textIds.size + 1}`;
        textIds.set(t.text, id);
        textUsers.set(id, []);
      }
      const id = textIds.get(t.text);
      const bucket = t.vendored ? vendoredRefs : refs;
      if (!refs.includes(id) && !vendoredRefs.includes(id)) {
        bucket.push(id);
        textUsers.get(id).push(label);
      }
    }
    lines.push(`${label}`);
    lines.push(`  Licence: ${c.license}`);
    if (c.includedIn?.length) lines.push(`  Included in: ${c.includedIn.join(", ")}`);
    if (c.repository) lines.push(`  Source: ${c.repository}`);
    if (c.textSource) lines.push(`  Licence text from: ${c.textSource}`);
    for (const note of c.notes ?? []) lines.push(`  Note: ${note}`);
    const fmt = (ids) => ids.map((r) => `[${key} text ${r}]`).join(", ");
    lines.push(`  Licence text: ${fmt(refs)}`);
    if (vendoredRefs.length > 0) {
      lines.push(`  Licence texts of code it vendors or compiles in: ${fmt(vendoredRefs)}`);
    }
    lines.push("");
  }
  lines.push("-".repeat(78));
  lines.push(`Licence texts for: ${title}`);
  lines.push("-".repeat(78));
  for (const [text, id] of textIds) {
    lines.push("");
    lines.push(`[${key} text ${id}] used by: ${textUsers.get(id).join(", ")}`);
    lines.push("");
    lines.push(text);
  }
  lines.push("");
  return lines.join("\n");
}
