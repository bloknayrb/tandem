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
  // Self-gate: these specs only discriminate on the live Tandem app. The
  // WebDriver session starts on about:blank (the `before` diagnostic captures
  // that), and a reload shortcut fired at a static blank page trivially leaves
  // any sentinel intact — a vacuous pass that would survive even a dropped
  // `with_flags(...)`. The "renders the editor shell" spec already waits for the
  // app to mount, but that is an ordering dependency between sibling specs;
  // assert the precondition here so each sentinel spec is self-sufficient and
  // can't silently no-op if the specs are reordered or that anchor is weakened.
  const onRealApp = await browser.execute(
    () =>
      location.href !== "about:blank" &&
      !!document.querySelector('[data-testid="title-bar"]'),
  );
  expect(onRealApp).toBe(true);

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

    // Diagnostic snapshot for failure triage: dump the WebView's DOM state at
    // the top of the hook. NOTE: this fires PRE-navigation — readyState reaches
    // "complete" on the initial about:blank before the Tandem frontend loads, so
    // the snapshot typically shows url:about:blank / testidCount:0. It is NOT
    // proof the app mounted (the "renders the editor shell" spec's title-bar
    // waitForExist is); it just makes a failed run explain what the session saw.
    // Synchronous DOM read — no network — so it returns even mid-reconnect.
    try {
      const snapshot = await browser.execute(() => {
        const ids = Array.from(document.querySelectorAll("[data-testid]"))
          .map((el) => el.getAttribute("data-testid"))
          .slice(0, 40);
        return {
          title: document.title,
          url: location.href,
          hasTauriInternals:
            typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ !==
            "undefined",
          testidCount: document.querySelectorAll("[data-testid]").length,
          testids: ids,
          bodyTextHead: (document.body?.innerText ?? "").slice(0, 400),
        };
      });
      console.log("[harness-diag] WebView snapshot:", JSON.stringify(snapshot));
    } catch (e) {
      console.log("[harness-diag] snapshot failed:", String(e));
    }
    // NOTE: an earlier async `fetch('/api/info')` probe here destabilized the
    // session — the async executeScript round-trip collapsed the WebDriver
    // connection and timed out the hook. The sync snapshot above is a pure DOM
    // read (no await, no network), so it stays. The reload-interception specs
    // need only the live WebView, not the backend: the prevent-default plugin
    // enforces RELOAD via a platform-agnostic injected JS keydown listener
    // (tauri-plugin-prevent-default `assets/script.js`) that calls
    // `preventDefault()` — Tandem declares the plugin with no `platform-windows`
    // feature, so there is no native interception path and the behavior is
    // identical across WebView2 and WebKitGTK. There is no app-level Ctrl+R/F5
    // handler in the client, so the plugin's listener is the only thing standing
    // between a native reload shortcut and an actual document reload — which is
    // exactly what makes the sentinel assertions below discriminate a dropped
    // `with_flags(...)`.
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

  it("stays alive after an ordinary key (liveness smoke check, not a discrimination proof)", async () => {
    // HONEST SCOPE: this only asserts the WebView is still alive and did not
    // reload after a benign key — it does NOT prove interception is "reload-only
    // and not too-broad". A too-broad flag bag that swallowed *every* key would
    // also leave the sentinel intact, so this passes in both the correct and the
    // over-broad state. We can't observe a global preventDefault directly via
    // WebDriver. TODO(#560): to make this a real discriminating control, give the
    // benign key an observable side effect (e.g. focus the `find-input` testid,
    // type into it, and assert its value changed — proving the key reached the
    // page and was NOT swallowed).
    const stamped = await stampSentinel();

    await browser.keys(["a"]);
    await browser.pause(250);

    const after = await readSentinel();
    expect(after).toBe(stamped);
  });
});
