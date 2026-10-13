// @vitest-environment happy-dom

/**
 * AI controls disabled IN PLACE while the licence refuses the AI (#1521).
 *
 * Critical Rule 7 keeps the testids, so the buttons must still render — but
 * disabled, and with a handler that refuses on its own. `disabled` alone is not
 * a guard: a stale render or an edited DOM can strip it, so each case below
 * also strips it and clicks, which is the half that goes red if the handler's
 * own check is removed. Every refusal has an enabled twin.
 *
 * Auto-cleanup never registers in this repo's client project, so each render
 * is unmounted explicitly and every query is scoped to its container.
 */

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, it, vi } from "vitest";
import AnnotationCardActions from "../../src/client/panels/AnnotationCardActions.svelte";
import BatchPromoteBar from "../../src/client/panels/BatchPromoteBar.svelte";

const byTestId = <T extends HTMLElement = HTMLButtonElement>(c: HTMLElement, id: string) =>
  c.querySelector<T>(`[data-testid='${id}']`);

describe("AnnotationCardActions — Send to Claude while the AI is off", () => {
  function mount(aiDisabled: boolean) {
    const onSendToClaude = vi.fn();
    const r = render(AnnotationCardActions, {
      props: {
        annotationId: "n1",
        annotationType: "note",
        isPending: true,
        isEditing: false,
        onSendToClaude,
        aiDisabled,
      },
    });
    return { ...r, onSendToClaude };
  }

  it("is present and disabled, and a click with `disabled` stripped does nothing", async () => {
    const { container, unmount, onSendToClaude } = mount(true);
    const btn = byTestId(container, "send-to-claude-btn-n1");
    expect(btn).not.toBeNull();
    expect(btn?.disabled).toBe(true);
    if (btn) btn.disabled = false;
    btn?.click();
    await tick();
    expect(onSendToClaude).not.toHaveBeenCalled();
    unmount();
  });

  it("the twin: enabled, one click sends once", async () => {
    const { container, unmount, onSendToClaude } = mount(false);
    const btn = byTestId(container, "send-to-claude-btn-n1");
    expect(btn?.disabled).toBe(false);
    btn?.click();
    await tick();
    expect(onSendToClaude).toHaveBeenCalledTimes(1);
    expect(onSendToClaude).toHaveBeenCalledWith("n1");
    unmount();
  });
});

describe("BatchPromoteBar while the AI is off", () => {
  function mount(aiDisabled: boolean, promoteConfirm: boolean) {
    const onPromote = vi.fn();
    const onConfirmPromote = vi.fn();
    const r = render(BatchPromoteBar, {
      props: {
        selectedCount: 2,
        promoteConfirm,
        onPromote,
        onConfirmPromote,
        onCancelPromote: vi.fn(),
        onClear: vi.fn(),
        reduceMotion: true,
        aiDisabled,
      },
    });
    return { ...r, onPromote, onConfirmPromote };
  }

  it("batch-promote-commit is disabled and its handler refuses", async () => {
    const { container, unmount, onConfirmPromote } = mount(true, true);
    const btn = byTestId(container, "batch-promote-commit");
    expect(btn?.disabled).toBe(true);
    if (btn) btn.disabled = false;
    btn?.click();
    await tick();
    expect(onConfirmPromote).not.toHaveBeenCalled();
    unmount();
  });

  it("batch-promote-confirm is disabled and its handler refuses", async () => {
    const { container, unmount, onPromote } = mount(true, false);
    const btn = byTestId(container, "batch-promote-confirm");
    expect(btn?.disabled).toBe(true);
    if (btn) btn.disabled = false;
    btn?.click();
    await tick();
    expect(onPromote).not.toHaveBeenCalled();
    unmount();
  });

  it("the twins: enabled, each click reaches its handler", async () => {
    const commit = mount(false, true);
    const c = byTestId(commit.container, "batch-promote-commit");
    expect(c?.disabled).toBe(false);
    c?.click();
    await tick();
    expect(commit.onConfirmPromote).toHaveBeenCalledTimes(1);
    commit.unmount();

    const request = mount(false, false);
    byTestId(request.container, "batch-promote-confirm")?.click();
    await tick();
    expect(request.onPromote).toHaveBeenCalledTimes(1);
    request.unmount();
  });
});
