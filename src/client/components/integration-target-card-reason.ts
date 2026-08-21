/**
 * #1422 — the per-status policy deciding HOW an `EntryValidation.reason`
 * reaches `IntegrationTargetCard.svelte`'s warning line.
 *
 * Extracted out of the component (extract-over-mount, same reason
 * `integration-wizard-helpers.ts` exists) so the decision is unit-testable
 * without mounting Svelte, and so
 * `tests/client/integration-target-card-reason-safety.test.ts` can pin the
 * policy against a source-text scan of the producers it is written against.
 *
 * WHY A POLICY PER STATUS, AND NOT ONE RULE FOR ALL SIX PRODUCERS.
 * `validateTandemEntry` and `validateChannelEntry`
 * (`src/server/integrations/existing-config.ts`) produce nine `reason:`
 * strings between them. Three interpolate text read straight out of the
 * user's config file, and they are not equally safe to paint onto a card:
 *
 *   - `invalid-command` interpolates `entry.command` — a command path. The
 *     card already renders `install.target.configPath` verbatim one line
 *     below, and a command path is no more sensitive than that. This is also
 *     the exact case #1422 was filed about ("a user whose ~/.claude.json has
 *     a UNC-pathed or otherwise non-Node-shaped command sees a card that
 *     declines to connect and gives no reason"), so withholding it IS the
 *     bug. Rendered in full.
 *   - `invalid-url` interpolates `entry.url`, and `LoopbackUrl` rejects
 *     non-empty `username`/`password` — so "the URL embeds a credential" is
 *     precisely one of the reachable ways to land on this status. Never
 *     rendered raw; the card rebuilds a scheme+host+port form from the
 *     PARSED entry url instead, which drops userinfo, path, query and
 *     fragment by construction rather than by pattern-matching them out.
 *   - `invalid-args` (npx branch) interpolates `JSON.stringify(args)` — an
 *     arbitrary user-supplied array, e.g.
 *     `{"command":"npx","args":["-y","@acme/mcp","--api-key","sk-live-…"]}`.
 *     The card renders the EXPECTED tuple (from the shared spec constant)
 *     and the argument COUNT, never the array.
 *
 * The remaining producers (`invalid-shape` in both validators, the Node-branch
 * and channel `invalid-args`) are fixed string literals today and are rendered
 * in full. Under a per-status policy that stays correct if someone rewords
 * them — which is the second reason this shape replaced the exact-string
 * allowlist it was first written as: an allowlist keyed on byte-equality means
 * rewording a safe reason silently reverts that card to generic copy, with no
 * test and no type error to notice. The one assumption a reword COULD break —
 * a "render in full" producer growing an interpolation — is what the guard
 * test in `integration-target-card-reason-safety.test.ts` pins.
 *
 * PRODUCER-AGNOSTIC ON PURPOSE. Nothing here is keyed to `validateTandemEntry`:
 * the reduced forms are built from the `McpEntry` the card already holds, so
 * feeding it a `channelValidation` would be correct too. The card does not do
 * that today (see the comment on its status derivation) — but the policy does
 * not have to change if a future surface does, and the guard test scans BOTH
 * validators so a channel-side producer cannot drift out from under it.
 *
 * NOT A SUBSTITUTE FOR THE SERVER SCRUB. `scrubValidation`/`scrubMcpEntry`
 * (`server/integrations/api-routes.ts`) already replace `reason` with fixed
 * per-status copy for NON-loopback callers of `GET /api/integrations/existing`.
 * Everything here governs the loopback render path — the desktop/CLI user
 * looking at their own machine's config — which is the path the server scrub
 * deliberately leaves alone.
 */

import type {
  EntryValidation,
  EntryValidationStatus,
  McpEntry,
} from "../../shared/integrations/contract.js";
import { TANDEM_STDIO_NPX_ARGS } from "../../shared/integrations/npx-entry-spec.js";
import { stripControlChars } from "../utils/diagnostics.js";

