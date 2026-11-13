import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createKeychain,
  KEYCHAIN_SERVICE_MODELS,
} from "../../../src/server/integrations/keychain.js";
import {
  type ModelsRoutesDeps,
  registerModelsRoutes,
} from "../../../src/server/models/api-routes.js";
import {
  __resetChatAnswererForTests,
  ANSWERER_LOCAL_NOTICE,
  ANSWERER_LOCAL_NOTICE_KEY,
  answererClaudeNotice,
  CHAT_ANSWERER_FILE_NAME,
  chatAnswerer,
  onChatAnswererChanged,
  primeChatAnswerer,
  setChatAnswerer,
} from "../../../src/server/models/chat-answerer.js";
import {
  __flushLocalModelAnnouncedForTests,
  ANSWERER_CLAUDE_NOTICE_KEY,
  answererLocalWasAnnounced,
  answeringWasAnnounced,
  baselineAdoptionPending,
  LOCAL_MODEL_ANNOUNCED_FILE_NAME,
  recordBaselineAnswering,
  SETTINGS_CHANGED_ANSWERER_LOCAL_NOTICE,
  SETTINGS_CHANGED_NOTICE,
  SETTINGS_CHANGED_NOTICE_KEY,
} from "../../../src/server/models/local-model-announced.js";
import {
  __resetLocalModelSettingsForTests,
  isLocalModelEditingEnabled,
  primeLocalModelSettings,
  setLocalModelEditing,
} from "../../../src/server/models/local-model-settings.js";
import { LOCAL_RUN_GENERATION } from "../../../src/server/models/local-run-generation.js";
import {
  __resetModelRegistryForTests,
  getModelsEtag,
} from "../../../src/server/models/registry.js";
import {
  getBuffer,
  resetForTesting as resetNotifications,
} from "../../../src/server/notifications.js";
import {
  clearStartupNotices,
  getStartupNotices,
  markStartupNoticeDelivered,
} from "../../../src/server/startup-notices.js";
import { TAURI_HOSTNAME } from "../../../src/shared/constants.js";
import {
  API_MODELS,
  API_MODELS_CHAT_ANSWERER,
  ERROR_CODE_CHAT_ANSWERER_SUPERSEDED,
  ERROR_CODE_CHAT_ANSWERER_WRITE_FAILED,
  ERROR_CODE_INVALID_CHAT_ANSWERER,
  ERROR_CODE_OWN_WINDOW_ONLY,
  MODELS_SCHEMA_VERSION,
  type ModelsEntry,
  type ModelsFile,
} from "../../../src/shared/models/contract.js";
import { desktopSidecarPolicy } from "../../helpers/own-window-policy.js";

/**
 * Who answers chat (#1123 A1): `chat-answerer.json`, its record part in
 * `local-model-announced.json`, and `GET/POST /api/models/chat-answerer`.
 * Every case runs against a per-test temp dir. A write is failed by replacing
 * `atomicWriteConfigFile` for the named file only — never by permissions — so
 * the cases mean the same thing on Windows and POSIX.
 */
const writeControl = vi.hoisted(() => ({ fail: new Set<string>() }));

vi.mock("../../../src/server/integrations/storage.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/server/integrations/storage.js")>();
  return {
    ...actual,
    atomicWriteConfigFile: async (file: string, content: string): Promise<void> => {
      for (const name of writeControl.fail) {
        if (file.endsWith(name)) throw new Error("simulated write failure");
      }
      return actual.atomicWriteConfigFile(file, content);
    },
  };
});

let dir = "";
const switchFile = () => path.join(dir, CHAT_ANSWERER_FILE_NAME);
const writeSwitch = (obj: unknown) =>
  fs.writeFileSync(switchFile(), typeof obj === "string" ? obj : JSON.stringify(obj));

/** A fresh process: module memory forgotten, the files on disk kept. */
function restart(): void {
  __resetLocalModelSettingsForTests(dir); // also resets the announced record
  __resetChatAnswererForTests(dir);
  __resetModelRegistryForTests(dir);
  clearStartupNotices();
  resetNotifications();
}

/** The boot order of `index.ts`'s gate: editing prime (first-lit-start), then the switch. */
function prime(): void {
  primeLocalModelSettings();
  primeChatAnswerer();
}

