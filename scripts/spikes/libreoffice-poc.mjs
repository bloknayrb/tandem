#!/usr/bin/env node
/**
 * LibreOffice headless docx write-back spike (Tandem issue #576, Unit 4).
 *
 * Purpose: empirically answer whether `soffice --headless --convert-to docx`
 * is a viable docx export engine for Tandem, with the discriminating question
 * being whether Word comments (Tandem's annotation export target) survive.
 *
 * This script does NOT install LibreOffice. You must have `soffice` on PATH
 * or installed at the default Windows location. See docs/spikes/docx-libreoffice-spike.md
 * for install instructions.
 *
 * Experiments:
 *   1. md -> html -> docx        (basic conversion path Tandem would use)
 *   2. fodt(with-annotation) -> docx (does soffice carry ODF annotations into
 *                                      Word comment XML on output?)
 *   3. docx-with-comment -> docx round-trip (do Word comments survive?)
 *   4. md fed directly to soffice (does soffice understand markdown at all?)
 *
 * Output: docx files under scripts/spikes/fixtures/output/ plus a JSON
 * summary at scripts/spikes/fixtures/output/results.json. The spike doc
 * (docs/spikes/docx-libreoffice-spike.md) interprets the results.
 *
 * NOTE on execFile: this script uses Node's promisified execFile (NOT
 * child_process.exec). All arguments are passed as an array; no shell
 * interpolation. Inputs are local fixture paths, not user input.
 */
import { execFile as _execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(_execFile);
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, "fixtures");
const OUT = resolve(FIXTURES, "output");

function findSoffice() {
  const envPath = process.env.SOFFICE_PATH;
  if (envPath && existsSync(envPath)) return envPath;
  const candidates =
    process.platform === "win32"
      ? [
          "C:/Program Files/LibreOffice/program/soffice.com",
          "C:/Program Files/LibreOffice/program/soffice.exe",
          "C:/Program Files (x86)/LibreOffice/program/soffice.exe",
        ]
      : ["/usr/bin/soffice", "/usr/local/bin/soffice", "/opt/libreoffice/program/soffice"];
  for (const c of candidates) if (existsSync(c)) return c;
  return "soffice"; // fall back to PATH
}

const SOFFICE = findSoffice();

