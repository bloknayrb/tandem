import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import rootConfig from "../../playwright.config";
import baselinesConfig from "../../scripts/design-baselines/playwright.config";
import { GUARD_PROBE_PORT } from "../../scripts/e2e-guard";
import { E2E_APP_DATA_BASENAME, E2E_APP_DATA_DIR } from "../../scripts/e2e-paths";
import shotConfig from "../../scripts/screenshots/playwright.config";
import {
  E2E_MCP_PORT,
  E2E_VITE_PORT,
  E2E_WS_PORT,
  PERF_MCP_PORT,
  PERF_WS_PORT,
} from "../../scripts/test-ports";
import { DEFAULT_MCP_PORT, DEFAULT_WS_PORT } from "../../src/shared/constants";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

type WebServerEntry = {
  command: string;
  url: string;
  reuseExistingServer?: boolean;
  env?: Record<string, string>;
};

/** The root config's webServer entries, split by role. The backend is the one health-checked on `/health`. */
function splitEntries(config: { webServer?: unknown }): {
  vite: WebServerEntry;
  backend: WebServerEntry;
} {
  const entries = config.webServer as WebServerEntry[];
  const backend = entries.find((w) => w.url.endsWith("/health"));
  const vite = entries.find((w) => !w.url.endsWith("/health"));
  if (!backend || !vite) throw new Error("expected one backend and one Vite webServer entry");
  return { vite, backend };
}

/**
 * A correct guard that Playwright never loads protects nothing, and until this
 * file existed nothing referenced `playwright.config.ts` at all — the key could
 * be deleted, or quietly reverted to a relative path, with no test failing.
 */
describe("e2e-guard wiring", () => {
  it("is wired as globalSetup and the file exists", () => {
    expect(rootConfig.globalSetup).toBe(path.resolve(ROOT, "scripts/e2e-guard.ts"));
    expect(existsSync(rootConfig.globalSetup as string)).toBe(true);
  });

  it("keeps globalSetup ABSOLUTE so child configs inherit it", () => {
    // Playwright resolves a relative globalSetup against the LOADED config's
    // dir, so `./scripts/e2e-guard.ts` becomes
    // `scripts/screenshots/scripts/e2e-guard.ts` under the screenshots config
    // and dies with MODULE_NOT_FOUND. This regression has happened once.
    expect(path.isAbsolute(rootConfig.globalSetup as string)).toBe(true);
  });

  it("is inherited by the screenshots config", () => {
    expect(shotConfig.globalSetup).toBe(rootConfig.globalSetup);
  });

  it("guards the port the backend webServer actually uses (#1492 anti-vacuity)", () => {
    // FINDING-5 shape: the guard exports the port it probes, and this pins it
    // to both the harness constant and the webServer entry. A hand-revert of
    // either side back to DEFAULT_MCP_PORT would otherwise leave the guard
    // silently probing an empty product port — vacuous in CI, falsely loud on
    // a dev box — with every other test still green.
    const { backend } = splitEntries(rootConfig);
    expect(GUARD_PROBE_PORT).toBe(E2E_MCP_PORT);
    expect(GUARD_PROBE_PORT).not.toBe(DEFAULT_MCP_PORT);
    expect(backend.url).toBe(`http://127.0.0.1:${GUARD_PROBE_PORT}/health`);
  });
});

