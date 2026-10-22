// @vitest-environment happy-dom

/**
 * `escapeIsClaimed` is the predicate that lets a nested popover keep its own
 * Escape while `Toolbar.svelte`'s capture-phase `window` listener is armed.
 * Its whole contract is "did this event originate inside a marked subtree",
 * so the edge cases worth pinning are the non-Element targets (the listener
 * really does see `window` and `document` as targets) and the sibling subtree.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  ESCAPE_OWNER_ATTR,
  escapeIsClaimed,
  modalDialogOpen,
} from "../../src/client/utils/escape-owner";

function build(): { owner: HTMLElement; child: HTMLElement; sibling: HTMLElement } {
  document.body.innerHTML = `
    <div id="owner" ${ESCAPE_OWNER_ATTR}><button id="child">x</button></div>
    <div id="sibling"><button id="other">y</button></div>
  `;
  return {
    owner: document.getElementById("owner") as HTMLElement,
    child: document.getElementById("child") as HTMLElement,
    sibling: document.getElementById("other") as HTMLElement,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("escapeIsClaimed", () => {
  it("claims the marked element itself", () => {
    expect(escapeIsClaimed(build().owner)).toBe(true);
  });

  it("claims a descendant of the marked element", () => {
    expect(escapeIsClaimed(build().child)).toBe(true);
  });

  it("does not claim a sibling subtree", () => {
    expect(escapeIsClaimed(build().sibling)).toBe(false);
  });

  it("does not claim once the marker is removed (the closed state)", () => {
    const { owner, child } = build();
    owner.removeAttribute(ESCAPE_OWNER_ATTR);
    expect(escapeIsClaimed(child)).toBe(false);
  });

  it("does not claim non-Element targets", () => {
    build();
    expect(escapeIsClaimed(null)).toBe(false);
    expect(escapeIsClaimed(window)).toBe(false);
    expect(escapeIsClaimed(document)).toBe(false);
  });
});

describe("modalDialogOpen", () => {
  it("is false with no aria-modal dialog, and ignores aria-modal=false", () => {
    document.body.innerHTML = `<div aria-modal="false"></div>`;
    expect(modalDialogOpen()).toBe(false);
  });

  it("is true while an aria-modal dialog is in the document", () => {
    document.body.innerHTML = `<div role="dialog" aria-modal="true"></div>`;
    expect(modalDialogOpen()).toBe(true);
  });

  it("excludes the caller's own dialog, so only a layer over it counts", () => {
    document.body.innerHTML = `
      <div id="self" role="dialog" aria-modal="true">
        <div id="nested" role="dialog" aria-modal="true"></div>
      </div>
    `;
    const self = document.getElementById("self");
    const nested = document.getElementById("nested") as HTMLElement;
    expect(modalDialogOpen(self)).toBe(true);
    nested.remove();
    expect(modalDialogOpen(self)).toBe(false);
  });
});
