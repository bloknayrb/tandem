#!/usr/bin/env node
/**
 * Generate the third-party licence notices that ship with every Tandem artifact.
 *
 *   node scripts/third-party-notices/generate.mjs npm
 *     Runs at the end of `npm run build`. Writes dist/THIRD_PARTY_NOTICES.txt
 *     (shipped in the npm tarball via `files: ["dist/"]`) and a PLACEHOLDER
 *     dist/desktop/THIRD_PARTY_NOTICES.txt carrying DESKTOP_PLACEHOLDER_MARKER,
 *     so `cargo test`'s tauri_build resource check passes in any built tree.
 *
 *   node scripts/third-party-notices/generate.mjs desktop [--target <triple>]
 *     Runs from tauri.conf.json's beforeBuildCommand, after `npm run build`.
 *     Overwrites dist/desktop/THIRD_PARTY_NOTICES.txt with the npm packages the
 *     desktop resources ship, plus the Rust crates linked into the app and the
 *     reaper, the Rust standard library, and the bundled Node.js runtime.
 *
 *   node scripts/third-party-notices/generate.mjs verify-desktop --target <triple>
 *     Release CI, after tauri-action: the desktop file is the real one (not the
 *     placeholder), names the target, and is byte-identical to the copy Tauri
 *     staged as a bundle resource.
 *
 *   node scripts/third-party-notices/generate.mjs verify-pack
 *     CI `check`, after the build: `npm pack --dry-run` lists the notices file
 *     and none of the build-only files beside it.
 *
 * WHERE THE LIST COMES FROM — what each build actually bundled, never the
 * dependency tree. The production tree is wrong in both directions: it misses
 * devDependencies the client inlines (svelte's runtime) and lists packages no
 * bundle contains.
 *   - tsup bundles (server, channel, monitor, stdio-bridge, cli): the `sources`
 *     of the sourcemap tsup writes beside each bundle in the same pass, so the
 *     list cannot describe a different build than the file it sits next to.
 *   - client (Vite): dist/.third-party/client.json, written by the
 *     `thirdPartyTrace` plugin in vite.config.ts, with a SHA-256 per chunk that
 *     is checked against the files on disk here.
 *   - Rust: `cargo metadata --filter-platform <triple>`, following normal
 *     dependency edges only (build- and dev-dependencies are not shipped).
 *   - Node.js: the LICENSE file from the pinned Node archive, which
 *     scripts/download-node-sidecar.mjs extracts beside the sidecar.
 *
 * FAILS CLOSED (exit 1) on: an unknown dist bundle, a stale client trace, a
 * component with no licence text and no override, an override nothing uses, a
 * missing positive anchor, an empty Rust closure, or a missing Node LICENSE.
 * A notices file that is silently empty or partial is the outcome this exists
 * to prevent; a red build is the cheap one.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_NODE_VERSION } from "../node-sidecar-version.mjs";
import {
  byCodeUnit,
  classifyLicence,
  findBundledNoticeFiles,
  normalizeText,
  packageRootOf,
  readLicenceFiles,
  readNpmPackage,
  renderSection,
} from "./lib.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = join(REPO, "dist");
const TRACE_DIR = join(DIST, ".third-party");
const OVERRIDES_DIR = join(REPO, "scripts", "third-party-notices", "overrides");
const NPM_NOTICES = join(DIST, "THIRD_PARTY_NOTICES.txt");
const DESKTOP_NOTICES = join(DIST, "desktop", "THIRD_PARTY_NOTICES.txt");
const DESKTOP_PLACEHOLDER_MARKER = "DESKTOP-SECTIONS-NOT-GENERATED";

/** dist/ subdirectories that are not shipped bundles. perf-client is excluded from `files`. */
const NOT_BUNDLES = new Set([".third-party", "desktop", "perf-client"]);

/** Rust roots linked into the desktop bundle: the app itself and the reaper externalBin. */
const RUST_ROOTS = [
  { manifest: "src-tauri/Cargo.toml", label: "desktop app" },
  { manifest: "reaper/Cargo.toml", label: "tandem-reaper" },
];

