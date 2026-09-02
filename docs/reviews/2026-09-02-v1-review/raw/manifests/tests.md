# Coverage manifest: tests

Generated from the agent transcript. Zero model tokens.

## Files touched (72)
- .github/workflows/ci.yml
- scripts/ci/coverage-gate.mjs
- scripts/ci/coverage-policy.json
- src/client
- src/client/
- src/client/hooks/
- src/client/hooks/useCoworkStatus
- src/client/hooks/useModels.svelte.ts
- src/server/
- src/server/annotations/schema.ts
- src/server/mcp
- src/server/mcp/license-gate.ts
- src/server/mcp/response.ts
- src/shared/
- tests/build/version-baked.test.ts
- tests/channel/run-timeouts.test.ts
- tests/cli/check-semantic-tokens.test.ts
- tests/cli/mcp-stdio.test.ts
- tests/cli/setup.test.ts
- tests/client/
- tests/client/app-action-mount-contract.test.ts
- tests/client/client-log-callsites.test.ts
- tests/client/cowork-admin-declined-modal-keyboard.test.ts
- tests/client/fixtures
- tests/client/integration-wizard-push-support.test.ts
- tests/client/list-ydoc-sync.test.ts
- tests/design-system-impl/css-pipeline-contract.test.ts
- tests/design-system-impl/testid-coverage.test.ts
- tests/docs/
- tests/docs/loopback-gate-claims.test.ts
- tests/docs/native-theme-claims.test.ts
- tests/docs/tool-count-drift.test.ts
- tests/docs/wake-availability-claims.test.ts
- tests/e2e/
- tests/e2e/annotation-lifecycle.spec.ts
- tests/e2e/fixtures
- tests/e2e/helpers.ts
- tests/e2e/rail-resize-handle.spec.ts
- tests/e2e/redesign-final-qa.spec.ts
- tests/fixtures
- tests/fixtures/
- tests/helpers/
- tests/hooks
- tests/monitor/build-artifact.test.ts
- tests/scripts/
- tests/scripts/acceptance-harness-wiring.test.ts
- tests/scripts/audit-origins.test.ts
- tests/scripts/coverage-gate-wiring.test.ts
- tests/scripts/coverage-manifest.test.ts
- tests/scripts/e2e-guard-wiring.test.ts
- tests/scripts/typecheck-tests-wiring.test.ts
- tests/scripts/windows-acl-proof-wiring.test.ts
- tests/server/
- tests/server/adr027-note-write-guards.test.ts
- tests/server/annotation-remove-seam.test.ts
- tests/server/annotation-reply-seam.test.ts
- tests/server/awareness.test.ts
- tests/server/changelog-path.test.ts
- tests/server/documents-open.test.ts
- tests/server/events/wake-socket.test.ts
- tests/server/export-path-canonicalization.test.ts
- tests/server/file-io/markdown-escaping.test.ts
- tests/server/file-watcher.test.ts
- tests/server/integrations/apply.test.ts
- tests/server/launcher/cwd-preview.test.ts
- tests/server/license-gate-coverage.test.ts
- tests/server/mcp-tool-integration.test.ts
- tests/server/open-pipeline-transact-batching.test.ts
- tests/server/platform.test.ts
- tests/server/reload.test.ts
- tests/server/session.test.ts
- tests/skill-instruction-contract.test.ts

