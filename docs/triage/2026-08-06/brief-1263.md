# Chat scope: global or document-scoped?

**Issues:** #1263   **Decision needed:** Keep chat global in `CTRL_ROOM` and close #1263 as decided — yes or no?

## What these are

Chat lives in one place: `CTRL_ROOM`'s `Y.Map("chat")` (`Y_MAP_CHAT`, `src/shared/constants.ts:184`). Claude's replies append there (`src/server/mcp/awareness.ts:94-95`), and the channel observer watches that single map (`src/server/events/observers/ctrl-chat.ts:19`). There is no per-document chat map anywhere in `src/`.

But the *records* are already document-aware. `ChatMessage` carries optional `documentId`, `anchor`, and `replyTo` (`src/shared/types.ts:506-522`). #1264's work added two sibling maps, both still global:

- `Y_MAP_CHAT_SEEN = "chatSeen"` (`constants.ts:186`) — unread is a **flat message-id → bool map**, not per-document, with a single global `initialized` sentinel establishing the first-sync baseline (`useChatState.svelte.ts:54-57, 139-141`).
- `Y_MAP_CHAT_DOCUMENT_NAMES = "chatDocumentNames"` (`constants.ts:189`) — path-free filenames, GC'd when no message references the id (`useChatState.svelte.ts:150-165`), persisted by `src/server/session/manager.ts:187`.

So #1263's body is accurate: #1264 deliberately made state ID-aware while leaving scope global, to keep a later migration possible.

## Why they stalled

Nothing is blocked on it. #1264 shipped by routing *around* the question — that was the right call, and it removed the forcing function. The issue is labelled `needs-design-decision` and has had no activity since it was filed (created and last updated 2026-08-02, per `gh issue view 1263`). It is a decision with no deadline, so it never came due.

## Options

**A. Remain global.** Zero code. Forecloses per-document privacy boundaries in chat, and leaves the "which document is this about?" burden on the `documentId` byline. This is what ships today.

**B. Document-scoped.** Real migration cost: split one `CTRL_ROOM` map into per-room maps; decide where messages with **no** `documentId` go (they exist — the field is optional); replace the single global `chatSeen` baseline sentinel with per-room baselines, or accept one re-marking event on upgrade; rework session persistence. Also forces answers on scratchpads, Save-As promotion, and rename/move — none of which have one today.

**C. Hybrid.** Everything in B, plus thread-selection UI, plus a rule for which thread a reply lands in. Most expensive, and the one that most needs a mental model Tandem hasn't articulated.

## Recommendation

**A — remain global, and record it.** Tandem's own framing is a workspace companion: one Claude Code session spans the whole tab set, `tandem_checkInbox` is session-wide, and mode (Solo/Tandem) is deliberately global rather than per-document. Document-scoped chat would be the only workspace concept scoped narrower than the session driving it. The `documentId` byline already delivers most of what scoping buys, at none of the migration cost.

## If yes / If no

**If yes:** one ADR in `docs/decisions.md` recording "chat is global, `documentId` is context not scope", naming the untitled-document and Save-As cases as non-problems under global scope. Close #1263. No code.

**If no (B or C):** this stops being a triage item and becomes a multi-PR workstream — schema migration for `chatSeen`, a home for `documentId`-less messages, per-room observer wiring in `ctrl-chat.ts`, and a decision on Clear Chat's blast radius. Worth scheduling only if a concrete user complaint exists; none is cited on the issue.
