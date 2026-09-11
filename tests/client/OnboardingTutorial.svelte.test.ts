// @vitest-environment happy-dom

/**
 * #1824 item C — the tutorial's "Make an edit" step named Ctrl+N
 * unconditionally, but Ctrl+N belongs to the browser in a browser tab (it
 * opens a new window before Tandem ever sees the key). Only the desktop app
 * owns its own window, so the shortcut only works there — matches
 * user-guide.md's existing caveat for the same three browser-reserved
 * shortcuts.
 */

import { render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

const isTauriRuntimeMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("../../src/client/cowork/cowork-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/cowork/cowork-helpers")>();
  return { ...actual, isTauriRuntime: isTauriRuntimeMock };
});

import OnboardingTutorial from "../../src/client/components/OnboardingTutorial.svelte";

function mount(currentStep: number) {
  return render(OnboardingTutorial, {
    props: {
      currentStep,
      onNext: vi.fn(),
      onDismiss: vi.fn(),
      coworkStatus: null,
    },
  });
}

afterEach(() => {
  isTauriRuntimeMock.mockReset();
  isTauriRuntimeMock.mockReturnValue(false);
});

describe("OnboardingTutorial edit-step copy (#1824 item C)", () => {
  it("names the + button in the tab bar, not Ctrl+N, in the browser build", () => {
    isTauriRuntimeMock.mockReturnValue(false);
    const { container } = mount(2); // step index 2 == "edit"
    expect(container.textContent).toContain("the + button in the tab bar");
    expect(container.textContent).not.toContain("Ctrl+N");
  });

  it("keeps Ctrl+N in the desktop (Tauri) build", () => {
    isTauriRuntimeMock.mockReturnValue(true);
    const { container } = mount(2);
    expect(container.textContent).toContain("Ctrl+N");
    expect(container.textContent).not.toContain("the + button in the tab bar");
  });
});
