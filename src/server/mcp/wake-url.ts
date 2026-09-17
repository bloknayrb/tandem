/**
 * The single source of truth for which MCP tools hand out `wakeUrl`.
 *
 * This constant exists because the previous answer — "read-mode `tandem_status`,
 * and nothing else" — was a fact of the code that lived nowhere BUT the code.
 * It was restated in prose across `SKILL.md`, `SERVER_INSTRUCTIONS`, four
 * user-facing docs and the acceptance harness, so narrowing it was invisible to
 * every one of them. That is how a session whose whole task was one
 * `tandem_scratchpad({ content })` call ended up unable to arm a wake watch: it
 * never touched the one tool that could give it an address, and `SKILL.md`
 * rightly forbids guessing one.
 *
 * Naming the set once means adding a producer reds every surface that has to be
 * updated, instead of none of them.
 *
 * **`tandem_checkInbox` is deliberately absent and must stay absent.** It is
 * polled every 2-3 tool calls, so carrying `wakeUrl` there re-presents the arm
 * affordance dozens of times per session — the documented route to a second
 * watch (`wake-advisory.ts`), which also burns a `MAX_WAKE_CONSUMERS` slot and
 * makes `getSubscriberCount() === 0`, the only sound negative in the
 * connection-honesty surface, unreachable process-globally for every other
 * session. Its marginal coverage is near zero anyway: any session that reaches a
 * poll has already called one of the three below.
 *
 * **Why this is a per-tool list rather than a response-wrapper attach.**
 * `response.ts` already wraps every non-error envelope (`withWakeAdvisory`), so
 * a central attach looks like the deeper fix. It is not, and the reason is
 * state: `wakeUrl` is wanted ONCE per session, at the FIRST response. An
 * unconditional attach is the `tandem_checkInbox` hazard generalized to every
 * tool. A latched attach cannot be written — no per-session identity is
 * available at this layer (`claudeSessionId` is absent on direct HTTP,
 * `mcpSessionId` on MCP `2026-07-28`), so the latch would be process-global and
 * would permanently deny the URL to every session after the first in a server
 * run: strictly worse than the bug it would fix. So this layer stays stateless
 * and deterministic — same tool, same field — and the once-per-session bound
 * lives in the only layer holding session state, the model's own instructions
 * (`SKILL.md`'s "**first** … not a second invitation", pinned by
 * `tests/skill-instruction-contract.test.ts`).
 */

import { getWakeEndpoint } from "../events/wake-socket.js";

/** The MCP tools whose successful responses carry `wakeUrl`. */
export const WAKE_URL_PRODUCERS = ["tandem_status", "tandem_open", "tandem_scratchpad"] as const;

/**
 * The `wakeUrl` field, or nothing at all.
 *
 * ABSENT rather than present-and-undefined, which is the whole point of the
 * conditional spread: `JSON.stringify` hides the difference but `Object.keys`
 * and a strict client both see it, and a present-but-undefined `wakeUrl` reads
 * as a live transport where there is none. In stdio mode no wake transport is
 * attached, `getWakeEndpoint()` is null, and reporting no address is the truth.
 */
export function wakeUrlField(): { wakeUrl?: string } {
  const wakeUrl = getWakeEndpoint();
  return wakeUrl ? { wakeUrl } : {};
}