/** Not a first lit start: the baseline marker exists, as on any install that ran lit. */
function markNotFirstLitStart(): void {
  fs.writeFileSync(path.join(dir, "local-model-baseline.json"), '{"version":1}\n');
}

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-chat-answerer-"));
  writeControl.fail.clear();
  restart();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  writeControl.fail.clear();
  await __flushLocalModelAnnouncedForTests();
  __resetChatAnswererForTests();
  __resetLocalModelSettingsForTests();
  __resetModelRegistryForTests();
  clearStartupNotices();
  resetNotifications();
  vi.restoreAllMocks();
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe("chat-answerer.json — the default is Claude (R1.1, R1.2)", () => {
  it("a new install (no file at all) reads Claude, and priming writes no switch file", () => {
    prime();
    expect(chatAnswerer()).toBe("claude");
    expect(fs.existsSync(switchFile())).toBe(false);
  });

  it("an existing install (other settings saved, no switch file) reads Claude", () => {
    fs.writeFileSync(
      path.join(dir, "local-model-settings.json"),
      JSON.stringify({ version: 1, editing: true }),
    );
    markNotFirstLitStart();
    prime();
    expect(isLocalModelEditingEnabled()).toBe(true);
    expect(chatAnswerer()).toBe("claude");
  });

  const claudeFiles: Array<[string, unknown]> = [
    ["not JSON", "{nope"],
    ["an array", "[]"],
    ["no version", { answerer: "local" }],
    ["a string version", { version: "1", answerer: "local" }],
    ["a newer version", { version: 2, answerer: "local" }],
    ["an older version", { version: 0, answerer: "local" }],
    ["answerer true", { version: 1, answerer: true }],
    ["answerer LOCAL", { version: 1, answerer: "LOCAL" }],
    ["oversized", { version: 1, answerer: "local", pad: "x".repeat(5000) }],
  ];
  for (const [label, content] of claudeFiles) {
    it(`a file that is ${label} reads Claude, and is not announced`, () => {
      markNotFirstLitStart();
      writeSwitch(content);
      prime();
      expect(chatAnswerer()).toBe("claude");
      expect(getStartupNotices()).toEqual([]);
      expect(getBuffer()).toEqual([]);
    });
  }

  it("a directory at the path reads Claude", () => {
    fs.mkdirSync(switchFile());
    prime();
    expect(chatAnswerer()).toBe("claude");
  });

  it("an unreadable file (a read that throws) reads Claude", () => {
    writeSwitch({ version: 1, answerer: "local" });
    const real = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) => {
      if (String(p).endsWith(CHAT_ANSWERER_FILE_NAME)) throw new Error("EACCES");
      return (real as (p: fs.PathOrFileDescriptor, o?: unknown) => unknown)(p, o);
    }) as typeof fs.readFileSync);
    prime();
    expect(chatAnswerer()).toBe("claude");
  });

  it("a well-formed local file reads local", () => {
    markNotFirstLitStart();
    writeSwitch({ version: 1, answerer: "local" });
    prime();
    expect(chatAnswerer()).toBe("local");
  });
});

describe("the words, not only the constants (#1123 review round 2)", () => {
  it("the allowance's local-switch notice does not claim Claude stopped answering (false until A2)", () => {
    expect(ANSWERER_LOCAL_NOTICE).not.toContain("instead of Claude");
    expect(ANSWERER_LOCAL_NOTICE).toContain("who answers your chat");
  });

  it("the start-up notice with the switch part says chat is SET to be answered by a local model", () => {
    expect(SETTINGS_CHANGED_ANSWERER_LOCAL_NOTICE).toMatch(
      /^Your chat is now set to be answered by a local model,/,
    );
    expect(SETTINGS_CHANGED_ANSWERER_LOCAL_NOTICE).toContain(
      "set who answers your chat back to Claude",
    );
  });

  it("the 'answered by Claude again' notice names the cause and the remedy", () => {
    expect(answererClaudeNotice("missing")).toBe(
      "Your chat is now answered by Claude, not by a local model as you chose, because the file that held that choice was removed. To have a local model answer it again, set who answers your chat in Settings → Models.",
    );
  });
});

describe("the dark guard (R1.4)", () => {
  it("unprimed, a stored 'local' reads Claude and the file is never opened", () => {
    writeSwitch({ version: 1, answerer: "local" });
    const lstat = vi.spyOn(fs, "lstatSync");
    const read = vi.spyOn(fs, "readFileSync");
    expect(chatAnswerer()).toBe("claude");
    const touched = [...lstat.mock.calls, ...read.mock.calls].some((c) =>
      String(c[0]).endsWith(CHAT_ANSWERER_FILE_NAME),
    );
    expect(touched).toBe(false);
  });

  it("unprimed, a switch request changes nothing and writes nothing", async () => {
    const result = await setChatAnswerer("local", "own-window");
    expect(result).toEqual({ answerer: "claude", persisted: false });
    expect(chatAnswerer()).toBe("claude");
    expect(fs.existsSync(switchFile())).toBe(false);
    expect(fs.existsSync(path.join(dir, LOCAL_MODEL_ANNOUNCED_FILE_NAME))).toBe(false);
  });
});

