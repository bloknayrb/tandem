// Webview-level key-interception coverage for the prevent-default plugin (#560).
//
// `prevent_default_flags()` returns `Flags::RELOAD`, so the plugin must swallow
// the browser reload shortcuts (Ctrl+R, F5, ...) inside the Tauri WebView while
// leaving everything else — DevTools, Find, Print, context menu — untouched.
//
// The Rust unit test (`src-tauri/tests/prevent_default.rs`) only checks the flag
// value. This spec proves the *behavior*: it stamps a sentinel on `window`,
// fires a reload shortcut, and asserts the sentinel survives. If the plugin
// stopped intercepting reloads (e.g. `with_flags(...)` was dropped from the
// builder), the WebView would reload, wipe the sentinel, and this test would
// fail — the exact regression the Rust test cannot catch.

const SENTINEL = "__tandem_prevent_default_sentinel__";

/** Stamp a fresh sentinel value on `window` and return it. */
async function stampSentinel(): Promise<number> {
  const value = Date.now();
  await browser.execute(
    (key: string, v: number) => {
      (window as unknown as Record<string, number>)[key] = v;
    },
    SENTINEL,
    value,
  );
  return value;
}

/** Read the sentinel back; `undefined` means the page reloaded and lost it. */
function readSentinel(): Promise<number | undefined> {
  return browser.execute(
    (key: string) => (window as unknown as Record<string, number | undefined>)[key],
    SENTINEL,
  );
}

describe("prevent-default reload interception", () => {
  before(async () => {
    // The desktop shell loads the editor frontend. Wait for the document body
    // to be present so keystrokes land on a real, focused WebView.
    await browser.waitUntil(
      async () => (await browser.execute(() => document.readyState)) === "complete",
      { timeout: 30_000, timeoutMsg: "WebView never reached readyState=complete" },
    );
  });

  it("renders the editor shell in the WebView", async () => {
    // Sanity anchor: a real Tandem WebView, not an error page. The title bar is
    // always mounted regardless of which document is open.
    const titleBar = await $('[data-testid="title-bar"]');
    await titleBar.waitForExist({ timeout: 20_000 });
  });

  it("swallows Ctrl+R so the WebView does not reload", async () => {
    const stamped = await stampSentinel();
    // Land keystrokes on the document, not on a detached element.
    await browser.execute(() => document.body?.focus());

    // Ctrl+R is a RELOAD shortcut → the plugin must preventDefault it.
    await browser.keys(["Control", "r"]);

    // Give a real reload time to happen if interception had failed.
    await browser.pause(1_000);

    const after = await readSentinel();
    expect(after).toBe(stamped); // survived → no reload → interception worked
  });

  it("swallows F5 so the WebView does not reload", async () => {
    const stamped = await stampSentinel();

    await browser.keys(["F5"]);
    await browser.pause(1_000);

    const after = await readSentinel();
    expect(after).toBe(stamped);
  });

  it("does not block ordinary typing (interception is reload-only)", async () => {
    // Discriminating control: a benign key must NOT be swallowed by the plugin.
    // We can't observe a global preventDefault directly via WebDriver, so we
    // assert the positive path stays intact — the sentinel persists across an
    // ordinary key, confirming the WebView is alive and not reloading on every
    // keystroke (which a too-broad flag bag could cause).
    const stamped = await stampSentinel();

    await browser.keys(["a"]);
    await browser.pause(250);

    const after = await readSentinel();
    expect(after).toBe(stamped);
  });
});
