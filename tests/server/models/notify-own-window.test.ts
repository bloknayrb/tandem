import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleNotifyStream,
  isTandemOwnWindow,
} from "../../../src/server/mcp/routes/notify-stream.js";
import {
  __flushLocalModelAnnouncedForTests,
  __resetLocalModelAnnouncedForTests,
  announceLocalModelChange,
  answeringWasAnnounced,
  editingOnWasAnnounced,
  recordAnsweringNone,
  SETTINGS_CHANGED_NOTICE,
  SETTINGS_CHANGED_NOTICE_KEY,
} from "../../../src/server/models/local-model-announced.js";
import {
  __resetLocalModelSettingsForTests,
  EDITING_ON_NOTICE,
  EDITING_ON_NOTICE_KEY,
  primeLocalModelSettings,
  setLocalModelEditing,
} from "../../../src/server/models/local-model-settings.js";
import {
  getBuffer,
  ownWindowSubscriberCount,
  resetForTesting as resetNotifications,
  subscribe as subscribeNotifications,
} from "../../../src/server/notifications.js";
import { isTauriSidecar, TAURI_SIDECAR_ARGV_FLAG } from "../../../src/server/platform.js";
import { clearStartupNotices } from "../../../src/server/startup-notices.js";
import { TAURI_HOSTNAME, TAURI_LINUX_ORIGIN } from "../../../src/shared/constants.js";

/**
 * #2404: a notice counts as SEEN only when it was sent to Tandem's own window.
 *
 * `GET /api/notify-stream` is an unauthenticated loopback GET, so the caller
 * this register entry is about — a page on another `127.0.0.1` port — can open
 * it. If any stream counted, that page could switch commenting on, open the
 * stream to mark its own change as seen, and restart the server; the next
 * start would then be silent. These tests are that attack, and its refusal.
 */

type Headers = Record<string, string>;

/** `close` handlers of every fake request. A fake never closes by itself, and
 *  the route's keepalive interval lives until its request does, so each test
 *  closes them all (`closeFakeRequests`) rather than leak a timer per stream. */
const closers: (() => void)[] = [];
function closeFakeRequests(): void {
  for (const close of closers.splice(0)) close();
}

function fakeRequest(headers?: Headers): Request {
  return {
    headers,
    on: (event: string, cb: () => void) => {
      if (event === "close") closers.push(cb);
    },
  } as unknown as Request;
}

/** A response that records what was written to it. */
function fakeResponse() {
  const written: string[] = [];
  const res = {
    writableEnded: false,
    writeHead: () => res,
    write: (chunk: string) => {
      written.push(chunk);
      return true;
    },
  };
  return { res: res as unknown as Response, written };
}

const HOST = "127.0.0.1:3479";

/** Run `fn` as the desktop app's sidecar: `--tauri-sidecar` in argv, which is
 *  what `isTauriSidecar()` (and so `handleNotifyStream`) reads. */
function asDesktopSidecar<T>(fn: () => T): T {
  process.argv.push(TAURI_SIDECAR_ARGV_FLAG);
  try {
    return fn();
  } finally {
    const at = process.argv.lastIndexOf(TAURI_SIDECAR_ARGV_FLAG);
    if (at !== -1) process.argv.splice(at, 1);
  }
}

const DESKTOP_WINDOW: [string, Headers][] = [
  ["the desktop WebView (Windows / macOS)", { origin: `http://${TAURI_HOSTNAME}` }],
  ["the desktop WebView over https", { origin: `https://${TAURI_HOSTNAME}` }],
  ["the desktop WebView (Linux)", { origin: TAURI_LINUX_ORIGIN }],
];