describe("switching (R1.1, R1.2, R2.1)", () => {
  beforeEach(() => {
    markNotFirstLitStart();
    prime();
  });

  it("own window → local: saved, effective, recorded as the user's, nothing announced", async () => {
    const seen: string[] = [];
    onChatAnswererChanged((now) => seen.push(now));
    const result = await setChatAnswerer("local", "own-window");
    expect(result).toEqual({ answerer: "local", persisted: true });
    expect(chatAnswerer()).toBe("local");
    expect(seen).toEqual(["local"]);
    expect(JSON.parse(fs.readFileSync(switchFile(), "utf8"))).toEqual({
      version: 1,
      answerer: "local",
    });
    await __flushLocalModelAnnouncedForTests();
    expect(answererLocalWasAnnounced()).toBe(true);
    expect(getBuffer()).toEqual([]);
    expect(getStartupNotices()).toEqual([]);
  });

  it("choosing local touches neither the answering fingerprint nor a pending adoption", async () => {
    recordBaselineAnswering("fp-adopted");
    await setChatAnswerer("local", "own-window");
    await __flushLocalModelAnnouncedForTests();
    expect(answeringWasAnnounced("fp-adopted")).toBe(true);
    expect(baselineAdoptionPending("fp-adopted")).toBe(true);
  });

  it("the development allowance → local: announced live and for replay", async () => {
    const result = await setChatAnswerer("local", "allowance");
    expect(result.answerer).toBe("local");
    expect(getBuffer().map((n) => n.message)).toEqual([ANSWERER_LOCAL_NOTICE]);
    expect(getStartupNotices().map((n) => n.dedupKey)).toEqual([ANSWERER_LOCAL_NOTICE_KEY]);
  });

  /** The file as JSON, or null when it is missing. */
  const onDisk = (): unknown =>
    fs.existsSync(switchFile()) ? JSON.parse(fs.readFileSync(switchFile(), "utf8")) : null;
  /** Claude as the user's own window writes it (with the marker). */
  const CLAUDE_FILE = { version: 1, answerer: "claude", setBy: "own-window" };
  /** Claude as anything else writes it (the allowance: no marker). */
  const FOREIGN_CLAUDE_FILE = { version: 1, answerer: "claude" };

  it("→ Claude: immediate (listeners told before any await), Claude on disk before the answer", async () => {
    await setChatAnswerer("local", "allowance");
    resetNotifications();
    const seen: string[] = [];
    onChatAnswererChanged((now) => seen.push(now));
    const pending = setChatAnswerer("claude", "allowance");
    // Synchronously, before the request settles:
    expect(chatAnswerer()).toBe("claude");
    expect(seen).toEqual(["claude"]);
    expect(onDisk()).toEqual(FOREIGN_CLAUDE_FILE);
    // …and the allowance's pending replay is withdrawn. The local model was
    // never the user's choice here, so nothing is announced.
    expect(getStartupNotices()).toEqual([]);
    expect(await pending).toEqual({ answerer: "claude", persisted: true });
    expect(getBuffer()).toEqual([]);
    await __flushLocalModelAnnouncedForTests();
    expect(answererLocalWasAnnounced()).toBe(false);
  });

  it("the user's own → Claude stays silent at the next start even when the record write never ran", async () => {
    await setChatAnswerer("local", "own-window");
    await __flushLocalModelAnnouncedForTests();
    writeControl.fail.add(LOCAL_MODEL_ANNOUNCED_FILE_NAME);
    await setChatAnswerer("claude", "own-window");
    await __flushLocalModelAnnouncedForTests();
    // The record on disk still says the user chose local; the file says Claude.
    restart();
    prime();
    expect(chatAnswerer()).toBe("claude");
    expect(getStartupNotices()).toEqual([]);
    expect(getBuffer()).toEqual([]);
  });

  it("→ Claude when neither the Claude write, the delete nor a read works: reported unconfirmed", async () => {
    await setChatAnswerer("local", "own-window");
    await __flushLocalModelAnnouncedForTests();
    failSyncWrite();
    vi.spyOn(fs, "rmSync").mockImplementation(() => {
      throw new Error("EPERM");
    });
    const real = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) => {
      if (String(p).endsWith(CHAT_ANSWERER_FILE_NAME)) throw new Error("EACCES");
      return (real as (p: fs.PathOrFileDescriptor, o?: unknown) => unknown)(p, o);
    }) as typeof fs.readFileSync);
    const storage = await import("../../../src/server/integrations/storage.js");
    const write = vi.spyOn(storage, "atomicWriteConfigFile");
    const result = await setChatAnswerer("claude", "own-window");
    expect(result).toEqual({ answerer: "claude", persisted: false });
    // The async overwrite was still attempted.
    expect(
      write.mock.calls.some(
        ([f, c]) => f.endsWith(CHAT_ANSWERER_FILE_NAME) && c.includes('"claude"'),
      ),
    ).toBe(true);
    expect(chatAnswerer()).toBe("claude");
  });

  it("→ Claude when the synchronous write fails: the file is deleted instead", async () => {
    await setChatAnswerer("local", "own-window");
    failSyncWrite();
    const result = await setChatAnswerer("claude", "own-window");
    expect(result).toEqual({ answerer: "claude", persisted: true });
    expect(onDisk()).toBeNull();
  });

  it("→ Claude when neither the Claude write nor the delete lands: reported unsaved", async () => {
    await setChatAnswerer("local", "own-window");
    failSyncWrite();
    vi.spyOn(fs, "rmSync").mockImplementation(() => {
      throw new Error("EPERM");
    });
    writeControl.fail.add(CHAT_ANSWERER_FILE_NAME);
    const result = await setChatAnswerer("claude", "own-window");
    expect(result).toEqual({ answerer: "claude", persisted: false });
    expect(chatAnswerer()).toBe("claude");
  });

  it("a failed local write leaves Claude, and says so", async () => {
    writeControl.fail.add(CHAT_ANSWERER_FILE_NAME);
    const result = await setChatAnswerer("local", "own-window");
    expect(result).toEqual({ answerer: "claude", persisted: false });
    expect(chatAnswerer()).toBe("claude");
    await __flushLocalModelAnnouncedForTests();
    expect(answererLocalWasAnnounced()).toBe(false);
  });

  it("a switch to Claude issued while a local write is in flight wins, on disk too", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const storage = await import("../../../src/server/integrations/storage.js");
    const real = storage.atomicWriteConfigFile;
    let held = false;
    vi.spyOn(storage, "atomicWriteConfigFile").mockImplementation(async (file, content) => {
      if (!held && file.endsWith(CHAT_ANSWERER_FILE_NAME)) {
        held = true;
        await gate;
      }
      return real(file, content);
    });
    const local = setChatAnswerer("local", "own-window");
    await new Promise((r) => setImmediate(r));
    const claude = setChatAnswerer("claude", "own-window");
    release();
    // The local request was superseded: nothing failed, and it says so.
    expect(await local).toEqual({ answerer: "claude", persisted: false, superseded: true });
    expect(await claude).toEqual({ answerer: "claude", persisted: true });
    expect(chatAnswerer()).toBe("claude");
    expect(onDisk()).toEqual(CLAUDE_FILE);
  });

  it("a newer build's file: local takes effect for this run only, unsaved and unrecorded; Claude replaces it", async () => {
    writeSwitch({ version: 2, answerer: "claude", extra: 1 });
    const local = await setChatAnswerer("local", "own-window");
    expect(local).toEqual({ answerer: "local", persisted: false });
    expect(JSON.parse(fs.readFileSync(switchFile(), "utf8"))).toEqual({
      version: 2,
      answerer: "claude",
      extra: 1,
    });
    await __flushLocalModelAnnouncedForTests();
    expect(answererLocalWasAnnounced()).toBe(false);
    await setChatAnswerer("claude", "own-window");
    expect(onDisk()).toEqual(CLAUDE_FILE);
  });

  it("a failed editing-off write leaves the switch where it was", async () => {
    await setChatAnswerer("local", "own-window");
    writeControl.fail.add("local-model-settings.json");
    await setLocalModelEditing(true, "own-window").catch(() => undefined);
    await setLocalModelEditing(false, "own-window");
    expect(chatAnswerer()).toBe("local");
    expect(JSON.parse(fs.readFileSync(switchFile(), "utf8")).answerer).toBe("local");
  });
});

