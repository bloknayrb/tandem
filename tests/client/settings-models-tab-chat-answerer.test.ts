// @vitest-environment happy-dom

/**
 * "Who answers your chat" in Settings → Models (#1123 part B, R2), mounted
 * with the REAL chat-answerer store (`hooks/useChatAnswerer.svelte.ts`) and
 * only `fetch` stubbed; the models list and the editing setting are still
 * poses. `BYO_MODELS_ENABLED` is flipped on by mocking the constant.
 */

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TandemSettings } from "../../src/client/hooks/useTandemSettings.svelte";
import { drain, installHeldFetch } from "../helpers/held-fetch";
import { asTandemOwnWindow } from "../helpers/models-write-access.svelte";

vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants.js")>()),
  BYO_MODELS_ENABLED: true as typeof import("../../src/shared/constants.js").BYO_MODELS_ENABLED,
}));

// The saved list, configurable per case (#1123 R1.6); empty by default, as
// every earlier case here poses it.
const modelsPose = vi.hoisted(() => ({
  models: [] as Array<Record<string, unknown>>,
  defaultModelId: null as string | null,
}));
vi.mock(import("../../src/client/hooks/useModels.svelte"), () => ({
  createModels: () => ({
    get models() {
      return modelsPose.models as never;
    },
    get defaultModelId() {
      return modelsPose.defaultModelId;
    },
    saveError: null,
    // #1123: the list has loaded (the first-run window waits for it).
    loaded: true,
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

vi.mock(import("../../src/client/hooks/useLocalModelSettings.svelte"), () => ({
  createLocalModelSettings: () => ({
    editing: false,
    known: true,
    loading: false,
    loadFailed: false,
    saveNotice: null,
    load: vi.fn(async () => {}),
    setEditing: vi.fn(async () => {}),
  }),
}));

const licence = vi.hoisted(() => ({ aiOff: false }));
vi.mock("../../src/client/hooks/useLicense.svelte", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/hooks/useLicense.svelte")>();
  return {
    ...actual,
    licenseStore: {
      ...actual.licenseStore,
      get ui() {
        return { ...actual.licenseStore.ui, aiOff: licence.aiOff };
      },
    },
  };
});

const store = await import("../../src/client/hooks/useChatAnswerer.svelte.js");
const { signalModelsWriteCommitted } = await import(
  "../../src/client/models/models-write-signal.js"
);
const { _setPageOriginForTests } = await import(
  "../../src/client/hooks/useModelsWriteAccess.svelte.js"
);
const { noteModelsWriteRefused } = await import("../../src/client/models/write-refusal.js");
const { MCP_BASE_URL } = await import("../../src/client/utils/backend-ports.js");
const { default: SettingsModelsTab } = await import(
  "../../src/client/components/settings-tabs/SettingsModelsTab.svelte"
);

asTandemOwnWindow();

let held: ReturnType<typeof installHeldFetch>;

beforeEach(() => {
  store._resetChatAnswererForTests();
  licence.aiOff = false;
  modelsPose.models = [];
  modelsPose.defaultModelId = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  held = installHeldFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const known = (answerer: "claude" | "local", localModelState: string | null = "usable") => ({
  answerer,
  localModelResolves: localModelState === "usable",
  ...(localModelState === null ? {} : { localModelState }),
  runGeneration: "g1",
});

function mount(readOnly = false) {
  const view = render(SettingsModelsTab, {
    props: {
      open: true,
      settings: { selectionDwellMs: 1000 } as TandemSettings,
      onUpdate: vi.fn(),
      connected: true,
      reconnectAttempts: 0,
      readOnly,
      notify: vi.fn(),
    },
  });
  const radio = (v: "claude" | "local") =>
    view.getByTestId(`chat-answerer-${v}`) as HTMLButtonElement;
  const text = () =>
    view.getByTestId("chat-answerer-section").textContent?.replace(/\s+/g, " ") ?? "";
  return { ...view, radio, text };
}

const posts = () => held.calls.filter((c) => c.method === "POST");
/** Past the tab's `ANNOUNCE_DELAY_MS` (300 ms), a real wait: the announcers
 *  take their text only after it. */
const announceDelay = async () => {
  await new Promise((r) => setTimeout(r, 350));
  await drain();
};
const gets = () => held.calls.filter((c) => c.method === "GET");

/** Mount and answer the mount read. */
async function mounted(body: unknown, status = 200, readOnly = false) {
  const view = mount(readOnly);
  await (await held.request(1)).answer(status, body);
  return view;
}

describe("shape and the known states (R2.1, R2.8)", () => {
  it("heading, two radios, one read on mount and no POST", async () => {
    const v = await mounted(known("claude"));
    expect(v.getByText("Who answers your chat")).toBeTruthy();
    expect(v.getByRole("radiogroup")).toBeTruthy();
    expect(v.radio("claude").textContent?.trim()).toBe("Claude");
    expect(v.radio("local").textContent?.trim()).toBe("Local model");
    expect(v.radio("claude").getAttribute("aria-checked")).toBe("true");
    expect(v.radio("local").getAttribute("aria-checked")).toBe("false");
    expect(gets()).toHaveLength(1);
    expect(posts()).toHaveLength(0);
  });

  const LOCAL_SENTENCE =
    "While chat is set to your local model, Tandem does not send Claude the chat messages you send, then or later.";
  const lines: Array<[string, unknown, string]> = [
    [
      "known Claude",
      known("claude"),
      "Chat is set to Claude. Local models are not sent your chat.",
    ],
    ["known local, usable", known("local"), `Chat is set to your local model. ${LOCAL_SENTENCE}`],
    [
      "known local, none",
      known("local", "none"),
      `Chat is set to your local model, but no local model can be used now. Turn on a local model and mark it Default, or set chat to Claude. ${LOCAL_SENTENCE}`,
    ],
    [
      "known local, no-default-chosen",
      known("local", "no-default-chosen"),
      `Chat is set to your local model, but none of your enabled local models is marked Default, so none can be used. Mark one as Default, or set chat to Claude. ${LOCAL_SENTENCE}`,
    ],
    [
      "known local, endpoint-rejected",
      known("local", "endpoint-rejected"),
      `Chat is set to your local model, but its Endpoint was not accepted, so it can't be used. Edit the model, or set chat to Claude. ${LOCAL_SENTENCE}`,
    ],
    [
      "known local, no-endpoint",
      known("local", "no-endpoint"),
      `Chat is set to your local model, but it has no Endpoint saved, so it can't be used. Edit the model, or set chat to Claude. ${LOCAL_SENTENCE}`,
    ],
    [
      "known local, the check threw",
      known("local", null),
      `Chat is set to your local model. Tandem couldn't check whether it can be used. ${LOCAL_SENTENCE}`,
    ],
  ];
  for (const [label, body, line] of lines) {
    it(`${label}: the line, not a live region`, async () => {
      const v = await mounted(body);
      const status = v.getByTestId("chat-answerer-status");
      expect(status.textContent?.trim()).toBe(line);
      expect(status.getAttribute("role")).toBeNull();
      expect(status.getAttribute("aria-live")).toBeNull();
    });
  }

  it("licence refused: the AI-off sentence after the line", async () => {
    licence.aiOff = true;
    const v = await mounted(known("local"));
    expect(v.getByTestId("chat-answerer-status").textContent?.trim()).toBe(
      `Chat is set to your local model. ${LOCAL_SENTENCE} AI features are off, so chat is not sent to any model. See Settings → License.`,
    );
  });

  it("licence refused with the read not known: no AI-off sentence", async () => {
    licence.aiOff = true;
    const v = mount();
    await held.request(1);
    expect(v.text()).not.toContain("AI features are off");
  });

  it("readOnly does not disable the control (R2.9)", async () => {
    const v = await mounted(known("claude"), 200, true);
    expect(v.radio("local").getAttribute("aria-disabled")).toBe("false");
    await fireEvent.click(v.radio("local"));
    await drain();
    expect(posts()).toHaveLength(1);
  });
});

describe("keys and sends (R2.2, R2.3)", () => {
  it("arrows, Home and End move focus and send nothing; an arrow twice lands back on the first", async () => {
    const v = await mounted(known("claude"));
    v.radio("claude").focus();
    const group = v.getByRole("radiogroup");
    await fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(document.activeElement).toBe(v.radio("local"));
    expect(v.radio("local").tabIndex).toBe(0);
    await fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(document.activeElement).toBe(v.radio("claude"));
    await fireEvent.keyDown(group, { key: "End" });
    expect(document.activeElement).toBe(v.radio("local"));
    await fireEvent.keyDown(group, { key: "Home" });
    expect(document.activeElement).toBe(v.radio("claude"));
    await drain();
    expect(posts()).toHaveLength(0);
    expect(v.radio("claude").getAttribute("aria-checked")).toBe("true");
  });

  it("a click on the other position sends exactly one POST", async () => {
    const v = await mounted(known("claude"));
    await fireEvent.click(v.radio("local"));
    await drain();
    expect(posts().map((c) => c.body)).toEqual([{ answerer: "local" }]);
    await posts()[0].answer(200, { answerer: "local", persisted: true });
    await (await held.request(3)).answer(200, known("local"));
    expect(v.radio("local").getAttribute("aria-checked")).toBe("true");
  });

  // Review round 1, item 5. Each radio is a real <button type="button">, so a
  // browser turns Space and Enter on it into a click (happy-dom does not, so
  // the keys themselves are driven in `tests/e2e/chat-answerer.spec.ts`, which
  // presses Space in a real browser — unrun while the flag is off). Here the
  // element's own activation behaviour (`HTMLElement.click()`, what that
  // keypress invokes) selects, and a keydown alone sends nothing, so one
  // keypress cannot send twice.
  it("the radios are real buttons; their activation selects, a keydown alone does not", async () => {
    const v = await mounted(known("claude"));
    for (const value of ["claude", "local"] as const) {
      expect(v.radio(value).tagName).toBe("BUTTON");
      expect(v.radio(value).getAttribute("type")).toBe("button");
    }
    v.radio("local").focus();
    await fireEvent.keyDown(v.radio("local"), { key: "Enter" });
    await fireEvent.keyDown(v.radio("local"), { key: " " });
    await drain();
    expect(posts()).toHaveLength(0);
    v.radio("local").click();
    await drain();
    expect(posts().map((c) => c.body)).toEqual([{ answerer: "local" }]);
  });

  it("the position already shown: no POST, and a re-read", async () => {
    const v = await mounted(known("claude"));
    await fireEvent.click(v.radio("claude"));
    await drain();
    expect(posts()).toHaveLength(0);
    expect(gets()).toHaveLength(2);
  });

  it("while a POST is pending the group is aria-disabled, focus stays, keys still move focus only", async () => {
    const v = await mounted(known("claude"));
    v.radio("local").focus();
    await fireEvent.click(v.radio("local"));
    await drain();
    expect(v.getByRole("radiogroup").getAttribute("aria-disabled")).toBe("true");
    expect(v.radio("claude").getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(v.radio("local"));
    await fireEvent.keyDown(v.getByRole("radiogroup"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(v.radio("claude"));
    await fireEvent.click(v.radio("claude"));
    await drain();
    expect(posts()).toHaveLength(1);
  });

  it("after a refused switch, focus is on the radio showing the server's value, with the line", async () => {
    const v = await mounted(known("claude"));
    v.radio("local").focus();
    await fireEvent.click(v.radio("local"));
    await drain();
    await posts()[0].answer(500, {
      answerer: "claude",
      persisted: false,
      code: "CHAT_ANSWERER_WRITE_FAILED",
    });
    await (await held.request(3)).answer(200, known("claude"));
    expect(document.activeElement).toBe(v.radio("claude"));
    expect(v.radio("claude").tabIndex).toBe(0);
    const err = v.getByTestId("chat-answerer-error");
    expect(err.getAttribute("role")).toBe("alert");
    expect(err.textContent?.trim()).toBe(
      "Chat could not be set to your local model. It is still set to Claude.",
    );
  });

  it("nothing is sent on mount, on a models save, or on Retry", async () => {
    const v = mount();
    await (await held.request(1)).fail();
    signalModelsWriteCommitted({ firstLocal: false });
    await (await held.request(2)).fail();
    await fireEvent.click(v.getByTestId("chat-answerer-retry"));
    await (await held.request(3)).answer(200, known("local"));
    expect(posts()).toHaveLength(0);
  });
});

describe("not known (R2.5)", () => {
  it("pending: neither checked, aria-disabled, 'Checking…' as a status, and Tab reaches the group", async () => {
    const v = mount();
    await held.request(1);
    expect(v.radio("claude").getAttribute("aria-checked")).toBe("false");
    expect(v.radio("local").getAttribute("aria-checked")).toBe("false");
    expect(v.radio("claude").getAttribute("aria-disabled")).toBe("true");
    const loading = v.getByTestId("chat-answerer-loading");
    expect(loading.getAttribute("role")).toBe("status");
    // The announcer takes the sentence only after the tab's announce delay.
    await announceDelay();
    expect(loading.textContent).toBe("Checking…");
    // Exactly one radio is tabbable with neither checked.
    expect([v.radio("claude").tabIndex, v.radio("local").tabIndex].sort()).toEqual([-1, 0]);
    await fireEvent.click(v.radio("local"));
    await drain();
    expect(posts()).toHaveLength(0);
  });

  it("failed: an alert and Retry; Retry hands focus to the group and reads", async () => {
    const v = mount();
    await (await held.request(1)).fail();
    const err = v.getByTestId("chat-answerer-load-error");
    expect(err.getAttribute("role")).toBe("alert");
    expect(err.textContent).toBe("Couldn't read what chat is set to.");
    const retry = v.getByTestId("chat-answerer-retry");
    retry.focus();
    await fireEvent.click(retry);
    expect(v.getByRole("radiogroup").contains(document.activeElement)).toBe(true);
    await (await held.request(2)).answer(200, known("claude"));
    expect(v.queryByTestId("chat-answerer-load-error")).toBeNull();
  });

  it("'Set chat to Claude' is offered while not known, sends Claude, and hands focus to the group", async () => {
    const v = mount();
    await (await held.request(1)).fail();
    const button = v.getByTestId("chat-answerer-use-claude");
    expect(button.textContent?.trim()).toBe("Set chat to Claude");
    button.focus();
    await fireEvent.click(button);
    await drain();
    expect(posts().map((c) => c.body)).toEqual([{ answerer: "claude" }]);
    expect(v.getByRole("radiogroup").contains(document.activeElement)).toBe(true);
    await posts()[0].answer(200, { answerer: "claude", persisted: true });
    await (await held.request(3)).answer(200, known("claude"));
    expect(v.queryByTestId("chat-answerer-use-claude")).toBeNull();
  });

  it("not offered once a write refusal has latched", async () => {
    const v = mount();
    await (await held.request(1)).fail();
    noteModelsWriteRefused();
    await drain();
    expect(v.queryByTestId("chat-answerer-use-claude")).toBeNull();
  });
});

describe("refused, unreadable and unavailable (R2.6, R2.7)", () => {
  const REFUSED = `This page can't show what chat is set to, because Tandem could not confirm it as Tandem's own window. To see or change it, use the Tandem desktop app, or open Tandem at ${MCP_BASE_URL} in an up-to-date browser.`;

  it("refused: the line, neither checked, the button; its 200 says 'Chat was set to Claude.' and keeps both", async () => {
    const v = await mounted({ code: "OWN_WINDOW_ONLY" }, 403);
    expect(v.getByTestId("chat-answerer-refused").textContent).toBe(REFUSED);
    expect(v.radio("claude").getAttribute("aria-checked")).toBe("false");
    await fireEvent.click(v.getByTestId("chat-answerer-use-claude"));
    await drain();
    await posts()[0].answer(200, { answerer: "claude", persisted: true });
    await (await held.request(3)).answer(403, { code: "OWN_WINDOW_ONLY" });
    const done = v.getByTestId("chat-answerer-set-claude-done");
    expect(done.getAttribute("role")).toBe("status");
    expect(done.textContent?.trim()).toBe("Chat was set to Claude.");
    expect(v.getByTestId("chat-answerer-refused")).toBeTruthy();
    expect(v.radio("claude").getAttribute("aria-checked")).toBe("false");
    expect(v.getByTestId("chat-answerer-use-claude")).toBeTruthy();
  });

  it("refused, and the button's POST refused too: the latch, the tab's own-window notice, no duplicate line", async () => {
    const v = await mounted({ code: "OWN_WINDOW_ONLY" }, 403);
    await fireEvent.click(v.getByTestId("chat-answerer-use-claude"));
    await drain();
    await posts()[0].answer(403, { code: "OWN_WINDOW_ONLY" });
    await (await held.request(3)).answer(403, { code: "OWN_WINDOW_ONLY" });
    expect(v.getByTestId("models-own-window-notice")).toBeTruthy();
    expect(v.queryByTestId("chat-answerer-refused")).toBeNull();
    expect(v.queryByTestId("chat-answerer-use-claude")).toBeNull();
  });

  it("a foreign page: unreadable, the tab's notice only, no button", async () => {
    _setPageOriginForTests("http://localhost:3479");
    const v = mount();
    await (await held.request(1)).fail();
    expect(v.getByTestId("models-own-window-notice")).toBeTruthy();
    expect(v.queryByTestId("chat-answerer-refused")).toBeNull();
    expect(v.queryByTestId("chat-answerer-use-claude")).toBeNull();
    expect(v.radio("local").getAttribute("aria-disabled")).toBe("true");
  });

  it("404: unavailable, with its line, no button", async () => {
    const v = await mounted({ error: "NOT_FOUND" }, 404);
    expect(v.getByTestId("chat-answerer-unavailable").textContent?.trim()).toBe(
      "Who answers your chat can't be changed with this version of Tandem's server.",
    );
    expect(v.queryByTestId("chat-answerer-use-claude")).toBeNull();
    expect(v.radio("claude").getAttribute("aria-disabled")).toBe("true");
  });
});

describe("outcome lines (R2.4)", () => {
  it("a failed POST: 'could not be confirmed', showing the current setting", async () => {
    const v = await mounted(known("claude"));
    await fireEvent.click(v.radio("local"));
    await drain();
    await posts()[0].fail();
    await (await held.request(3)).answer(200, known("claude"));
    expect(v.getByTestId("chat-answerer-error").textContent?.trim()).toBe(
      "That change could not be confirmed. Showing the current setting.",
    );
  });

  it("the line does not survive the tab body (it is rebuilt on each open)", async () => {
    const v = await mounted(known("claude"));
    await fireEvent.click(v.radio("local"));
    await drain();
    await posts()[0].answer(500, {
      answerer: "local",
      persisted: false,
      code: "CHAT_ANSWERER_WRITE_FAILED",
    });
    await (await held.request(3)).answer(200, known("local"));
    expect(v.getByTestId("chat-answerer-error").textContent?.trim()).toBe(
      "Chat is set to your local model now, but this change could not be saved, so chat may be set to Claude again after Tandem restarts.",
    );
    v.unmount();
    const again = mount();
    expect(again.queryByTestId("chat-answerer-error")).toBeNull();
  });
});

describe("review fixes", () => {
  it("the tab stop goes back to the server's value when focus leaves the group", async () => {
    const v = await mounted(known("claude"));
    v.radio("claude").focus();
    await fireEvent.keyDown(v.getByRole("radiogroup"), { key: "ArrowRight" });
    expect(v.radio("local").tabIndex).toBe(0);
    await fireEvent.focusOut(v.radio("local"), { relatedTarget: document.body });
    expect(v.radio("claude").tabIndex).toBe(0);
    expect(v.radio("local").tabIndex).toBe(-1);
  });

  it("the store refuses to send 'local' while the read is not known", async () => {
    mount();
    await (await held.request(1)).fail();
    await store.setChatAnswerer("local");
    await drain();
    expect(posts()).toHaveLength(0);
  });
});

describe("'Chat was set to Claude.' is never left unsaid (UX review)", () => {
  it("pressed while the first read is still pending, then a refused re-read: the line", async () => {
    const v = mount();
    const first = await held.request(1);
    await fireEvent.click(v.getByTestId("chat-answerer-use-claude"));
    await drain();
    await first.answer(403, { code: "OWN_WINDOW_ONLY" });
    await posts()[0].answer(200, { answerer: "claude", persisted: true });
    await (await held.request(3)).answer(403, { code: "OWN_WINDOW_ONLY" });
    expect(v.getByTestId("chat-answerer-set-claude-done").textContent?.trim()).toBe(
      "Chat was set to Claude.",
    );
  });

  it("after a failed read, a 200 and a failed re-read: the line beside the read error", async () => {
    const v = mount();
    await (await held.request(1)).fail();
    await fireEvent.click(v.getByTestId("chat-answerer-use-claude"));
    await drain();
    await posts()[0].answer(200, { answerer: "claude", persisted: true });
    await (await held.request(3)).fail();
    expect(v.getByTestId("chat-answerer-set-claude-done").textContent?.trim()).toBe(
      "Chat was set to Claude.",
    );
    expect(v.getByTestId("chat-answerer-load-error")).toBeTruthy();
  });

  it("the live region is mounted empty before the line arrives", async () => {
    const v = mount();
    await held.request(1);
    const region = v.getByTestId("chat-answerer-set-claude-done");
    expect(region.getAttribute("role")).toBe("status");
    expect(region.textContent?.trim()).toBe("");
  });
});

// #1123, the test-hardening PR, R4.3: the two lines in the gapped description
// column take LiveRegion's announcer shape (its header: the host shape is only
// for a parent with no `gap`).
describe("'Checking…' and 'Chat was set to Claude.' as announcers (R4.3)", () => {
  const column = (v: ReturnType<typeof mount>) => {
    const el = v.container.querySelector<HTMLElement>("#chat-answerer-description");
    if (!el) throw new Error("no #chat-answerer-description");
    return el;
  };
  /** The visible copies: `aria-hidden` paragraphs in the column holding `text`. */
  const visible = (v: ReturnType<typeof mount>, text: string) =>
    Array.from(column(v).querySelectorAll<HTMLElement>("[aria-hidden='true']")).filter(
      (el) => el.textContent?.trim() === text,
    );
  const isOutOfFlow = (el: HTMLElement) =>
    /position:\s*absolute/.test(el.getAttribute("style") ?? "");

  it("both announcers are in the description column, out of flow, before any sentence", async () => {
    const v = mount();
    for (const id of ["chat-answerer-loading", "chat-answerer-set-claude-done"]) {
      const a = v.getByTestId(id);
      expect(column(v).contains(a)).toBe(true);
      expect(a.getAttribute("role")).toBe("status");
      expect(isOutOfFlow(a)).toBe(true);
      expect(a.getAttribute("aria-hidden")).toBeNull();
    }
    expect(v.getByTestId("chat-answerer-set-claude-done").textContent).toBe("");
    // Unmount-free: the same nodes are still there once the read answers.
    const loading = v.getByTestId("chat-answerer-loading");
    await (await held.request(1)).answer(200, known("claude"));
    expect(v.getByTestId("chat-answerer-loading")).toBe(loading);
  });

  it("first open: the 'Checking…' announcer is mounted empty, then receives it as a mutation", async () => {
    const v = mount();
    const first = await held.request(1);
    // The read is pending at mount: the sentence is shown at once, but the
    // announcer is created empty (LiveRegion's header: one inserted already
    // holding its text is commonly read out by nothing).
    const announcer = v.getByTestId("chat-answerer-loading");
    expect(column(v).contains(announcer)).toBe(true);
    expect(announcer.textContent).toBe("");
    expect(visible(v, "Checking…")).toHaveLength(1);
    await announceDelay();
    expect(v.getByTestId("chat-answerer-loading")).toBe(announcer);
    expect(announcer.textContent).toBe("Checking…");
    await first.answer(200, known("claude"));
    expect(announcer.textContent).toBe("");
  });

  it("'Checking…': the announcer holds it and an aria-hidden visible copy is in the column; then both go", async () => {
    const v = mount();
    const first = await held.request(1);
    await announceDelay();
    expect(v.getByTestId("chat-answerer-loading").textContent).toBe("Checking…");
    expect(visible(v, "Checking…")).toHaveLength(1);
    await first.answer(200, known("claude"));
    expect(v.getByTestId("chat-answerer-loading").textContent).toBe("");
    expect(visible(v, "Checking…")).toHaveLength(0);
    expect(column(v).textContent).not.toContain("Checking…");
  });

  it("'Chat was set to Claude.': the announcer holds it and an aria-hidden visible copy is in the column", async () => {
    const v = await mounted({ code: "OWN_WINDOW_ONLY" }, 403);
    const announcer = v.getByTestId("chat-answerer-set-claude-done");
    expect(announcer.textContent).toBe("");
    expect(visible(v, "Chat was set to Claude.")).toHaveLength(0);
    await fireEvent.click(v.getByTestId("chat-answerer-use-claude"));
    await drain();
    await posts()[0].answer(200, { answerer: "claude", persisted: true });
    await (await held.request(3)).answer(403, { code: "OWN_WINDOW_ONLY" });
    // The same node, mounted before the line, now holds it: its arrival is a
    // mutation of a region already in the tree (a remount would fail here).
    expect(v.getByTestId("chat-answerer-set-claude-done")).toBe(announcer);
    expect(announcer.textContent).toBe("Chat was set to Claude.");
    expect(visible(v, "Chat was set to Claude.")).toHaveLength(1);
  });

  it("'Checking…' after a failed read's Retry arrives in the announcer already mounted", async () => {
    const v = mount();
    await (await held.request(1)).fail();
    await announceDelay();
    const announcer = v.getByTestId("chat-answerer-loading");
    expect(announcer.textContent).toBe("");
    await fireEvent.click(v.getByTestId("chat-answerer-retry"));
    await held.request(2);
    expect(v.getByTestId("chat-answerer-loading")).toBe(announcer);
    expect(announcer.textContent).toBe("Checking…");
    expect(visible(v, "Checking…")).toHaveLength(1);
  });

  it("with nothing to say, every in-flow child of the column has text (no empty boxes)", async () => {
    const v = await mounted(known("claude"));
    const inFlow = Array.from(column(v).children).filter((el) => !isOutOfFlow(el as HTMLElement));
    expect(inFlow.length).toBeGreaterThan(0);
    for (const el of inFlow) expect(el.textContent?.trim()).not.toBe("");
  });
});

// #1123 R1.6, Default decision DD1 of 2026-11-18: a cloud or switched-off
// default keeps local models from answering, and Settings says so above the
// list, whatever chat is set to.
describe("a cloud or switched-off default beside an enabled local model (R1.6)", () => {
  const LOCAL = {
    id: "l1",
    provider: "local-ollama",
    displayName: "Qwen",
    modelId: "qwen2.5:14b",
    endpoint: "http://127.0.0.1:11434",
    enabled: true,
  };
  const CLOUD = {
    id: "c1",
    provider: "anthropic",
    displayName: "Opus",
    modelId: "claude-opus-4-7",
    enabled: true,
  };
  const LONG = " To use one, mark it as Default and set chat to your local model.";
  const SHORT = " To use one, mark it as Default.";
  const CLOUD_LINE =
    "Your Default model, Opus, is a cloud model, so your local models won't answer chat.";
  const line = (v: ReturnType<typeof mount>) => v.queryByText(/^\s*Your Default model\b/);
  const pose = (models: Array<Record<string, unknown>>, defaultModelId: string | null) => {
    modelsPose.models = models;
    modelsPose.defaultModelId = defaultModelId;
  };

  it("cloud default, chat on Claude: the cloud sentence and the longer instruction, above the first row, static", async () => {
    pose([CLOUD, LOCAL], CLOUD.id);
    const v = await mounted(known("claude"));
    const el = line(v) as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.textContent?.trim()).toBe(CLOUD_LINE + LONG);
    expect(el.getAttribute("role")).toBeNull();
    expect(el.getAttribute("aria-live")).toBeNull();
    expect(el.closest("[role],[aria-live]")).toBeNull();
    // Before the first model row in DOM order.
    const firstRow = v.container.querySelector('[data-testid^="model-row-"]') as HTMLElement;
    expect(firstRow).not.toBeNull();
    expect(el.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The existing lines are unchanged.
    expect(v.getByTestId("chat-answerer-status").textContent?.trim()).toBe(
      "Chat is set to Claude. Local models are not sent your chat.",
    );
  });

  it("cloud default, the read not known: the longer instruction", async () => {
    pose([CLOUD, LOCAL], CLOUD.id);
    const v = mount();
    expect(line(v)?.textContent?.trim()).toBe(CLOUD_LINE + LONG);
  });

  it("switched-off default, chat known local: the switched-off sentence and the short instruction", async () => {
    const OFF = { ...LOCAL, id: "l0", displayName: "Old", enabled: false };
    pose([OFF, LOCAL], OFF.id);
    const v = await mounted(known("local", "none"));
    expect(line(v)?.textContent?.trim()).toBe(
      "Your Default model, Old, is switched off, so your local models won't answer chat." + SHORT,
    );
  });

  it("a default both cloud and switched off: the switched-off sentence", async () => {
    pose([{ ...CLOUD, enabled: false }, LOCAL], CLOUD.id);
    const v = await mounted(known("claude"));
    expect(line(v)?.textContent?.trim()).toBe(
      "Your Default model, Opus, is switched off, so your local models won't answer chat." + LONG,
    );
  });

  it("an empty name: the name and its commas are left out", async () => {
    pose([{ ...CLOUD, displayName: "" }, LOCAL], CLOUD.id);
    const v = await mounted(known("claude"));
    expect(line(v)?.textContent?.trim()).toBe(
      "Your Default model is a cloud model, so your local models won't answer chat." + LONG,
    );
  });

  it("read-only settings (the Default radio disabled): no instruction", async () => {
    pose([CLOUD, LOCAL], CLOUD.id);
    const v = await mounted(known("claude"), 200, true);
    expect(line(v)?.textContent?.trim()).toBe(CLOUD_LINE);
  });

  it("a local default that is on: no line", async () => {
    pose([CLOUD, LOCAL], LOCAL.id);
    const v = await mounted(known("local"));
    expect(line(v)).toBeNull();
  });

  it("a cloud default with no enabled local model: no line", async () => {
    pose([CLOUD, { ...LOCAL, enabled: false }], CLOUD.id);
    const v = await mounted(known("claude"));
    expect(line(v)).toBeNull();
  });

  it("no default, or a default naming no entry: no line", async () => {
    pose([CLOUD, LOCAL], null);
    expect(line(await mounted(known("claude")))).toBeNull();
    cleanup();
    store._resetChatAnswererForTests();
    held = installHeldFetch();
    pose([CLOUD, LOCAL], "ghost");
    expect(line(await mounted(known("claude")))).toBeNull();
  });
});
