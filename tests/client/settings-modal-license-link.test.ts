// @vitest-environment happy-dom

/**
 * Settings' "View license" link. The LICENSE says it must be displayed on each
 * copy, and the desktop bundle ships it as LICENSE.txt so `/api/open` will
 * take it. A dev or npm tree only has the bare LICENSE, which `/api/open`
 * refuses (`UNSUPPORTED_FORMAT`), so the button must not appear there: a
 * button that always fails is worse than none, and the About tab still shows
 * the path.
 */

import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsModal from "../../src/client/components/SettingsModal.svelte";
import { _resetAppInfoCache } from "../../src/client/hooks/useAppInfo";
import { loadSettings } from "../../src/client/hooks/useTandemSettings";
import { hasOpenableExtension } from "../../src/client/utils/server-paths";
import { API_INFO, API_OPEN } from "../../src/shared/api-paths";
import { installLocalStorageStub } from "../helpers/local-storage-stub.js";

const BASE_INFO = {
  version: "0.0.0-test",
  toolCount: 1,
  mcpSdkVersion: "0.0.0",
  transport: "http",
};

let fetchMock: ReturnType<typeof vi.fn>;

/** Answer /api/info with `info` and /api/open with 200; leave anything else pending. */
function stubFetch(info: Record<string, unknown>): void {
  fetchMock = vi.fn((url: string) => {
    if (url.endsWith(API_INFO)) {
      return Promise.resolve(new Response(JSON.stringify(info), { status: 200 }));
    }
    if (url.endsWith(API_OPEN)) {
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }
    return new Promise(() => {});
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderModal(onClose = vi.fn()) {
  const view = render(SettingsModal, {
    props: {
      open: true,
      onClose,
      settings: loadSettings(),
      onUpdate: vi.fn(),
      connected: true,
      reconnectAttempts: 0,
    },
  });
  return { ...view, onClose };
}

const byTestId = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-testid='${id}']`);

/** Wait until the info fetch has landed, using a control that is always rendered from it. */
async function waitForInfo(container: HTMLElement): Promise<void> {
  await waitFor(() => expect(container.textContent).toContain("v0.0.0-test"));
}

beforeEach(() => {
  installLocalStorageStub();
  _resetAppInfoCache();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  _resetAppInfoCache();
});

describe("SettingsModal License link", () => {
  it("opens the bundled LICENSE.txt read-only and closes the modal", async () => {
    stubFetch({ ...BASE_INFO, licensePath: "C:\\Program Files\\Tandem\\LICENSE.txt" });
    const { container, onClose } = renderModal();

    // Enabled, not just present: `info` lands a tick before `loading` clears,
    // and a click on the still-disabled button does nothing.
    const btn = await waitFor(() => {
      const el = byTestId(container, "settings-modal-view-license-btn") as HTMLButtonElement;
      expect(el).toBeTruthy();
      expect(el.disabled).toBe(false);
      return el;
    });
    await fireEvent.click(btn);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const openCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith(API_OPEN));
    expect(openCall).toBeDefined();
    expect(JSON.parse(String((openCall?.[1] as RequestInit).body))).toEqual({
      filePath: "C:\\Program Files\\Tandem\\LICENSE.txt",
      readOnly: true,
      force: false,
    });
  });

  it("offers no button for the bare LICENSE of a dev or npm tree", async () => {
    stubFetch({ ...BASE_INFO, licensePath: "/usr/lib/node_modules/tandem-editor/LICENSE" });
    const { container } = renderModal();
    await waitForInfo(container);
    expect(byTestId(container, "settings-modal-view-license-btn")).toBeNull();
  });

  it("offers no button when the server found no licence", async () => {
    stubFetch(BASE_INFO);
    const { container } = renderModal();
    await waitForInfo(container);
    expect(byTestId(container, "settings-modal-view-license-btn")).toBeNull();
  });
});

describe("hasOpenableExtension", () => {
  it("accepts allowlisted extensions on either separator, case-insensitively", () => {
    expect(hasOpenableExtension("C:\\Tandem\\LICENSE.txt")).toBe(true);
    expect(hasOpenableExtension("/opt/tandem/LICENSE.TXT")).toBe(true);
    expect(hasOpenableExtension("/repo/CHANGELOG.md")).toBe(true);
  });

  it("refuses an extensionless file, and a dot that belongs to a directory", () => {
    expect(hasOpenableExtension("/repo/LICENSE")).toBe(false);
    expect(hasOpenableExtension("C:\\v0.28.0\\LICENSE")).toBe(false);
    expect(hasOpenableExtension("/repo.md/LICENSE")).toBe(false);
  });

  it("refuses an extension outside the allowlist", () => {
    expect(hasOpenableExtension("/repo/LICENSE.pdf")).toBe(false);
  });
});
