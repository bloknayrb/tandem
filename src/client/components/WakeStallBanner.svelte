<script lang="ts">
import LiveRegion from "./LiveRegion.svelte";
import "./tandem-banner.css";

/**
 * "Your message is still waiting" (Track D-5).
 *
 * A projection of current truth, not an event — the same shape as
 * `FidelityReportBanner`. The `no-push` and `offline` notices fire once at
 * send, on what was known then; this one answers whether the thing you sent is
 * STILL unanswered, so it re-derives from live state and erases itself when a
 * poll finally lands. Hence **no dismiss button**: a dismissible control on a
 * projection either lies (hidden while still true) or nags (returns instantly),
 * and there is nothing here for the user to acknowledge.
 *
 * `info`, not `warning`. Nothing is broken and nothing has been lost — the
 * message is queued and `tandem_checkInbox` will surface it whenever the model
 * next runs. What the user gains is the difference between "asynchronous" and
 * "broken", which is the confusion that started this whole line of work.
 *
 * All of the decision-making lives in `status/delivery-stall.ts`. This
 * component only formats.
 */

interface Props {
  /**
   * ms the oldest unanswered message has waited, or null to render nothing.
   * Callers should pass `deliveryStall`'s result, which only ever yields a
   * value at or above `DELIVERY_STALL_MS` — the sub-minute range is
   * unreachable in practice, and the clamp below keeps it sane regardless.
   */
  stalledMs: number | null;
  /**
   * The server keys delivery rounds (multi-session ownership, #2358 PR
   * 3b-2e2; the owner's 2026-11-17 answer 3). The message is then said to be
   * waiting, with no promise of when Claude will look: with two sessions the
   * next check-in may be a session that is never handed it. Absent or false,
   * the wording is exactly as before.
   */
  keyed?: boolean;
}

const { stalledMs, keyed = false }: Props = $props();

/**
 * Rounded DOWN to whole minutes, deliberately. The banner appears at the
 * two-minute threshold, and "3 minutes" while 3:59 has elapsed understates the
 * wait — which is the safe direction for a claim about someone else's silence.
 *
 * Floored at one minute so the component is total: a caller that ignored the
 * threshold would otherwise render "0 minutes", or "-1 minutes" off a clock
 * skew, which reads as a bug rather than as a wait.
 */
const waited = $derived.by(() => {
  if (stalledMs === null) return null;
  const minutes = Math.max(1, Math.floor(stalledMs / 60_000));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
});

/**
 * The second sentence. With keyed rounds (#2358 PR 3b-2e2) it only says the
 * message is waiting: no promise of when Claude will look, and no dismiss (the
 * owner, 2026-11-23, "As decided, no dismiss"). Flag off it is the old promise
 * byte for byte, including the line break and indent the template it replaced
 * carried into the DOM (a browser collapses them; the flag-off DOM is pinned
 * identical in `tests/client/wake-stall-banner.test.ts`).
 */
const after = $derived(
  keyed
    ? "Your message is still waiting."
    : "Your message is queued — it'll be seen the next\n        time Claude checks in.",
);
</script>

<!-- #1431: the host outlives the banner. `stalledMs` is null at mount and only
     crosses the stall threshold later, so the sentence arriving is a mutation of
     a region already in the accessibility tree — which is the only thing an AT
     announces. The banner div carries no live attributes of its own. -->
<LiveRegion data-testid="wake-stall-live">
  {#if waited !== null}
    <div
      class="tandem-banner tandem-banner--info"
      data-testid="wake-stall-banner"
    >
      <span class="tandem-banner__message">
        Claude hasn't picked this up for {waited}. {after}
      </span>
    </div>
  {/if}
</LiveRegion>
