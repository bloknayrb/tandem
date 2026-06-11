// Webview-level key-interception coverage for the prevent-default plugin (#560).
//
// `prevent_default_flags()` returns `Flags::RELOAD`, so the plugin must swallow
// the browser reload shortcuts (Ctrl+R, F5, ...) inside the Tauri WebView while
// leaving ordinary keys untouched. The Rust unit test
// (`src-tauri/tests/prevent_default.rs`) only checks the flag *value*; it cannot
// prove the plugin actually intercepts a keystroke in a live WebView.
//
// HOW THIS DISCRIMINATES (and why the obvious approach does NOT):
// The intuitive test — fire Ctrl+R and assert the page did not reload — is a
// TAUTOLOGY here. A WebDriver-injected Ctrl+R (`browser.keys`) reaches page DOM
// listeners but does NOT drive WebView2's browser-chrome reload accelerator, so
// the page never reloads whether or not the plugin intercepts. Proven on real
// CI: with interception forced OFF (`.with_flags(Flags::empty())`, confirmed
// compiled), a "did the page reload?" sentinel test still passed. So we cannot
// observe the *effect* (a reload) — we observe the *cause* directly instead.
//
// The plugin injects a bubble-phase `window` keydown listener at page load
// (tauri-plugin-prevent-default `assets/script.js`) that calls `preventDefault()`
// for each registered shortcut. We install our OWN bubble-phase `window` listener
// at test time — registered AFTER the plugin's, so within the same event dispatch
// it runs later and observes `e.defaultPrevented`. Then:
//   • Flags::RELOAD  → plugin prevents Ctrl+R → our probe sees prevented === true
//   • Flags::empty   → plugin's shortcut map is empty → prevented === false  (RED)
// `fired` (our listener ran at all) proves the synthetic key reached page DOM
// listeners — the prerequisite that makes the whole approach valid; if it were
// ever false the spec fails loudly instead of vacuously passing.
//
// Tandem declares the plugin with no `platform-windows` feature, so there is no
// native interception path — the injected JS listener is the only mechanism, and
// it is identical across WebView2 and WebKitGTK. There is no app-level Ctrl+R/F5
// handler in the client, so the plugin's listener is the only thing that calls
// preventDefault on these combos — which is exactly what makes `prevented`
// discriminate a dropped/empty flag set.

interface KeyProbe {
  /** Our listener ran → the synthetic key reached page DOM listeners. */
  fired: boolean;
  /** A listener earlier in the dispatch (the plugin) called preventDefault. */
  prevented: boolean;
}

/**
 * Fire a key combo and report whether its terminal keydown reached the page and
 * whether the plugin's listener prevented its default.
 *
 * `matchKey` is the combo's terminal key (e.g. "r", "F5", "a") — the modifier
 * keydowns in the combo (Control) are ignored so they don't register a spurious
 * result. `requireCtrl` additionally demands `ctrlKey` so a bare "r" can't match
 * the Ctrl+R probe. Match criteria are passed as plain data (not a serialized
 * function) to keep the injected script free of dynamic code evaluation.
 */
async function probeKey(
  keys: string[],
  matchKey: string,
  requireCtrl: boolean,
): Promise<KeyProbe> {
  // Self-gate: these specs only discriminate on the live Tandem app. The
  // WebDriver session starts on about:blank (the `before` diagnostic captures
  // that); a key fired at a static blank page has no plugin listener, so a vacuous
  // "not prevented" could masquerade as a result. The "renders the editor shell"
  // spec already waits for the app to mount, but that is an ordering dependency
  // between sibling specs — assert the precondition here so each spec is
  // self-sufficient and can't silently no-op if reordered or that anchor weakens.
  const onRealApp = await browser.execute(
    () =>
      location.href !== "about:blank" &&
      !!document.querySelector('[data-testid="title-bar"]'),
  );
  expect(onRealApp).toBe(true);

  // Install a fresh probe listener. Bubble phase on `window`, registered now
  // (after the plugin's page-load listener), so it observes a defaultPrevented
  // set earlier in the same dispatch. Remove any prior probe first so exactly one
  // is live (can't use `{ once: true }`: it would auto-remove on the combo's
  // leading Control keydown, before the terminal key arrives).
  await browser.execute(
    (mk: string, needCtrl: boolean) => {
      const w = window as unknown as Record<string, unknown>;
      const prior = w.__tandemKeyProbeHandler as EventListener | undefined;
      if (prior) window.removeEventListener("keydown", prior);
      w.__tandemKeyProbe = { fired: false, prevented: false };
      const handler = (e: KeyboardEvent) => {
        if (e.key.toLowerCase() === mk.toLowerCase() && (!needCtrl || e.ctrlKey)) {
          w.__tandemKeyProbe = { fired: true, prevented: e.defaultPrevented };
        }
      };
      w.__tandemKeyProbeHandler = handler;
      window.addEventListener("keydown", handler);
    },
    matchKey,
    requireCtrl,
  );

  await browser.execute(() => document.body?.focus());
  await browser.keys(keys);
  await browser.pause(300);

  return browser.execute(
    () => (window as unknown as Record<string, KeyProbe>).__tandemKeyProbe,
  );
}

describe("prevent-default reload interception", () => {
  before(async () => {
    // The desktop shell loads the editor frontend. Wait for readyState complete
    // so keystrokes land on a real WebView.
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
    // read (no await, no network), so it stays.
  });

  it("renders the editor shell in the WebView", async () => {
    // Sanity anchor: a real Tandem WebView, not an error page. The title bar is
    // always mounted regardless of which document is open.
    const titleBar = await $('[data-testid="title-bar"]');
    await titleBar.waitForExist({ timeout: 20_000 });
  });

  it("intercepts Ctrl+R (the plugin calls preventDefault)", async () => {
    const probe = await probeKey(["Control", "r"], "r", true);
    // fired proves the synthetic key reached page listeners (the approach is
    // valid); prevented proves the plugin's RELOAD listener actually intercepted.
    // With `with_flags(Flags::empty())` this flips to prevented:false → RED.
    expect(probe.fired).toBe(true);
    expect(probe.prevented).toBe(true);
  });

  it("intercepts F5 (the plugin calls preventDefault)", async () => {
    const probe = await probeKey(["F5"], "F5", false);
    expect(probe.fired).toBe(true);
    expect(probe.prevented).toBe(true);
  });

  it("does NOT intercept an ordinary key (not blanket key-swallowing)", async () => {
    // Control with a deliberately SCOPED claim: "a" is in no `Flags` variant's
    // accelerator set, so this guards only against a degenerate handler that
    // preventDefaults *every* key — `prevented:true` here would mean blanket
    // swallowing. It does NOT detect flag-set WIDENING (e.g. RELOAD →
    // RELOAD|CONTEXT_MENU): those add accelerators that still aren't "a". That
    // direction is covered by the Rust test (`src-tauri/tests/prevent_default.rs`
    // asserts the flag bag is exactly `Flags::RELOAD`), so this spec doesn't
    // duplicate it. `fired:true` also re-proves key delivery on a benign key.
    const probe = await probeKey(["a"], "a", false);
    expect(probe.fired).toBe(true);
    expect(probe.prevented).toBe(false);
  });
});
