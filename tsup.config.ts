import { readFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { join } from "node:path";
import { defineConfig } from "tsup";

const require = createRequire(import.meta.url);
const pkg = require("./package.json") as { version: string };
// require("@modelcontextprotocol/sdk/package.json") resolves to dist/cjs/package.json
// (a CJS type marker without "version") due to the SDK's exports map. Walk the resolved
// path back to the package root to read the real version.
const sdkStub = require.resolve("@modelcontextprotocol/sdk/package.json");
const sdkRoot = sdkStub.slice(0, sdkStub.lastIndexOf("dist"));
const mcpSdkPkg = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")) as {
  version: string;
};

// Node builtins must stay external — CJS deps that call require("fs") etc.
// fail with "Dynamic require not supported" if bundled into ESM.
const nodeBuiltins = builtinModules.flatMap((m) => [m, `node:${m}`]);

// Shared config for self-contained bundles (Tauri ships these without node_modules)
const selfContained = {
  noExternal: [/.*/],
  external: nodeBuiltins,
  banner: {
    js: 'import { createRequire as __cjsRequireCreator } from "module"; const require = __cjsRequireCreator(import.meta.url);',
  },
} as const;

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
    ...selfContained,
    define: {
      __MCP_SDK_VERSION__: JSON.stringify(mcpSdkPkg.version),
    },
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
    ...selfContained,
  },
  {
    entry: ["src/monitor/index.ts"],
    outDir: "dist/monitor",
    format: ["esm"],
    target: "node22",
    platform: "node",
    splitting: false,
    clean: true,
    dts: false,
    sourcemap: true,
    ...selfContained,
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