describe("start-up (R1.2)", () => {
  it("a stored 'local' the record does not show as the user's raises the one start-up notice", () => {
    markNotFirstLitStart();
    writeSwitch({ version: 1, answerer: "local" });
    prime();
    expect(chatAnswerer()).toBe("local");
    expect(getStartupNotices().map((n) => n.dedupKey)).toEqual([SETTINGS_CHANGED_NOTICE_KEY]);
  });

  it("a stored 'local' at a FIRST lit start is not part of the baseline: still announced", () => {
    writeSwitch({ version: 1, answerer: "local" });
    prime();
    expect(getStartupNotices().map((n) => n.dedupKey)).toEqual([SETTINGS_CHANGED_NOTICE_KEY]);
  });

  it("the user's own choice is silent at the next start", async () => {
    markNotFirstLitStart();
    prime();
    await setChatAnswerer("local", "own-window");
    await __flushLocalModelAnnouncedForTests();
    restart();
    prime();
    expect(chatAnswerer()).toBe("local");
    expect(getStartupNotices()).toEqual([]);
  });

  it("a choice made while Tandem was stopped (the file written underneath) raises the notice", async () => {
    markNotFirstLitStart();
    prime();
    restart();
    writeSwitch({ version: 1, answerer: "local" });
    prime();
    expect(getStartupNotices().map((n) => n.dedupKey)).toEqual([SETTINGS_CHANGED_NOTICE_KEY]);
  });

  it("an own-window choice withdraws the pending start-up part for the switch", async () => {
    markNotFirstLitStart();
    writeSwitch({ version: 1, answerer: "local" });
    prime();
    expect(getStartupNotices()).toHaveLength(1);
    await setChatAnswerer("local", "own-window");
    expect(getStartupNotices()).toEqual([]);
  });

  it("Claude with nothing recorded is silent", () => {
    markNotFirstLitStart();
    prime();
    expect(getStartupNotices()).toEqual([]);
    expect(getBuffer()).toEqual([]);
  });

  it("a stored 'local' with no record: the start-up notice says chat is now answered by a local model", () => {
    markNotFirstLitStart();
    writeSwitch({ version: 1, answerer: "local" });
    prime();
    expect(getStartupNotices().map((n) => n.message)).toEqual([
      SETTINGS_CHANGED_ANSWERER_LOCAL_NOTICE,
    ]);
  });

  it("merged with commenting found on, it still says so; the user's own choice of the local model takes that part out of the text", async () => {
    markNotFirstLitStart();
    fs.writeFileSync(
      path.join(dir, "local-model-settings.json"),
      JSON.stringify({ version: 1, editing: true }),
    );
    writeSwitch({ version: 1, answerer: "local" });
    prime();
    expect(getStartupNotices().map((n) => n.message)).toEqual([
      SETTINGS_CHANGED_ANSWERER_LOCAL_NOTICE,
    ]);
    await setChatAnswerer("local", "own-window");
    expect(getStartupNotices().map((n) => n.message)).toEqual([SETTINGS_CHANGED_NOTICE]);
  });
});

const CLAUDE_FILE_OWN = { version: 1, answerer: "claude", setBy: "own-window" };
/** Make the synchronous Claude write fail (its temp file names this file). */
const failSyncWrite = (code = "EPERM") => {
  const real = fs.openSync;
  return vi.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    if (String(p).includes(CHAT_ANSWERER_FILE_NAME)) {
      throw Object.assign(new Error(code), { code });
    }
    return (real as (...a: unknown[]) => number)(p, ...rest);
  }) as typeof fs.openSync);
};