## Commands run (52)
- `cat <scratchpad>/open-issues.txt`
- `wc -l <scratchpad>/baseline-vitest.txt && tail -60 <scratchpad-path>`
- `head -25 <scratchpad>/baseline-vitest.txt | cut -c1-400; echo ---; grep -n "skipped\|↓\|SKIP"`
- `cat vitest.config.ts && echo "=====PLAYWRIGHT=====" && cat playwright.config.ts`
- `cat scripts/ci/coverage-policy.json; echo "=====GATE====="; cat scripts/ci/coverage-gate.mjs`
- `echo "== test file census by subdir ==" && for d in tests/*/; do n=$(find "$d" -type f \( -name '*.test.ts' -o -name '*.spec.ts' \) | wc -l); echo "$n $d"; done`
- `echo "== .skip / .todo / .only / fixme / skipIf / runIf ==" && grep -rnE "\b(it|test|describe)\.(skip|todo|only|fixme|skipIf|runIf|concurrent\.skip)\b|\btest\.f`
- `echo "== package.json scripts ==" && node -e 'const p=require("./package.json"); for (const [k,v] of Object.entries(p.scripts)) console.log(k.padEnd(32), v)'; e`
- `cat .github/workflows/ci.yml`
- `echo "== e2e specs =="; wc -l tests/e2e/*.spec.ts | sort -rn; echo; echo "== e2e helpers/fixtures =="; ls tests/e2e/fixtures tests/e2e/*.ts | grep -v spec.ts`
- `cat tests/scripts/coverage-gate-wiring.test.ts`
- `echo "== coverage ignore hints in src/ =="; grep -rnE "v8 ignore|c8 ignore|istanbul ignore" src/ | head -40; echo "(count: $(grep -rnE 'v8 ignore|c8 ignore|ista`
- `echo "== build-artifact.test.ts =="; cat tests/monitor/build-artifact.test.ts; echo; echo "== version-baked.test.ts head =="; sed -n 1,40p tests/build/version-b`
- `echo "== try { ...expect... } catch =="; grep -rnE -B1 -A6 "^\s*try \{" tests --include='*.test.ts' --include='*.spec.ts' | grep -E "catch \((e|err|error|_)?\)?`
- `echo "== session.test.ts try/catch =="; sed -n 85,100p tests/server/session.test.ts; echo ...; sed -n 240,255p tests/server/session.test.ts; echo; echo "== rede`
- `echo "== .rejects / .resolves not preceded by await/return =="; grep -rnE "expect\(.*\)\.(rejects|resolves)\." tests --include='*.test.ts' --include='*.spec.ts'`
- `S=<scratchpad>; cat > $S/scan-zero-assert.mjs <<'EOF' // Heuristic scan: find it()/test() blo`
- `show() { echo "----- $1:$2 -----"; sed -n "$2,$(( $2 + ${3:-14} ))p" "$1"; };  show tests/skill-instruction-contract.test.ts 63 14 show tests/channel/run-timeou`
- `show() { echo "----- $1:$2 -----"; sed -n "$2,$(( $2 + ${3:-14} ))p" "$1"; };  show tests/server/file-watcher.test.ts 176 10 show tests/server/events/wake-socke`
- `S=<scratchpad>; cat > $S/scan-subject-mock.mjs <<'EOF' import { readFileSync, existsSync } fr`
- `S=<scratchpad>; cat > $S/scan-stale-mock.mjs <<'EOF' import { readFileSync, existsSync } from`
- `echo "== wiring / claims / contract tests =="; wc -l tests/scripts/*.test.ts tests/docs/*.test.ts tests/design-system-impl/testid-coverage.test.ts tests/design-`
- `S=<scratchpad>; grep -nE "^\s*test(\.describe)?(\.\w+)*\(\s*[\"'\]" tests/e2e/*.spec.ts > $S`
- `echo "== keyword hits per e2e spec (ERE) =="; for kw in "tandem_save|/api/save|\bsave\b" "find|replace|search" "restore|restart|generationId|session" "external|`
- `S=<scratchpad>; for f in annotation-lifecycle reply-threads chat-reveal settings-and-filters `
- `sed -n 1,100p tests/e2e/annotation-lifecycle.spec.ts; echo "....."; sed -n 160,291p tests/e2e/annotation-lifecycle.spec.ts`
- `echo "== fixtures =="; find tests/fixtures tests/client/fixtures -type f | sort; echo; echo "== schema version constants =="; grep -nE "SCHEMA_VERSION|CURRENT_.`
- `show() { echo "----- $1:$2 -----"; sed -n "$2,$3p" "$1"; }; show tests/server/reload.test.ts 28 40; show tests/server/reload.test.ts 138 146; show tests/server/`
- `for pair in "tests/skill-instruction-contract.test.ts:expectPerSessionAutoArmContract" "tests/cli/mcp-stdio.test.ts:async function settle" "tests/client/integra`
- `echo "----- settle -----"; sed -n 1529,1540p tests/cli/mcp-stdio.test.ts; echo "----- expectAligned -----"; sed -n 42,75p tests/e2e/rail-resize-handle.spec.ts; `
- `for h in useCoworkStatus useClaudeCliStatus useIntegrationWizard useModels useReachabilityCheck useAutostart; do f=src/client/hooks/$h.svelte.ts; echo "----- $f`
- `echo "----- useModels return block -----"; sed -n 451,560p src/client/hooks/useModels.svelte.ts | grep -nE "^\s+(get )?[a-zA-Z_]+(\(|,|:)" | cut -c1-80; echo; e`
- `cat tests/design-system-impl/testid-coverage.test.ts`
- `cat tests/server/license-gate-coverage.test.ts`
- `echo "== MCP registration mechanisms in src/server/mcp =="; grep -rnE "\.(tool|registerTool)\(|gatedTool\(|withErrorBoundary\(" src/server/mcp --include='*.ts' `
- `echo "== tool names at .tool/.registerTool sites =="; grep -rhoE "\.(tool|registerTool)\(\s*\"tandem_\w+\"" src/server/mcp --include='*.ts' | grep -oE "tandem_\`
- `sed -n 1,120p tests/server/annotation-remove-seam.test.ts`
- `sed -n 120,434p tests/server/annotation-remove-seam.test.ts | grep -vE "^\s*(//|\*|/\*)" | grep -nE "describe\(|it\(|expect\(|filesMentioning|SRC_FILES|toEqual\`
- `sed -n 339,365p tests/server/annotation-remove-seam.test.ts; echo "=================== REPLY SEAM ==================="; grep -vE "^\s*(//|\*|/\*)" tests/server/`
- `grep -vE "^\s*(//|\*|/\*)" tests/server/documents-open.test.ts | grep -nE "describe\(|it\(|expect\(|filesMentioning|SANCTIONED|ALLOWED|IMPORTERS|toStrictEqual\(`
- `grep -vE "^\s*(//|\*|/\*)" tests/design-system-impl/css-pipeline-contract.test.ts | grep -nE "describe\(|it\(|expect\(" | head -40`
- `grep -vE "^\s*(//|\*|/\*)" tests/scripts/typecheck-tests-wiring.test.ts | grep -nE "describe\(|it\(|expect\(" | cut -c1-170 | head -50`
- `grep -vE "^\s*(//|\*|/\*)" tests/scripts/acceptance-harness-wiring.test.ts | grep -nE "describe\(|it\(|expect\(" | cut -c1-170 | head -45`
- `grep -vE "^\s*(//|\*|/\*)" tests/scripts/windows-acl-proof-wiring.test.ts | grep -nE "describe\(|it\(|expect\(" | cut -c1-170 | head -40`
- `grep -vE "^\s*(//|\*|/\*)" tests/docs/loopback-gate-claims.test.ts | grep -nE "describe\(|it\(|expect\(|BARE|SIX|six|const .*= \[" | cut -c1-170 | head -40`
- `grep -vE "^\s*(//|\*|/\*)" tests/scripts/audit-origins.test.ts | grep -nE "describe\(|it\(|expect\(" | cut -c1-170`
- `echo "== e2e-guard-wiring =="; grep -vE "^\s*(//|\*|/\*)" tests/scripts/e2e-guard-wiring.test.ts | grep -nE "describe\(|it\(" | cut -c1-150; echo; echo "== tool`
- `sed -n 1,35p tests/docs/tool-count-drift.test.ts | grep -vE "^\s*(//|\*|/\*)" `
- `sed -n 20,36p tests/docs/tool-count-drift.test.ts`
- `sed -n 36,80p tests/docs/tool-count-drift.test.ts | grep -nE "registered|matchAll|RegExp|/\(|tool\\\\\(|registerTool" | cut -c1-200`
- `echo "== snapshot assertions =="; grep -rnE "toMatchSnapshot|toMatchInlineSnapshot|toMatchFileSnapshot" tests --include='*.ts' | cut -c1-160; echo; echo "== __s`
- `echo "== unit/integration owners of journeys without an e2e spec =="; for kw in "session.*restore|restoreSession|loadSession" "watcher|external.*change|fs\.watc`

