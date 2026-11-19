// @vitest-environment happy-dom

/**
 * An old cloud entry in Settings → Models (#1123, cloud providers hidden;
 * ADR-039 P4 and its "Shown as unavailable" pick). With `BYO_MODELS_ENABLED`
 * on, an entry whose provider fails `isLocalProvider` (anthropic, openai,
 * gemini) is listed under "<name> (API key)" with "This provider can't be used
 * in Tandem."; its Default and On/Off keep their checked state but are
 * unavailable (`aria-disabled`, described by that sentence) and refuse a
 * click; its open button reads "View" and opens the unavailable window; Delete
 * works. A local entry beside it is unchanged.
 *
 * The store is a pose plus one shared set of mutator spies, as
 * `settings-models-tab-chat-answerer.test.ts` builds it.
 */

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TandemSettings } from "../../src/client/hooks/useTandemSettings.svelte";
import { drain, installHeldFetch } from "../helpers/held-fetch";
import { modelsPose } from "../helpers/models-pose.svelte";
import { asTandemOwnWindow } from "../helpers/models-write-access.svelte";

vi.mock(import("../../src/shared/constants.js"), async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/shared/constants.js")>()),
  BYO_MODELS_ENABLED: true as typeof import("../../src/shared/constants.js").BYO_MODELS_ENABLED,
}));

const mutators = vi.hoisted(() => ({
  addModel: vi.fn(async (): Promise<string | null> => "id"),
  updateModel: vi.fn(async () => true),
  deleteModel: vi.fn(async (_id: string) => {}),
  toggleEnabled: vi.fn(async (_id: string) => {}),
  setDefault: vi.fn(async (_id: string | null) => true),
  reload: vi.fn(async () => {}),
}));

vi.mock(import("../../src/client/hooks/useModels.svelte"), async () => {
  const { modelsPose } = await import("../helpers/models-pose.svelte");
  return {
    createModels: () => ({
      get models() {
        return modelsPose.models as never;
      },
      get defaultModelId() {
        return modelsPose.defaultModelId;
      },
      saveError: null,
      loaded: true,
      loading: false,
      loadFailed: false,
      clearError: vi.fn(),
      ...mutators,
    }),
  };
});

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

const { _setPageOriginForTests } = await import(
  "../../src/client/hooks/useModelsWriteAccess.svelte.js"
);
const { default: SettingsModelsTab } = await import(
  "../../src/client/components/settings-tabs/SettingsModelsTab.svelte"
);

asTandemOwnWindow();

