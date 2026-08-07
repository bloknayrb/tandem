<script lang="ts">
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
  /** ms the oldest unanswered message has waited, or null to render nothing. */
  stalledMs: number | null;
}

const { stalledMs }: Props = $props();

/**
 * Rounded DOWN to whole minutes, deliberately. The banner appears at the
 * two-minute threshold, and "3 minutes" while 3:59 has elapsed understates the
 * wait — which is the safe direction for a claim about someone else's silence.
 */
const waited = $derived.by(() => {
  if (stalledMs === null) return null;
  const minutes = Math.floor(stalledMs / 60_000);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
});
</script>

{#if waited !== null}
  <div
    class="tandem-banner tandem-banner--info"
    role="status"
    aria-live="polite"
    data-testid="wake-stall-banner"
  >
    <span class="tandem-banner__message">
      Claude hasn't picked this up for {waited}. Your message is queued — it'll be seen the next
      time Claude checks in.
    </span>
  </div>
{/if}
