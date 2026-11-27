// @vitest-environment happy-dom

/**
 * DiffView (ADR-057 PR 4). Both sides carry file text an outside writer or
 * Claude controls, so it must render as text, never as HTML.
 */

import { cleanup, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import DiffView from "../../src/client/components/DiffView.svelte";

afterEach(() => cleanup());

const props = (other: string, current: string, truncated = false) => ({
  props: {
    result: {
      ok: true as const,
      comparison: { current, other, otherLabel: "disk" as const, truncated },
    },
  },
});

describe("DiffView", () => {
  it("renders markup in either version as literal text", () => {
    const evil = '<img src=x onerror="window.__pwned=1"> and <b>bold</b>';
    const { container } = render(DiffView, props(`${evil}\n`, "safe\n"));
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="window.__pwned=1">');
  });

  it("marks removed and added lines, and says when there are no differences", () => {
    const { container, unmount } = render(DiffView, props("old\n", "new\n"));
    const kinds = [...container.querySelectorAll("[data-testid='diff-line']")].map((el) =>
      el.getAttribute("data-kind"),
    );
    expect(kinds).toEqual(["remove", "add"]);
    unmount();
    const same = render(DiffView, props("same\n", "same\n"));
    expect(same.container.querySelector("[data-testid='diff-none']")).toBeTruthy();
  });

  it("says when the versions were cut at the cap", () => {
    const { container } = render(DiffView, props("a\n", "b\n", true));
    expect(container.querySelector("[data-testid='diff-truncated']")).toBeTruthy();
  });

  it("never says plainly 'No differences.' of a comparison that was cut", () => {
    const { container } = render(DiffView, props("a\n", "a\n", true));
    expect(container.querySelector("[data-testid='diff-none']")?.textContent?.trim()).toBe(
      "No differences in the part compared.",
    );
  });

  it("shows loading, then a failed fetch's message as text", () => {
    const loading = render(DiffView, { props: { result: null } });
    expect(loading.container.textContent).toContain("Comparing");
    loading.unmount();
    const failed = render(DiffView, {
      props: { result: { ok: false as const, message: "That backup no longer exists." } },
    });
    expect(failed.container.querySelector("[data-testid='compare-error']")?.textContent).toBe(
      "That backup no longer exists.",
    );
  });

  it("announces the outcome it draws", () => {
    const { container } = render(DiffView, props("same\n", "same\n"));
    expect(container.querySelector("[data-testid='compare-live']")?.textContent).toBe(
      "No differences.",
    );
  });
});
