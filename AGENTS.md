# Repository Guidelines

## Project Structure & Module Organization

Tandem is a TypeScript/Vite document editor with a Node server, CLI, monitor, and optional Tauri desktop shell. Main code lives in `src/`: `src/client` for the Svelte 5 UI (`.svelte` components + `.svelte.ts` rune-based modules), `src/server` for MCP/API and document services, `src/cli` for the `tandem` command, `src/channel` for event streaming, `src/monitor` for monitoring, and `src/shared` for common types and helpers. Desktop integration lives in `src-tauri`. Tests mirror product areas under `tests/client`, `tests/server`, `tests/cli`, `tests/monitor`, `tests/shared`, and `tests/e2e`. Docs are in `docs`, samples in `sample`, and generated output in `dist`.

## Build, Test, and Development Commands

- `npm run dev:standalone`: starts Vite and the server watcher for local development. It deliberately does NOT start the monitor — an always-on push consumer with no Claude behind it masks `subscribers === 0`, the only sound negative the server has. Run `npx tsx src/monitor/index.ts` by hand when testing push delivery.
- `npm run dev`: starts only the Vite client.
- `npm run build`: typechecks, builds the client with Vite, then bundles server/CLI code with tsup.
- `npm run typecheck`: runs both server and client TypeScript checks.
- `npm test`: runs Vitest unit and integration tests.
- `npm run test:e2e`: runs Playwright end-to-end tests.
- `npm run lint` / `npm run format`: run ESLint and Biome formatting.
- `npm run dev:tauri` / `npm run build:tauri`: run or package the Tauri desktop app.
- Git hooks: `pre-commit` runs lint-staged (ESLint + Biome + a semantic-token scan); `pre-push` runs `biome check src/ tests/`, the **full** Vitest suite, and `cargo test`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the one-time setup `cargo test` needs — a fresh clone cannot push without it.

## Invariants That Fail Silently

These are not style preferences. Violating one produces code that type-checks, passes tests, and is wrong at runtime — read [`CLAUDE.md` → Critical Rules](CLAUDE.md) before touching the areas they cover.

- **Origin-tag every Y.Doc write.** Raw `doc.transact(...)` is forbidden in `src/`. Use one of the six helpers in `src/shared/origins.ts`; the helper you pick is a semantic contract that decides which observers and event consumers react. There is no blocking gate on this — only a warn-only hook and `npm run audit:origins`. See [ADR-031](docs/decisions.md).
- **Y.Map key strings come from `src/shared/constants.ts`**, never string literals.
- **stdout is reserved** for the MCP wire in stdio mode. `console.log/warn/info` are redirected to stderr; a dependency that writes to stdout corrupts the protocol.
- **Three coordinate systems** — flat text offsets, ProseMirror positions, and Yjs RelativePositions — are not interchangeable. Use `validateRange()` / `anchoredRange()` rather than raw offsets.
- **`tandem_getTextContent` uses `extractText()`, never `extractMarkdown()`**; the latter shifts offsets out of the annotation coordinate system.
- **`tandem_edit` refuses ranges that overlap heading markup.** A range covering a `## ` prefix returns `INVALID_RANGE`; target the text content, not the marker.
- **`data-testid` values are a contract, not labels.** E2E selectors are kebab-case and may be added but never removed or renamed. The set is snapshotted out of `src/client/` by `tests/design-system-impl/testid-coverage.test.ts`; renaming one without regenerating that snapshot fails CI. The human-readable list in [docs/design-system-impl/testid-manifest.md](docs/design-system-impl/testid-manifest.md) is a convenience copy that no test reads.
- **CORS denies by absence, never by `null`.** Emit `Access-Control-Allow-Origin` only for an allowlisted origin. `null` looks like a refusal but is a *grant* — it is the origin serialization of opaque contexts, so a sandboxed iframe on any page matches it (#1291). See [docs/security.md](docs/security.md).
- **A new mutating MCP tool or `/api` route must join the license-gated set in both halves.** An MCP write bypasses the Hocuspocus read-only surface, so gating a route while leaving its MCP twin ungated is a hole. Only the MCP half is CI-enforced (`tests/server/license-gate-coverage.test.ts`); the `/api` half is review-only against the enumeration in [`CLAUDE.md` → Licensing gate](CLAUDE.md). Note the gate is applied two ways — a `licenseGateMiddleware` mount *and* direct in-handler `licenseGate()` calls — so grepping the middleware name alone under-reports it.

## Coding Style & Naming Conventions

Follow `.editorconfig` and `biome.json`: UTF-8, LF endings, final newline, two-space indentation, 100-column formatting, double quotes, semicolons, and trailing commas. Svelte components use `PascalCase` (`.svelte` files); rune-based hooks use `camelCase` (`.svelte.ts` files); tests use `*.test.ts` or `*.spec.ts`; route/service files use descriptive kebab-case where the surrounding directory already does.

## Testing Guidelines

Vitest covers unit and integration behavior; Playwright covers browser workflows. Place tests under the owning `tests/<area>` directory and name them after the behavior or regression, for example `document-offset.test.ts` or `annotation-lifecycle.spec.ts`. Run focused Vitest suites with `npm test -- tests/server/document-service.test.ts`.

## Commit & Pull Request Guidelines

History uses Conventional Commits such as `feat(client): ...`, `refactor(annotations): ...`, `docs: ...`, and `chore: ...`; keep the scope specific when useful. PRs should include a concise problem/solution summary, linked issue or PR number when applicable, test commands run, and screenshots for visible UI changes. Note configuration, security, or migration impacts explicitly.

## Security & Configuration Tips

Do not commit secrets or local MCP credentials. Start from `.env.example` and `.mcp.json.example` when configuring local environments. Use `npm run doctor` to verify Node, ports, MCP configuration, and server health before reporting setup issues.
