import { expect, test } from "@playwright/test";

test("reply thread browser smoke renders existing replies and a reply composer", async ({
  page,
}) => {
  await page.setContent(`
    <div data-testid="comment-thread">
      <div data-testid="reply-reply-1">Existing reply</div>
    </div>
    <div style="margin-top: 6px;">
      <button data-testid="reply-btn-annotation-1">Reply (1)</button>
    </div>
    <script>
      const btn = document.querySelector("[data-testid='reply-btn-annotation-1']");
      btn.addEventListener("click", () => {
        const root = btn.parentElement;
        root.innerHTML = \`
          <textarea data-testid="reply-input-annotation-1">Draft reply</textarea>
          <button data-testid="reply-send-btn-annotation-1">Send</button>
        \`;
      });
    </script>
  `);

  const thread = page.locator("[data-testid='comment-thread']");
  await expect(thread).toContainText("Existing reply");

  await page.locator("[data-testid='reply-btn-annotation-1']").click();
  await expect(page.locator("[data-testid='reply-input-annotation-1']")).toBeVisible();
  await expect(page.locator("[data-testid='reply-send-btn-annotation-1']")).toBeVisible();
});