describe("chat answered by Claude again, not by the user's own choice (Bryan, 2026-11-12: announce it)", () => {
  /** The user chose the local model in Tandem's own window; then a restart. */
  async function chosenLocalThen(before: () => void): Promise<void> {
    markNotFirstLitStart();
    prime();
    await setChatAnswerer("local", "own-window");
    await __flushLocalModelAnnouncedForTests();
    restart();
    before();
  }
  const claudeAgain = () =>
    getStartupNotices().filter((n) => n.dedupKey === ANSWERER_CLAUDE_NOTICE_KEY);
  const deliver = () => {
    for (const n of claudeAgain()) markStartupNoticeDelivered(n);
  };

  const causes: Array<[string, () => void, Parameters<typeof answererClaudeNotice>[0]]> = [
    ["the file was removed", () => fs.rmSync(switchFile()), "missing"],
    ["a newer build's file", () => writeSwitch({ version: 2, answerer: "local" }), "newer"],
    ["the file was changed to garbage", () => writeSwitch("{nope"), "invalid"],
  ];
  for (const [label, cause, key] of causes) {
    it(`${label}: exactly one notice, the switch at Claude, and the record cleared once a window was told`, async () => {
      await chosenLocalThen(cause);
      prime();
      expect(chatAnswerer()).toBe("claude");
      expect(claudeAgain().map((n) => n.message)).toEqual([answererClaudeNotice(key)]);
      expect(getStartupNotices()).toHaveLength(1);
      deliver();
      await __flushLocalModelAnnouncedForTests();
      expect(answererLocalWasAnnounced()).toBe(false);
      restart();
      prime();
      expect(getStartupNotices()).toEqual([]);
    });
  }

  it("a Claude file WITHOUT the own-window marker (a process, a restore, the allowance) is announced as a change the user did not make", async () => {
    await chosenLocalThen(() => writeSwitch({ version: 1, answerer: "claude" }));
    prime();
    expect(chatAnswerer()).toBe("claude");
    expect(claudeAgain().map((n) => n.message)).toEqual([answererClaudeNotice("claude")]);
  });

  it("a Claude file WITH the own-window marker is silent and clears the record", async () => {
    await chosenLocalThen(() => writeSwitch(CLAUDE_FILE_OWN));
    prime();
    expect(chatAnswerer()).toBe("claude");
    expect(getStartupNotices()).toEqual([]);
    await __flushLocalModelAnnouncedForTests();
    expect(answererLocalWasAnnounced()).toBe(false);
  });

  it("RESIDUAL (#2410, a process running as the user): a foreign writer that copies the marker on purpose is silent", async () => {
    // Accepted, not a defect: the marker is not a secret, and such a process
    // can also rewrite the record. Pinned so a change here is deliberate.
    await chosenLocalThen(() =>
      writeSwitch({ version: 1, answerer: "claude", setBy: "own-window", forged: true }),
    );
    prime();
    expect(getStartupNotices()).toEqual([]);
  });

  it("told, not chosen (the allowance switched to local, then to Claude): no 'as you chose' notice", async () => {
    markNotFirstLitStart();
    prime();
    await setChatAnswerer("local", "allowance");
    for (const n of getStartupNotices()) markStartupNoticeDelivered(n);
    await __flushLocalModelAnnouncedForTests();
    expect(answererLocalWasAnnounced()).toBe(true); // told
    resetNotifications();
    await setChatAnswerer("claude", "allowance");
    expect(claudeAgain()).toEqual([]);
    expect(getBuffer().some((n) => n.message.includes("as you chose"))).toBe(false);
    // …and at the next start either way.
    restart();
    prime();
    expect(getStartupNotices()).toEqual([]);
  });

  it("told, not chosen (a stray 'local' found at start-up, then the file deleted): no 'as you chose' notice", async () => {
    markNotFirstLitStart();
    writeSwitch({ version: 1, answerer: "local" });
    prime();
    for (const n of getStartupNotices()) markStartupNoticeDelivered(n);
    await __flushLocalModelAnnouncedForTests();
    expect(answererLocalWasAnnounced()).toBe(true); // told
    fs.rmSync(switchFile());
    restart();
    prime();
    expect(chatAnswerer()).toBe("claude");
    expect(getStartupNotices()).toEqual([]);
    expect(getBuffer()).toEqual([]);
  });

  it("any switch back to the local model withdraws a waiting notice, so a window that connects later is not sent it", async () => {
    await chosenLocalThen(() => fs.rmSync(switchFile()));
    prime();
    expect(claudeAgain()).toHaveLength(1);
    // Back to local through the allowance, not the user's own window.
    await setChatAnswerer("local", "allowance");
    expect(chatAnswerer()).toBe("local");
    expect(claudeAgain()).toEqual([]);
    // What a late window would be replayed: no "answered by Claude again".
    expect(getStartupNotices().some((n) => n.message.includes("answered by Claude"))).toBe(false);
  });

  it("measured (round 3 #2): chosen local, then the allowance switches to Claude with no window connected, then a restart — the notice is raised again", async () => {
    markNotFirstLitStart();
    prime();
    await setChatAnswerer("local", "own-window");
    await __flushLocalModelAnnouncedForTests();
    await setChatAnswerer("claude", "allowance");
    await __flushLocalModelAnnouncedForTests();
    expect(claudeAgain().map((n) => n.message)).toEqual([answererClaudeNotice("allowance")]);
    restart();
    prime();
    expect(chatAnswerer()).toBe("claude");
    expect(claudeAgain().map((n) => n.message)).toEqual([answererClaudeNotice("allowance")]);
    // Delivered to a window: then, and only then, it is spent.
    deliver();
    await __flushLocalModelAnnouncedForTests();
    restart();
    prime();
    expect(getStartupNotices()).toEqual([]);
  });

  it("measured (round 3 #3): the user's own → Claude with ENOSPC on the write, the delete working and the record write failing — reported unsaved", async () => {
    markNotFirstLitStart();
    prime();
    await setChatAnswerer("local", "own-window");
    await __flushLocalModelAnnouncedForTests();
    failSyncWrite("ENOSPC");
    writeControl.fail.add(CHAT_ANSWERER_FILE_NAME); // the async last resort too
    writeControl.fail.add(LOCAL_MODEL_ANNOUNCED_FILE_NAME);
    const result = await setChatAnswerer("claude", "own-window");
    expect(chatAnswerer()).toBe("claude");
    expect(fs.existsSync(switchFile())).toBe(false);
    expect(result).toEqual({ answerer: "claude", persisted: false });
    // Through a restart: the record still says "chosen" and the file is gone,
    // which reads as removed. The route said it was not saved; that is the
    // honest answer it can give.
    await __flushLocalModelAnnouncedForTests();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeControl.fail.clear();
    restart();
    prime();
    expect(chatAnswerer()).toBe("claude");
    expect(claudeAgain().map((n) => n.message)).toEqual([answererClaudeNotice("missing")]);
  });

  it("the same with the record write working: saved, and silent at the next start", async () => {
    markNotFirstLitStart();
    prime();
    await setChatAnswerer("local", "own-window");
    await __flushLocalModelAnnouncedForTests();
    failSyncWrite("ENOSPC");
    const result = await setChatAnswerer("claude", "own-window");
    expect(result).toEqual({ answerer: "claude", persisted: true });
    expect(fs.existsSync(switchFile())).toBe(false);
    await __flushLocalModelAnnouncedForTests();
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    restart();
    prime();
    expect(getStartupNotices()).toEqual([]);
  });

  it("a failed local write leaves a Claude file where it was (round 3 L2)", async () => {
    markNotFirstLitStart();
    prime();
    await setChatAnswerer("claude", "own-window");
    expect(JSON.parse(fs.readFileSync(switchFile(), "utf8"))).toEqual(CLAUDE_FILE_OWN);
    writeControl.fail.add(CHAT_ANSWERER_FILE_NAME);
    await setChatAnswerer("local", "own-window");
    expect(JSON.parse(fs.readFileSync(switchFile(), "utf8"))).toEqual(CLAUDE_FILE_OWN);
  });

  it("told, not chosen, then a read that fails at start-up: the record is KEPT, so the next clean 'local' start is silent (round 3 L3)", async () => {
    markNotFirstLitStart();
    writeSwitch({ version: 1, answerer: "local" });
    prime();
    for (const n of getStartupNotices()) markStartupNoticeDelivered(n);
    await __flushLocalModelAnnouncedForTests();
    expect(answererLocalWasAnnounced()).toBe(true); // told
    restart();
    const real = fs.readFileSync;
    const read = vi.spyOn(fs, "readFileSync").mockImplementation(((
      p: fs.PathOrFileDescriptor,
      o?: unknown,
    ) => {
      if (String(p).endsWith(CHAT_ANSWERER_FILE_NAME)) throw new Error("EBUSY");
      return (real as (p: fs.PathOrFileDescriptor, o?: unknown) => unknown)(p, o);
    }) as typeof fs.readFileSync);
    prime();
    read.mockRestore();
    expect(chatAnswerer()).toBe("claude");
    expect(getStartupNotices()).toEqual([]); // told only: nothing to say
    await __flushLocalModelAnnouncedForTests();
    expect(answererLocalWasAnnounced()).toBe(true);
    restart();
    prime();
    expect(chatAnswerer()).toBe("local");
    expect(getStartupNotices()).toEqual([]);
  });

  it("not yet told when Tandem stops: announced again at the next start", async () => {
    await chosenLocalThen(() => fs.rmSync(switchFile()));
    prime();
    expect(claudeAgain()).toHaveLength(1);
    restart();
    prime();
    expect(claudeAgain()).toHaveLength(1);
  });

  it("a read that fails at start-up (transient): Claude for this run, announced, the record KEPT — the next clean read of 'local' restores the choice with no warning", async () => {
    await chosenLocalThen(() => {});
    const real = fs.readFileSync;
    const read = vi.spyOn(fs, "readFileSync").mockImplementation(((
      p: fs.PathOrFileDescriptor,
      o?: unknown,
    ) => {
      if (String(p).endsWith(CHAT_ANSWERER_FILE_NAME)) throw new Error("EBUSY");
      return (real as (p: fs.PathOrFileDescriptor, o?: unknown) => unknown)(p, o);
    }) as typeof fs.readFileSync);
    prime();
    read.mockRestore();
    expect(chatAnswerer()).toBe("claude");
    expect(claudeAgain().map((n) => n.message)).toEqual([answererClaudeNotice("unreadable")]);
    deliver();
    await __flushLocalModelAnnouncedForTests();
    expect(answererLocalWasAnnounced()).toBe(true);
    restart();
    prime();
    expect(chatAnswerer()).toBe("local");
    expect(getStartupNotices()).toEqual([]);
  });

  it("a switch to Claude through the development allowance: one notice; the user's own switch to Claude: none", async () => {
    markNotFirstLitStart();
    prime();
    await setChatAnswerer("local", "own-window");
    await __flushLocalModelAnnouncedForTests();
    await setChatAnswerer("claude", "allowance");
    expect(chatAnswerer()).toBe("claude");
    expect(claudeAgain().map((n) => n.message)).toEqual([answererClaudeNotice("allowance")]);
    expect(getBuffer().map((n) => n.message)).toEqual([answererClaudeNotice("allowance")]);

    resetNotifications();
    clearStartupNotices();
    await setChatAnswerer("local", "own-window");
    await __flushLocalModelAnnouncedForTests();
    await setChatAnswerer("claude", "own-window");
    expect(getStartupNotices()).toEqual([]);
    expect(getBuffer()).toEqual([]);
  });

  it("choosing the local model again in Tandem's own window withdraws a waiting notice", async () => {
    await chosenLocalThen(() => fs.rmSync(switchFile()));
    prime();
    expect(claudeAgain()).toHaveLength(1);
    await setChatAnswerer("local", "own-window");
    expect(claudeAgain()).toEqual([]);
  });
});