describe("#1492 — the E2E harness runs on its own reserved ports", () => {
  const { vite, backend } = splitEntries(rootConfig);

  it("uses non-product, non-dev ports", () => {
    expect(E2E_MCP_PORT).not.toBe(DEFAULT_MCP_PORT);
    expect(E2E_WS_PORT).not.toBe(DEFAULT_WS_PORT);
    // 5174 too: Vite auto-increments a second `npm run dev` onto it.
    expect([5173, 5174]).not.toContain(E2E_VITE_PORT);
  });

  it("keeps the E2E and perf pairs disjoint", () => {
    // A stale server from one harness must never answer the other's probe.
    const e2e = [E2E_VITE_PORT, E2E_WS_PORT, E2E_MCP_PORT];
    for (const p of [PERF_WS_PORT, PERF_MCP_PORT]) expect(e2e).not.toContain(p);
  });

  it("moves the backend webServer onto the reserved pair, in url AND env", () => {
    // url alone is not enough: the env block is what the server binds from, so
    // a url-only edit health-checks one port while the server sits on another.
    expect(backend.url).toBe(`http://127.0.0.1:${E2E_MCP_PORT}/health`);
    expect(backend.env?.TANDEM_MCP_PORT).toBe(String(E2E_MCP_PORT));
    expect(backend.env?.TANDEM_PORT).toBe(String(E2E_WS_PORT));
  });

  it("never adopts an existing backend", () => {
    // Adoption skips scripts/e2e-server.mjs's per-run wipe — the cascading
    // annotation-envelope failure its header documents (old guard gap 2).
    expect(backend.reuseExistingServer).toBe(false);
  });

  it("moves the Vite server onto its own strict port", () => {
    expect(vite.url).toBe(`http://127.0.0.1:${E2E_VITE_PORT}`);
    expect(rootConfig.use?.baseURL).toBe(`http://127.0.0.1:${E2E_VITE_PORT}`);
    expect(vite.command).toContain(`--port ${E2E_VITE_PORT}`);
    expect(vite.command).toContain("--strictPort");
  });

  it("exports the client's VITE_TANDEM_* env at config-module scope", () => {
    // The Vite webServer entry has no env: block by design. Playwright merges
    // (`{ ...process.env, ...options.env }`), so the child inherits process.env
    // — which importing the config module mutates. Importing rootConfig above
    // ran that mutation, which is what this asserts.
    expect(process.env.VITE_TANDEM_MCP_PORT).toBe(String(E2E_MCP_PORT));
    expect(process.env.VITE_TANDEM_WS_PORT).toBe(String(E2E_WS_PORT));
  });

  it("moves the design-baselines config onto the same reserved pair", () => {
    const { vite: blVite, backend: blBackend } = splitEntries(baselinesConfig);
    expect(blBackend.url).toBe(`http://127.0.0.1:${E2E_MCP_PORT}/health`);
    expect(blBackend.env?.TANDEM_MCP_PORT).toBe(String(E2E_MCP_PORT));
    expect(blBackend.env?.TANDEM_PORT).toBe(String(E2E_WS_PORT));
    expect(blBackend.reuseExistingServer).toBe(false);
    expect(blVite.url).toBe(`http://127.0.0.1:${E2E_VITE_PORT}`);
    expect(blVite.command).toContain(`--port ${E2E_VITE_PORT}`);
  });

  it("moves the perf config onto the perf pair (source-text pin)", () => {
    // TEXT pin, not an import. It used to be one because importing
    // tests/perf/playwright.config.ts threw by design when dist artifacts were
    // missing; that throw has since moved into tests/perf/assert-perf-builds.mjs
    // (a webServer preflight), because loading the config also broke
    // `npm run audit:dead-code` -- knip loads every playwright.config.ts it can
    // glob. Importing is now survivable, but the pin stays text on purpose:
    // what is being asserted is that these exact expressions appear in the
    // SOURCE, which an import cannot show -- a computed value that happened to
    // equal the right path would satisfy an import-based check.
    const src = readFileSync(path.join(ROOT, "tests/perf/playwright.config.ts"), "utf8");
    expect(src).toContain("`http://127.0.0.1:${PERF_MCP_PORT}/health`");
    expect(src).toContain("TANDEM_MCP_PORT: String(PERF_MCP_PORT)");
    expect(src).toContain("TANDEM_PORT: String(PERF_WS_PORT)");
    expect(src).not.toContain("DEFAULT_MCP_PORT");
    // FINDING 6: the perf-baked client must never land in dist/client.
    expect(src).toContain('path.join(REPO_ROOT, "dist", "perf-client", "index.html")');

    // The missing-build check is no longer an unconditional module-load throw
    // (it broke `npm run audit:dead-code`; knip loads every playwright config
    // it can glob). It is now a preflight in the command of the FIRST
    // webServer entry, and nothing else pins it: knip's `project` glob is
    // `tests/**/*.ts`, so the .mjs preflight is invisible to the dead-code
    // audit too. Simplify the command back to a bare `npx vite preview`, or
    // reorder the webServer array, and nothing goes red -- but a run without a
    // build gets a 120s health-check timeout instead of a one-line message,
    // and in the reorder case perf-server.mjs wipes PERF_APP_DATA_DIR for a
    // run that was already doomed.
    expect(src).toContain('path.join(__dirname, "assert-perf-builds.mjs")');
    // A text pin alone would survive deleting or renaming the script it names:
    // the config keeps its literal, this suite stays green, and `perf:gate`
    // dies at webServer start with `Cannot find module`. That matters more
    // than usual because nothing ELSE in the repo sees this file either --
    // tsconfig does not compile `.mjs` and knip's `project` glob is
    // `tests/**/*.ts`.
    expect(
      existsSync(path.join(ROOT, "tests", "perf", "assert-perf-builds.mjs")),
      "the perf config names a preflight script that does not exist",
    ).toBe(true);
    const webServerAt = src.indexOf("webServer:");
    const preflightAt = src.indexOf("PERF_BUILD_PREFLIGHT", webServerAt);
    const vitePreviewAt = src.indexOf("npx vite preview", webServerAt);
    expect(webServerAt, "no webServer array in the perf config").toBeGreaterThan(-1);
    expect(
      preflightAt,
      "PERF_BUILD_PREFLIGHT is not invoked inside the webServer array",
    ).toBeGreaterThan(-1);
    expect(
      preflightAt,
      "the build preflight must precede `vite preview` in the first webServer command",
    ).toBeLessThan(vitePreviewAt);
  });

  it("keeps every harness port out of docs/troubleshooting.md", () => {
    // BLOCKER-class collision (#1492 review, FINDING 1): the "Port already in
    // use" remedy there tells users to move their REAL Tandem to specific
    // ports. The old candidate pair (4478/4479) was exactly that remedy — a
    // harness there would freePort()-SIGKILL the desktop app of anyone who
    // followed the product's own docs. No harness port may ever appear in
    // that file, remedy block or otherwise.
    const doc = readFileSync(path.join(ROOT, "docs/troubleshooting.md"), "utf8");
    for (const port of [E2E_VITE_PORT, E2E_WS_PORT, E2E_MCP_PORT, PERF_WS_PORT, PERF_MCP_PORT]) {
      expect(doc).not.toContain(String(port));
    }
  });

  it("keeps product-port literals out of tests/e2e entirely", () => {
    // FINDING 2: the one raw `http://127.0.0.1:3479` fetch in scroll-pill
    // escaped the constant-import inventory and would have driven the
    // developer's real desktop Tandem (loopback + LOCALHOST_ORIGIN_RE admit
    // any 127.0.0.1 origin). Specs must reach the backend through
    // scripts/test-ports.ts and the client through baseURL-relative gotos.
    const dir = path.join(ROOT, "tests/e2e");
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts")) continue;
      const text = readFileSync(path.join(dir, name), "utf8");
      if (/(127\.0\.0\.1|localhost):(3478|3479|5173)/.test(text)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});

describe("harness ports cannot reach a shipped artifact", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    files: string[];
    scripts: Record<string, string>;
  };

  it("excludes the perf client from the published tarball", () => {
    // T3 FINDING 1: `files: ["dist/"]` publishes the WHOLE directory and
    // `prepublishOnly`'s `npm run build` does not clean it, so a `perf:gate`
    // run followed by a publish would ship dist/perf-client — a full client
    // bundle hardcoded to the perf backend pair. Nothing serves it (the server
    // serves ../client, Tauri names ../dist/client), so the cost is a
    // confusing artifact rather than a broken app, but the exclusion is what
    // makes "can never be shipped" true rather than merely likely.
    expect(pkg.files).toContain("!dist/perf-client");
  });

  it("routes the release client build through the env-stripping wrapper", () => {
    // T3 FINDING 2: src/client/utils/backend-ports.ts resolves VITE_TANDEM_*
    // from the AMBIENT environment at build time. `export
    // VITE_TANDEM_MCP_PORT=4729 && npm run build` (or `cargo tauri build`,
    // whose beforeBuildCommand is this same script) would otherwise bake the
    // harness port into the shipped client, leaving it permanently
    // "Disconnected" with no diagnosis. A bare `vite build` here is the
    // regression.
    expect(pkg.scripts.build).toContain("node scripts/build-client.mjs");
    expect(pkg.scripts.build).not.toMatch(/(^|&&\s*)(npx\s+)?vite build/);

    const wrapper = readFileSync(path.join(ROOT, "scripts/build-client.mjs"), "utf8");
    expect(wrapper).toContain('"VITE_TANDEM_WS_PORT"');
    expect(wrapper).toContain('"VITE_TANDEM_MCP_PORT"');
    expect(wrapper).toContain("delete env[key]");
  });

  it("greps the emitted bundle for every harness port", () => {
    // Second line of defence for the same hazard, and the only one that still
    // fires if the wrapper is routed around. Pinned against test-ports.ts so a
    // renumbered harness port cannot leave a stale marker behind — the marker
    // list is bare digits because that is the only form the port survives
    // minification in (the URL stays a template with the port as a variable);
    // verified against real builds in both directions.
    const verifier = readFileSync(
      path.join(ROOT, "scripts/ci/verify-harness-stripped.mjs"),
      "utf8",
    );
    const list = verifier.match(/const HARNESS_PORT_MARKERS = \[([^\]]*)\]/);
    expect(list).not.toBeNull();
    const declared = (list?.[1] ?? "").split(",").map((n) => Number(n.trim()));
    for (const port of [E2E_WS_PORT, E2E_MCP_PORT, PERF_WS_PORT, PERF_MCP_PORT]) {
      expect(declared).toContain(port);
    }
  });
});

