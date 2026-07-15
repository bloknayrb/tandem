// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { activationKeydown } from "../../src/client/utils/keyboard-activate";

function makeEvent(key: string): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
}

describe("activationKeydown", () => {
  it("fires the handler on Enter and prevents default", () => {
    const handler = vi.fn();
    const e = makeEvent("Enter");
    activationKeydown(handler)(e);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("fires the handler on Space and prevents default", () => {
    const handler = vi.fn();
    const e = makeEvent(" ");
    activationKeydown(handler)(e);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("ignores other keys and leaves default intact", () => {
    const handler = vi.fn();
    for (const key of ["Escape", "Tab", "a", "ArrowDown"]) {
      const e = makeEvent(key);
      activationKeydown(handler)(e);
      expect(e.defaultPrevented).toBe(false);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("selfOnly blocks events bubbled from a descendant (and never preventDefaults them)", () => {
    const handler = vi.fn();
    const parent = document.createElement("div");
    const child = document.createElement("button");
    parent.appendChild(child);
    document.body.appendChild(parent);
    parent.addEventListener("keydown", activationKeydown(handler, { selfOnly: true }));

    const e = makeEvent("Enter");
    child.dispatchEvent(e);
    expect(handler).not.toHaveBeenCalled();
    // Critical for the CoworkAdminDeclinedModal fix: the bubbled keydown must
    // keep its default so the inner button's native Enter activation works.
    expect(e.defaultPrevented).toBe(false);

    const self = makeEvent(" ");
    parent.dispatchEvent(self);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(self.defaultPrevented).toBe(true);
    parent.remove();
  });

  it("without selfOnly, bubbled events activate", () => {
    const handler = vi.fn();
    const parent = document.createElement("div");
    const child = document.createElement("span");
    parent.appendChild(child);
    document.body.appendChild(parent);
    parent.addEventListener("keydown", activationKeydown(handler));

    child.dispatchEvent(makeEvent("Enter"));
    expect(handler).toHaveBeenCalledTimes(1);
    parent.remove();
  });
});
