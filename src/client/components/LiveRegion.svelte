<script lang="ts">
import type { Snippet } from "svelte";
import { SR_ONLY_STYLE } from "./live-region";

/**
 * Persistent ARIA live-region host (#1431).
 *
 * **The defect this exists to make expensive.** A live region only announces a
 * *mutation* to a region that was already in the accessibility tree. A
 * `role="status"` written on the node an `{#if}` creates is inserted together
 * with its text, and is commonly read out by nothing at all. Every such site
 * type-checks, renders, and passes any test that asserts "the warning text is
 * present" — so nothing but this primitive makes the correct shape the cheap
 * one.
 *
 * Two shapes, both of them just markup:
 *
 * - **Host** (`children`): wrap the `{#if}` rather than living inside it. The
 *   region outlives its content, so the content's arrival is a mutation.
 *   Only for a parent with no `gap` (the empty host would otherwise sit there
 *   as permanent dead air) and no sticky dependency.
 * - **Announcer** (`message` + `srOnly`): a permanently-mounted, out-of-flow
 *   copy of the sentence, sibling to the visible node. For gapped flex
 *   parents, sticky banners, and anywhere a box would cost layout. Always pair
 *   it with `aria-hidden="true"` on the *visible message node* — never on a
 *   container that also holds controls, or the controls leave the a11y tree.
 *
 * **One host per message, never one shared across independent messages.**
 * `role="status"` carries an implicit `aria-atomic="true"`, and the UA
 * traverses ancestors to the first element with `aria-atomic` set and presents
 * that element's *entire* contents — so a single host spanning four banners
 * would make a connection drop read out the trial-countdown sentence too.
 *
 * **Politeness is fixed, never computed from state.** A region whose
 * `role`/`aria-live` flips in the same commit that delivers its text has
 * changed identity at the moment it needed to announce. A site needing
 * assertive semantics writes a second, separately-owned region rather than
 * making this one's politeness reactive; see `FidelityReportBanner`.
 *
 * **No `$effect`, no timer, no async.** Deliberate. `await tick()` resolves on
 * a microtask (Svelte's rAF branch is behind `async_mode_flag`, which
 * `svelte.config.js` does not enable), so it defers nothing an AT can observe
 * and any test written to prove it would pass against a no-op. If a future
 * site genuinely needs a frame-crossing deferral it needs a real yield, a
 * teardown, and a test that asserts the mechanism — not `tick()`.
 *
 * `data-testid` rides in on `...rest` as a literal at each call site, so
 * `tests/design-system-impl/testid-coverage.test.ts` still captures the
 * concrete selector (Critical Rule 7). Keep it on one line — `parseValue`
 * returns null on a wrapped value.
 */

interface Props {
  /** Host shape: the `{#if}` that supplies the message goes in here. */
  children?: Snippet;
  /** Announcer shape: the sentence to speak. Empty string = nothing to say. */
  message?: string;
  /** Announcer shape: render out of flow and visually hidden. */
  srOnly?: boolean;
}

const { children, message, srOnly = false, ...rest }: Props & Record<string, unknown> = $props();
</script>

<!-- `{...rest}` first, so a call site cannot accidentally override the fixed
     live-region semantics that are the whole point of this component. -->
{#if children}
  <div {...rest} role="status" aria-live="polite">{@render children()}</div>
{:else}
  <div {...rest} role="status" aria-live="polite" style={srOnly ? SR_ONLY_STYLE : undefined}>{message ?? ""}</div>
{/if}
