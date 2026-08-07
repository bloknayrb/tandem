# Should Solo mode silence Claude's activity text?

**Issues:** #1287   **Decision needed:** In Solo, do we suppress the working-pill and status text (yes), or keep them and fix the copy instead (no)?

## What these are

The contradiction #1287 reports is real, and its cited mechanism checks out:

- `SOLO_PAUSED` sets `canAnimate: true` (`src/client/status/status-ai-view.ts:~65-72`), and the pill renders `{view.label}{#if claudeStatus && view.canAnimate} · {claudeStatus}` (`src/client/status/StatusBar.svelte:~406`). So `Solo · edits held · reviewing scratchpad…` is reachable by construction.
- `tandem_status`'s write branch sets `awarenessMap.set(Y_MAP_CLAUDE, {status: text, active: true, …})` with **no mode read** (`src/server/mcp/document.ts:827-841`).
- `src/server/mcp/typing-presence.ts` never imports `Y_MAP_MODE` at all — the per-tool `working` marker has no mode gate anywhere.
- The held pill is separate, driven by the persisted `heldInSolo` count, not live mode (`StatusBar.svelte:373-385`).

## Why they stalled

Because it isn't a bug, and treating it as one is what stalls it. Both signals are true. Solo's hold covers **annotation notifications** — `shouldForwardExternally` at the `pushEvent` fan-out and `replaySince`, plus `mode.ts#hideFromAI` on the pull paths. It does **not** block document mutations, does not block chat, and does not stop Claude reading the document. So Claude genuinely can be mid-tool-call while "held" shows. Nobody wants to write the fix until someone decides what Solo is supposed to *promise*.

## The honest tension

The label `Solo · edits held` overstates the contract in the direction of the user's inference: it sounds like "the AI is idle and blind." What Solo actually guarantees is narrower — *your comments and replies aren't being pushed to it, and won't appear in its inbox until you switch back.* The activity text is not contradicting the hold; it is contradicting an over-promise the label already made. That matters for which fix is right: suppressing the activity text would make the UI *agree with a claim that is false*, which is worse than the current visible disagreement.

## Options

**A. Suppress in Solo** — flip `canAnimate` to false for `SOLO_PAUSED`, gate the working pill on `!soloMode`. Two lines, zero server work. Buys a clean-looking pill by hiding a true signal; users lose the ability to tell "Claude is idle" from "Claude is working on something I can't see." Forecloses honest reporting later without re-litigating.

**B. Keep both, fix the copy** — re-word `SOLO_PAUSED` to promise only what Solo delivers (e.g. `Solo · comments held`), and qualify the activity text in Solo (`…(you're in Solo — it isn't seeing your comments)`). Copy-only, client-only. Leaves two pills competing for one strip of status bar.

**C. Gate at the source** — add mode checks to `tandem_status` and `withTypingPresence` so Solo suppresses the writes server-side. Most thorough, most expensive, and it destroys information the client might legitimately want; also asymmetric with the existing design where Solo gates *forwarding*, not *writing*.

**D. Run the full audit #1287 asks for** — enumerate every surface (status pill, working pill, held pill, `AnnotationCard` typing dot, `ActivityTray`, chat panel) before changing anything.

## Recommendation

**B, scoped by a cheap version of D.** Do not suppress. The Solo/Tandem contract is a *forwarding* boundary, and the UI should say that precisely rather than pretend to be an activity boundary. Reword the label so it stops over-promising, and qualify the activity text so the two read as one sentence instead of two claims.

Reject C: gating the *write* would be the first place Solo suppresses server state rather than delivery, and it would break the working pill's other job (proving a session is alive).

The audit is worth doing, but as a 30-minute enumeration feeding the copy — not as a prerequisite. #1287 already found the one combination that actually renders contradictorily; the open question it raises (can the working pill show while `aiView` is null?) is answered in the code: it can't, it's gated on `aiView?.canAnimate` (`StatusBar.svelte:434`).

## If yes / If no

**If yes (suppress):** two client edits and a test asserting no activity text renders in Solo. Also owes an answer to "how does the user now tell idle from working-invisibly?" — probably nothing, which is the cost.

**If no (recommendation B):** one copy pass over `status-ai-view.ts`'s `SOLO_PAUSED` strings, one conditional in the `aiIndicatorContent` snippet, a short enumeration of the other five surfaces recorded on #1287, and E2E assertions on the new strings via `status-ai-indicator`. No server change, no mode plumbing.