/**
 * How a status's `reason` is allowed to reach the card.
 *
 * - `verbatim` — render the producer's string (sanitized) as-is.
 * - `url-authority` — discard the producer's string; rebuild a scheme + host
 *   + port line from the parsed entry url.
 * - `argument-count` — discard the producer's string for the npx branch and
 *   rebuild it from the expected tuple plus the argument count; the other
 *   `invalid-args` producers carry no payload and are rendered verbatim.
 * - `status-copy` — never render the producer's string.
 */
export type ReasonPolicy = "verbatim" | "url-authority" | "argument-count" | "status-copy";

/**
 * The policy table. Lives next to the status union it is keyed on, which is
 * where the next person adding a status will look — the old exact-string
 * allowlist lived nowhere near it.
 */
export const REASON_POLICY: Record<EntryValidationStatus, ReasonPolicy> = {
  // Never reached: `tandemEntryValidationFailed` gates the card's warning
  // branch, so a `valid` validation never gets here. Present so the record is
  // total and adding a status is a type error rather than a runtime hole.
  valid: "status-copy",
  "invalid-shape": "verbatim",
  "invalid-command": "verbatim",
  "invalid-args": "argument-count",
  "invalid-url": "url-authority",
};

/**
 * Fallback copy naming the failed check without repeating its payload. Used
 * when a policy declines to render (an unparseable url, a missing entry) and
 * when `reason` is absent or empty.
 */
export const REASON_STATUS_COPY: Record<EntryValidationStatus, string> = {
  valid: "Has a custom setup — we won't touch it",
  "invalid-shape": "Has a custom setup — we won't touch it",
  "invalid-url": "Points somewhere we don't recognize — we won't touch it",
  "invalid-command": "Runs a command we don't recognize — we won't touch it",
  "invalid-args": "Passes arguments we don't recognize — we won't touch it",
};

/**
 * Union-drift floor. `EntryValidationStatus` is declared TWICE — once in
 * `server/integrations/existing-config.ts` (the producer) and once in
 * `shared/integrations/contract.ts` (what this file types against) — and the
 * two are not structurally tied. A status added server-side and not mirrored
 * into the shared copy arrives here as a string no `Record` has a key for, and
 * an unguarded lookup would render the literal text `undefined` on the card.
 * This is the fallback half of that fix; the parity assertion in
 * `integration-target-card-reason-safety.test.ts` is the half that makes the
 * drift visible instead of merely survivable.
 */
export const UNKNOWN_STATUS_COPY = "Has a custom setup — we won't touch it";

export function statusCopy(status: EntryValidationStatus): string {
  return REASON_STATUS_COPY[status] ?? UNKNOWN_STATUS_COPY;
}

export interface ReasonRenderResult {
  text: string;
  /** True when `text` is a diagnostic (a producer string, or one rebuilt from
   *  the entry) rather than hand-written copy — drives the card's monospace /
   *  wrap treatment so it reads as a diagnostic, not as body prose. */
  diagnostic: boolean;
}

/**
 * Decide what `IntegrationTargetCard`'s warning line shows for a failed
 * validation. `entry` is the `McpEntry` the validation was computed from —
 * required, because two of the four policies rebuild their text from the
 * entry's structured fields rather than from the producer's prose.
 */
export function renderValidationReason(
  validation: EntryValidation,
  entry: McpEntry | undefined,
): ReasonRenderResult {
  const { status } = validation;
  const reason = validation.reason === undefined ? "" : sanitizeReason(validation.reason);
  // An absent or empty wire `reason` (the field is optional and nothing
  // re-validates it once it lands in the client) must never render as a blank
  // diagnostic row on a card that is still locked.
  if (reason === "") return { text: statusCopy(status), diagnostic: false };

  switch (REASON_POLICY[status]) {
    case "verbatim":
      return { text: reason, diagnostic: true };
    case "url-authority":
      return renderUrlAuthority(status, entry);
    case "argument-count":
      return renderArgumentCount(reason, entry);
    default:
      // `status-copy`, and — via the `?? UNKNOWN_STATUS_COPY` in `statusCopy`
      // — any status this build has never heard of.
      return { text: statusCopy(status), diagnostic: false };
  }
}