describe("isTandemOwnWindow", () => {
  // The desktop window's origin counts only on a server that IS the desktop
  // app's sidecar. On an npm install it is content on port 80 or 443 of this
  // computer browsed as `tauri.localhost` (review of PR #2413, item 1).
  it.each(DESKTOP_WINDOW)(
    "%s: true on the desktop sidecar, false on an npm server",
    (_n, headers) => {
      expect(isTandemOwnWindow(fakeRequest(headers), true)).toBe(true);
      expect(isTandemOwnWindow(fakeRequest(headers), false)).toBe(false);
      // Claiming same-origin as well does not rescue it on an npm server.
      const claimed = { ...headers, host: HOST, "sec-fetch-site": "same-origin" };
      expect(isTandemOwnWindow(fakeRequest(claimed), false)).toBe(false);
    },
  );

  it("the default follows this process: not a sidecar under the test runner, a sidecar with the argv flag", () => {
    const req = () => fakeRequest({ origin: `http://${TAURI_HOSTNAME}` });
    expect(isTauriSidecar()).toBe(false);
    expect(isTandemOwnWindow(req())).toBe(false);
    expect(asDesktopSidecar(() => isTandemOwnWindow(req()))).toBe(true);
    expect(isTandemOwnWindow(req())).toBe(false); // the flag did not leak
  });

  it.each<[string, Headers]>([
    ["the served page, no Origin", { host: HOST, "sec-fetch-site": "same-origin" }],
    [
      "the served page, Origin equal to its own host",
      { host: HOST, origin: `http://${HOST}`, "sec-fetch-site": "same-origin" },
    ],
  ])("true for %s, sidecar or not", (_name, headers) => {
    expect(isTandemOwnWindow(fakeRequest(headers), true)).toBe(true);
    expect(isTandemOwnWindow(fakeRequest(headers), false)).toBe(true);
  });

  it.each<[string, Headers | undefined]>([
    ["a curl-style request (no Origin, no Sec-Fetch-Site)", { host: HOST }],
    ["a request object with no headers at all", undefined],
    [
      "a page on another loopback port (EventSource)",
      { host: HOST, origin: "http://127.0.0.1:8080", "sec-fetch-site": "same-site" },
    ],
    [
      "that page claiming same-origin without the matching Origin",
      { host: HOST, origin: "http://127.0.0.1:8080", "sec-fetch-site": "same-origin" },
    ],
    ["an <img>-style request from another port", { host: HOST, "sec-fetch-site": "same-site" }],
    ["a cross-site request", { host: HOST, "sec-fetch-site": "cross-site" }],
    ["a top-level navigation", { host: HOST, "sec-fetch-site": "none" }],
    ["Origin: null", { host: HOST, origin: "null", "sec-fetch-site": "same-origin" }],
    [
      "the Vite dev origin",
      { host: HOST, origin: "http://localhost:5173", "sec-fetch-site": "same-site" },
    ],
    [
      "an Origin on the right host but https",
      { host: HOST, origin: `https://${HOST}`, "sec-fetch-site": "same-origin" },
    ],
  ])("false for %s, sidecar or not", (_name, headers) => {
    expect(isTandemOwnWindow(fakeRequest(headers), true)).toBe(false);
    expect(isTandemOwnWindow(fakeRequest(headers), false)).toBe(false);
  });
});

