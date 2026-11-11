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

describe("isTandemOwnWindow", () => {
  it.each<[string, Headers]>([
    ["the desktop WebView (Windows / macOS)", { origin: `http://${TAURI_HOSTNAME}` }],
    ["the desktop WebView over https", { origin: `https://${TAURI_HOSTNAME}` }],
    ["the desktop WebView (Linux)", { origin: TAURI_LINUX_ORIGIN }],
    ["the served page, no Origin", { host: HOST, "sec-fetch-site": "same-origin" }],
    [
      "the served page, Origin equal to its own host",
      { host: HOST, origin: `http://${HOST}`, "sec-fetch-site": "same-origin" },
    ],
  ])("true for %s", (_name, headers) => {
    expect(isTandemOwnWindow(fakeRequest(headers))).toBe(true);
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
  ])("false for %s", (_name, headers) => {
    expect(isTandemOwnWindow(fakeRequest(headers))).toBe(false);
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

  const editingNotices = () => getBuffer().filter((n) => n.dedupKey === EDITING_ON_NOTICE_KEY);

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
    await setLocalModelEditing(true); // no window open
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
    expect(editingNotices(), "raised again at start-up").toHaveLength(1);
  });

  it.each<[string, Headers]>([
    ["the served page", { host: HOST, "sec-fetch-site": "same-origin" }],
    ["the desktop WebView", { origin: `http://${TAURI_HOSTNAME}` }],
  ])(
    "%s opening the stream marks it seen, and the next start is silent",
    async (_name, headers) => {
      await setLocalModelEditing(true);
      const { res, written } = fakeResponse();
      handleNotifyStream(fakeRequest(headers), res);
      expect(written.join("")).toContain(EDITING_ON_NOTICE);
      expect(editingOnWasAnnounced()).toBe(true);
      await __flushLocalModelAnnouncedForTests();

      restart();
      expect(editingNotices()).toEqual([]);
    },
  );

  it("live: a foreign stream connected at switch-on does not count; Tandem's window does", async () => {
    const stop = subscribeNotifications(() => {});
    await setLocalModelEditing(true);
    await __flushLocalModelAnnouncedForTests();
    expect(editingOnWasAnnounced()).toBe(false);
    stop();

    await setLocalModelEditing(false);
    subscribeNotifications(() => {}, { ownWindow: true });
    await setLocalModelEditing(true);
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

    await setLocalModelEditing(true); // nobody watching
    await __flushLocalModelAnnouncedForTests();
    restart();
    expect(editingNotices()).toHaveLength(1);
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
