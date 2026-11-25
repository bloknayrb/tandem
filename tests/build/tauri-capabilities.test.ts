/**
 * What the desktop WebView may call through Tauri's plugin ACL (#1825).
 *
 * A capability grant is reachable by any script running in the `main` window,
 * so it is blast radius for an editor XSS rather than a convenience. Two
 * plugins were granted their `default` sets:
 *
 * - `fs:default` gave the WebView read access to the app-specific directories
 *   (app data, config, cache, log). No client code calls the fs plugin — Rust
 *   reads files natively, which no capability gates — so the grant served
 *   nothing and is gone. If a client caller is ever added, this test fails on
 *   the import, so the grant comes back as a decision with a scoped
 *   permission rather than by habit.
 * - `shell:default` is kept, and it is not an over-grant: in
 *   tauri-plugin-shell 2.x it is exactly `allow-open` (http(s), mailto, tel),
 *   and the plugin's own injected init script routes every
 *   `<a target="_blank">` click through `plugin:shell|open`. No client file
 *   imports the shell plugin, so removing the grant would look safe from a grep
 *   and would silently break every external link in the desktop app.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CAP_DIR = path.join(ROOT, "src-tauri/capabilities");

function grantedPermissions(): string[] {
  const files = readdirSync(CAP_DIR).filter((f) => f.endsWith(".json"));
  expect(files.length, "no capability files found").toBeGreaterThan(0);
  return files.flatMap((f) => {
    const cap = JSON.parse(readFileSync(path.join(CAP_DIR, f), "utf8")) as {
      permissions: (string | { identifier: string })[];
    };
    return cap.permissions.map((p) => (typeof p === "string" ? p : p.identifier));
  });
}

function clientFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return clientFiles(full);
    return /\.(ts|svelte)$/.test(e.name) ? [full] : [];
  });
}

describe("Tauri capability grants (#1825)", () => {
  it("grants no fs plugin permission", () => {
    expect(grantedPermissions().filter((p) => p.startsWith("fs:"))).toEqual([]);
  });

  it("no client code calls the fs plugin, which is why it needs no grant", () => {
    const callers = clientFiles(path.join(ROOT, "src/client")).filter((f) =>
      /@tauri-apps\/plugin-fs|["'`]plugin:fs\|/.test(readFileSync(f, "utf8")),
    );
    expect(callers.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("grants the shell plugin only its default (allow-open) set", () => {
    // Widening this to execute/spawn/kill would let an editor XSS run programs.
    expect(grantedPermissions().filter((p) => p.startsWith("shell:"))).toEqual(["shell:default"]);
  });
});
