import { createRequire } from "node:module";
import { defineConfig } from "tsup";

const require = createRequire(import.meta.url);
const pkg = require("./package.json") as { version: string };

export default defineConfig([
  {
    entry: ["src/server/index.ts"],
    outDir: "dist/server",
    format: ["esm"],
    target: "node22",
    platform: "node",
    splitting: false,
    clean: true,
    dts: false,
    sourcemap: true,
  },
  {
    entry: ["src/channel/index.ts"],
    outDir: "dist/channel",
    format: ["esm"],
    target: "node22",
    platform: "node",
    splitting: false,
    clean: true,
    dts: false,
    sourcemap: true,
  },
  {
    entry: ["src/cli/index.ts"],
    outDir: "dist/cli",
    format: ["esm"],
    target: "node22",
    platform: "node",
    splitting: false,
    clean: true,
    dts: false,
    sourcemap: true,
    banner: {
      js: "#!/usr/bin/env node",
    },
    define: {
      __TANDEM_VERSION__: JSON.stringify(pkg.version),
    },
  },
]);
