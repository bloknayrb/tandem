// @vitest-environment happy-dom

/**
 * The Models tab's "Let local models comment and suggest changes" control,
 * mounted with the REAL `useLocalModelSettings` store (#1123). The sibling
 * `settings-models-tab-editing.test.ts` poses a mocked store; this file is the
 * join between the two — the tab's markup driven by the store's real `$state`
 * and real request ordering, with only the network stubbed.
 *
 * Seams: `BYO_MODELS_ENABLED` is flipped on by mocking the constant (the same
 * seam as `use-models-loading.test.ts`), `useModels.svelte` is mocked as in the
 * other tab tests, and global `fetch` is a stub whose answers are held open
 * with deferreds and released by hand — no sleeps.
 */

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TandemSettings } from "../../src/client/hooks/useTandemSettings.svelte";

vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants.js")>()),
  // The production const is a literal `false` (ships dark).
  BYO_MODELS_ENABLED: true as false,
}));

vi.mock(import("../../src/client/hooks/useModels.svelte"), () => ({
  createModels: () => ({
    models: [],
    defaultModelId: null,
    saveError: null,
    loading: false,
    loadFailed: false,
    reload: vi.fn(async () => {}),
    clearError: vi.fn(),
    addModel: vi.fn(async () => "id"),
    updateModel: vi.fn(async () => true),
    deleteModel: vi.fn(async () => {}),
    toggleEnabled: vi.fn(async () => {}),
    setDefault: vi.fn(async () => true),
  }),
}));

const { _resetLocalModelSettingsForTests, createLocalModelSettings } = await import(
  "../../src/client/hooks/useLocalModelSettings.svelte.js"
);
const { default: SettingsModelsTab } = await import(
  "../../src/client/components/settings-tabs/SettingsModelsTab.svelte"
);

interface Call {
  method: string;
  body?: unknown;
  /** Answer this request. Resolves once the store has finished with the answer. */
  answer: (status: number, body: unknown) => Promise<void>;
  /** Fail this request at the network level. */
  fail: () => void;
  /** Has the store aborted this request? (As real `fetch` does, the stub then
   *  rejects it with an AbortError.) */
  aborted: () => boolean;
}
let calls: Call[] = [];

/** Enough microtask turns for a promise continuation chain in the store to run out. */
async function drain(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
  await tick();
}