describe("only Tandem's own window marks a change as seen (#2404)", () => {
  let dir: string;

  /** A server restart: module state forgotten, the files on disk kept. */
  function restart(): void {
    resetNotifications();
    clearStartupNotices();
    __resetLocalModelSettingsForTests(dir);
    primeLocalModelSettings();
  }

  /** The live notice: commenting was switched on by a request that did not
   *  come from Tandem's own window (`"unspecified"` below stands for that). */
  const editingNotices = () => getBuffer().filter((n) => n.dedupKey === EDITING_ON_NOTICE_KEY);
  /** The start-up notice: a prime found it on with no record the user was told. */
  const startupNotices = () =>
    getBuffer().filter((n) => n.dedupKey === SETTINGS_CHANGED_NOTICE_KEY);

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-own-window-"));
    resetNotifications();
    clearStartupNotices();
    __resetLocalModelSettingsForTests(dir);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    closeFakeRequests();
    await __flushLocalModelAnnouncedForTests();
    __resetLocalModelSettingsForTests();
    resetNotifications();
    clearStartupNotices();
    vi.restoreAllMocks();
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("the attack: switch on unseen, open the stream as a foreign page, restart — it is announced again", async () => {
    await setLocalModelEditing(true, "unspecified"); // no window open
    expect(editingNotices()).toHaveLength(1);

    const foreign: (Headers | undefined)[] = [
      undefined,
      { host: HOST },
      { host: HOST, origin: "http://127.0.0.1:8080", "sec-fetch-site": "same-site" },
    ];
    for (const headers of foreign) {
      const { res, written } = fakeResponse();
      handleNotifyStream(fakeRequest(headers), res);
      // The stream DOES receive the notice…
      expect(written.join("")).toContain(EDITING_ON_NOTICE);
      // …but it is not Tandem's window, so nothing is recorded as seen.
      await __flushLocalModelAnnouncedForTests();
      expect(editingOnWasAnnounced()).toBe(false);
    }
    expect(ownWindowSubscriberCount()).toBe(0);

    restart();
    expect(startupNotices(), "raised again at start-up").toHaveLength(1);
    expect(startupNotices()[0]?.message).toBe(SETTINGS_CHANGED_NOTICE);
  });

  it.each<[string, Headers, boolean]>([
    ["the served page (npm server)", { host: HOST, "sec-fetch-site": "same-origin" }, false],
    ["the served page (desktop sidecar)", { host: HOST, "sec-fetch-site": "same-origin" }, true],
    ["the desktop WebView (desktop sidecar)", { origin: `http://${TAURI_HOSTNAME}` }, true],
  ])(
    "%s opening the stream marks it seen, and the next start is silent",
    async (_name, headers, sidecar) => {
      await setLocalModelEditing(true, "unspecified");
      const { res, written } = fakeResponse();
      const open = () => handleNotifyStream(fakeRequest(headers), res);
      if (sidecar) asDesktopSidecar(open);
      else open();
      expect(written.join("")).toContain(EDITING_ON_NOTICE);
      expect(editingOnWasAnnounced()).toBe(true);
      await __flushLocalModelAnnouncedForTests();

      restart();
      expect(editingNotices()).toEqual([]);
      expect(startupNotices()).toEqual([]);
    },
  );

  it.each(DESKTOP_WINDOW)(
    "on an npm server, a stream presenting %s receives the notice but is NOT counted as told",
    async (_name, headers) => {
      await setLocalModelEditing(true, "unspecified"); // no window open
      const { res, written } = fakeResponse();
      handleNotifyStream(fakeRequest(headers), res);
      expect(written.join("")).toContain(EDITING_ON_NOTICE);
      await __flushLocalModelAnnouncedForTests();
      expect(editingOnWasAnnounced()).toBe(false);
      expect(ownWindowSubscriberCount()).toBe(0);

      // So the start-up notice is raised at the next start, and a second such
      // stream does not record THAT as told either.
      restart();
      expect(startupNotices()).toHaveLength(1);
      const again = fakeResponse();
      handleNotifyStream(fakeRequest(headers), again.res);
      expect(again.written.join("")).toContain(SETTINGS_CHANGED_NOTICE);
      await __flushLocalModelAnnouncedForTests();
      expect(editingOnWasAnnounced()).toBe(false);
    },
  );

  it("live: a foreign stream connected at switch-on does not count; Tandem's window does", async () => {
    const stop = subscribeNotifications(() => {});
    await setLocalModelEditing(true, "unspecified");
    await __flushLocalModelAnnouncedForTests();
    expect(editingOnWasAnnounced()).toBe(false);
    stop();

    await setLocalModelEditing(false, "unspecified");
    subscribeNotifications(() => {}, { ownWindow: true });
    await setLocalModelEditing(true, "unspecified");
    expect(editingOnWasAnnounced()).toBe(true);
  });

  it("a prime that reads off clears a stale 'told', so a later unseen On is announced after a restart", async () => {
    fs.writeFileSync(
      path.join(dir, "local-model-announced.json"),
      JSON.stringify({ version: 1, editing: true, answering: null }),
    );
    __resetLocalModelAnnouncedForTests(dir);
    primeLocalModelSettings(); // no settings file: off
    expect(editingOnWasAnnounced()).toBe(false);

    await setLocalModelEditing(true, "unspecified"); // nobody watching
    await __flushLocalModelAnnouncedForTests();
    restart();
    expect(startupNotices()).toHaveLength(1);
  });

  it("recordAnsweringNone forgets the fingerprint, so the same model answering again is unannounced", async () => {
    subscribeNotifications(() => {}, { ownWindow: true });
    announceLocalModelChange("local-model-answering-changed", "x", { answering: "abc" });
    expect(answeringWasAnnounced("abc")).toBe(true);
    recordAnsweringNone();
    expect(answeringWasAnnounced("abc")).toBe(false);
    await __flushLocalModelAnnouncedForTests();
    __resetLocalModelAnnouncedForTests(dir);
    expect(answeringWasAnnounced("abc")).toBe(false); // persisted
    recordAnsweringNone(); // no-op when already none
  });
});