// --- routes -----------------------------------------------------------------

const OWN = `http://${TAURI_HOSTNAME}`;
const passthrough = (_req: Request, _res: Response, next: NextFunction) => next();
const servers: Server[] = [];

function makeApp(over: Partial<ModelsRoutesDeps> & { live?: boolean } = {}): Express {
  const app = express();
  app.use(express.json());
  const { live, ...rest } = over;
  registerModelsRoutes(app, passthrough, passthrough, {
    ownWindow: desktopSidecarPolicy(),
    keychain: createKeychain({
      service: KEYCHAIN_SERVICE_MODELS,
      backend: { get: () => null, set: () => {}, delete: () => false },
    }),
    localModelSettingsEnabled: live ?? true,
    ...rest,
  });
  return app;
}

async function listen(app: Express): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  const a = server.address();
  if (typeof a !== "object" || a === null) throw new Error("no address");
  return `http://127.0.0.1:${a.port}`;
}

async function call(
  base: string,
  method: "GET" | "POST",
  url: string,
  opts: { json?: unknown; origin?: string | null; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.origin !== null) headers.Origin = opts.origin ?? OWN;
  let body: string | undefined;
  if ("json" in opts) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  const res = await fetch(`${base}${url}`, { method, headers, body });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe(`${API_MODELS_CHAT_ANSWERER} (R1.3)`, () => {
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => resolve());
            s.closeAllConnections();
          }),
      ),
    );
  });

  beforeEach(() => {
    markNotFirstLitStart();
    prime();
  });

  it("GET answers the switch, whether a local model resolves now (through the injected seam), and the run id", async () => {
    let resolves = false;
    const base = await listen(makeApp({ localModelResolvesNow: () => resolves }));
    expect((await call(base, "GET", API_MODELS_CHAT_ANSWERER)).body).toEqual({
      answerer: "claude",
      localModelResolves: false,
      runGeneration: LOCAL_RUN_GENERATION,
    });
    resolves = true;
    const res = await call(base, "GET", API_MODELS_CHAT_ANSWERER);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      answerer: "claude",
      localModelResolves: true,
      runGeneration: LOCAL_RUN_GENERATION,
    });
  });

  it("GET with no seam at all answers that no local model resolves", async () => {
    const base = await listen(makeApp());
    expect((await call(base, "GET", API_MODELS_CHAT_ANSWERER)).body).toMatchObject({
      localModelResolves: false,
    });
  });

  it("GET is refused to another origin, and to a request with neither an Origin nor Sec-Fetch-Site: same-origin", async () => {
    const base = await listen(makeApp({ localModelResolvesNow: () => true }));
    const foreign = await call(base, "GET", API_MODELS_CHAT_ANSWERER, {
      origin: "http://127.0.0.1:9999",
    });
    expect(foreign.status).toBe(403);
    expect(foreign.body).toMatchObject({ code: ERROR_CODE_OWN_WINDOW_ONLY });
    const bare = await call(base, "GET", API_MODELS_CHAT_ANSWERER, { origin: null });
    expect(bare.status).toBe(403);
    const sameOrigin = await call(base, "GET", API_MODELS_CHAT_ANSWERER, {
      origin: null,
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    expect(sameOrigin.status).toBe(200);
  });

  it("POST from Tandem's own window switches; the GET follows", async () => {
    const base = await listen(makeApp());
    const post = await call(base, "POST", API_MODELS_CHAT_ANSWERER, {
      json: { answerer: "local" },
    });
    expect(post).toEqual({ status: 200, body: { answerer: "local", persisted: true } });
    expect((await call(base, "GET", API_MODELS_CHAT_ANSWERER)).body).toMatchObject({
      answerer: "local",
    });
    const back = await call(base, "POST", API_MODELS_CHAT_ANSWERER, {
      json: { answerer: "claude" },
    });
    expect(back).toEqual({ status: 200, body: { answerer: "claude", persisted: true } });
  });

  it("POST from another origin is refused, for local and for Claude alike, and changes nothing", async () => {
    const base = await listen(makeApp());
    for (const answerer of ["local", "claude"]) {
      const res = await call(base, "POST", API_MODELS_CHAT_ANSWERER, {
        json: { answerer },
        origin: "http://127.0.0.1:5173",
      });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: ERROR_CODE_OWN_WINDOW_ONLY });
    }
    expect(chatAnswerer()).toBe("claude");
    expect(fs.existsSync(switchFile())).toBe(false);
  });

  it("POST validates its body and coerces nothing", async () => {
    const base = await listen(makeApp());
    for (const json of [{}, { answerer: "LOCAL" }, { answerer: true }, { answerer: ["local"] }]) {
      const res = await call(base, "POST", API_MODELS_CHAT_ANSWERER, { json });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: ERROR_CODE_INVALID_CHAT_ANSWERER });
    }
    expect(chatAnswerer()).toBe("claude");
  });

  it("a local request superseded by a later Claude request answers 409 SUPERSEDED, not a write failure", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const storage = await import("../../../src/server/integrations/storage.js");
    const real = storage.atomicWriteConfigFile;
    let held = false;
    vi.spyOn(storage, "atomicWriteConfigFile").mockImplementation(async (file, content) => {
      if (!held && file.endsWith(CHAT_ANSWERER_FILE_NAME)) {
        held = true;
        await gate;
      }
      return real(file, content);
    });
    const base = await listen(makeApp());
    const local = call(base, "POST", API_MODELS_CHAT_ANSWERER, { json: { answerer: "local" } });
    while (!held) await new Promise((r) => setImmediate(r));
    const claude = call(base, "POST", API_MODELS_CHAT_ANSWERER, { json: { answerer: "claude" } });
    await new Promise((r) => setImmediate(r));
    release();
    expect(await local).toEqual({
      status: 409,
      body: { answerer: "claude", persisted: false, code: ERROR_CODE_CHAT_ANSWERER_SUPERSEDED },
    });
    expect(await claude).toEqual({ status: 200, body: { answerer: "claude", persisted: true } });
  });

  it("a failed write answers 500 with the effective value", async () => {
    writeControl.fail.add(CHAT_ANSWERER_FILE_NAME);
    const base = await listen(makeApp());
    const res = await call(base, "POST", API_MODELS_CHAT_ANSWERER, { json: { answerer: "local" } });
    expect(res).toEqual({
      status: 500,
      body: { answerer: "claude", persisted: false, code: ERROR_CODE_CHAT_ANSWERER_WRITE_FAILED },
    });
  });

  it("dark: GET and POST answer 404 and touch nothing", async () => {
    const base = await listen(makeApp({ live: false }));
    expect((await call(base, "GET", API_MODELS_CHAT_ANSWERER)).status).toBe(404);
    expect(
      (await call(base, "POST", API_MODELS_CHAT_ANSWERER, { json: { answerer: "local" } })).status,
    ).toBe(404);
    expect(fs.existsSync(switchFile())).toBe(false);
  });

  it("saving, editing, defaulting, disabling and deleting a model never changes the switch", async () => {
    const base = await listen(makeApp());
    const entry: ModelsEntry = {
      id: "m-1",
      provider: "local-ollama",
      displayName: "Local",
      modelId: "qwen",
      endpoint: "http://127.0.0.1:11434",
      enabled: true,
    };
    const save = async (file: ModelsFile) => {
      const res = await call(base, "POST", API_MODELS, {
        json: { file, ifMatch: getModelsEtag() },
      });
      expect(res.status).toBe(200);
      expect(chatAnswerer()).toBe("claude");
      expect(fs.existsSync(switchFile())).toBe(false);
    };
    const files: ModelsFile[] = [
      { schemaVersion: MODELS_SCHEMA_VERSION, defaultModelId: null, models: [entry] }, // saved
      {
        schemaVersion: MODELS_SCHEMA_VERSION,
        defaultModelId: null,
        models: [{ ...entry, modelId: "llama" }],
      }, // edited
      {
        schemaVersion: MODELS_SCHEMA_VERSION,
        defaultModelId: "m-1",
        models: [{ ...entry, modelId: "llama" }],
      }, // defaulted
      {
        schemaVersion: MODELS_SCHEMA_VERSION,
        defaultModelId: "m-1",
        models: [{ ...entry, enabled: false }],
      }, // disabled
      { schemaVersion: MODELS_SCHEMA_VERSION, defaultModelId: null, models: [] }, // deleted
    ];
    for (const f of files) await save(f);
    // And with the local model chosen, the same writes leave it chosen.
    await setChatAnswerer("local", "own-window");
    for (const f of files) {
      const res = await call(base, "POST", API_MODELS, {
        json: { file: f, ifMatch: getModelsEtag() },
      });
      expect(res.status).toBe(200);
      expect(chatAnswerer()).toBe("local");
    }
  });
});
