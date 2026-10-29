import { vi } from "vitest";

/**
 * ChatPanel's auto-scroll, observed: `scrollTo` on the messages list
 * (`[data-testid='chat-messages']`).
 *
 * `scrolls` hears only calls whose target is that list, so "it scrolled" means
 * the list scrolled. `intoView` records `scrollIntoView` instead, which the panel
 * must never call for this: it scrolls every scrollable ancestor too, App's
 * `overflow: hidden` `.rail-full-right` included (#2329).
 *
 * Patches `Element.prototype` for the whole file; `restore()` puts both back.
 */
export function spyChatAutoScroll() {
  const scrolls = vi.fn<(options: ScrollToOptions) => void>();
  const intoView = vi.fn();
  const scrollTo = vi.spyOn(Element.prototype, "scrollTo").mockImplementation(function (
    this: Element,
    ...args: unknown[]
  ) {
    if (this.matches("[data-testid='chat-messages']")) scrolls(args[0] as ScrollToOptions);
  });
  const orig = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = intoView;
  return {
    scrolls,
    intoView,
    restore() {
      scrollTo.mockRestore();
      Element.prototype.scrollIntoView = orig;
    },
  };
}
