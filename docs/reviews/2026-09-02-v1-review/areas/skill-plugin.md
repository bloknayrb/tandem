# Area: Shipped skill and plugin (`skills/tandem/SKILL.md`, `.claude-plugin/`)

**Raw:** [`../raw/findings-skill-plugin.txt`](../raw/findings-skill-plugin.txt) (Fable, resumed, 4 calls);
[`../raw/gapfill-C.txt`](../raw/gapfill-C.txt) (Sonnet, plugin leads).
**Manifest:** [`../raw/manifests/skill-plugin.md`](../raw/manifests/skill-plugin.md).
**Tracks:** [J words](../tracks/J-words.md) for the skill text; [F](../tracks/F-push-paths-and-cli.md)
for the double toolset; the version-pin item is in the upgrade-path area (#1790).
**Spot-check:** both Highs read at the cited lines; the version-skew measurement (per-tag curl and
md5) is the agent's.

The shipped skill is loaded into real user sessions. **Bump its frontmatter `version` with any
content change**, or `setup --apply` never refreshes the installed copy (that is the mechanism
behind the skew finding).

## Findings

| Sev | Where | Finding | Evidence | Status | Issue |
|---|---|---|---|---|---|
| H | `skills/tandem/SKILL.md:110`; `docs/workflows.md:311-316`; `docx-comments.ts:483-497`; `annotations.ts:390,396` | The recipe `tandem_getAnnotations({author: "import"})` can never return anything: imports land as `type: "note"`, the handler filters by author then drops notes, and promoted ones become `author: "user"`. The tool description at `:372` already says so. | [read] | Source-confirmed | [#1771](https://github.com/bloknayrb/tandem/issues/1771) |
| H | `src/server/mcp/annotations.ts` resolve → lifecycle accept; `useAnnotationReview.svelte.ts:299` | MCP accept of a `suggestedText` annotation flips status only; `applySuggestion` lives only in the client, and the tool description is silent. Under decision 3 Claude never accepts, so this survives only for user-authored records accepted via MCP. | [read] | Source-confirmed (grep) | [#1770](https://github.com/bloknayrb/tandem/issues/1770) |
| M | SKILL.md frontmatter vs `apply.ts:~2091-2141` `refreshSkillIfNewer` | v0.20.0 and v0.20.1 shipped changed content at unchanged `version: 4` (md5 55d1e8ea → 68fa0ce0), so upgraders never received it; the contract test pins the current number only, so the next content-only edit is unguarded. | [ran] | Agent-ran (per-tag curl + md5) | [#1790](https://github.com/bloknayrb/tandem/issues/1790) |
| M | `SKILL.md:25`; `document.ts:600-603` | Hard Rule 4 is stale both ways: a plaintext newline is now refused `INVALID_ARGUMENT` (#1460), and the rule never names `tandem_appendContent` / `tandem_editList`. Extends #1737. | [read] | Source-confirmed | [#1820](https://github.com/bloknayrb/tandem/issues/1820) |
| M | `SKILL.md:~60` | Never names `tandem_annotationReply`, so threads fork into chat. | [read] | Agent-reported | [#1820](https://github.com/bloknayrb/tandem/issues/1820) |
| M | SKILL.md | No rule against Edit/Write on a file open in Tandem (`EXTERNAL_CONFLICT` with no scripted recovery). | [read] | Agent-reported | [#1820](https://github.com/bloknayrb/tandem/issues/1820) |
| M | `docs/workflows.md:235-261`; `awareness.ts` `surfacedIds` | Sub-agent inbox polling drains the orchestrator's process-global ledger. `[inferred]`; lead-grade. | [inferred] | Agent-reported | [#1820](https://github.com/bloknayrb/tandem/issues/1820), [decision H](../decisions.md) |
| M | `doctor.ts:1842-1845` | Plugin plus `setup --apply` loads the `tandem_*` toolset twice (plugin servers namespace as `plugin_<plugin>_<server>`); doctor documents it as known and names no remedy. | [read] | Source-confirmed | [#1811](https://github.com/bloknayrb/tandem/issues/1811) |
| L | `SKILL.md:75,166-171`; `document.ts:580,956`; tool descriptions | Hard Rule 2 omits `textSnapshotTruncated` (extends #1486); the Error Recovery table is narrow and stale; "Reacting to Events" says `selection` where the field is `anchor`; the `.docx` workflow omits `heldFromExport`; read-only refusals say "(.docx)" for every read-only open; `tandem_search` query says "supports regex" while regex is opt-in; `tandem_edit` newline wording disagrees three ways. | [read] | Agent-reported | [#1820](https://github.com/bloknayrb/tandem/issues/1820), [#1823](https://github.com/bloknayrb/tandem/issues/1823) |

## Decided, not a finding

`.claude-plugin/plugin.json` ships `tandem-channel` unconditionally. `docs/decisions.md:378`
records KEEP (2026-08-08); only the inert-consumer rationale is unreconciled in
`architecture.md` (a #1821 line).

## Leads not run

Marketplace activation on macOS and Linux (arming measured on Windows only), a
[smoke line](../smoke-lines.md); the acceptance-harness Python was not read.

## Doc drift (in [#1821](https://github.com/bloknayrb/tandem/issues/1821))

`workflows.md:336` highlight target; `:~484` `freePort` 3478/3479 stale since #1492;
`:108-126` double comment; `welcome.md:13` "five kinds" vs the user guide's "three types".

## Verified fine

Every SKILL.md tool and parameter exists (33 registrations: 30 active + 3 deprecated stubs, matching
CLAUDE.md); the Getting Woken section matches the server; the plugin manifest pins 0.24.1
everywhere; monitor wake gating; tutorial targets and idempotency; 25/25 skill tests pass.
