# Proposed diff — prompt audit, Tandem @ c447e96c

19 hunks. One finding per hunk, so they can be taken selectively. High-confidence first.

---
## H1 — `.claude/agents/crdt-reviewer.md:24` and `:57`

```diff
-- `docs/architecture.md` (lines 310-389) — coordinate system documentation
+- `docs/architecture.md` → **Coordinate Systems** section — coordinate system documentation
```

```diff
-Start by reading `docs/architecture.md` (lines 310-389) and `src/shared/offsets.ts`, then work through each focus area systematically.
+Start by reading the **Coordinate Systems** section of `docs/architecture.md` and `src/shared/offsets.ts`, then work through each focus area systematically.
```

---
## H2 — `.claude/agents/annotation-model-reviewer.md:13`

```diff
-- Server-side Y.Map mutations must be wrapped in `doc.transact(() => { ... }, MCP_ORIGIN)` to prevent channel echo
+- Server-side Y.Map mutations must go through an origin-tagging helper from `src/shared/origins.ts` (`withMcp` for MCP tool handlers) — raw `doc.transact(...)` is forbidden anywhere in `src/`, client included (ADR-031, #1482)
```

---
## H3 — `.claude/agents/annotation-model-reviewer.md:43`

```diff
-- **Rule:** Every Y.Doc write goes through one of the five wrapper helpers in `src/shared/origins.ts` — `withMcp` / `withFileSync` / `withInternal` / `withReload` / `withBrowser`. Raw `doc.transact(...)` is forbidden outside `src/shared/origins.ts` (caught by `.claude/hooks/check-raw-transact.sh`).
+- **Rule:** Every Y.Doc write goes through one of the six wrapper helpers in `src/shared/origins.ts` — `withMcp` / `withFileSync` / `withInternal` / `withReload` / `withBrowser` / `withModeRelease`. Raw `doc.transact(...)` is forbidden outside `src/shared/origins.ts`. Enforcement is warn-only and PostToolUse-only (`.claude/hooks/check-raw-transact.sh` never sees code no agent edited), so a clean hook run is not evidence — the CI gate is `tests/scripts/audit-origins.test.ts`.
```

## H3b — `.claude/agents/crdt-reviewer.md:46`

```diff
-- **Transaction origin tagging (ADR-031):** Every Y.Doc write goes through one of `withMcp` / `withFileSync` / `withInternal` / `withReload` / `withBrowser` from `src/shared/origins.ts`.
+- **Transaction origin tagging (ADR-031):** Every Y.Doc write goes through one of `withMcp` / `withFileSync` / `withInternal` / `withReload` / `withBrowser` / `withModeRelease` from `src/shared/origins.ts`.
```

---
## H4 — `.claude/agents/annotation-model-reviewer.md:52`

```diff
-- **Check:** Verify `tandem_getAnnotations`/`tandem_exportAnnotations` in `src/server/mcp/annotations.ts` filter notes before returning. Verify the annotations observer in `src/server/events/observers/annotations.ts` only emits events for `type: "comment"` (the `if (ann.type !== "comment") continue` guard on line 39).
+- **Check:** Verify `tandem_getAnnotations`/`tandem_exportAnnotations` in `src/server/mcp/annotations.ts` filter notes before returning. Verify the annotations observer in `src/server/events/observers/annotations.ts` only emits events for `type: "comment"` — grep the file for the `ann.type !== "comment"` guard rather than trusting a line number.
```

---
## H5 — `.claude/skills/dev-server/SKILL.md:15`

```diff
-- E2E tests (`npm run test:e2e`) will also kill dev servers on those ports
+- E2E tests (`npm run test:e2e`) do NOT touch :3478/:3479 — since #1492 they run on the reserved harness pair in `scripts/test-ports.ts` (Vite 4573, backend 4728/4729), so a suite run and a dev server coexist. What the harness does SIGKILL is anything holding 4728/4729.
```

---
## H6 — `.claude/agents/security-reviewer.md:17`

```diff
-- DNS rebinding protection on `/api` routes (Host-header validation in `apiMiddleware`)
+- DNS rebinding protection on `/api` routes: the load-bearing control is `isLoopback(req.socket.remoteAddress)` in `src/server/auth/middleware.ts` — the `Host` header is deliberately never consulted for it, and that is what makes rebinding non-exploitable. `apiMiddleware`'s `isHostAllowed()` check is a second layer, not the primary one; a change that "simplifies" loopback detection onto the Host header is the regression to look for.
```

---
## H7 — `.claude/agents/security-reviewer.md:18`

