# Repository Guidelines

## Project Structure & Module Organization

Tandem is a TypeScript/Vite document editor with a Node server, CLI, monitor, and optional Tauri desktop shell. Main code lives in `src/`: `src/client` for the Svelte 5 UI (`.svelte` components + `.svelte.ts` rune-based modules), `src/server` for MCP/API and document services, `src/cli` for the `tandem` command, `src/channel` for event streaming, `src/monitor` for monitoring, and `src/shared` for common types and helpers. Desktop integration lives in `src-tauri`. Tests mirror product areas under `tests/client`, `tests/server`, `tests/cli`, `tests/monitor`, `tests/shared`, and `tests/e2e`. Docs are in `docs`, samples in `sample`, and generated output in `dist`.

## Build, Test, and Development Commands

- `npm run dev:standalone`: starts Vite, the server watcher, and monitor for local development.
- `npm run dev`: starts only the Vite client.
- `npm run build`: typechecks, builds the client with Vite, then bundles server/CLI code with tsup.
- `npm run typecheck`: runs both server and client TypeScript checks.
- `npm test`: runs Vitest unit and integration tests.
- `npm run test:e2e`: runs Playwright end-to-end tests.
- `npm run lint` / `npm run format`: run ESLint and Biome formatting.
- `npm run dev:tauri` / `npm run build:tauri`: run or package the Tauri desktop app.

## Coding Style & Naming Conventions

Follow `.editorconfig` and `biome.json`: UTF-8, LF endings, final newline, two-space indentation, 100-column formatting, double quotes, semicolons, and trailing commas. Svelte components use `PascalCase` (`.svelte` files); rune-based hooks use `camelCase` (`.svelte.ts` files); tests use `*.test.ts` or `*.spec.ts`; route/service files use descriptive kebab-case where the surrounding directory already does.

## Testing Guidelines

Vitest covers unit and integration behavior; Playwright covers browser workflows. Place tests under the owning `tests/<area>` directory and name them after the behavior or regression, for example `document-offset.test.ts` or `annotation-lifecycle.spec.ts`. Run focused Vitest suites with `npm test -- tests/server/document-service.test.ts`.

## Commit & Pull Request Guidelines

History uses Conventional Commits such as `feat(client): ...`, `refactor(annotations): ...`, `docs: ...`, and `chore: ...`; keep the scope specific when useful. PRs should include a concise problem/solution summary, linked issue or PR number when applicable, test commands run, and screenshots for visible UI changes. Note configuration, security, or migration impacts explicitly.

## Security & Configuration Tips

Do not commit secrets or local MCP credentials. Start from `.env.example` and `.mcp.json.example` when configuring local environments. Use `npm run doctor` to verify Node, ports, MCP configuration, and server health before reporting setup issues.
