import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * `index.html`'s CSP meta tag and `src-tauri/tauri.conf.json`'s Tauri CSP each carry their own
 * `img-src` directive (#1420, #1497) — index.html's comment above the meta tag calls this "one
 * policy written twice." Nothing enforces that at build time, so this pins them equal.
 */
function extractImgSrc(source: string, label: string): string {
  const match = source.match(/img-src\s+([^;"]+)/);
  if (!match) {
    throw new Error(`${label}: no img-src directive found`);
  }
  return match[1].trim();
}

describe("CSP img-src parity", () => {
  it("index.html and src-tauri/tauri.conf.json agree on img-src", () => {
    const html = readFileSync(path.join(ROOT, "index.html"), "utf-8");
    const tauriConf = readFileSync(path.join(ROOT, "src-tauri/tauri.conf.json"), "utf-8");

    const htmlImgSrc = extractImgSrc(html, "index.html");
    const tauriImgSrc = extractImgSrc(tauriConf, "src-tauri/tauri.conf.json");

    expect(htmlImgSrc).toBe(tauriImgSrc);
    expect(htmlImgSrc).toBe("'self' data: blob:");
  });
});