describe("e2e app-data basename", () => {
  it("agrees across all three copies", () => {
    // scripts/e2e-server.mjs deliberately does NOT import the constant — it
    // re-validates by basename before an `rm -rf`, and that independence is the
    // safety boundary. This assertion is what keeps the duplication honest.
    const launcher = readFileSync(path.join(ROOT, "scripts/e2e-server.mjs"), "utf8");
    expect(path.basename(E2E_APP_DATA_DIR)).toBe(E2E_APP_DATA_BASENAME);
    expect(launcher).toContain(`const E2E_APP_DATA_BASENAME = "${E2E_APP_DATA_BASENAME}"`);
  });
});

describe("related-test hook transport", () => {
  const hook = readFileSync(path.join(ROOT, ".claude/hooks/related-test.sh"), "utf8");

  it("resolves vitest by walking up, with npx as the fallback", () => {
    // A bare relative `node_modules/...` is not equivalent to npx: git
    // worktrees have `tests/` but no `node_modules`, so the hook would print
    // "Running related test:" for a run that died with ERR_MODULE_NOT_FOUND.
    expect(hook).toContain("node_modules/vitest/vitest.mjs");
    expect(hook).toContain("npx vitest run");
  });

  it("finds the vitest entry from the repo root", () => {
    expect(existsSync(path.join(ROOT, "node_modules/vitest/vitest.mjs"))).toBe(true);
  });
});
