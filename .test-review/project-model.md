# Tandem — production behavior model

Built **production-first**: five agents read `src/`, `scripts/`, `src-tauri/src/`, manifests, workflows
and `docs/`, with `tests/` and every `*.test.ts` deliberately out of view. No test informed a single
entry in this model. That ordering is the point — it is what lets the suite audit ask "does a test
protect this?" rather than "what does this test happen to assert?".

**Source revision:** `31145313aacbc829963ab2845c78c636e6ba9543` (branch `docs/mcp-lan-mutation-finding`)
**Uncommitted at model time:** `.claude/settings.json` (modified) — no production or test file dirty.
**Date:** 2026-09-08

## Where the entries live

> **`model-parts/` is untracked** — the five files below hold the full entries and live only on the
> machine the audit ran on. They are ~9,000 markdown lines, and
> `tests/server/file-io/roundtrip-repo-metric.test.ts` round-trips every tracked `.md` in the repo
> within a 120s budget, which committing them exceeded. This index, the counts, the caveats and the
> findings below are the tracked record.

| Part | Area | Behaviors | IDs |
|---|---|---|---|
| [server-documents.md](model-parts/server-documents.md) | Document / annotation / CRDT core, file watcher, events, positions | 70 | `SRVDOC-01…70` |
| [server-mcp-api.md](model-parts/server-mcp-api.md) | MCP tools, `/api` routes, license, launcher, integrations, channel | 78 | `SRVAPI-01…78` |
| [client-editor.md](model-parts/client-editor.md) | Tiptap editor, decorations, coordinates, sync, paste, link safety | 39 | `CLIED-01…39` |
| [client-shell.md](model-parts/client-shell.md) | Shell, tabs, panels, settings, theming, dialogs, keyboard | 42 | `CLISH-01…42` |
| [cli-tooling-native.md](model-parts/cli-tooling-native.md) | `tandem` CLI, `scripts/` build+CI gates, `.github/workflows`, Rust desktop | 200 | `TOOL-01…200` |

**429 entries total.** Each carries: flow (trigger → decisions → state changes → outcome *and* failure
path), `file:line` anchors, scope, impact, the contract that states the *intended* behavior (ADR number,
a numbered CLAUDE.md Critical Rule, a `docs/` section, or `code only`), and a confidence label separating
a documented contract from behavior inferred out of the implementation.

## Read this before using the counts

**Granularity is not comparable across parts.** `cli-tooling-native.md` has 200 entries for ~7k lines of
CLI plus `scripts/` plus Rust; `client-editor.md` has 39 for a much larger surface. The CLI pass modeled
at roughly one entry per function, the client passes at roughly one entry per user-visible behavior.
Counting entries per area therefore measures how each agent chose to slice, not how much ground is
covered. Downstream, the heat map is keyed to **impact**, never to entry count, and no percentage in the
audit is computed per-area against these denominators.

**These are declared gaps, not clean bills.** Every part closes with an explicit "not modeled" section.
The substantive ones:

- `src/server/local-model/**` internals (`loop.ts`, `ollama-client.ts`, `tools.ts`, `prompts.ts`,
  `config.ts`, `config-source.ts`) — only the collaborator wiring layer is modeled. The subsystem ships
  dark behind `BYO_MODELS_ENABLED === false`.
- Within `integrations/apply.ts` (2,560 lines): the stale-binary-repair family
  (`refreshMcpEntryBinary`, `refreshAllMcpEntryBinaries`, `convergeNpxEntry`, `repairEntryInPlace`) and
  the channel-shim-decision family (`resolveChannelShimIntent`, `applyConfigWithToken`).
- Read-only route files: `document-raw.ts`, `sessions.ts`, `license.ts`, `notify-stream.ts`,
  `send-open-result.ts`, `health.ts`, `info.ts`, `diagnostics.ts`, `_shared.ts`.
- Client leaves: context menu, slash menu, `toolbar/`, `SourceView.svelte`, the command palette body,
  the integration wizard flow, seven of the nine Settings tab bodies, `ShortcutEditorList.svelte`,
  the shortcut matcher chain, `cowork-invoke.ts`, `ModelEditModal.svelte`.