## Probe/executed outputs (4)

### wc -l <scratchpad>/baseline-vitest.txt && tail -60 <scratchpad>/ba
(output 4460 chars)
```
81 <scratchpad>/baseline-vitest.txt

···········································stderr | tests/server/license-kv-store.test.ts > writeLicenseEntitlement > skips (never calls fetch) when KV is not configured
[license] Cloudflare KV not configured (TANDEM_CF_* unset) — skipping entitlement write

·············stderr | tests/server/license-gate.test.ts > gatedTool (registration wrapper) > wraps thrown handler errors in an INTERNAL_ERROR envelope (error boundary)
[Tandem] Tool tandem_test threw: Error: boom
    at <repo>/tests/server/license-gate.test.ts:84:13
    at <repo>/src/server/mcp/license-gate.ts:72:12
    at <repo>/src/server/mcp/response.ts:113:37
    at <repo>/tests/server/license-gate.test.ts:86:26
    at file://<repo>/node_modules/@vitest/runner/dist/chunk-artifact.js:302:11
    at file://<repo>/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:26
    at file://<repo>/node_modules/@vitest/runner/dist/chunk-artifact.js:2326:20
    at new Promise (<anonymous>)
    at runWithCancel (file://<repo>/node_modules/@vitest/runner/dist/chunk-artifact.js:2323:10)
    at file://<repo>/node_modules/@vitest/runner/dist/chunk-artifact.js:2305:20

········································································································stderr | tests/monitor/integration.test.ts > mode default convergence > monitor side uses the cold-start default 'tandem' when /api/mode omits the mode field on a cold start
[Monitor] Mode check failed (invalid mode undefined), no prior mode — using cold-start default 'tandem'

stderr | tests/monitor/integration.test.ts > mode default convergence > monitor side preserves an observed 'solo' across a later malformed /api/mode response (does NOT revert to the default)
[Monitor] Mode check failed (invalid mode undefined), preserving last known mode 'solo'

·····stderr | tests/server/sse-subscriber-count.test.ts > getSubscriberCount tracks the SSE fan-out > rises on connect and returns to baseline on close
[SSE] Client connected to /api/events
[SSE] Client disconnected from /api/events

stderr | tests/server/sse-subscriber-count.test.ts > getSubscriberCount tracks the SSE fan-out > counts each consumer independently
[SSE] Client connected to /api/events
[SSE] Client connected to /api/events
[SSE] Client disconnected from /api/events
[SSE] Client disconnected from /api/events

··········································stderr | tests/monitor/timeouts.test.ts > fetch timeout > aborts a hung /api/mode fetch via AbortSignal.timeout and falls back to the cold-start default
[Monitor] Mode check failed (/api/mode timed out after 2000ms), no prior mode — using cold-start default 'tandem'

························stderr | tests/server/notifications.test.ts > notifications > subscriber error does not prevent other subscribers from receiving
[Notifications
```

