# Caller-supplied write destinations, and a CSRF hole found while investigating them

**Status:** rewritten 2026-08-28 after adversarial review demolished the first draft
**Found by:** three security-reviewer passes over the CodeQL alert set during PR #1650

## What the first draft got wrong

Recording this first, because the corrections are the useful part and because the first draft's
central proposal was a no-op that would have shipped looking like a fix.

1. **`assertPathSafe` does not walk symlinked path components.** It `lstat`s exactly one — the
   deepest existing ancestor — then `break`s (`integrations/apply.ts:580-601`). What actually
   catches a symlinked intermediate is `realpathSync` plus the `allowedRoots` containment test at
   `:602-608`. Widen `allowedRoots` to the filesystem root and nothing is left. At both proposed
   sites the parent is **already** `realpath`'d (`convert.ts:130`, `:154-162`;
   `docx-apply.ts:330`), so the call would have been provably dead code. The draft's "ship the
   symlink walk, defer containment" had it exactly inverted: containment *is* the whole value.
2. **Save-As and rename do not have containment either.** Both call
   `assertPathSafe(resolved, { allowedRoots: [path.parse(resolved).root] })` — the same widening
   the draft proposed — with a written rationale that Save-As is user-driven
   (`document-service.ts:715-733`, `:1044-1050`). So "the siblings have it, consistency argues for
   it" was backwards. **They deliberately rejected it.**
3. **There are five sites, not four.** `tandem_exportAnnotations` (`annotations.ts:771-936`) takes
   a caller-supplied absolute `outputPath` with a UNC screen only — no extension pin, no
   containment, and **no `findAvailablePath`**, because overwrite-on-collision is intentional
   there (`annotations.ts:851-853`). It is strictly the more capable primitive, and `convert.ts:100`
   points straight at it. The draft read that pointer and did not follow it.
4. **A `.docx` pin would break the regression test for this PR's own §1 fix.**
   `docx-apply.test.ts:1166-1187` passes an extensionless `backupPath` and expects success — it is
   the pin for the `slice(0, -0)` bug. Pinning the extension retires it.
5. **`INVALID_PATH` is not what an MCP caller sees.** `document.ts:1073-1080` and
   `docx-apply.ts:463` both map it to `FORMAT_ERROR`. Every proposed spec asserted the internal
   thrown code, so none could have passed even after the fix — and `FORMAT_ERROR` would tell an AI
   caller to retry the *document* format when the *path* was rejected. Also
   `PathRejectedError` (`apply.ts:284-293`) carries no `.code` at all, so both catch chains would
   have let it escape to a 500.
6. The four-row table's line citations were drifted by 5–8 lines throughout.

**The corrected picture: none of the five sites has root containment, and two have no extension
pin.** That is a coherent product posture, not an oversight — which changes this from "fix a bug"
to "propose a policy change", and makes it Bryan's call rather than mine.

## The part that is unambiguous, and ships: CSRF on three mutating routes

Found while establishing whether alert 185 was web-reachable. It is not — but this is.

`enforceLoopbackMutation` checks `req.socket.remoteAddress` (`mcp/api-routes.ts:283`), and a
browser on the user's machine connects from 127.0.0.1. `authMiddleware` exempts loopback *before*
any token check (`auth/middleware.ts:164-168`), so no credential is ever needed. The Host check
accepts `127.0.0.1:<port>` — it defeats DNS rebinding, not a direct-IP fetch.

A `Content-Type: text/plain`, `mode: 'no-cors'` POST is a **simple request**: no preflight, so the
origin allowlist never gets a say. **Measured, not inferred** (express 5.2.1, this repo's
`node_modules`): `text/plain`, `application/x-www-form-urlencoded`, `multipart/form-data` and a
missing Content-Type *all* leave `req.body === undefined`, while `application/json` parses. So an
attacker can reach any of these handlers but cannot inject a single field.

Of the nine routes CLAUDE.md lists as single-layer, **two reach a real side effect** with an
all-undefined body, and a third is worth hardening on the same reasoning:

| Route | Side effect | Why it gets through |
|---|---|---|
| **`/api/save`** | **Overwrites the user's file on disk** whenever the steady state holds (`saveDocumentToDisk` has ten skip returns — open, on-disk, not read-only, saveable format, no save in flight, no unresolved conflict, no external modification — and no dirty check). For an open `.docx` it re-exports through mammoth over the original, losing what the converter cannot represent. The binary carve-out at `document-service.ts:307` does not stop this and was never meant to: it is scoped to `source === "auto-save"`, and `routes/save.ts:127` passes `"manual"` — the same value the user's own Ctrl+S carries. The attack does what a legitimate explicit save does, rather than slipping past a guard aimed at it | `routes/save.ts:30` `req.body ?? {}`; falls to `getActiveDocId()` at `:37` and `saveDocumentToDisk` at `:109` |
| **`/api/convert`** | Writes a new `.md` beside the user's document **and flips the active document** | `routes/convert.ts:6`; both guards are `!== undefined`, so `convertToMarkdown(undefined, undefined)` targets the active doc |
| `/api/rotate-token` | **Hardening, not a hole — review corrected an earlier draft of this doc that listed it as a third finding.** It swaps the in-memory auth token from disk and arms a 60-second grace window, but in the steady state the disk token already equals the in-memory one, so the swap is a no-op and the grace slot holds the already-current credential; and the route 409s *before* touching any state whenever `TANDEM_AUTH_TOKEN` is set, which is the entire Tauri desktop build | `routes/rotate-token.ts:10` takes `_req` — the body is **never read**, so there is nothing to fail closed on |