- `canonicalize()` in the licensing signing path — audited by no pass.
- `src/shared/constants.ts` was never independently audited for Y.Map key completeness (Critical Rule 1).

A behavior absent from this model is **unknown**, not safe. Where the audit maps a test to nothing, that
is reported as `unknown`, not as a redundant test.

## Cross-cutting invariants the audit anchors to

These recur across parts and are the properties a defective oracle would most expensively fail to catch.

1. **The document is never changed unexpectedly.** The project's own framing (#1448 programme). Live in
   `SRVDOC` (save/backup/reload/conflict), `CLIED-18…30` + `CLIED-36` (markdown, paste transforms, and
   their ordering), `TOOL` (atomic write, self-write fingerprinting).
2. **Range validation is ordered, and the order is the contract** (Critical Rule 4): integer → ordering →
   lower bound → snapshot staleness → upper bound → non-empty → surrogate-safe → heading overlap.
   Four callers deliberately pass `surrogates: "ignore"`; the `.docx` export resolver snaps outward instead.
3. **Personal notes are never read, edited, resolved, removed or replied to by Claude** (ADR-027).
   Modeled as separate entries per write family and per read filter — see `SRVDOC-56…70`.
4. **Origin tagging is the contract, and the wrong helper is a silent bug** (Critical Rule 2). Only
   `browser` writes generate channel events.
5. **Loopback and origin gates govern only the routes that call them.** `enforceLoopbackMutation` is
   mounted on `/api` and nothing else; six mutating routes carry neither per-handler gate; two must not
   be given the origin gate at all.
6. **A gate that cannot fail is a defect** (#1229, ADR-051). For every CI gate and audit script the
   model records what would have to be true for it to report success while its property is violated.
7. **Two systems ship dark and must stay byte-identical while dark** — licensing (`LICENSE_GATE_ENABLED`,
   plus the separate empty Rust `LICENSE_UPDATE_ENDPOINT`) and the local-model collaborator
   (`BYO_MODELS_ENABLED`).

## Findings raised during modeling

Modeling is not a code review, and these were not sought. Two surfaced anyway and are recorded because
they change how a test should be judged. Neither is acted on here — this pass changes no production code.

- **`SRVDOC-70` — ADR-027 write guards carry no Solo-mode check.** `lifecycle.ts` contains exactly one
  `readModeState()` call, inside `writeReply`, and it only decides whether to stamp `heldInSolo` on a new
  reply. `tandem_resolveAnnotation` (dismiss) and `tandem_removeAnnotation` can therefore act on a
  Solo-held user comment that no read surface will return, given an id Claude held before the hold
  engaged. `hideFromAI`'s docstring scopes itself to the three pull surfaces and is silent on write
  reachability, so stated intent does not settle it. Labeled **unknown whether intentional**.
- **`SRVDOC-66` — the pull-side and push-side reply gates disagree.** `channelVisibleReplies` applies no
  author check; `narrowReplyForChannel` applies an explicit one. No comment in either file names the
  asymmetry.

A third is a documentation defect rather than a behavior: the first pass anchored two entries to
`reload-family.ts` when the code is in `watcher.ts`; corrected in place at `SRVDOC-32`.

## Method notes

- Intended behavior was taken from owner-authored contracts where they exist — ADRs in
  `docs/decisions.md`, numbered Critical Rules in `CLAUDE.md`, `docs/security.md`, `docs/gotchas.md`.
  Where the only evidence of intent is the implementation, the entry says `code only` in its Contract
  field and `inferred from code` in Confidence. Implementation was not laundered into contract.
- `docs/decisions.md` itself was not read end to end by the document-core pass; its ADR citations come
  from `CLAUDE.md` and code comments. Treat ADR references in that part as secondhand.
- Agents were run read-only, forbidden by name from `git checkout` / `restore` / `stash` / `clean` /
  `reset` / `apply` and from any write outside `.test-review/`. The working tree is unchanged.