### head -25 <scratchpad>/baseline-vitest.txt | cut -c1-400; echo ---; grep -n "skipped\|↓\|SKIP" <scratchpad-path>
(output 1720 chars)
```
stderr | tests/server/sse-cors-inheritance.test.ts > /api/events inherits the CORS decision (#1291) > still echoes an allowlisted loopback origin onto the stream
[SSE] Client connected to /api/events

stderr | tests/server/sse-cors-inheritance.test.ts > /api/events inherits the CORS decision (#1291) > opens the stream at all
[SSE] Client disconnected from /api/events

stderr | tests/server/sse-cors-inheritance.test.ts > /api/events inherits the CORS decision (#1291) > opens the stream at all
[SSE] Client connected to /api/events

stderr | tests/server/sse-cors-inheritance.test.ts
[SSE] Client disconnected from /api/events

·························stderr | tests/server/session-metadata.test.ts > session metadata (#103) > returns 0 annotations for a corrupt envelope
[parseAnnotationDoc] JSON.parse failed: SyntaxError: Expected property name or '}' in JSON at position 2 (line 1 column 3)
    at JSON.parse (<anonymous>)
    at parseAnnotationDoc (<repo>/src/server/annotations/schema.ts:300:24)
    at annotationCountForPath (<repo>/src/server/session/manager.ts:557:18)
    at <repo>/src/server/session/manager.ts:573:24
    at async Promise.all (index 0)
    at <repo>/tests/server/session-metadata.test.ts:110:18
    at file://<repo>/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:20

···········································stderr | tests/server/license-kv-store.test.ts > writeLicenseEntitlement > skips (never calls fetch) when KV is not configured
[license] Cloudflare KV not configured (TANDEM_CF_* unset) — skipping entitlement write

---
76: Test Files  614 passed | 2 skipped (616)
77:      Tests  10138 passed | 26 skipped (10164)
```

