// @vitest-environment happy-dom

/**
 * Mounted keyboard regression test for CoworkAdminDeclinedModal.
 *
 * The dialog is a CHILD of the backdrop div, so before the `selfOnly` guard
 * (activationKeydown) the backdrop's keydown handler preventDefault()ed
 * Enter/Space bubbling up from the dialog's buttons and link — breaking
 * keyboard activation of every control inside AND dismissing the popup out
 * from under the user. These tests pin the fix: Enter/Space on inner
 * controls must NOT dismiss; Enter/Space on the backdrop itself still must.
 *
 * Kept separate from cowork-admin-declined-modal.test.ts, which is
 * deliberately mount-free and exercises the REAL cowork-invoke exports
 * (mocking useCoworkStatus here would be fine there too, but this file needs
 * a mounted component while that one needs unmocked invoke helpers).
 */

import { fireEvent } from "@testing-library/dom";
import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CoworkAdminDeclinedModal from "../../src/client/components/CoworkAdminDeclinedModal.svelte";
import { _resetAdminDismissForTests } from "../../src/client/cowork/coworkAdminDismiss.svelte";

// uacDeclined status so the modal renders. Everything else in the component
// (cowork-invoke, dismiss module) stays real — no button is ever clicked, so
// loadInvoke's Tauri-unavailable rejection is never hit.
vi.mock("../../src/client/hooks/useCoworkStatus.svelte", () => ({
  createCoworkStatus: () => ({
    status: {
      osSupported: true,
      coworkDetected: true,
      enabled: true,
      vethernetCidr: "172.30.16.0/28",
      lanIpFallback: null,
      useLanIpOverride: false,
      workspaces: [],
      uacDeclined: true,
      uacDeclinedAt: "2026-07-14T00:00:00Z",
      workspacesLastScannedAt: null,
    },
    loading: false,
    error: null,
    refetch: vi.fn(async () => {}),
  }),
}));

describe("CoworkAdminDeclinedModal keyboard activation", () => {
  beforeEach(() => {
    // `dismissed` is module state — a dismissing test run would poison later
    // cases (and other files sharing the worker) without this reset.
    _resetAdminDismissForTests();
  });

  // No global auto-cleanup is wired in this repo's vitest setup; without this,
  // each render() accumulates in document.body and screen queries collide.
  afterEach(() => cleanup());

  it("Enter on the retry button does NOT dismiss the modal (bubbled keydown ignored)", async () => {
    render(CoworkAdminDeclinedModal);
    const retry = screen.getByTestId("cowork-admin-declined-retry-btn");
    await fireEvent.keyDown(retry, { key: "Enter" });
    expect(screen.queryByTestId("cowork-admin-declined-modal")).not.toBeNull();
  });

  it("Space on the disable button does NOT dismiss the modal", async () => {
    render(CoworkAdminDeclinedModal);
    const disable = screen.getByTestId("cowork-admin-declined-disable-btn");
    await fireEvent.keyDown(disable, { key: " " });
    expect(screen.queryByTestId("cowork-admin-declined-modal")).not.toBeNull();
  });

  it("Enter bubbled from the Learn-more link keeps its default (link activation works)", async () => {
    render(CoworkAdminDeclinedModal);
    const link = screen.getByTestId("cowork-admin-declined-learn-more-link");
    const e = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    link.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(screen.queryByTestId("cowork-admin-declined-modal")).not.toBeNull();
  });

  it("Enter on the backdrop itself still dismisses (positive control)", async () => {
    render(CoworkAdminDeclinedModal);
    const backdrop = screen.getByTestId("cowork-admin-declined-backdrop");
    await fireEvent.keyDown(backdrop, { key: "Enter" });
    expect(screen.queryByTestId("cowork-admin-declined-modal")).toBeNull();
  });
});
