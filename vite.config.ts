import { svelte } from "@sveltejs/vite-plugin-svelte";
import { createHash } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { defineConfig, type Plugin } from "vite";

/**
 * Records which modules each emitted chunk actually contains, for
 * scripts/third-party-notices/generate.mjs (the licence notices that ship with
 * every artifact). The tsup bundles need no equivalent: their sourcemaps
 * already list their inputs. The client ships no sourcemap, so this is its
 * only record.
 *
 * Runs in `writeBundle`, after the files are on disk, and stores each chunk's
 * SHA-256 so the generator can refuse a trace that does not describe the
 * files it sits next to. Keyed by the outDir's basename, so the perf harness
 * build (`--outDir dist/perf-client`) cannot overwrite the release client's.
 */
function thirdPartyTrace(): Plugin {
  let root = "";
  let outDir = "";
  return {
    name: "tandem-third-party-trace",
    apply: "build",
    configResolved(config) {
      root = config.root;
      outDir = path.resolve(config.root, config.build.outDir);
    },
    writeBundle(_options, bundle) {
      const chunks: Record<string, { sha256: string; modules: string[] }> = {};
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== "chunk") continue;
        // Zero-length modules are dropped, except under node_modules: a CSS
        // import's JS stub renders to nothing while its styles ship in a CSS
        // asset, and over-listing a package is harmless where missing one is not.
        const modules = Object.entries(output.modules)
          .filter(([id, info]) => info.renderedLength > 0 || id.includes("/node_modules/"))
          .map(([id]) => {
            const bare = id.split("?")[0];
            // Virtual modules (`\0vite/...`) keep their id; real files go repo-relative
            // so the trace carries no machine-specific path.
            return bare.startsWith("\0")
              ? bare
              : path.relative(root, bare).split(path.sep).join("/");
          })
          .sort();
        chunks[fileName] = {
          sha256: createHash("sha256").update(output.code).digest("hex"),
          modules: [...new Set(modules)],
        };
      }
      const traceDir = path.join(path.dirname(outDir), ".third-party");
      mkdirSync(traceDir, { recursive: true });
      writeFileSync(
        path.join(traceDir, `${path.basename(outDir)}.json`),
        `${JSON.stringify({ chunks }, null, 2)}\n`,
      );
    },
  };
}

export default defineConfig({
  plugins: [svelte(), thirdPartyTrace()],
  root: ".",
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
      "@client": path.resolve(__dirname, "src/client"),
    },
    dedupe: [
      "yjs",
      "@hocuspocus/provider",
      "y-prosemirror",
      "prosemirror-model",
      "prosemirror-state",
      "prosemirror-view",
      "prosemirror-transform",
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist/client",
  },
});