### cat vitest.config.ts && echo "=====PLAYWRIGHT=====" && cat playwright.config.ts
(output 12109 chars)
```
import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [svelte({ hot: false })],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
      "@server": path.resolve(__dirname, "src/server"),
      "@client": path.resolve(__dirname, "src/client"),
    },
  },
  test: {
    projects: [
      {
        // Client tests: Svelte components need browser conditions + DOM environment
        plugins: [svelte({ hot: false })],
        resolve: {
          conditions: ["browser"],
          alias: {
            "@shared": path.resolve(__dirname, "src/shared"),
            "@server": path.resolve(__dirname, "src/server"),
            "@client": path.resolve(__dirname, "src/client"),
          },
        },
        test: {
          name: "client",
          environment: "happy-dom",
          include: ["tests/client/**/*.test.ts"],
          // Same reason the node project below carries 15s, and the same
          // number: under vitest's parallel pool this project's specs exceed
          // the 5s default while doing nothing unusual. `useTauriFileDrop`
          // runs 18 specs in 2.9s alone (~160ms each) and times out at 5s when
          // the machine is loaded -- a ~30x spread, so the ceiling was
          // measuring contention, not the code.
          //
          // The asymmetry was the bug: the node project was given headroom
          // when it hit this and the client project never was, so every
          // developer running the suite alongside anything else lost time to
          // a red run that reproduced nowhere. Tests that genuinely hang still
          // surface at 15s.
          testTimeout: 15_000,
        },
      },
      {
        // Server / CLI / other tests: Node environment, no browser conditions
        resolve: {
          alias: {
            "@shared": path.resolve(__dirname, "src/shared"),
            "@server": path.resolve(__dirname, "src/server"),
            "@client": path.resolve(__dirname, "src/client"),
          },
        },
        test: {
          name: "node",
          environment: "node",
          // `exclude`, NOT a negated `include` entry. `include: [..., "!tests/client/**"]`
          // selects exactly the same 324 files -- verified by diffing
          // `vitest list --project=node --filesOnly` across both spellings -- but it
          // silently collects NO V8 coverage for any of them. Measured: with the
          // negation, `vitest run --project=node <any test> --coverage` reports
          // `Unknown% ( 0/0 )` and exits 0; with this spelling the same command
          // reports real per-file numbers. Because a run spanning both projects
          // aggregates to the same 0/0, every coverage run of the whole suite was
          // reporting nothing while exiting successfully -- the #1229 shape, and it
          // would have seeded Uni
```

### echo "== package.json scripts ==" && node -e 'const p=require("./package.json"); for (const [k,v] of Object.entries(p.scripts)) console.log(k.padEnd(32), v)'; echo; echo "== vitest/playwright versions
(output 3029 chars)
```
== package.json scripts ==
dev                              vite
dev:standalone                   node scripts/dev-standalone.mjs
dev:client                       vite
dev:server                       tsx watch src/server/index.ts
build                            npm run typecheck && node scripts/build-client.mjs && node scripts/check-font-assets.mjs && tsup
build:server                     tsup
check:fonts                      node scripts/check-font-assets.mjs
typecheck                        tsc -p tsconfig.server.json --noEmit && tsc --noEmit && svelte-check --tsconfig ./tsconfig.client.json --fail-on-warnings
typecheck:tests                  tsc -p tsconfig.tests.node.json --noEmit && tsc -p tsconfig.tests.client.json --noEmit && tsc -p tsconfig.tests.e2e.json --noEmit
server                           tsx src/server/index.ts
start:server                     node dist/server/index.js
channel                          tsx src/channel/index.ts
start:channel                    node dist/channel/index.js
test                             vitest
test:coverage                    cross-env TANDEM_COVERAGE=1 vitest run --coverage --coverage.reporter=text --coverage.reporter=json-summary --coverage.reporter=html --testTimeout=120000 --hookTimeout=300000 && node scripts/ci/coverage-manifest.mjs && node scripts/ci/coverage-gate.mjs
test:e2e                         playwright test
test:e2e:ui                      playwright test --ui
perf:gate                        tsx scripts/perf-build.ts && playwright test --config=tests/perf/playwright.config.ts
test:tauri-driver                npm --prefix tests/tauri-driver test
test:acceptance-harness          node scripts/spikes/run-acceptance-harness.mjs
capture:screenshots              cross-env SCREENSHOTS=1 playwright test --config=scripts/screenshots/playwright.config.ts
capture:design-baselines         cross-env CAPTURE_DESIGN_BASELINES=1 playwright test --config=scripts/design-baselines/playwright.config.ts
preview                          vite preview
lint                             eslint .
format                           biome format --write .
doctor                           tsx scripts/doctor.mjs
build:reaper                     node scripts/build-reaper.mjs
dev:tauri                        node scripts/download-node-sidecar.mjs && node scripts/build-reaper.mjs && cargo tauri dev
build:tauri                      node scripts/download-node-sidecar.mjs && node scripts/build-reaper.mjs && cargo tauri build
check:tokens                     tsx scripts/check-semantic-tokens.ts
check:links                      node scripts/check-doc-links.mjs
audit:dead-code                  knip
audit:origins                    tsx scripts/audit-origins.ts
audit:ymap-keys                  tsx scripts/audit-ymap-keys.ts
prepare                          husky
prepublishOnly                   npm run build

== vitest/playwright versions ==
vitest ^4.1.0
@playwright/test ^1.58.2
@vitest/coverage-v8 ^4.1.11
happy-dom ^20.9.0
@
```