/** Virtual modules the client build injects, mapped to the package whose code they are. */
const VIRTUAL_MODULE_PACKAGES = [
  [/^\0rolldown\//, "rolldown"],
  [/^\0vite\//, "vite"],
];

const PERMISSIVE_TEXT = "Permission is hereby granted";

function fail(message) {
  process.stderr.write(`[third-party-notices] ${message}\n`);
  process.exit(1);
}

function getArg(name) {
  const idx = process.argv.indexOf(name);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

// ── Overrides ───────────────────────────────────────────────────────────────

/**
 * Licence text for components whose published package/crate carries none.
 * Each file is `overrides/<ecosystem>/<name>.txt` (`/` in a scoped npm name
 * becomes `+`), a `Source:` header naming where the text was copied from, a
 * `---` line, then the text. Applied only when the component has no file of
 * its own, and any override no component used fails the build, so the set
 * cannot rot.
 */
function loadOverrides(ecosystem) {
  const dir = join(OVERRIDES_DIR, ecosystem);
  const map = new Map();
  if (!existsSync(dir)) return map;
  for (const file of readdirSync(dir).sort(byCodeUnit)) {
    if (!file.endsWith(".txt")) continue;
    const raw = readFileSync(join(dir, file), "utf8").replace(/\r\n?/g, "\n");
    const sep = raw.indexOf("\n---\n");
    if (sep === -1) fail(`override ${ecosystem}/${file} has no "---" separator`);
    const source = /^Source:\s*(.+)$/m.exec(raw.slice(0, sep))?.[1]?.trim();
    if (!source) fail(`override ${ecosystem}/${file} has no Source: line`);
    const text = normalizeText(raw.slice(sep + 5));
    if (!text) fail(`override ${ecosystem}/${file} is empty`);
    map.set(file.slice(0, -4).replace(/\+/g, "/"), { file, source, text, used: false });
  }
  return map;
}

/**
 * `otherTargets` names components that exist for some other build target (a
 * Windows-only crate on a Linux build): their overrides are not "unused" just
 * because this target does not link them.
 */
function applyOverrides(components, overrides, ecosystem, otherTargets = new Set()) {
  const missing = [];
  for (const c of components) {
    if (c.texts.length > 0) continue;
    const o = overrides.get(c.name);
    if (!o) {
      missing.push(`${c.name}@${c.version} (${c.license})`);
      continue;
    }
    o.used = true;
    c.texts = [{ file: `overrides/${ecosystem}/${o.file}`, text: o.text }];
    c.textSource = o.source;
  }
  if (missing.length > 0) {
    fail(
      `${missing.length} ${ecosystem} component(s) ship no licence file and have no override in ` +
        `scripts/third-party-notices/overrides/${ecosystem}/:\n  ${missing.join("\n  ")}\n` +
        "Copy the text from the component's upstream repository; the file format is described at loadOverrides().",
    );
  }
  const unused = [...overrides.entries()]
    .filter(([name, o]) => !o.used && !otherTargets.has(name))
    .map(([, o]) => o.file);
  if (unused.length > 0) {
    fail(
      `unused ${ecosystem} override(s): ${unused.join(", ")} — the component now ships its own ` +
        "licence file or is no longer bundled. Delete the override.",
    );
  }
}

// ── npm ─────────────────────────────────────────────────────────────────────

/** Module paths (absolute or virtual) per shipped dist bundle. */
function collectBundleModules() {
  if (!existsSync(DIST)) fail("dist/ does not exist — run the build first");
  const bundles = new Map();
  const dirs = readdirSync(DIST, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !NOT_BUNDLES.has(d.name))
    .map((d) => d.name)
    .sort(byCodeUnit);
  for (const name of dirs) {
    const dir = join(DIST, name);
    if (name === "client") {
      bundles.set(name, collectClientModules(dir));
      continue;
    }
    const mapPath = join(dir, "index.js.map");
    if (!existsSync(mapPath)) {
      fail(
        `dist/${name}/ has no index.js.map and is not the client — this script does not know what ` +
          "it contains. Teach collectBundleModules about it rather than skipping it.",
      );
    }
    const map = JSON.parse(readFileSync(mapPath, "utf8"));
    const modules = map.sources.map((s) => resolve(dir, map.sourceRoot ?? "", s));
    // esbuild injects its own runtime helpers (__commonJS, __export, …) into every bundle.
    modules.push(join(REPO, "node_modules", "esbuild", "package.json"));
    bundles.set(name, modules);
  }
  return bundles;
}

function collectClientModules(dir) {
  const tracePath = join(TRACE_DIR, "client.json");
  if (!existsSync(tracePath)) {
    fail(
      "dist/.third-party/client.json is missing — the vite.config.ts thirdPartyTrace plugin did not run",
    );
  }
  const { chunks } = JSON.parse(readFileSync(tracePath, "utf8"));
  const onDisk = walkFiles(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => relative(dir, f).split("\\").join("/"));
  for (const file of onDisk) {
    if (!chunks[file]) fail(`dist/client/${file} has no record in the client trace — stale trace`);
  }
  const modules = [];
  for (const [file, chunk] of Object.entries(chunks)) {
    const path = join(dir, file);
    if (!existsSync(path))
      fail(`client trace names dist/client/${file}, which does not exist — stale trace`);
    if (sha256(readFileSync(path)) !== chunk.sha256) {
      fail(`dist/client/${file} does not match its trace hash — stale trace`);
    }
    for (const id of chunk.modules) {
      if (id.startsWith("\0")) {
        const hit = VIRTUAL_MODULE_PACKAGES.find(([re]) => re.test(id));
        if (!hit) {
          fail(
            `client chunk ${file} contains virtual module ${JSON.stringify(id)} of unknown origin`,
          );
        }
        modules.push(join(REPO, "node_modules", hit[1], "package.json"));
      } else {
        modules.push(join(REPO, id));
      }
    }
  }
  return modules;
}

/**
 * overrides/npm-inlined.json: packages a dependency inlined into its own build
 * that are not installed anywhere, mapped to the host that inlined them. The
 * version, licence and text are read from the host's own third-party notices
 * file, so the table holds only the attribution, which the sourcemap path
 * loses. An entry nothing used fails the build.
 */
const inlinedTable = (() => {
  const path = join(OVERRIDES_DIR, "npm-inlined.json");
  const table = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  delete table.$comment;
  return { table, used: new Set() };
})();

function inlinedComponent(name, bundle, mod) {
  const entry = inlinedTable.table[name];
  if (!entry) {
    fail(
      `bundle ${bundle} contains ${name} (via ${relative(REPO, mod)}), which is not installed — a dependency ` +
        "inlined it. Add it to scripts/third-party-notices/overrides/npm-inlined.json with the host package.",
    );
  }
  inlinedTable.used.add(name);
  const hostRoot = join(REPO, "node_modules", entry.inlinedBy);
  const hostFiles = existsSync(hostRoot) ? findBundledNoticeFiles(hostRoot) : [];
  const esc = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  for (const file of hostFiles) {
    const text = readFileSync(join(hostRoot, file), "utf8").replace(/\r\n?/g, "\n");
    const m = new RegExp(
      `^Name: ${esc}\\nVersion: (.+)\\nLicense: (.+)\\n([\\s\\S]*?)(?:\\n---\\n|(?![\\s\\S]))`,
      "m",
    ).exec(text);
    if (!m) continue;
    const body = /License Text:\n===\n([\s\S]*)$/.exec(m[3])?.[1];
    if (!body?.trim()) {
      fail(`${entry.inlinedBy}'s ${file} lists ${name} without its licence text`);
    }
    return {
      name,
      version: m[1].trim(),
      license: m[2].trim(),
      repository: /^Repository: (.+)$/m.exec(m[3])?.[1]?.trim() ?? "",
      texts: [{ file, text: normalizeText(body) }],
      textSource: `${entry.inlinedBy}/${file} (inlined by ${entry.inlinedBy})`,
      includedIn: [],
    };
  }
  fail(`${name} is mapped to ${entry.inlinedBy}, whose third-party notices do not list it`);
}

/** `{ components, byBundle }`: one component per name@version, tagged with the bundles holding it. */
function collectNpm() {
  const bundles = collectBundleModules();
  const byKey = new Map();
  const byBundle = new Map();
  for (const [bundle, modules] of bundles) {
    const keys = new Set();
    for (const mod of modules) {
      const hit = packageRootOf(mod);
      if (!hit) {
        // esbuild chains a dependency's own sourcemap, so a source can name a
        // file from the dependency's repo. One that resolves outside both
        // node_modules and our src/ would be mis-read as first-party and its
        // package silently dropped.
        const rel = relative(REPO, mod).split("\\").join("/");
        if (!rel.startsWith("src/"))
          fail(`bundle ${bundle} has a source outside node_modules and src/: ${rel}`);
        continue;
      }
      let root = hit.root;
      if (!existsSync(join(root, "package.json"))) {
        // Same chaining: a dependency that inlined ANOTHER package into its own
        // dist reports it under a path that only existed in its build tree
        // (@hocuspocus/server → .../node_modules/node_modules/lib0). That code
        // ships too, so attribute it to the installed package of that name.
        root = join(REPO, "node_modules", hit.name);
        if (!existsSync(join(root, "package.json"))) {
          const c = inlinedComponent(hit.name, bundle, mod);
          const key = `${c.name}@${c.version}`;
          if (!byKey.has(key)) byKey.set(key, c);
          if (!byKey.get(key).includedIn.includes(bundle)) byKey.get(key).includedIn.push(bundle);
          keys.add(key);
          continue;
        }
      }
      const pkg = readNpmPackage(root);
      const key = `${pkg.name}@${pkg.version}`;
      if (!byKey.has(key)) byKey.set(key, { ...pkg, includedIn: [] });
      const c = byKey.get(key);
      if (!c.includedIn.includes(bundle)) c.includedIn.push(bundle);
      keys.add(key);
    }
    byBundle.set(bundle, keys);
  }
  const components = [...byKey.values()];
  for (const c of components) c.includedIn.sort(byCodeUnit);
  if (components.length === 0) fail("no npm packages found in any bundle — the trace is broken");
  const unusedInlined = Object.keys(inlinedTable.table).filter((n) => !inlinedTable.used.has(n));
  if (unusedInlined.length > 0) {
    fail(
      `unused npm-inlined.json entries: ${unusedInlined.join(", ")} — no bundle contains them now. Delete them.`,
    );
  }
  applyOverrides(components, loadOverrides("npm"), "npm");

  // Positive anchors: prove the tsup and Vite traces each still see real
  // packages AND that licence text is still being read, not merely names.
  for (const [bundle, name] of [
    ["server", "yjs"],
    ["client", "svelte"],
  ]) {
    const c = components.find((x) => x.name === name && x.includedIn.includes(bundle));
    if (!c)
      fail(`anchor ${name} not found in the ${bundle} bundle — the ${bundle} trace is broken`);
    if (!c.texts.some((t) => t.text.includes(PERMISSIVE_TEXT))) {
      fail(`anchor ${name} has no MIT text — licence files are not being read`);
    }
  }
  return { components, byBundle };
}

/** Bundles the desktop app ships, read from tauri.conf.json's resources so a new one cannot be missed. */
function desktopBundles(npm) {
  const conf = JSON.parse(readFileSync(join(REPO, "src-tauri", "tauri.conf.json"), "utf8"));
  const names = [];
  for (const src of Object.keys(conf.bundle?.resources ?? {})) {
    const m = /^\.\.\/dist\/([^/]+)\/?$/.exec(src);
    if (!m || m[1] === "desktop") continue;
    if (!npm.byBundle.has(m[1])) fail(`tauri.conf.json ships dist/${m[1]}/ but no trace covers it`);
    names.push(m[1]);
  }
  if (names.length === 0) fail("tauri.conf.json bundle.resources names no dist bundle");
  return names.sort(byCodeUnit);
}

function npmForBundles(npm, bundles) {
  return npm.components
    .filter((c) => c.includedIn.some((b) => bundles.includes(b)))
    .map((c) => ({ ...c, includedIn: c.includedIn.filter((b) => bundles.includes(b)) }));
}

// ── Rust ────────────────────────────────────────────────────────────────────

function hostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const m = /^host:\s*(.+)$/m.exec(out);
  if (!m) fail("could not read the host triple from `rustc -vV`");
  return m[1].trim();
}

function collectCrates(triple) {
  const byId = new Map();
  for (const { manifest, label } of RUST_ROOTS) {
    const meta = JSON.parse(
      execFileSync(
        "cargo",
        [
          "metadata",
          "--format-version",
          "1",
          "--locked",
          "--filter-platform",
          triple,
          "--manifest-path",
          join(REPO, manifest),
        ],
        { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
      ),
    );
    const packages = new Map(meta.packages.map((p) => [p.id, p]));
    const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
    const rootId = meta.resolve.root;
    // Follow only edges with a normal (kind: null) entry: build- and
    // dev-dependencies, and anything reachable only through them, never ship.
    const seen = new Set([rootId]);
    const queue = [rootId];
    while (queue.length > 0) {
      const node = nodes.get(queue.shift());
      for (const dep of node?.deps ?? []) {
        if (!dep.dep_kinds.some((k) => k.kind === null)) continue;
        if (seen.has(dep.pkg)) continue;
        seen.add(dep.pkg);
        queue.push(dep.pkg);
      }
    }
    seen.delete(rootId);
    if (seen.size === 0) fail(`${manifest} resolved to zero dependencies for ${triple}`);
    for (const id of seen) {
      const p = packages.get(id);
      if (!byId.has(id)) {
        const dir = dirname(p.manifest_path);
        byId.set(id, {
          name: p.name,
          version: p.version,
          license: p.license ?? (p.license_file ? `SEE LICENSE IN ${p.license_file}` : "UNKNOWN"),
          repository: p.repository ?? "",
          texts: readLicenceFiles(dir, p.license_file ? [p.license_file] : []),
          includedIn: [],
        });
      }
      const c = byId.get(id);
      if (!c.includedIn.includes(label)) c.includedIn.push(label);
    }
  }
  const crates = [...byId.values()];
  applyOverrides(crates, loadOverrides("cargo"), "cargo", lockedCrateNames());
  const tauri = crates.find((c) => c.name === "tauri");
  if (!tauri) fail("anchor crate tauri not found — the cargo walk is broken");
  if (!tauri.texts.some((t) => t.text.includes("Apache License"))) {
    fail("anchor crate tauri has no Apache-2.0 text — crate licence files are not being read");
  }
  return crates;
}

/** Every crate name in the two lockfiles, across all targets. */
function lockedCrateNames() {
  const names = new Set();
  for (const { manifest } of RUST_ROOTS) {
    const lock = readFileSync(join(REPO, dirname(manifest), "Cargo.lock"), "utf8");
    for (const m of lock.matchAll(/^name = "([^"]+)"$/gm)) names.add(m[1]);
  }
  return names;
}

/**
 * The Rust standard library is statically linked into both binaries but is not
 * a crate `cargo metadata` reports. Its text comes from overrides/rust/std.txt
 * because the sysroot copy ships only with the rust-docs component, which CI's
 * minimal toolchain does not install.
 */
function rustStd() {
  const overrides = loadOverrides("rust");
  const std = overrides.get("std");
  if (!std) fail("overrides/rust/std.txt is missing");
  const version = /^rustc\s+(\S+)/.exec(execFileSync("rustc", ["-V"], { encoding: "utf8" }))?.[1];
  if (!version) fail("could not read the rustc version");
  return {
    name: "Rust standard library",
    version,
    license: "MIT OR Apache-2.0",
    repository: "https://github.com/rust-lang/rust",
    texts: [{ file: "overrides/rust/std.txt", text: std.text }],
    textSource: std.source,
    includedIn: RUST_ROOTS.map((r) => r.label),
  };
}

function nodeRuntime(triple) {
  const isWindows = triple.includes("windows");
  const sidecar = join(
    REPO,
    "src-tauri",
    "binaries",
    `node-sidecar-${triple}${isWindows ? ".exe" : ""}`,
  );
  const licencePath = join(REPO, "src-tauri", "binaries", `node-sidecar-${triple}.LICENSE`);
  if (!existsSync(licencePath)) {
    fail(
      `${relative(REPO, licencePath)} is missing — run \`node scripts/download-node-sidecar.mjs --target ${triple}\`, ` +
        "which extracts Node's LICENSE beside the binary",
    );
  }
  const marker = existsSync(`${sidecar}.version`)
    ? readFileSync(`${sidecar}.version`, "utf8").trim()
    : null;
  if (marker !== DEFAULT_NODE_VERSION) {
    fail(
      `sidecar version marker says ${marker ?? "nothing"}, pin is ${DEFAULT_NODE_VERSION} — re-run the download`,
    );
  }
  const text = normalizeText(readFileSync(licencePath, "utf8"));
  if (!text.includes("Node.js is licensed for use as follows")) {
    fail(`${relative(REPO, licencePath)} does not look like Node's LICENSE`);
  }
  return {
    name: "Node.js",
    version: DEFAULT_NODE_VERSION,
    license: "MIT, plus the licences of the components Node.js bundles (listed in its text)",
    repository: "https://github.com/nodejs/node",
    texts: [{ file: "LICENSE", text }],
    includedIn: ["node-sidecar"],
  };
}

// ── Output ──────────────────────────────────────────────────────────────────

function header(kind, extra = []) {
  const { version } = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  return [
    `THIRD-PARTY SOFTWARE NOTICES — Tandem ${version} (${kind})`,
    ...extra,
    "",
    "Generated at build time by scripts/third-party-notices/generate.mjs from what this build",
    "actually contains. Do not edit.",
    "",
    "Tandem itself is licensed under the Business Source License 1.1; see the LICENSE file",
    "distributed with it. The software listed below is not Tandem's: each component is",
    "included under its own licence, reproduced here as that licence requires.",
    "",
    "Not repeated here: the bundled fonts' licences (SIL Open Font License 1.1), which ship",
    "beside the font files in the client's fonts/ folder.",
    "",
    "",
  ].join("\n");
}

function writeReport(name, sections) {
  const flagged = [];
  for (const [section, components] of sections) {
    for (const c of components) {
      const cls = classifyLicence(c.license);
      if (cls !== "permissive") {
        flagged.push({
          section,
          name: c.name,
          version: c.version,
          license: c.license,
          class: cls,
          includedIn: c.includedIn,
        });
      }
    }
  }
  flagged.sort(
    (a, b) =>
      byCodeUnit(a.section, b.section) ||
      byCodeUnit(a.name, b.name) ||
      byCodeUnit(a.version, b.version),
  );
  mkdirSync(TRACE_DIR, { recursive: true });
  writeFileSync(join(TRACE_DIR, `report-${name}.json`), `${JSON.stringify(flagged, null, 2)}\n`);
  if (flagged.length > 0) {
    process.stderr.write(
      `[third-party-notices] ${flagged.length} component(s) not plainly permissive (for review, not an error):\n`,
    );
    for (const f of flagged) {
      process.stderr.write(`  [${f.class}] ${f.section}: ${f.name}@${f.version} — ${f.license}\n`);
    }
  }
}

function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content.endsWith("\n") ? content : `${content}\n`);
  process.stderr.write(
    `[third-party-notices] wrote ${relative(REPO, path)} (${statSync(path).size} bytes)\n`,
  );
}

const NPM_TITLE = "JavaScript packages bundled into Tandem";

function runNpm() {
  const npm = collectNpm();
  writeFile(NPM_NOTICES, header("npm package") + renderSection("npm", NPM_TITLE, npm.components));
  // Placeholder so a plain `npm run build` leaves a desktop resource in place for
  // `cargo test`'s tauri_build check. It carries the marker that verify-desktop
  // refuses, so it can never pass for the real file in a release.
  const desktop = npmForBundles(npm, desktopBundles(npm));
  writeFile(
    DESKTOP_NOTICES,
    header("desktop app — INCOMPLETE", [
      `${DESKTOP_PLACEHOLDER_MARKER}: written by \`npm run build\`. The desktop build's`,
      "beforeBuildCommand replaces this file with the complete notices.",
    ]) + renderSection("npm", NPM_TITLE, desktop),
  );
  writeReport("npm", [["npm", npm.components]]);
}

function runDesktop() {
  const triple = process.env.TAURI_ENV_TARGET_TRIPLE || getArg("--target") || hostTriple();
  const npm = collectNpm();
  const desktop = npmForBundles(npm, desktopBundles(npm));
  const crates = collectCrates(triple);
  const std = rustStd();
  const node = nodeRuntime(triple);
  writeFile(
    DESKTOP_NOTICES,
    header("desktop app", [`Target: ${triple}`]) +
      renderSection("npm", NPM_TITLE, desktop) +
      "\n" +
      renderSection("crate", "Rust crates linked into the desktop app and tandem-reaper", crates) +
      "\n" +
      renderSection("rust", "Rust standard library", [std]) +
      "\n" +
      renderSection("node", "Node.js runtime (binaries/node-sidecar)", [node]),
  );
  writeReport("desktop", [
    ["npm", desktop],
    ["crate", crates],
  ]);
}

function runVerifyDesktop() {
  const triple = getArg("--target");
  if (!triple) fail("verify-desktop needs --target <triple>");
  if (!existsSync(DESKTOP_NOTICES)) fail(`${relative(REPO, DESKTOP_NOTICES)} does not exist`);
  const text = readFileSync(DESKTOP_NOTICES, "utf8");
  if (text.includes(DESKTOP_PLACEHOLDER_MARKER)) {
    fail(
      "the desktop notices are still the npm-build placeholder — beforeBuildCommand did not run desktop mode",
    );
  }
  for (const needle of [
    `Target: ${triple}`,
    "Rust crates linked",
    "Rust standard library",
    "Node.js is licensed for use as follows",
  ]) {
    if (!text.includes(needle)) fail(`desktop notices lack ${JSON.stringify(needle)}`);
  }
  // Tauri stages each resource beside the binary before bundling; that copy is
  // what the installers package.
  const staged = [
    join(REPO, "src-tauri", "target", triple, "release", "THIRD_PARTY_NOTICES.txt"),
    join(REPO, "src-tauri", "target", "release", "THIRD_PARTY_NOTICES.txt"),
  ].filter(existsSync);
  if (staged.length === 0)
    fail(`no staged THIRD_PARTY_NOTICES.txt under src-tauri/target for ${triple}`);
  for (const path of staged) {
    if (readFileSync(path, "utf8") !== text)
      fail(`${relative(REPO, path)} differs from ${relative(REPO, DESKTOP_NOTICES)}`);
  }
  process.stderr.write(`[third-party-notices] desktop notices verified for ${triple}\n`);
}

function runVerifyPack() {
  // One fixed command string through the shell: npm is a .cmd shim on Windows,
  // and an args array with `shell: true` is deprecated (DEP0190).
  const res = spawnSync("npm pack --dry-run --json --ignore-scripts", {
    cwd: REPO,
    encoding: "utf8",
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) fail(`npm pack --dry-run failed:\n${res.stderr}`);
  const files = JSON.parse(res.stdout)[0].files.map((f) => f.path);
  if (!files.includes("dist/THIRD_PARTY_NOTICES.txt"))
    fail("the npm tarball does not include dist/THIRD_PARTY_NOTICES.txt");
  const leaked = files.filter(
    (f) => f.startsWith("dist/desktop/") || f.startsWith("dist/.third-party/"),
  );
  if (leaked.length > 0) fail(`the npm tarball includes build-only files: ${leaked.join(", ")}`);
  const notices = readFileSync(NPM_NOTICES, "utf8");
  if (!notices.includes(PERMISSIVE_TEXT))
    fail("dist/THIRD_PARTY_NOTICES.txt carries no licence text");
  process.stderr.write("[third-party-notices] npm tarball includes the notices\n");
}

const MODES = {
  npm: runNpm,
  desktop: runDesktop,
  "verify-desktop": runVerifyDesktop,
  "verify-pack": runVerifyPack,
};
const mode = process.argv[2];
if (!MODES[mode]) fail(`usage: generate.mjs <${Object.keys(MODES).join("|")}>`);
MODES[mode]();
