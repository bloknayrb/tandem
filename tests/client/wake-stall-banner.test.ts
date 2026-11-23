/**
 * `WakeStallBanner`'s wording (#2358 PR 3b-2e2).
 *
 * The owner's 2026-11-17 answer 3, "Hide while starting, then reword
 * (Recommended)": with multi-session ownership on, when the banner shows it
 * says the message is waiting without promising when Claude will look. His
 * 2026-11-23 pick, "As decided, no dismiss (Recommended)": no dismiss button.
 * The hide is `deliveryStall`'s and the hook's (`useAiReadiness.svelte.test.ts`,
 * "keyed rounds"); this file pins the component alone.
 *
 * Flag off the component must be byte-identical to the one before this PR, so
 * the flag-off DOM is compared with the exact markup that component rendered
 * (captured from it before the change, line break and indent included).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import WakeStallBanner from "../../src/client/components/WakeStallBanner.svelte";

afterEach(() => {
  cleanup();
});

/** The pre-3b-2e2 component's rendered markup at a three-minute stall. */
const BEFORE_3B_2E2 =
  '<!----><div data-testid="wake-stall-live" role="status" aria-live="polite"><!----><div class="tandem-banner tandem-banner--info" data-testid="wake-stall-banner"><span class="tandem-banner__message">Claude hasn\'t picked this up for 3 minutes. Your message is queued — it\'ll be seen the next\n        time Claude checks in.</span></div><!----></div>';

describe("WakeStallBanner wording", () => {
  it("flag off (no `keyed`): the markup is exactly the pre-3b-2e2 component's", () => {
    const { container } = render(WakeStallBanner, { props: { stalledMs: 180_000 } });
    expect(container.innerHTML).toBe(BEFORE_3B_2E2);
  });

  it("flag off (`keyed: false` passed): the same markup", () => {
    const { container } = render(WakeStallBanner, {
      props: { stalledMs: 180_000, keyed: false },
    });
    expect(container.innerHTML).toBe(BEFORE_3B_2E2);
  });

  it("keyed: says the message is waiting, with no promise of when Claude will look", () => {
    const { container } = render(WakeStallBanner, {
      props: { stalledMs: 180_000, keyed: true },
    });
    const banner = container.querySelector("[data-testid='wake-stall-banner']");
    expect(banner?.textContent).toBe(
      "Claude hasn't picked this up for 3 minutes. Your message is still waiting.",
    );
    expect(banner?.textContent).not.toMatch(/checks in|next time|queued|soon/);
  });

  it("keyed: the same banner and live region, info tone, and no dismiss button", () => {
    const { container } = render(WakeStallBanner, {
      props: { stalledMs: 180_000, keyed: true },
    });
    expect(container.innerHTML).toBe(
      BEFORE_3B_2E2.replace(
        "Your message is queued — it'll be seen the next\n        time Claude checks in.",
        "Your message is still waiting.",
      ),
    );
    expect(container.querySelector("button")).toBeNull();
  });

  it("keyed: nothing renders without a stall", () => {
    const { container } = render(WakeStallBanner, { props: { stalledMs: null, keyed: true } });
    expect(container.querySelector("[data-testid='wake-stall-banner']")).toBeNull();
  });

  it("App.svelte passes the hook's keyed fact (nothing mounts App in tests, so read from source)", () => {
    const app = readFileSync(join(process.cwd(), "src/client/App.svelte"), "utf8");
    const mount = app.match(/<WakeStallBanner\b[^>]*\/>/s)?.[0] ?? "";
    expect(mount).toMatch(/stalledMs=\{aiReadiness\.deliveryStalledMs\}/);
    expect(mount).toMatch(/keyed=\{aiReadiness\.deliveryKeyed\}/);
  });

  it("follows the flag across a re-render in the same region", async () => {
    const { container, rerender } = render(WakeStallBanner, {
      props: { stalledMs: 180_000, keyed: true },
    });
    const region = container.querySelector("[data-testid='wake-stall-live']");
    await rerender({ stalledMs: 180_000, keyed: false });
    expect(container.querySelector("[data-testid='wake-stall-live']")).toBe(region);
    expect(container.innerHTML).toBe(BEFORE_3B_2E2);
  });
});