/**
 * `invalid-url`: rebuild scheme + host + port from the entry's url.
 *
 * Built from `new URL(...)`, not from the producer's string, so userinfo,
 * path, query and fragment are dropped by construction — `parsed.host` is
 * host + port and nothing else. An entry whose url does not parse at all
 * falls back to status copy rather than guessing at a reduced form.
 */
function renderUrlAuthority(
  status: EntryValidationStatus,
  entry: McpEntry | undefined,
): ReasonRenderResult {
  const raw = typeof entry?.url === "string" ? entry.url : undefined;
  if (raw === undefined || raw === "") return { text: statusCopy(status), diagnostic: false };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { text: statusCopy(status), diagnostic: false };
  }
  // A url with no authority (`file:///x`, `mailto:…`) still names its scheme,
  // which is the whole diagnostic in that case.
  const authority = parsed.host === "" ? parsed.protocol : `${parsed.protocol}//${parsed.host}`;
  return { text: `url must be a loopback http url; got ${authority}`, diagnostic: true };
}

/**
 * `invalid-args`: the npx branch's producer embeds `JSON.stringify(args)`, so
 * rebuild it as expected-tuple + count. Every other `invalid-args` producer
 * (the Node branch's "exactly one .js arg", the channel validator's) is a
 * fixed literal carrying no payload, and is rendered verbatim.
 *
 * The npx branch is identified by `entry.command === "npx"` — the same bare-name
 * check the validator itself dispatches on (`existing-config.ts`; an absolute
 * npx is deliberately never accepted), not by pattern-matching the producer's
 * wording, so rewording it cannot silently flip this branch.
 */
function renderArgumentCount(reason: string, entry: McpEntry | undefined): ReasonRenderResult {
  if (entry?.command !== "npx") return { text: reason, diagnostic: true };
  const count = Array.isArray(entry.args) ? entry.args.length : 0;
  const expected = JSON.stringify(TANDEM_STDIO_NPX_ARGS);
  return {
    text: `npx args must be ${expected} (the package may be version-pinned); got ${count} argument${count === 1 ? "" : "s"}`,
    diagnostic: true,
  };
}

/**
 * Strip control / bidi characters and clamp length.
 *
 * Applied to every string this module renders, and separately to
 * `install.errorMessage` in the card. It is a floor under the per-status
 * policy, not the policy itself: the policy decides WHETHER a payload is
 * shown, this decides that whatever is shown cannot carry an ANSI escape, a
 * Trojan-Source bidi override, or an unbounded run of text through the card's
 * one-line status slot.
 *
 * It matters most for the two unbounded inputs: a `verbatim` `invalid-command`
 * reason (which interpolates a command path of any length) and
 * `install.errorMessage` (a raw `readFile` failure — Node embeds the path it
 * was reading, and nothing bounds it). 300 code points is a generous ceiling
 * against a pathological one, not a measured average; the fixed-literal
 * producers are all under 60 characters and never reach it.
 *
 * Clamps on code points via the spread, not `.slice()` directly — a plain
 * UTF-16 slice can split a surrogate pair (e.g. an emoji) and leave a lone
 * surrogate that renders as U+FFFD; `buildBugReportUrl` documents avoiding
 * exactly that mistake.
 */
const REASON_MAX_LENGTH = 300;

export function sanitizeReason(reason: string): string {
  const stripped = stripControlChars(reason).trim();
  const chars = [...stripped];
  return chars.length > REASON_MAX_LENGTH
    ? `${chars.slice(0, REASON_MAX_LENGTH).join("")}…`
    : stripped;
}
