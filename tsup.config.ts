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

// License gate (ADR-040): ships DARK by default. Injected as __LICENSE_GATE_ENABLED__
// into every bundle whose tree imports src/server/license/* (server + cli today).
// Flip to `true` at v1.0 once commercial-readiness exit criteria are met.
const LICENSE_GATE_ENABLED = false;

// Node builtins must stay external — CJS deps that call require("fs") etc.
// fail with "Dynamic require not supported" if bundled into ESM.
const nodeBuiltins = builtinModules.flatMap((m) => [m, `node:${m}`]);

// Native modules must stay external — they dispatch to platform-specific
// `.node` binaries at runtime via dynamic require, which esbuild cannot trace
// into a single-file bundle. Bundling the JS dispatcher without its native
// counterpart causes a runtime "Cannot find module" inside @napi-rs/keyring.
// The keychain module guards the require behind try/catch and surfaces a
// typed KeychainUnavailableError, so the production install ships the package
// directly from node_modules.
const nativeExternals = [/^@napi-rs\/keyring/];

// Shared config for self-contained bundles (Tauri ships these without node_modules)
const selfContained = {
  noExternal: [/.*/],
  external: [...nodeBuiltins, ...nativeExternals],
  banner: {
    js: 'import { createRequire as __cjsRequireCreator } from "module"; const require = __cjsRequireCreator(import.meta.url);',
  },
} as const;

/**
 * A standalone sidecar bundle: one entry, self-contained, spawned by something
 * that is not us (an MCP client, a plugin host) and therefore unable to rely on
 * a sibling `node_modules`.
 *
 * Three of these exist and they differed only in `entry`/`outDir`, so the shape
 * is the factory rather than a block to copy. The CLI is deliberately NOT one of
 * them — see its own note below.
 */
const sidecarBundle = (name: string) =>
  ({
    entry: [`src/${name}/index.ts`],
    outDir: `dist/${name}`,
    format: ["esm"],
    target: "node22",
    platform: "node",
    splitting: false,
    clean: true,
    dts: false,
    sourcemap: true,
    ...selfContained,
  }) as const;

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
      __APP_VERSION__: JSON.stringify(pkg.version),
      // apply.ts (bundled here) reads __TANDEM_VERSION__ first to pin the npx
      // spec; define it in the server bundle too so it isn't a bare free global.
      __TANDEM_VERSION__: JSON.stringify(pkg.version),
      __LICENSE_GATE_ENABLED__: JSON.stringify(LICENSE_GATE_ENABLED),
    },
  },
  sidecarBundle("channel"),
  sidecarBundle("monitor"),
  // The `tandem` stdio entry's script, kept out of `dist/cli` because that
  // bundle is deliberately NOT self-contained (see the CLI block below) and so
  // cannot run from a Tauri resource dir, which ships no `node_modules`.
  //
  // No `define` block, like its siblings: nothing in this entry's import
  // closure reads `__TANDEM_VERSION__` / `__APP_VERSION__` /
  // `__LICENSE_GATE_ENABLED__`. If that changes, add them — esbuild leaves an
  // absent define as a bare free global, a runtime ReferenceError with no
  // build error.
  sidecarBundle("stdio-bridge"),
  {
    // NOT `...selfContained`, deliberately: `noExternal: [/.*/]` would inline
    // `src/cli/start.ts` and with it a second copy of the whole server, and
    // `selfContained`'s `createRequire` banner would be overwritten by the
    // shebang banner below. The cost is that this bundle needs a sibling
    // `node_modules` — fine for an npm global install, which is the only place
    // it ships. Anything that must run without one gets its own entry above.
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
      __LICENSE_GATE_ENABLED__: JSON.stringify(LICENSE_GATE_ENABLED),
    },
  },
]);