beforeEach(() => {
  _resetLocalModelSettingsForTests();
  calls = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal ?? undefined;
        // Honour the request's signal, as real `fetch` does: a read the store
        // aborts is rejected, not left hanging.
        signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
        calls.push({
          aborted: () => signal?.aborted === true,
          method: init?.method ?? "GET",
          ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
          answer: async (status, body) => {
            const res = new Response(JSON.stringify(body), {
              status,
              headers: { "Content-Type": "application/json" },
            });
            // Know when the store has read the body, so the wait below is on
            // that event and not on a timer.
            const readJson = res.json.bind(res);
            let read!: () => void;
            const bodyRead = new Promise<void>((r) => {
              read = r;
            });
            res.json = () => readJson().finally(read);
            resolve(res);
            await bodyRead;
            await drain();
          },
          fail: () => reject(new TypeError("fetch failed")),
        });
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount() {
  const view = render(SettingsModelsTab, {
    props: {
      open: true,
      settings: {
        selectionDwellMs: 1000,
        selectionToolbar: true,
        marginView: false,
      } as TandemSettings,
      onUpdate: vi.fn(),
      connected: true,
      reconnectAttempts: 0,
      readOnly: false,
      notify: vi.fn(),
    },
  });
  const box = () => view.getByTestId("local-model-editing-toggle") as HTMLInputElement;
  return { ...view, box };
}

/** The request the store has sent as number `n` (1-based), once it is out. */
async function request(n: number): Promise<Call> {
  await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(n));
  return calls[n - 1] as Call;
}

function wire() {
  return calls.map(({ method, body }) => (body === undefined ? { method } : { method, body }));
}

function expectSettled(box: HTMLInputElement, checked: boolean) {
  expect(box.indeterminate).toBe(false);
  expect(box.checked).toBe(checked);
  expect(box.getAttribute("aria-disabled") ?? "false").toBe("false");
  expect(box.disabled).toBe(false);
}

function expectUnsettled(box: HTMLInputElement) {
  expect(box.indeterminate).toBe(true);
  expect(box.checked).toBe(false);
  expect(box.getAttribute("aria-disabled")).toBe("true");
  expect(box.disabled).toBe(false);
}

/** Mount, and answer the mount read. */
async function mountWith(editing: boolean) {
  const view = mount();
  await (await request(1)).answer(200, { editing });
  return view;
}

describe("SettingsModelsTab with the real local-model settings store", () => {
  it("fires exactly one GET on mount; until it answers the box is indeterminate and 'Checking…' shows", async () => {
    const { box, getByTestId, queryByTestId } = mount();
    // Synchronously on mount, before the request has even left.
    expectUnsettled(box());
    expect(getByTestId("local-model-editing-loading").getAttribute("role")).toBe("status");

    const get = await request(1);
    await drain();
    expect(wire()).toEqual([{ method: "GET" }]);
    expectUnsettled(box());
    expect(queryByTestId("local-model-editing-loading")).not.toBeNull();
    expect(queryByTestId("local-model-editing-load-error")).toBeNull();

    await get.answer(200, { editing: true });
    expectSettled(box(), true);
    expect(queryByTestId("local-model-editing-loading")).toBeNull();
    expect(queryByTestId("local-model-editing-force-off-pending")).toBeNull();
    expect(wire()).toEqual([{ method: "GET" }]); // still exactly one
  });

  it("a click on the box while the mount read is held sends nothing", async () => {
    const { box } = mount();
    const get = await request(1);
    await fireEvent.click(box());
    await drain();
    expect(wire()).toEqual([{ method: "GET" }]);
    expectUnsettled(box());
    await get.answer(200, { editing: false });
    expectSettled(box(), false);
    expect(wire()).toEqual([{ method: "GET" }]);
  });

  it("clicking the settled, checked box sends one POST {editing:false} and the box ends unchecked", async () => {
    const { box, queryByTestId } = await mountWith(true);
    expectSettled(box(), true);

    await fireEvent.click(box());
    const post = await request(2);
    expect(wire()).toEqual([{ method: "GET" }, { method: "POST", body: { editing: false } }]);
    expectSettled(box(), false); // optimistic, and still a live box while the save is out

    await post.answer(200, { editing: false, persisted: true });
    expectSettled(box(), false);
    expect(queryByTestId("local-model-editing-error")).toBeNull();
    expect(wire()).toHaveLength(2); // one POST, and no re-read
  });

  it("a POST answered 500 {editing:true, persisted:false} leaves the box CHECKED and shows the save notice as an alert", async () => {
    // This is the case the tab's imperative `syncEditingBox` exists for. With
    // the real, reactive store the click's optimistic write and the server's
    // answer are the SAME value (true → true), so `checked={…}` sees no change
    // after the answer and Svelte writes nothing to the DOM. If anything had
    // left the DOM box out of step with the store, only the imperative sync
    // after `await setEditing(…)` would put it back. Posed here by unticking
    // the DOM box under the store's feet while the POST is held.
    const { box, getByTestId, queryByTestId } = await mountWith(false);
    expectSettled(box(), false);

    await fireEvent.click(box()); // Off → On
    const post = await request(2);
    expect(wire()[1]).toEqual({ method: "POST", body: { editing: true } });
    expect(box().checked).toBe(true);
    expect(queryByTestId("local-model-editing-error")).toBeNull();

    box().checked = false; // the DOM drifts; the store still says on

    await post.answer(500, { editing: true, persisted: false, code: "X" });
    expectSettled(box(), true);
    const notice = getByTestId("local-model-editing-error");
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toMatch(/on for now/);
    expect(notice.textContent).toMatch(/could not be saved/);
    expect(wire()).toHaveLength(2);
  });

  it("an Off the server did not take (500 {editing:true, persisted:false}) puts the box back to CHECKED", async () => {
    // The other half of the same contract, with no hand-made drift: the click
    // unticks the box, the server still holds on, and the box must end checked.
    const { box, getByTestId } = await mountWith(true);
    await fireEvent.click(box()); // On → Off
    const post = await request(2);
    expect(wire()[1]).toEqual({ method: "POST", body: { editing: false } });
    expect(box().checked).toBe(false);

    await post.answer(500, { editing: true, persisted: false, code: "X" });
    expectSettled(box(), true);
    const notice = getByTestId("local-model-editing-error");
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toMatch(/on for now/);
  });

  it("a failed mount GET shows the load error with Retry and Switch off; Switch off sends POST {editing:false}", async () => {
    const { box, getByTestId, queryByTestId } = mount();
    const get = await request(1);
    // The store dedupes a load that is in flight, so this is the mount's own
    // promise and sends no second GET.
    const mountLoad = createLocalModelSettings().load();
    get.fail();
    await mountLoad;
    await drain();
    expect(wire()).toEqual([{ method: "GET" }]);

    expectUnsettled(box());
    const error = getByTestId("local-model-editing-load-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.querySelector("button")).toBeNull();
    expect(queryByTestId("local-model-editing-loading")).toBeNull();
    expect(queryByTestId("local-model-editing-retry")).not.toBeNull();

    await fireEvent.click(getByTestId("local-model-editing-force-off"));
    const post = await request(2);
    expect(wire()).toEqual([{ method: "GET" }, { method: "POST", body: { editing: false } }]);

    await post.answer(200, { editing: false, persisted: true });
    expectSettled(box(), false);
    expect(queryByTestId("local-model-editing-load-error")).toBeNull();
    expect(queryByTestId("local-model-editing-retry")).toBeNull();
    expect(queryByTestId("local-model-editing-error")).toBeNull();
    expect(wire()).toHaveLength(2);
  });

  it("Retry after a failed mount GET reads again, shows 'Checking…' meanwhile, and settles on the answer", async () => {
    const { box, getByTestId, queryByTestId } = mount();
    const get = await request(1);
    const mountLoad = createLocalModelSettings().load();
    get.fail();
    await mountLoad;
    await drain();

    await fireEvent.click(getByTestId("local-model-editing-retry"));
    const retry = await request(2);
    await drain();
    expect(wire()).toEqual([{ method: "GET" }, { method: "GET" }]);
    expectUnsettled(box());
    expect(queryByTestId("local-model-editing-loading")).not.toBeNull();
    expect(queryByTestId("local-model-editing-load-error")).toBeNull();

    await retry.answer(200, { editing: true });
    expectSettled(box(), true);
    expect(queryByTestId("local-model-editing-loading")).toBeNull();
  });

  /**
   * Round 3: Retry and both Switch off buttons are removed (or replaced) by the
   * state change they cause. A focused button that unmounts drops keyboard
   * focus to `body`, so each hands focus to the checkbox — which never
   * unmounts — before acting. Each case focuses the button first, as a
   * keyboard user's Tab would, because a synthetic click moves no focus.
   */
  describe("keyboard focus survives the button that was pressed", () => {
    /** Mount and fail the mount read: the Retry / Switch off state. */
    async function mountFailed() {
      const view = mount();
      const get = await request(1);
      const mountLoad = createLocalModelSettings().load();
      get.fail();
      await mountLoad;
      await drain();
      return view;
    }

    function focusAndCheck(button: HTMLElement) {
      button.focus();
      expect(document.activeElement).toBe(button);
    }

    it("Retry after a failed read: focus is on the checkbox, not on body, once the read has settled", async () => {
      const { box, getByTestId, queryByTestId } = await mountFailed();
      const retry = getByTestId("local-model-editing-retry");
      focusAndCheck(retry);

      await fireEvent.click(retry);
      // Moved before the button goes, so there is no moment with focus on body.
      expect(document.activeElement).toBe(box());
      const second = await request(2);
      await drain();
      expect(queryByTestId("local-model-editing-retry")).toBeNull(); // replaced by "Checking…"
      expect(document.activeElement).toBe(box());

      await second.answer(200, { editing: true });
      expectSettled(box(), true);
      expect(retry.isConnected).toBe(false);
      expect(document.activeElement).toBe(box());
      expect(document.activeElement).not.toBe(document.body);
      expect(wire()).toEqual([{ method: "GET" }, { method: "GET" }]);
    });

    it("Retry whose read fails again: focus stays on the checkbox while the buttons come back", async () => {
      const { box, getByTestId } = await mountFailed();
      const retry = getByTestId("local-model-editing-retry");
      focusAndCheck(retry);
      await fireEvent.click(retry);
      const second = await request(2);
      const retryLoad = createLocalModelSettings().load();
      second.fail();
      await retryLoad;
      await drain();

      expectUnsettled(box());
      expect(getByTestId("local-model-editing-retry")).not.toBe(retry); // a new button
      expect(document.activeElement).toBe(box());
    });

    it("Switch off after a failed read: focus is on the checkbox once the save has settled", async () => {
      const { box, getByTestId, queryByTestId } = await mountFailed();
      const off = getByTestId("local-model-editing-force-off");
      focusAndCheck(off);

      await fireEvent.click(off);
      expect(document.activeElement).toBe(box());
      const post = await request(2);
      expect(wire()[1]).toEqual({ method: "POST", body: { editing: false } });

      await post.answer(200, { editing: false, persisted: true });
      expectSettled(box(), false);
      expect(queryByTestId("local-model-editing-force-off")).toBeNull();
      expect(off.isConnected).toBe(false);
      expect(document.activeElement).toBe(box());
      expect(document.activeElement).not.toBe(document.body);
    });

    it("Switch off while 'Checking…': the save goes out without the read answering, and focus is on the checkbox", async () => {
      const { box, getByTestId, queryByTestId } = mount();
      const get = await request(1);
      await drain();
      const off = getByTestId("local-model-editing-force-off-pending");
      focusAndCheck(off);

      await fireEvent.click(off);
      expect(document.activeElement).toBe(box());
      // The held read was never answered: the click aborted it, and the POST
      // is already out.
      const post = await request(2);
      expect(get.aborted()).toBe(true);
      expect(wire()).toEqual([{ method: "GET" }, { method: "POST", body: { editing: false } }]);

      await post.answer(200, { editing: false, persisted: true });
      expectSettled(box(), false);
      expect(queryByTestId("local-model-editing-loading")).toBeNull();
      expect(queryByTestId("local-model-editing-force-off-pending")).toBeNull();
      expect(queryByTestId("local-model-editing-load-error")).toBeNull();
      expect(off.isConnected).toBe(false);
      expect(document.activeElement).toBe(box());
      expect(document.activeElement).not.toBe(document.body);
      expect(wire()).toHaveLength(2);
    });
  });

  it("a remount reads again and shows the unknown state while that read is in flight, whatever the last visit showed", async () => {
    const first = await mountWith(true);
    expectSettled(first.box(), true);
    first.unmount();

    const { box, queryByTestId } = mount();
    expectUnsettled(box()); // the store still holds known + on from the last visit
    expect(queryByTestId("local-model-editing-loading")).not.toBeNull();
    const second = await request(2);
    expect(wire()).toEqual([{ method: "GET" }, { method: "GET" }]);

    await second.answer(200, { editing: false }); // changed in another window meanwhile
    expectSettled(box(), false);
  });
});