The other five (`open`, `close`, `upload`, `annotation-reply`, `remove-annotation`) fail closed on
a missing required field before any Y.Doc access or notification. `apply-changes` reaches
`applyChangesCore` on the active document but only when it is an on-disk `.docx` with unapplied
suggestions — real, narrower than the rest.

`routes/scratchpad.ts:12-28` documents this exact attack and carries both gates. Its comment claims
it "was the ONLY mutating route with neither gate", which is false and needs correcting.

### The fix, and the trap in it

**`save`, `convert`, `apply-changes`** — add `assertOriginAllowlisted` + `assertLoopbackForMutation`
at handler top, mirroring scratchpad. Verified: `assertOriginAllowlisted` fails closed on a
*missing* Origin too, because `LOCALHOST_ORIGIN_RE.test("")` is false
(`mcp/api-routes.ts:112-121`). All three have browser-only callers
(`client/actions/builtin.svelte.ts:340,400,434`; `ReviewOnlyBanner.svelte:33`;
`ApplyChangesButton.svelte:33`), so the gate costs nothing.

**`rotate-token` must NOT get the origin gate.** Its only caller is the CLI via Node `fetch`
(`cli/rotate-token.ts:73-80`), which sends **no Origin** — the gate would 403 it every run, and the
CLI reads non-2xx as `serverRejected` and **rolls the new token back off disk** (`:82-85`,
`:105-109`). Applying the pattern uniformly breaks token rotation outright. Instead: **require a
parsed body.** The CLI already sends `Content-Type: application/json` with `{}`, which forces a
preflight the attacker cannot pass; the browser attack arrives `undefined`. `if (req.body ===
undefined) → 400` is the whole fix, and it is a *positive* proof of preflight passage rather than a
header check. Same reason `/api/open` must not get the origin gate: the Tauri sidecar POSTs it via
reqwest with no Origin (`src-tauri/src/lib.rs:110`, `:639-641`).

### What the fix breaks, and must be fixed with it

- **`tests/server/routes/response-path-scrub.test.ts:61-62`** builds requests as
  `{ body, headers: {}, socket: {...} }` — no Origin. **Six** specs turn into 403s, not four; an
  earlier draft undercounted. `tests/server/external-conflict.test.ts` loses two more, and its
  stub is worse than Origin-less — it has no `headers` object at all, so
  `assertOriginAllowlisted` **TypeErrors** rather than returning 403.
- **`tests/docs/loopback-gate-claims.test.ts`** derives the ungated set from source and compares it
  against the enumerations in **CLAUDE.md** and **docs/security.md**. Gating three routes shrinks
  nine to six, so both documents must be edited in the same PR or that test goes red. This is the
  doc-gate working exactly as designed.
- `scratchpad.ts`'s "ONLY mutating route" claim.

### Verification

- Per route, a spec that sends **no Origin** and asserts 403, and one that sends an allowlisted
  Origin and asserts the side effect still happens. The second is the required-GREEN control, and
  it must assert the *side effect*, not the status — a gate that 403s everything passes a status
  check.
- For `rotate-token`, a spec with `req.body === undefined` asserting 400, and one with a parsed
  `{}` asserting the rotation proceeds. The second is the regression guard for the CLI.
- The mutation that must go red: **delete one gate call.** The first draft's suite failed exactly
  this — its flagship `assertPathSafe` call could have been deleted with nothing turning red.

## The part that does not ship: containment

Alert 16 (`convert.ts` `outputPath`) is a **genuine defect** and must not be dismissed as a false
positive — the path is caller-controlled and reaches a write. But the fix that would actually close
it is root containment, and per correction #2 that contradicts a deliberate, documented decision on
the two guarded siblings. So it goes to `docs/security.md` as an open finding with this analysis,
not into a dismissal and not into a unilateral behaviour change.

**The threat is product-specific and sharper than "arbitrary file write".** An attacker who can
create `*.md` at an arbitrary absolute path can write `~/.claude/CLAUDE.md`, a project `CLAUDE.md`,
`.claude/agents/*.md`, or `~/.claude/skills/*/SKILL.md` — all Markdown, all auto-loaded into future
Claude Code sessions as instructions, all in directories that already exist. `findAvailablePath`
blocks overwrite but not creation, and a *new* `.claude/agents/evil.md` is sufficient. So in this
product `.md` is close to the worst extension to leave unpinned, and **an extension pin reduces
surface without removing the primitive.** Any pin must be sold that way.

**The open question for Bryan**, stated plainly because it is a policy choice and not a bug:
should a caller-named export or backup destination be confined to a root set? Save-As and rename
answered "no" deliberately. If the answer is still no, alert 16 is `won't fix` with the reasoning
above rather than `false positive`, and that is an honest record. If it is yes, it is one change
applied to all five sites at once, not to the two that happened to get alerts.
