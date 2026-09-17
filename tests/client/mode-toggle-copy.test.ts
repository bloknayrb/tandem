// @vitest-environment happy-dom

import { cleanup, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ModeToggle from "../../src/client/editor/toolbar/ModeToggle.svelte";

/**
 * #1779 — the Solo toggle promised more privacy than Solo delivers.
 *
 * "your AI pauses and won't see your comments or edits until you switch back to
 * Tandem" was wrong twice over. **Chat is delivered in both directions
 * regardless of mode** (`queue.ts#shouldForwardExternally` returns true for
 * `chat:message` before it reads the mode at all, and `awareness.ts`'s
 * `chatMessages` bucket has no mode gate), and the DOCUMENT is ungated on every
 * pull surface — `tandem_getTextContent`, `tandem_getContext` and
 * `tandem_search` all read it in Solo. What Solo actually holds is the user's
 * own annotations and replies.
 *
 * A promise a user acts on is a privacy control whether or not it is enforced by
 * code, so this is pinned as copy: the status bar has said the right thing since
 * #1287, and the toggle now matches it.
 *
 * Rendered DIRECTLY rather than through `TandemModeHarness`, which never mounts
 * this component, and the E2E suite reads only `aria-pressed`. Nothing else in
 * the tree sees this string.
 */
describe("the Solo toggle's title says what Solo holds (#1779)", () => {
  // `@testing-library/svelte` only auto-cleans when its setup module is
  // imported; this suite renders directly, so an uncleaned mount makes the
  // SECOND `getByTestId` in a test throw "found multiple elements".
  afterEach(cleanup);

  function soloTitle(): string {
    const { getByTestId } = render(ModeToggle, {
      props: { tandemMode: "solo", onModeChange: vi.fn() },
    });
    return getByTestId("mode-solo-btn").getAttribute("title") ?? "";
  }

  it("no longer claims the AI won't see the user's edits", () => {
    // The overclaim itself. Matched loosely (`won.t`) so the typographic
    // apostrophe the file actually uses cannot smuggle it back.
    const title = soloTitle();
    expect(title).not.toMatch(/won.t see/i);
    expect(title).not.toMatch(/pauses/i);
  });

  it("names what IS held — the user's comments and replies", () => {
    expect(soloTitle()).toMatch(/comments and replies/i);
  });

  it("says chat still works, because it does", () => {
    // The half a reader is most likely to get wrong: a user who believes chat is
    // held in Solo stops using the one channel that is always open.
    expect(soloTitle()).toMatch(/chat/i);
  });

  it("leaves the Tandem button's title alone — it was already accurate", () => {
    const { getByTestId } = render(ModeToggle, {
      props: { tandemMode: "tandem", onModeChange: vi.fn() },
    });
    expect(getByTestId("mode-tandem-btn").getAttribute("title")).toMatch(/sees your selections/i);
  });
});
