// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import ReplyThread from "../../src/client/panels/ReplyThread.svelte";

describe("ReplyThread", () => {
  it("renders existing replies when reply input is not available", () => {
    const replies = [
      {
        id: "reply-1",
        annotationId: "annotation-1",
        author: "claude",
        text: "Existing reply",
        timestamp: Date.now(),
      },
    ];

    const { container } = render(ReplyThread, {
      props: {
        annotationId: "annotation-1",
        replies,
        isPending: false,
        isEditing: false,
      },
    });

    expect(container.querySelector("[data-testid='comment-thread']")).toBeTruthy();
    expect(container.textContent).toContain("Existing reply");
    expect(container.textContent).toContain("reply");
  });
});