```diff
-- CORS on `/api` reflects `http://127.0.0.1:*` origins only (bare `localhost` was narrowed out in PR #637)
+- CORS on `/api` reflects only `127.0.0.1` and `tauri.localhost` origins (plus `TAURI_LINUX_ORIGIN`); bare `localhost` is rejected. Denial is by ABSENCE of `Access-Control-Allow-Origin` — emitting `null` is a grant, not a refusal (#1291).
```

---
## H8 — `.claude/agents/security-reviewer.md:20`

```diff
-- File extension allowlist: `.md`, `.txt`, `.html`, `.htm`, `.docx`
+- File extension allowlist (`SUPPORTED_EXTENSIONS`, `src/shared/constants.ts`): `.md`, `.markdown`, `.txt`, `.html`, `.htm`, `.docx`
```

---
## M1 — `src/server/mcp/awareness.ts:278-279` (`tandem_checkInbox`)

```diff
       description:
-        "Check for user actions you haven't seen yet — new comments, chat messages, and responses to your annotations. You cannot tell whether real-time push is reaching you, so poll at a steady cadence: every 2-3 tool calls, after completing any task, between steps, and whenever you pause. Items already returned by a previous poll are de-duplicated, so frequent calls are cheap. An item flagged `alreadyPushed` was also emitted as a real-time event — if you recognize it and already responded, don't respond twice. Low token cost — when in doubt, call it.",
+        "Return user actions not yet returned by a previous poll — new comments, chat messages, and replies to your annotations — plus the current collaboration `mode` and `activity`. This is the authoritative delivery path: real-time push cannot be confirmed to have reached a client, so nothing here is suppressed on the strength of a push, and steady polling is the only reliable way to see user activity. Repeat calls de-duplicate against what was already returned, so frequent polling never double-reports. An item carries `alreadyPushed: true` when it was also emitted as a real-time event; that describes the server's side only. Does not return user notes (`type: \"note\"`), which are private per ADR-027.",
```

Rationale: the removed text is behavioral coaching — a fixed poll cadence, a "don't respond twice" instruction, and a triggering booster — that already lives in `skills/tandem/SKILL.md` §Collaboration Etiquette. The rewrite keeps the *reason* polling matters (so the routing signal survives) and adds the two contract facts that were missing: `mode`/`activity` in the return, and note exclusion.

---
## M2 — `src/server/mcp/document.ts:997` (`tandem_save`)

```diff
     "tandem_save",
-    "Save the current document back to disk",
+    "Write the document's current content back to its file on disk. Tandem snapshots the file's " +
+      "original bytes before its first write each server run, so a save is reversible via " +
+      "tandem_restoreBackup. On .docx this also writes shared comments back as native Word " +
+      "comments and returns `fidelityWarnings` when the export downgraded anything — report those " +
+      "rather than claiming a clean round-trip. If the file changed on disk since it was opened " +
+      "the save is REFUSED and a conflict is reported instead; it is never silently overwritten. " +
+      "Uploaded (upload://) documents have no path, so the save is session-only.",
```

---
## M3 — `src/server/mcp/annotations.ts:471` (`tandem_removeAnnotation`)

```diff
     "tandem_removeAnnotation",
-    "Remove an annotation entirely",
+    "Delete an annotation and its whole reply thread permanently. Not the same as " +
+      "tandem_resolveAnnotation, which keeps the record and moves it to accepted/dismissed — " +
+      "prefer resolve unless the annotation should leave no trace. Refuses to remove user notes " +
+      "(type: \"note\"), which are private per ADR-027. There is no undo.",
```

---
## M4 — `src/server/mcp/annotations.ts:429` (`tandem_resolveAnnotation`)

```diff
     "tandem_resolveAnnotation",
-    "Accept or dismiss an annotation",
+    "Move a pending annotation to accepted or dismissed. Accepting one that carries " +
+      "suggestedText applies that text to the document; dismissing leaves the document " +
+      "unchanged. Only pending annotations can transition, and user notes cannot be " +
+      "transitioned at all (ADR-027). The record is kept either way — use " +
+      "tandem_removeAnnotation to delete it.",
```

---
## M5 — `src/server/mcp/document.ts:476-477` (`tandem_getTextContent`)

```diff
       description:
-        "Read document as plain text whose offsets match the annotation coordinate system.",
+        "Read the document as plain text whose character offsets are the coordinate system every " +
+          "range-taking tool uses (tandem_edit, tandem_comment, tandem_resolveRange). This is the " +
+          "read to use before anchoring: the text includes heading prefixes such as \"## \" and " +
+          "joins blocks with newlines, so offsets taken from it line up exactly. Pass `section` " +
+          "with a heading's text (case-insensitive) to read just that section. It never returns " +
+          "Markdown, even for .md files — Markdown syntax would shift offsets out of this " +
+          "coordinate system; call tandem_save and read the file if you need real Markdown.",
```

---
## M6 — `src/server/mcp/awareness.ts:241` (`tandem_getActivity`)

```diff
     "tandem_getActivity",
-    "Check if the user is actively editing and where their cursor is",
+    "Report whether the user is currently typing (`isTyping`), where their cursor and selection " +
+      "are, and which document they are in. Call it before annotating or editing near the " +
+      "user's cursor — annotating text someone is mid-sentence on is disruptive, and the range " +
+      "is likely to move under you. Returns presence only; it does not return document content " +
+      "or pending user messages (use tandem_checkInbox for those).",
```

---
## M7 — `CLAUDE.md:61-62`

```diff
 ## Development Workflow
 
-Quality over speed. Claude is an AI — time and effort have no cost. Never abbreviate steps.
-The only goal is the best possible work product.
-
 For every feature or fix: draft a plan (`/plan`), **spawn adversarial agents to review the plan
```

Rationale: Group 1a. The workflow contract in the paragraph that follows *is* the enforceable requirement and stays untouched. These two sentences are register-setting that a current model reads as a standing instruction to maximize effort on every task, trivial ones included.

---
## M8 — `.claude/skills/screenshots/SKILL.md:29-33`

```diff
-`scripts/take-screenshots.mjs` no longer exists. It was deleted in the
-post-v0.22.1 documentation overhaul: two pipelines writing the same filenames
-meant whichever ran last decided what the README showed, and for the three shots
-they shared they used different framing and different seed data. Its unique
-recipes were ported into the spec first.
+There is exactly one capture pipeline, and a second one must not be added: two
+pipelines writing the same filenames means whichever ran last decides what the
+README shows, with different framing and seed data per shot.
```

---
## M9 — `skills/tandem/SKILL.md:171`

```diff
-...and by `tandem_applyChanges` on anything that isn't a `.docx` opened from disk. Note `.docx` alone no longer causes this: those open editable.
+...and by `tandem_applyChanges` on anything that isn't a `.docx` opened from disk. A `.docx` on its own does not cause this — those open editable.
```

---
## M10 — `.claude/skills/e2e/SKILL.md:12`

```diff
-The product's 3478/3479 are untouched, so a running Tandem or `dev:server` coexists with an E2E run; you no longer need to quit anything.
+The product's 3478/3479 are untouched, so a running Tandem or `dev:server` coexists with an E2E run — leave it up.
```

---
## M12 — `.claude/agents/annotation-model-reviewer.md:53`

```diff
-- **Also check:** `tandem_editAnnotation` should reject edits to notes (they're user-private, Claude can't modify them).
+- **Also check the other three write families — a read filter is not a write guard, and covering
+  only the edit path is what let three write paths disagree until #1680.** The guards sit on
+  `editPending`, `transitionPending`, `AnnotationLifecycle.remove` and `AnnotationLifecycle.reply`,
+  and each must run AFTER `sanitizeAnnotation` (a legacy `flag` is only a note once normalized).
+  Two omissions are deliberate, so flagging them is a regression rather than a finding:
+  `removeAnnotationRecord` is unguarded because the browser's Archive calls it directly, and
+  `addUserReply` is unguarded because replying inside one's own note thread is what #1000 permits.
+  The reply guard tests `type === "note"` OR `type === "comment" && audience !== "outbound"` —
+  not `type !== "comment"`, which would make a highlight parent answer `invalid-note` instead of
+  `not-repliable`.
```

---
## M13 — `.claude/agents/annotation-model-reviewer.md:44`

```diff
-- **Check:** Grep for `.transact(` in `src/server/mcp/`. Every callsite should be a `withX` helper. MCP tool handlers must use `withMcp` (Claude-initiated user intent).
+- **Check:** Grep for `.transact(` across all of `src/`, `.svelte` files included — there is no `src/client` exemption (#1482), and three raw client calls survived for months precisely because sweeps were scoped to the server. Every callsite should be a `withX` helper. MCP tool handlers must use `withMcp` (Claude-initiated user intent). A bare `map.set(...)` is invisible to this grep; the DEV-only `installUntaggedWriteWarning` is its complement.
```

---
## M14 — `.claude/agents/svelte-migration-reviewer.md` — new section after §6

```diff
+### 7. $state Written From a Tiptap Event Handler
+- **Rule:** Never write `$state` synchronously from a Tiptap event handler — bridge through `createCoalescingTick` (`src/client/utils/coalescing-tick.ts`).
+- **Why:** a `$state` write inside an active Svelte reaction throws `state_unsafe_mutation` **in production too**. The error text names only `$derived`/`$inspect`, but a plain `{#if}` block triggers it, so the message misdirects.
+- **Check:** `transaction` subscribers are the exposed ones — the blur transaction carries no doc change while `update` is gated on `docChanged`. `transaction` also fires on every cursor move, which is why the tick coalesces.
+- **Non-finding:** writing state from `update` is the same class with no observed instance. Do not propose migrating handlers onto `transaction`.
```

---
## L1 — `skills/tandem/SKILL.md:20`

```diff
-These prevent the most common failures. Follow them always.
+These prevent the most common failures.
```