// --- minimal markdown -> HTML. Production Tandem would use a richer converter;
// this PoC keeps the dep surface zero on purpose.
function mdToHtml(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let out = "";
  let i = 0;
  const inline = (s) =>
    s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/~~([^~]+)~~/g, "<s>$1</s>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  while (i < lines.length) {
    const line = lines[i];
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>\n`;
      i++;
      continue;
    }
    if (/^```/.test(line)) {
      i++;
      let code = "";
      while (i < lines.length && !/^```/.test(lines[i])) {
        code += lines[i] + "\n";
        i++;
      }
      i++;
      out += `<pre><code>${code.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</code></pre>\n`;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      out += "<ul>\n";
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        out += `  <li>${inline(lines[i].replace(/^\s*[-*]\s+/, ""))}</li>\n`;
        i++;
      }
      out += "</ul>\n";
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      out += "<ol>\n";
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        out += `  <li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>\n`;
        i++;
      }
      out += "</ol>\n";
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      out += `<blockquote>${inline(line.replace(/^\s*>\s?/, ""))}</blockquote>\n`;
      i++;
      continue;
    }
    if (/^\|.*\|$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i])) {
        rows.push(lines[i]);
        i++;
      }
      const cells = rows.map((r) =>
        r
          .split("|")
          .slice(1, -1)
          .map((c) => c.trim()),
      );
      const isSep = (r) => r.every((c) => /^:?-+:?$/.test(c));
      out += '<table border="1">\n';
      cells.forEach((row, idx) => {
        if (isSep(row)) return;
        const tag = idx === 0 ? "th" : "td";
        out += "  <tr>" + row.map((c) => `<${tag}>${inline(c)}</${tag}>`).join("") + "</tr>\n";
      });
      out += "</table>\n";
      continue;
    }
    if (line.trim()) {
      out += `<p>${inline(line)}</p>\n`;
    }
    i++;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Spike</title></head><body>\n${out}</body></html>`;
}

async function sofficeConvert(input, outdir, { filter, asWriter } = {}) {
  // Each invocation needs its own user profile to avoid the "another instance
  // is using the user profile" error when running serially. --writer forces
  // soffice to treat HTML as a Writer document (not Writer/Web), which is
  // required for the standard "Office Open XML Text" (docx) export filter
  // to apply. Without it, HTML inputs fail with "no export filter found".
  const profile = resolve(
    OUT,
    `.userprofile-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  const args = [
    "--headless",
    "--norestore",
    "--nologo",
    "--nodefault",
    "--nolockcheck",
    ...(asWriter ? ["--writer"] : []),
    `-env:UserInstallation=file:///${profile.replace(/\\/g, "/")}`,
    "--convert-to",
    filter ?? "docx",
    "--outdir",
    outdir,
    input,
  ];
  const t0 = performance.now();
  const { stdout, stderr } = await run(SOFFICE, args, {
    timeout: 90_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const ms = performance.now() - t0;
  rmSync(profile, { recursive: true, force: true });
  return { ms, stdout, stderr };
}

function bytes(p) {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

// Inspect a .docx (zip): list entries, scan word/comments.xml + word/document.xml
// for Word-comment markers. Uses jszip (already a transitive dep via mammoth).
async function inspectDocx(p) {
  const require = createRequire(import.meta.url);
  let JSZip;
  try {
    JSZip = require("jszip");
  } catch {
    return { ok: false, reason: "jszip not available; skipping zip inspection" };
  }
  try {
    const buf = readFileSync(p);
    const zip = await JSZip.loadAsync(buf);
    const entries = Object.values(zip.files).map((f) => ({ name: f.name, dir: f.dir }));
    const commentsEntry = zip.file("word/comments.xml");
    const documentEntry = zip.file("word/document.xml");
    const commentsXml = commentsEntry ? await commentsEntry.async("string") : null;
    const documentXml = documentEntry ? await documentEntry.async("string") : null;
    const commentRefs = documentXml
      ? (documentXml.match(/<w:commentReference\b/g) || []).length
      : 0;
    const commentRangeStarts = documentXml
      ? (documentXml.match(/<w:commentRangeStart\b/g) || []).length
      : 0;
    const commentsInFile = commentsXml ? (commentsXml.match(/<w:comment\s/g) || []).length : 0;
    return {
      ok: true,
      entryCount: entries.length,
      hasCommentsFile: Boolean(commentsEntry),
      commentReferences: commentRefs,
      commentRangeStarts,
      commentsXmlCount: commentsInFile,
      commentsXmlSample: commentsXml ? commentsXml.slice(0, 600) : null,
      relevantEntries: entries
        .map((e) => e.name)
        .filter((n) => /comments|footnotes|endnotes|header|footer|tracked|revisions/i.test(n)),
    };
  } catch (e) {
    return { ok: false, reason: String(e.message ?? e) };
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  // sanity: soffice version
  let sofficeVersion = "unknown";
  try {
    const { stdout } = await run(SOFFICE, ["--version"], { timeout: 15_000 });
    sofficeVersion = stdout.trim();
  } catch (e) {
    console.error(`[spike] could not run soffice --version: ${e.message}`);
  }

  const results = {
    soffice: { path: SOFFICE, version: sofficeVersion },
    platform: { os: process.platform, arch: process.arch, node: process.version },
    experiments: {},
  };

  // --- Experiment 1: md -> html -> docx
  console.log("[spike] experiment 1: md -> html -> docx");
  const mdPath = join(FIXTURES, "sample.md");
  const htmlPath = join(OUT, "sample.html");
  const md = readFileSync(mdPath, "utf8");
  writeFileSync(htmlPath, mdToHtml(md));
  const e1 = { input: mdPath, intermediateHtml: htmlPath };
  try {
    const { ms } = await sofficeConvert(htmlPath, OUT, { asWriter: true });
    const outDocx = join(OUT, "sample.docx");
    e1.cold = { ms: Math.round(ms), bytes: bytes(outDocx), output: outDocx };
    const warm1 = await sofficeConvert(htmlPath, OUT, { asWriter: true });
    const warm2 = await sofficeConvert(htmlPath, OUT, { asWriter: true });
    e1.warm = [Math.round(warm1.ms), Math.round(warm2.ms)];
    e1.docxInspection = await inspectDocx(outDocx);
    e1.ok = true;
  } catch (e) {
    e1.ok = false;
    e1.error = String(e.message ?? e);
  }
  results.experiments.mdToDocx = e1;

  // --- Experiment 2: fodt(with-annotation) -> docx
  console.log(
    "[spike] experiment 2: fodt-with-annotation -> docx (does ODF annotation become Word comment?)",
  );
  const fodtPath = join(FIXTURES, "with-comment.fodt");
  const e2 = { input: fodtPath };
  try {
    const { ms } = await sofficeConvert(fodtPath, OUT);
    const outDocx = join(OUT, "with-comment.docx");
    e2.ms = Math.round(ms);
    e2.bytes = bytes(outDocx);
    e2.output = outDocx;
    e2.docxInspection = await inspectDocx(outDocx);
    e2.ok = true;
  } catch (e) {
    e2.ok = false;
    e2.error = String(e.message ?? e);
  }
  results.experiments.fodtCommentToDocx = e2;

  // --- Experiment 3: round-trip an existing-comment .docx
  console.log("[spike] experiment 3: docx-with-comment -> docx round-trip");
  const e3 = {};
  try {
    const srcDocx = join(OUT, "with-comment.docx");
    if (existsSync(srcDocx)) {
      const rtOut = join(OUT, "roundtrip");
      mkdirSync(rtOut, { recursive: true });
      const { ms } = await sofficeConvert(srcDocx, rtOut);
      const rtDocx = join(rtOut, "with-comment.docx");
      e3.ms = Math.round(ms);
      e3.bytes = bytes(rtDocx);
      e3.output = rtDocx;
      e3.docxInspection = await inspectDocx(rtDocx);
      e3.ok = true;
    } else {
      e3.ok = false;
      e3.error = "experiment 2 did not produce with-comment.docx";
    }
  } catch (e) {
    e3.ok = false;
    e3.error = String(e.message ?? e);
  }
  results.experiments.docxCommentRoundtrip = e3;

  // --- Experiment 4: confirm soffice does NOT read markdown as markdown
  console.log(
    "[spike] experiment 4: soffice --convert-to docx sample.md (test: does it know markdown?)",
  );
  const e4 = {};
  try {
    const e4Out = join(OUT, "md-direct");
    mkdirSync(e4Out, { recursive: true });
    const { ms, stderr } = await sofficeConvert(mdPath, e4Out);
    const candidate = join(e4Out, "sample.docx");
    e4.ms = Math.round(ms);
    e4.stderr = stderr?.slice(0, 400) ?? "";
    e4.output = candidate;
    e4.bytes = bytes(candidate);
    if (existsSync(candidate)) e4.docxInspection = await inspectDocx(candidate);
    e4.ok = true;
    e4.note =
      "If soffice treats .md as plain text, the produced docx will be a single paragraph of literal markdown -- not rendered formatting. Compare bytes/inspection vs experiment 1.";
  } catch (e) {
    e4.ok = false;
    e4.error = String(e.message ?? e);
  }
  results.experiments.mdDirectAttempt = e4;

  // --- Experiment 5: ~10-page doc latency (md -> html -> docx via Writer)
  console.log("[spike] experiment 5: ~10-page md -> docx latency");
  const e5 = {};
  try {
    const bigMd = readFileSync(join(FIXTURES, "large.md"), "utf8");
    const bigHtmlPath = join(OUT, "large.html");
    writeFileSync(bigHtmlPath, mdToHtml(bigMd));
    const cold = await sofficeConvert(bigHtmlPath, OUT, { asWriter: true });
    const warm1 = await sofficeConvert(bigHtmlPath, OUT, { asWriter: true });
    const warm2 = await sofficeConvert(bigHtmlPath, OUT, { asWriter: true });
    const outDocx = join(OUT, "large.docx");
    e5.cold = Math.round(cold.ms);
    e5.warm = [Math.round(warm1.ms), Math.round(warm2.ms)];
    e5.bytes = bytes(outDocx);
    e5.output = outDocx;
    e5.ok = true;
  } catch (e) {
    e5.ok = false;
    e5.error = String(e.message ?? e);
  }
  results.experiments.largeDocLatency = e5;

  console.log("\n=== SPIKE RESULTS ===");
  console.log(JSON.stringify(results, null, 2));

  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
  console.log(`\n[spike] wrote ${join(OUT, "results.json")}`);
}

main().catch((e) => {
  console.error("[spike] fatal:", e);
  process.exit(1);
});