beforeEach(() => {
  for (const fn of Object.values(mutators)) fn.mockReset();
  mutators.addModel.mockImplementation(async () => "id");
  mutators.updateModel.mockImplementation(async () => true);
  mutators.setDefault.mockImplementation(async () => true);
  mutators.deleteModel.mockImplementation(async () => {});
  mutators.toggleEnabled.mockImplementation(async () => {});
  mutators.reload.mockImplementation(async () => {});
  modelsPose.models = [];
  modelsPose.defaultModelId = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  installHeldFetch(); // the chat-answerer read stays pending; nothing here needs it
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Literals, never built from the product's maps.
const U1 = "This provider can't be used in Tandem.";
const U6: Readonly<Record<string, string>> = {
  anthropic: "Anthropic (API key)",
  openai: "OpenAI (API key)",
  gemini: "Gemini (API key)",
};
const LOCAL_HEADING: Readonly<Record<string, string>> = {
  "local-ollama": "Ollama (local)",
  "local-llamacpp": "llama.cpp (local)",
  "local-lmstudio": "LM Studio (local)",
  "local-other": "Other local server (OpenAI-compatible)",
};
const CLOUD = ["anthropic", "openai", "gemini"] as const;
const LOCALS = ["local-ollama", "local-llamacpp", "local-lmstudio", "local-other"] as const;
const OWN_WINDOW_MSG = "models-own-window-msg";

type Entry = Record<string, unknown> & { id: string };
const cloudEntry = (
  provider: string,
  opts: { enabled?: boolean; key?: boolean; id?: string } = {},
): Entry => ({
  id: opts.id ?? `c-${provider}`,
  provider,
  displayName: `My ${provider}`,
  modelId: `${provider}-model`,
  enabled: opts.enabled ?? true,
  ...(opts.key === false ? {} : { apiKeyRef: "ref-abcd" }),
});
const localEntry = (
  provider: string = "local-ollama",
  opts: { enabled?: boolean; endpoint?: boolean } = {},
): Entry => ({
  id: `l-${provider}`,
  provider,
  displayName: "Qwen",
  modelId: "qwen2.5:14b",
  enabled: opts.enabled ?? true,
  ...(opts.endpoint === false ? {} : { endpoint: "http://127.0.0.1:11434" }),
});

function pose(models: Entry[], defaultModelId: string | null) {
  modelsPose.models = models;
  modelsPose.defaultModelId = defaultModelId;
}

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
  const radio = (id: string) => view.getByTestId(`model-default-${id}`) as HTMLInputElement;
  const toggle = (id: string) => view.getByTestId(`model-toggle-${id}`) as HTMLInputElement;
  const open = (id: string) => view.getByTestId(`model-edit-btn-${id}`) as HTMLButtonElement;
  return { ...view, radio, toggle, open };
}

const norm = (t: string | null | undefined) => (t ?? "").replace(/\s+/g, " ").trim();
const tokens = (el: Element) =>
  (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
const headingOf = (row: HTMLElement) =>
  norm(row.parentElement?.parentElement?.querySelector(".settings-section-label")?.textContent);

/** Past the radio refusal's queued re-statement of the group. */
async function settle() {
  await drain();
  await tick();
}

describe("row 2: an old cloud entry's row", () => {
  for (const provider of CLOUD) {
    for (const enabled of [true, false]) {
      for (const key of [true, false]) {
        const name = `${provider}, ${enabled ? "on" : "off"}, ${key ? "with" : "without"} apiKeyRef`;
        it(`${name}: the sentence, unavailable controls that say why and refuse, View, Delete`, async () => {
          const cloud = cloudEntry(provider, { enabled, key });
          const local = localEntry();
          pose([cloud, local], local.id);
          const v = mount();

          // The heading and the sentence.
          const row = v.getByTestId(`model-row-${cloud.id}`);
          expect(headingOf(row)).toBe(U6[provider]);
          const reason = v.getByTestId(`model-unavailable-${cloud.id}`);
          expect(norm(reason.textContent)).toBe(U1);
          expect(row.contains(reason)).toBe(true);

          // Default and On/Off: aria-disabled, not disabled, described by the
          // sentence and then the own-window message; styled unavailable.
          for (const control of [v.radio(cloud.id), v.toggle(cloud.id)]) {
            expect(control.getAttribute("aria-disabled")).toBe("true");
            expect(control.disabled).toBe(false);
            expect(tokens(control)).toEqual([reason.id, OWN_WINDOW_MSG]);
            const style = control.getAttribute("style") ?? "";
            expect(style).toContain("cursor: not-allowed");
            expect(style).toContain("opacity: 0.5");
          }
          // The radio keeps its title (CP-6).
          expect(v.radio(cloud.id).closest("label")?.getAttribute("title")).toBe(
            "Use as the default model",
          );

          // A click on each is refused: nothing sent, nothing toggled.
          await fireEvent.click(v.radio(cloud.id));
          await fireEvent.click(v.toggle(cloud.id));
          await settle();
          expect(mutators.setDefault).not.toHaveBeenCalled();
          expect(mutators.toggleEnabled).not.toHaveBeenCalled();
          expect(v.radio(cloud.id).checked).toBe(false);
          expect(v.radio(local.id).checked).toBe(true);
          expect(v.toggle(cloud.id).checked).toBe(enabled);

          // The open button reads View and mounts the unavailable window.
          expect(norm(v.open(cloud.id).textContent)).toBe("View");
          expect(v.open(cloud.id).getAttribute("aria-disabled")).toBe("false");
          await fireEvent.click(v.open(cloud.id));
          expect(v.getByTestId("model-edit-unavailable-close")).toBeTruthy();
          await fireEvent.click(v.getByTestId("model-edit-unavailable-close"));
          expect(v.queryByTestId("model-edit-modal")).toBeNull();

          // Delete then Confirm deletes it.
          await fireEvent.click(v.getByTestId(`model-delete-btn-${cloud.id}`));
          await fireEvent.click(v.getByTestId(`model-delete-confirm-${cloud.id}`));
          expect(mutators.deleteModel).toHaveBeenCalledTimes(1);
          expect(mutators.deleteModel).toHaveBeenCalledWith(cloud.id);
        });
      }
    }
  }

  it("a cloud Default stays checked, and a click on it sends nothing", async () => {
    const cloud = cloudEntry("openai");
    const local = localEntry();
    pose([cloud, local], cloud.id);
    const v = mount();
    expect(v.radio(cloud.id).checked).toBe(true);
    await fireEvent.click(v.radio(cloud.id));
    await settle();
    expect(v.radio(cloud.id).checked).toBe(true);
    expect(mutators.setDefault).not.toHaveBeenCalled();
  });
});

describe("headings", () => {
  it("each cloud group reads '<name> (API key)'; the four local headings are unchanged", () => {
    const all = [...CLOUD.map((p) => cloudEntry(p)), ...LOCALS.map((p) => localEntry(p))];
    pose(all, null);
    const v = mount();
    for (const e of all) {
      const want = U6[e.provider as string] ?? LOCAL_HEADING[e.provider as string];
      expect(headingOf(v.getByTestId(`model-row-${e.id}`)), e.id).toBe(want);
    }
  });
});

describe("row 3: a local entry beside a cloud Default", () => {
  const cases: Array<[string, Entry]> = [
    ...LOCALS.map((p): [string, Entry] => [p, localEntry(p)]),
    ["local-ollama with no endpoint", localEntry("local-ollama", { endpoint: false })],
    ["local-ollama switched off", localEntry("local-ollama", { enabled: false })],
  ];
  for (const [name, local] of cases) {
    it(`${name}: live controls, no sentence, Edit`, async () => {
      const cloud = cloudEntry("anthropic");
      pose([cloud, local], cloud.id);
      const v = mount();
      expect(v.queryByTestId(`model-unavailable-${local.id}`)).toBeNull();
      for (const control of [v.radio(local.id), v.toggle(local.id)]) {
        expect(control.getAttribute("aria-disabled")).toBe("false");
        expect(tokens(control)).toEqual([OWN_WINDOW_MSG]);
      }
      expect(norm(v.open(local.id).textContent)).toBe("Edit");
      await fireEvent.click(v.radio(local.id));
      expect(mutators.setDefault).toHaveBeenCalledTimes(1);
      expect(mutators.setDefault).toHaveBeenCalledWith(local.id);
      await fireEvent.click(v.toggle(local.id));
      expect(mutators.toggleEnabled).toHaveBeenCalledTimes(1);
      expect(mutators.toggleEnabled).toHaveBeenCalledWith(local.id);
    });
  }
});

describe("over row 2: not Tandem's own window, and read-only settings", () => {
  it("blocked: the controls keep both ids", () => {
    _setPageOriginForTests("http://localhost:3479");
    const cloud = cloudEntry("gemini");
    pose([cloud, localEntry()], null);
    const v = mount();
    const reason = v.getByTestId(`model-unavailable-${cloud.id}`);
    for (const control of [v.radio(cloud.id), v.toggle(cloud.id)]) {
      expect(control.getAttribute("aria-disabled")).toBe("true");
      expect(tokens(control)).toEqual([reason.id, OWN_WINDOW_MSG]);
    }
  });

  it("readOnly: Default, On/Off and Delete are natively disabled", () => {
    const cloud = cloudEntry("anthropic");
    pose([cloud, localEntry()], null);
    const v = mount(true);
    expect(v.radio(cloud.id).disabled).toBe(true);
    expect(v.toggle(cloud.id).disabled).toBe(true);
    expect((v.getByTestId(`model-delete-btn-${cloud.id}`) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe("the reason's id", () => {
  it("an entry id holding a space: every describedby token resolves, the first to the sentence", () => {
    const cloud = cloudEntry("openai", { id: "my cloud key" });
    pose([cloud, localEntry()], null);
    const v = mount();
    for (const control of [v.radio(cloud.id), v.toggle(cloud.id)]) {
      const ids = tokens(control);
      for (const id of ids) expect(document.getElementById(id), id).not.toBeNull();
      expect(norm(document.getElementById(ids[0])?.textContent)).toBe(U1);
    }
  });

  it("two cloud entries of different kinds: each token names exactly one element, in the same row; no id repeats", () => {
    const a = cloudEntry("anthropic");
    const g = cloudEntry("gemini");
    pose([a, g, localEntry()], null);
    const v = mount();
    for (const entry of [a, g]) {
      const row = v.getByTestId(`model-row-${entry.id}`);
      for (const control of [v.radio(entry.id), v.toggle(entry.id)]) {
        const [first, ...rest] = tokens(control);
        expect(document.querySelectorAll(`[id="${first}"]`)).toHaveLength(1);
        expect(row.contains(document.getElementById(first))).toBe(true);
        expect(rest).toEqual([OWN_WINDOW_MSG]);
      }
    }
    const ids = [...document.querySelectorAll("[id]")].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("focus after the unavailable window closes", () => {
  for (const how of ["Close", "Escape", "×"] as const) {
    it(`${how}: focus returns to the row's View button`, async () => {
      const cloud = cloudEntry("anthropic");
      pose([cloud, localEntry()], null);
      const v = mount();
      const view = v.open(cloud.id);
      view.focus();
      await fireEvent.click(view);
      expect(document.activeElement).toBe(v.getByTestId("model-edit-unavailable-close"));
      if (how === "Close") await fireEvent.click(v.getByTestId("model-edit-unavailable-close"));
      else if (how === "×") await fireEvent.click(v.getByTestId("model-edit-cancel"));
      else
        (document.activeElement as HTMLElement).dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      await tick();
      expect(v.queryByTestId("model-edit-modal")).toBeNull();
      expect(document.activeElement).toBe(view);
    });
  }

  it("a later Add window's close does not send focus to an earlier View button", async () => {
    const cloud = cloudEntry("anthropic");
    pose([cloud, localEntry()], null);
    const v = mount();
    await fireEvent.click(v.open(cloud.id));
    await fireEvent.click(v.getByTestId("model-edit-unavailable-close"));
    // A click does not move focus in happy-dom; a real one does.
    const add = v.getByTestId("model-add-btn");
    add.focus();
    await fireEvent.click(add);
    await fireEvent.click(v.getByTestId("model-edit-cancel"));
    await tick();
    expect(v.queryByTestId("model-edit-modal")).toBeNull();
    expect(document.activeElement).not.toBe(v.open(cloud.id));
  });
});

describe("source pins (comment-stripped)", () => {
  const strip = (src: string) =>
    src
      .replace(/\r\n/g, "\n")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const read = async (rel: string) => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    return strip(readFileSync(join(__dirname, "../..", rel), "utf8"));
  };
  const count = (s: string, re: RegExp) => [...s.matchAll(new RegExp(re, "g"))].length;

  it("the tab: one write site each, both guarded by the provider; the per-row const; ModelEditModal mounted once as today", async () => {
    const tab = await read("src/client/components/settings-tabs/SettingsModelsTab.svelte");
    expect(count(tab, /models\.setDefault\(/)).toBe(1);
    expect(count(tab, /models\.toggleEnabled\(/)).toBe(1);
    expect(
      count(
        tab,
        /onchange=\{\(\) => \{\s*if \(!access\.blocked && !unusableProvider\)\s+void models\.setDefault\(entry\.id\);?\s*\}\}/,
      ),
    ).toBe(1);
    expect(
      count(
        tab,
        /onchange=\{\(\) => \{\s*if \(!access\.blocked && !unusableProvider\)\s+void models\.toggleEnabled\(entry\.id\);?\s*\}\}/,
      ),
    ).toBe(1);
    expect(count(tab, /\{@const unusableProvider = !isLocalProvider\(entry\.provider\)\}/)).toBe(1);
    expect(count(tab, /<ModelEditModal\b/)).toBe(1);
    expect(tab).toMatch(
      /<ModelEditModal\s+entry=\{editingEntry\}\s+error=\{modalError \?\? \(access\.blocked \? access\.notice : null\)\}\s+saveUnavailable=\{access\.blocked\}\s+onCancel=\{closeModal\}\s+onSave=\{handleSave\}\s*\/>/,
    );
  });

  it("the sentence's own tag (the one carrying its data-testid) is muted, never subtle", async () => {
    // Pinned on the tag that carries `data-testid={`model-unavailable-${entry.id}`}`.
    // Moving the style to a class means moving this pin with it.
    const tab = await read("src/client/components/settings-tabs/SettingsModelsTab.svelte");
    const tags = tab.match(/<div\b[^>]*data-testid=\{`model-unavailable-\$\{entry\.id\}`\}[^>]*>/g);
    expect(tags).toHaveLength(1);
    const tag = (tags as string[])[0];
    expect(tag).toContain("--tandem-fg-muted");
    expect(tag).not.toContain("--tandem-fg-subtle");
  });
});
