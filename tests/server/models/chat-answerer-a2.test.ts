/**
 * Who answers chat, part A2's items carried from A1's last review (#1123,
 * R7.1–R7.5). Every case runs against a per-test temp dir; a write is failed by
 * replacing the call for the named file only — never by permissions — so the
 * cases mean the same on Windows and POSIX. The links used are HARD links,
 * which Windows (NTFS) creates without a privilege, so those cases run there
 * too; the one symbolic-link case is gated off Windows (creating one there
 * needs a privilege CI does not have) and its logic — a link at the marker
 * path counts as the marker — is platform-neutral.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetChatAnswererForTests,
  CHAT_ANSWERER_FILE_NAME,
  chatAnswerer,
  onChatAnswererChanged,
  primeChatAnswerer,
  type SetChatAnswererResult,
  setChatAnswerer,
} from "../../../src/server/models/chat-answerer.js";
import {
  __flushLocalModelAnnouncedForTests,
  answererLocalWasChosen,
  LOCAL_MODEL_ANNOUNCED_FILE_NAME,
  retryUnsavedRecord,
  SETTINGS_CHANGED_ANSWERER_LOCAL_NOTICE,
} from "../../../src/server/models/local-model-announced.js";
import {
  __resetLocalModelSettingsForTests,
  primeLocalModelSettings,
} from "../../../src/server/models/local-model-settings.js";
import { __resetModelRegistryForTests } from "../../../src/server/models/registry.js";
import { resetForTesting as resetNotifications } from "../../../src/server/notifications.js";
import { clearStartupNotices, getStartupNotices } from "../../../src/server/startup-notices.js";

/**
 * The async config writes: `fail` and `decide` fail one; `before` runs while
 * the write is in flight (after the caller has awaited into it), which is
 * where a test issues an overlapping request.
 */
const writeControl = vi.hoisted(() => ({
  fail: new Set<string>(),
  decide: null as null | ((file: string, content: string) => boolean),
  before: null as null | ((file: string) => void),
  after: null as null | ((file: string) => void),
  /** The generated runs: write without fsync (still temp file + rename), so
   *  a seed costs no disk flushes — Windows is slow at those (round 2). */
  fast: false,
}));

vi.mock("../../../src/server/integrations/storage.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/server/integrations/storage.js")>();
  return {
    ...actual,
    atomicWriteConfigFile: async (file: string, content: string): Promise<void> => {
      await Promise.resolve();
      writeControl.before?.(file);
      for (const name of writeControl.fail) {
        if (file.endsWith(name)) throw new Error("simulated write failure");
      }
      if (writeControl.decide?.(file, content)) throw new Error("simulated write failure");
      if (writeControl.fast) {
        const tmp = `${file}.${Math.random().toString(36).slice(2)}.gen.tmp`;
        await fs.promises.writeFile(tmp, content);
        await fs.promises.rename(tmp, file);
      } else {
        await actual.atomicWriteConfigFile(file, content);
      }
      // The write has landed and the caller's await has not resumed yet.
      writeControl.after?.(file);
    },
  };
});

let dir = "";
let generating: Promise<void> | null = null;
let stopGenerating = false;
const switchFile = () => path.join(dir, CHAT_ANSWERER_FILE_NAME);
const markerFile = () => path.join(dir, `.${CHAT_ANSWERER_FILE_NAME}.removed-by-tandem`);
const recordFile = () => path.join(dir, LOCAL_MODEL_ANNOUNCED_FILE_NAME);
const CLAUDE_OWN = { version: 1, answerer: "claude", setBy: "own-window" };
const isSwitch = (f: unknown) => String(f).endsWith(CHAT_ANSWERER_FILE_NAME);
const isRecord = (f: unknown) => String(f).endsWith(LOCAL_MODEL_ANNOUNCED_FILE_NAME);

function restart(): void {
  __resetLocalModelSettingsForTests(dir);
  __resetChatAnswererForTests(dir);
  __resetModelRegistryForTests(dir);
  clearStartupNotices();
  resetNotifications();
}

function prime(): void {
  primeLocalModelSettings();
  primeChatAnswerer();
}

/** Prime with the switch file's read failing once (a scanner holding it). */
function primeWithFailedRead(): void {
  const real = fs.readFileSync;
  const read = vi.spyOn(fs, "readFileSync").mockImplementation(((
    p: fs.PathOrFileDescriptor,
    o?: unknown,
  ) => {
    if (isSwitch(p)) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    return (real as (p: fs.PathOrFileDescriptor, o?: unknown) => unknown)(p, o);
  }) as typeof fs.readFileSync);
  prime();
  read.mockRestore();
}

function markNotFirstLitStart(): void {
  fs.writeFileSync(path.join(dir, "local-model-baseline.json"), '{"version":1}\n');
}

/** What the next start would read: only a parsed "local" answers locally. */
function diskAnswerer(): "local" | "claude" {
  try {
    const obj = JSON.parse(fs.readFileSync(switchFile(), "utf8"));
    return obj?.version === 1 && obj?.answerer === "local" ? "local" : "claude";
  } catch {
    return "claude";
  }
}

function diskJson(): unknown {
  try {
    return JSON.parse(fs.readFileSync(switchFile(), "utf8"));
  } catch {
    return null;
  }
}

const quietConsole = () => vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-chat-answerer-a2-"));
  writeControl.fail.clear();
  writeControl.decide = null;
  writeControl.before = null;
  writeControl.after = null;
  restart();
  quietConsole();
});

afterEach(async () => {
  // A generated run that outlived its test (a timeout) stops at its next seed
  // and is waited for, so its writes cannot land in the directory removed
  // below (round 2: ENOTEMPTY on Windows).
  stopGenerating = true;
  await generating?.catch(() => {});
  generating = null;
  stopGenerating = false;
  writeControl.fast = false;
  writeControl.fail.clear();
  writeControl.decide = null;
  writeControl.before = null;
  writeControl.after = null;
  vi.restoreAllMocks();
  await __flushLocalModelAnnouncedForTests();
  __resetChatAnswererForTests();
  __resetLocalModelSettingsForTests();
  __resetModelRegistryForTests();
  clearStartupNotices();
  resetNotifications();
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe("R7.1: a failed record write fails the user's own switch to the local model for real", () => {
  it("Claude stays in effect and on disk, the response says so, and nothing switches at the next start", async () => {
    markNotFirstLitStart();
    prime();
    await setChatAnswerer("claude", "own-window");
    await __flushLocalModelAnnouncedForTests();
    const heard: string[] = [];
    onChatAnswererChanged((now) => heard.push(now));
    writeControl.fail.add(LOCAL_MODEL_ANNOUNCED_FILE_NAME);
    const result = await setChatAnswerer("local", "own-window");
    expect(result).toEqual({ answerer: "claude", persisted: false });
    expect(chatAnswerer()).toBe("claude");
    expect(heard).toEqual([]);
    expect(diskJson()).toEqual(CLAUDE_OWN);
    writeControl.fail.clear();
    await __flushLocalModelAnnouncedForTests();
    restart();
    prime();
    expect(chatAnswerer()).toBe("claude");
    expect(getStartupNotices()).toEqual([]);
  });

  it("a fresh install: a refused switch leaves nothing in memory a later record write could persist — no notice at the next start", async () => {
    markNotFirstLitStart();
    prime(); // no switch file at all
    writeControl.fail.add(LOCAL_MODEL_ANNOUNCED_FILE_NAME);
    expect(await setChatAnswerer("local", "own-window")).toEqual({
      answerer: "claude",
      persisted: false,
    });
    writeControl.fail.clear();
    expect(answererLocalWasChosen()).toBe(false);
    // Any other record write in the run (here, the retry of the failed one).
    retryUnsavedRecord();
    await __flushLocalModelAnnouncedForTests();
    if (fs.existsSync(recordFile())) {
      expect(JSON.parse(fs.readFileSync(recordFile(), "utf8")).answererChosen).toBeUndefined();
    }
    restart();
    prime();
    expect(chatAnswerer()).toBe("claude");
    expect(getStartupNotices()).toEqual([]);
  });

  it("L1 records its choice, L2 arrives during that write and its own record write fails: the record does not say 'chosen' once they settle", async () => {
    markNotFirstLitStart();
    prime();
    let recordWrites = 0;
    let l2: Promise<SetChatAnswererResult> | null = null;
    writeControl.before = (file) => {
      if (!isRecord(file)) return;
      recordWrites += 1;
      if (recordWrites === 1) l2 = setChatAnswerer("local", "own-window");
    };
    // Fail L2's own record write: the second write that records a choice.
    let choiceWrites = 0;
    writeControl.decide = (file, content) =>
      isRecord(file) && content.includes('"answererChosen": true') && ++choiceWrites === 2;
    const l1 = setChatAnswerer("local", "own-window");
    await l1;
    const r2 = await (l2 as unknown as Promise<SetChatAnswererResult>);
    writeControl.before = null;
    writeControl.decide = null;
    await __flushLocalModelAnnouncedForTests();
    expect(r2.persisted).toBe(false);
    expect(chatAnswerer()).toBe("claude");
    expect(answererLocalWasChosen()).toBe(false);
    restart();
    prime();
    expect(chatAnswerer()).toBe("claude");
    expect(getStartupNotices()).toEqual([]);
  });

  it("re-review B1-R: an allowance switch to Claude during the user's RE-choice of an already chosen local model is still announced", async () => {
    markNotFirstLitStart();
    prime();
    expect((await setChatAnswerer("local", "own-window")).persisted).toBe(true);
    await __flushLocalModelAnnouncedForTests();
    let claude: Promise<SetChatAnswererResult> | null = null;
    writeControl.before = (file) => {
      if (isRecord(file) && claude === null) claude = setChatAnswerer("claude", "allowance");
    };
    await setChatAnswerer("local", "own-window"); // the re-choice, superseded
    await (claude as unknown as Promise<SetChatAnswererResult>);
    writeControl.before = null;
    await __flushLocalModelAnnouncedForTests();
    expect(chatAnswerer()).toBe("claude");
    // No window of Tandem's was connected: the notice must still be owed.
    restart();
    prime();
    expect(JSON.stringify(getStartupNotices())).toContain("now answered by Claude");
  });

  for (const source of ["allowance", "own-window"] as const) {
    it(`re-review B1: a Claude request (${source}) arriving while an own-window switch records its choice — the record never says 'chosen' once they settle`, async () => {
      markNotFirstLitStart();
      prime();
      let claude: Promise<SetChatAnswererResult> | null = null;
      writeControl.before = (file) => {
        if (isRecord(file) && claude === null) claude = setChatAnswerer("claude", source);
      };
      await setChatAnswerer("local", "own-window");
      await (claude as unknown as Promise<SetChatAnswererResult>);
      writeControl.before = null;
      await __flushLocalModelAnnouncedForTests();
      expect(chatAnswerer()).toBe("claude");
      expect(answererLocalWasChosen()).toBe(false);
      restart();
      prime();
      expect(chatAnswerer()).toBe("claude");
      expect(getStartupNotices()).toEqual([]);
    });
  }

  it("round-2 item 2, one failure: an allowance switch to Claude during the user's own switch's record write, whose withdrawal then fails — no 'answered by Claude' at the next start", async () => {
    markNotFirstLitStart();
    prime();
    let claude: Promise<SetChatAnswererResult> | null = null;
    const contents: string[] = [];
    writeControl.before = (file) => {
      if (isRecord(file) && claude === null) claude = setChatAnswerer("claude", "allowance");
    };
    // Record writes, in order: the choice (lands), the allowance request's
    // queued retry (written as the record stands then: "chosen"), the
    // superseded choice's withdrawal (fails).
    writeControl.decide = (file, content) => {
      if (!isRecord(file)) return false;
      contents.push(content);
      return contents.length === 3;
    };
    const local = await setChatAnswerer("local", "own-window");
    const result = await (claude as unknown as Promise<SetChatAnswererResult>);
    writeControl.before = null;
    writeControl.decide = null;
    await __flushLocalModelAnnouncedForTests();
    // The sequence the review reproduced.
    expect(contents[0]).toContain('"answererChosen": true');
    expect(contents[1]).toContain('"answererChosen": true');
    expect(contents[2]).not.toContain('"answererChosen"');
    expect(local.superseded).toBe(true);
    expect(result).toEqual({ answerer: "claude", persisted: true });
    expect(JSON.parse(fs.readFileSync(recordFile(), "utf8")).answererChosen).toBeUndefined();
    restart();
    prime();
    expect(chatAnswerer()).toBe("claude");
    expect(getStartupNotices()).toEqual([]);
  });

  it("round-2 item 2, two failures, own-window requests only: L1's withdrawal and L2's record write both fail — no 'answered by Claude' at the next start", async () => {
    markNotFirstLitStart();
    prime();
    let l2: Promise<SetChatAnswererResult> | null = null;
    let recordWrites = 0;
    writeControl.before = (file) => {
      if (isRecord(file) && ++recordWrites === 1) l2 = setChatAnswerer("local", "own-window");
    };
    // Record writes: L1's choice (lands), L1's withdrawal (fails), L2's choice
    // (fails), then the clear L2's refusal makes.
    const contents: string[] = [];
    writeControl.decide = (file, content) => {
      if (!isRecord(file)) return false;
      contents.push(content);
      return contents.length === 2 || contents.length === 3;
    };
    const l1 = await setChatAnswerer("local", "own-window");
    const r2 = await (l2 as unknown as Promise<SetChatAnswererResult>);
    writeControl.before = null;
    writeControl.decide = null;
    await __flushLocalModelAnnouncedForTests();
    expect(contents[0]).toContain('"answererChosen": true');
    expect(contents[1]).not.toContain('"answererChosen"');
    expect(contents[2]).toContain('"answererChosen": true');
    expect(l1.superseded).toBe(true);
    expect(r2.persisted).toBe(false);
    expect(chatAnswerer()).toBe("claude");
    expect(diskAnswerer()).toBe("claude");
    expect(JSON.parse(fs.readFileSync(recordFile(), "utf8")).answererChosen).toBeUndefined();
    restart();
    prime();
    expect(chatAnswerer()).toBe("claude");
    expect(getStartupNotices()).toEqual([]);
  });

  it("round-2 item 2: when the allowance request's own re-check write fails too, its response says unsaved", async () => {
    markNotFirstLitStart();
    prime();
    let claude: Promise<SetChatAnswererResult> | null = null;
    writeControl.before = (file) => {
      if (isRecord(file) && claude === null) claude = setChatAnswerer("claude", "allowance");
    };
    let recordWrites = 0;
    writeControl.decide = (file) => isRecord(file) && ++recordWrites >= 3;
    await setChatAnswerer("local", "own-window");
    const result = await (claude as unknown as Promise<SetChatAnswererResult>);
    writeControl.before = null;
    writeControl.decide = null;
    expect(result.persisted).toBe(false);
  });

  it("the announcement cannot go silent: chosen earlier, a refused re-choice, then a program sets Claude — the next start announces", async () => {
    markNotFirstLitStart();
    prime();
    expect(await setChatAnswerer("local", "own-window")).toEqual({
      answerer: "local",
      persisted: true,
    });
    await __flushLocalModelAnnouncedForTests();
    writeControl.fail.add(LOCAL_MODEL_ANNOUNCED_FILE_NAME);
    expect((await setChatAnswerer("local", "own-window")).persisted).toBe(false);
    writeControl.fail.clear();
    expect(chatAnswerer()).toBe("local");
    await __flushLocalModelAnnouncedForTests();
    fs.writeFileSync(switchFile(), JSON.stringify({ version: 1, answerer: "claude" }));
    restart();
    prime();
    expect(chatAnswerer()).toBe("claude");
    expect(getStartupNotices().length).toBe(1);
  });
});

describe("review item 1: a refused switch changes nothing the record or the notices hold", () => {
  it("a waiting start-up notice for a stored 'local model' survives the user's refused re-choice", async () => {
    markNotFirstLitStart();
    fs.writeFileSync(switchFile(), JSON.stringify({ version: 1, answerer: "local" }));
    prime(); // a stored local model the record does not show: the start-up notice
    expect(getStartupNotices().length).toBe(1);
    writeControl.fail.add(LOCAL_MODEL_ANNOUNCED_FILE_NAME);
    expect((await setChatAnswerer("local", "own-window")).persisted).toBe(false);
    expect(getStartupNotices().length).toBe(1);
    expect(answererLocalWasChosen()).toBe(false);
  });
});

describe("a superseded local request writes nothing", () => {
  it("two local requests issued together: only the latest writes the switch file", async () => {
    markNotFirstLitStart();
    prime();
    let switchWrites = 0;
    writeControl.before = (file) => {
      if (isSwitch(file)) switchWrites += 1;
    };
    await Promise.all([
      setChatAnswerer("local", "own-window"),
      setChatAnswerer("local", "own-window"),
    ]);
    expect(switchWrites).toBe(1);
    expect(chatAnswerer()).toBe("local");
  });
});

describe("review item 9: a local write that landed but cannot be read back", () => {
  it("is what the disk says: the local model takes effect, so a restart does not flip who answers", async () => {
    markNotFirstLitStart();
    prime();
    const realRead = fs.readFileSync;
    let wrote = false;
    writeControl.before = (file) => {
      if (isSwitch(file)) wrote = true;
    };
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) => {
      if (wrote && isSwitch(p)) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      return (realRead as (p: fs.PathOrFileDescriptor, o?: unknown) => unknown)(p, o);
    }) as typeof fs.readFileSync);
    const result = await setChatAnswerer("local", "own-window");
    vi.restoreAllMocks();
    quietConsole();
    expect(result).toEqual({ answerer: "local", persisted: true });
    expect(chatAnswerer()).toBe("local");
    expect(diskAnswerer()).toBe("local");
    await __flushLocalModelAnnouncedForTests();
    restart();
    prime();
    expect(chatAnswerer()).toBe("local");
    expect(getStartupNotices()).toEqual([]);
  });
});

describe("R7.5 / review item 25: the user's mark is kept, and never invented, when a refused switch puts Claude back", () => {
  it("after a start that read the user's marked Claude, a refused own switch puts the MARK back", async () => {
    markNotFirstLitStart();
    prime();
    await setChatAnswerer("claude", "own-window");
    await __flushLocalModelAnnouncedForTests();
    restart();
    prime();
    writeControl.fail.add(LOCAL_MODEL_ANNOUNCED_FILE_NAME);
    await setChatAnswerer("local", "own-window");
    expect(diskJson()).toEqual(CLAUDE_OWN);
  });

  it("over a program's unmarked Claude, a refused own switch puts back Claude WITHOUT the mark", async () => {
    markNotFirstLitStart();
    fs.writeFileSync(switchFile(), JSON.stringify({ version: 1, answerer: "claude" }));
    prime();
    writeControl.fail.add(LOCAL_MODEL_ANNOUNCED_FILE_NAME);
    await setChatAnswerer("local", "own-window");
    expect(diskJson()).toEqual({ version: 1, answerer: "claude" });
  });

  it("round-2 item 7: the user's own Claude, then a program's unmarked Claude — a refused own switch puts back Claude WITHOUT the mark", async () => {
    markNotFirstLitStart();
    prime();
    await setChatAnswerer("claude", "own-window");
    await __flushLocalModelAnnouncedForTests();
    expect(diskJson()).toEqual(CLAUDE_OWN);
    fs.writeFileSync(switchFile(), JSON.stringify({ version: 1, answerer: "claude" }));
    writeControl.fail.add(LOCAL_MODEL_ANNOUNCED_FILE_NAME);
    expect((await setChatAnswerer("local", "own-window")).persisted).toBe(false);
    expect(diskJson()).toEqual({ version: 1, answerer: "claude" });
  });

  it("a start-up read that failed over the user's marked Claude: a refused own switch still keeps their mark", async () => {
    markNotFirstLitStart();
    prime();
    await setChatAnswerer("claude", "own-window");
    await __flushLocalModelAnnouncedForTests();
    restart();
    primeWithFailedRead();
    writeControl.fail.add(LOCAL_MODEL_ANNOUNCED_FILE_NAME);
    await setChatAnswerer("local", "own-window");
    expect(diskJson()).toEqual(CLAUDE_OWN);
  });
});

describe("R7.3 / R7.4: Tandem's own removal of the switch file", () => {
  /** The user chose the local model; then the synchronous Claude write fails
   *  (so Tandem's removal runs) and the async last resort fails too. */
  async function chosenLocalThenClaudeWritesFail(): Promise<void> {
    markNotFirstLitStart();
    prime();
    await setChatAnswerer("local", "own-window");
    await __flushLocalModelAnnouncedForTests();
    const realOpen = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p).includes(CHAT_ANSWERER_FILE_NAME) && String(p).endsWith(".tmp")) {
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      }
      return (realOpen as (...a: unknown[]) => number)(p, ...rest);
    }) as typeof fs.openSync);
    writeControl.fail.add(CHAT_ANSWERER_FILE_NAME);
  }

  function failRenameToMarker(): void {
    const realRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === markerFile()) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      return realRename(from, to);
    });
  }

  async function settleAndRestart(): Promise<void> {
    vi.restoreAllMocks();
    quietConsole();
    writeControl.fail.clear();
    await __flushLocalModelAnnouncedForTests();
    restart();
    prime();
  }

  it("a rename that fails empties the file in place: it reads Claude, not missing", async () => {
    await chosenLocalThenClaudeWritesFail();
    failRenameToMarker();
    const result = await setChatAnswerer("claude", "allowance");
    expect(result).toEqual({ answerer: "claude", persisted: true });
    expect(fs.readFileSync(switchFile(), "utf8")).toBe("");
    await settleAndRestart();
    expect(chatAnswerer()).toBe("claude");
    const notices = getStartupNotices();
    expect(notices.length).toBe(1);
    expect(JSON.stringify(notices)).not.toContain("was removed");
  });

  it("a hard-linked settings file is never emptied in place: its other name keeps its content", async () => {
    await chosenLocalThenClaudeWritesFail();
    const other = path.join(dir, "other-name.json");
    fs.linkSync(switchFile(), other);
    const before = fs.readFileSync(other, "utf8");
    failRenameToMarker();
    await setChatAnswerer("claude", "allowance");
    expect(fs.readFileSync(other, "utf8")).toBe(before);
    expect(fs.existsSync(switchFile())).toBe(false); // deleted instead
  });

  it("a hard link that appears between the check and the open is refused (the descriptor re-check)", async () => {
    await chosenLocalThenClaudeWritesFail();
    const other = path.join(dir, "other-name.json");
    fs.linkSync(switchFile(), other);
    const before = fs.readFileSync(other, "utf8");
    failRenameToMarker();
    const realLstat = fs.lstatSync;
    // The path check sees one name (the link is made after it).
    vi.spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, o?: unknown) => {
      const st = (realLstat as (p: fs.PathLike, o?: unknown) => fs.Stats)(p, o);
      return isSwitch(p) ? Object.assign(Object.create(st), { nlink: 1, isFile: () => true }) : st;
    }) as typeof fs.lstatSync);
    await setChatAnswerer("claude", "allowance");
    expect(fs.readFileSync(other, "utf8")).toBe(before);
  });

  it("the path check alone refuses a hard-linked file (the descriptor seeing one name)", async () => {
    await chosenLocalThenClaudeWritesFail();
    const other = path.join(dir, "other-name.json");
    fs.linkSync(switchFile(), other);
    const before = fs.readFileSync(other, "utf8");
    failRenameToMarker();
    const realFstat = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number, o?: unknown) => {
      const st = (realFstat as (fd: number, o?: unknown) => fs.Stats)(fd, o);
      return Object.assign(Object.create(st), { nlink: 1, isFile: () => true });
    }) as typeof fs.fstatSync);
    await setChatAnswerer("claude", "allowance");
    expect(fs.readFileSync(other, "utf8")).toBe(before);
  });

  it("a link planted at the marker path never has its target changed", async () => {
    await chosenLocalThenClaudeWritesFail();
    const victim = path.join(dir, "victim.txt");
    fs.writeFileSync(victim, "precious");
    fs.linkSync(victim, markerFile());
    failRenameToMarker();
    vi.spyOn(fs, "ftruncateSync").mockImplementation(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });
    await setChatAnswerer("claude", "allowance");
    expect(fs.readFileSync(victim, "utf8")).toBe("precious");
  });

  it("review item 24: rename, emptying and marker all fail, the delete works — the next start still does not say 'was removed'", async () => {
    await chosenLocalThenClaudeWritesFail();
    failRenameToMarker();
    vi.spyOn(fs, "ftruncateSync").mockImplementation(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });
    fs.mkdirSync(markerFile()); // the marker cannot be created
    await setChatAnswerer("claude", "allowance");
    expect(fs.existsSync(switchFile())).toBe(false);
    await settleAndRestart();
    expect(getStartupNotices().length).toBe(1);
    expect(JSON.stringify(getStartupNotices())).not.toContain("was removed");
  });

  it("positive control: a removal Tandem did not make still says 'was removed'", async () => {
    markNotFirstLitStart();
    prime();
    await setChatAnswerer("local", "own-window");
    await __flushLocalModelAnnouncedForTests();
    fs.rmSync(switchFile());
    restart();
    prime();
    expect(JSON.stringify(getStartupNotices())).toContain("was removed");
  });

  it.skipIf(process.platform === "win32")(
    "a symbolic link at the file's path: Tandem's rename moves the link, which counts as its marker",
    async () => {
      markNotFirstLitStart();
      prime();
      await setChatAnswerer("local", "own-window");
      await __flushLocalModelAnnouncedForTests();
      const target = path.join(dir, "elsewhere.json");
      fs.writeFileSync(target, JSON.stringify({ version: 1, answerer: "local" }));
      fs.rmSync(switchFile());
      fs.symlinkSync(target, switchFile());
      const realOpen = fs.openSync;
      vi.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
        if (String(p).endsWith(".tmp"))
          throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
        return (realOpen as (...a: unknown[]) => number)(p, ...rest);
      }) as typeof fs.openSync);
      writeControl.fail.add(CHAT_ANSWERER_FILE_NAME);
      await setChatAnswerer("claude", "allowance");
      vi.restoreAllMocks();
      quietConsole();
      writeControl.fail.clear();
      expect(fs.lstatSync(markerFile()).isSymbolicLink()).toBe(true);
      await __flushLocalModelAnnouncedForTests();
      restart();
      prime();
      expect(JSON.stringify(getStartupNotices())).not.toContain("was removed");
    },
  );
});

/** A small seeded generator (mulberry32), so a failure names its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Value = "claude" | "local";
type Source = "own-window" | "allowance";
interface Req {
  value: Value;
  source: Source;
}

interface Outcome {
  requests: Req[];
  results: SetChatAnswererResult[];
  before: Value;
  /** The switch file carried the user's mark before the run. */
  beforeMarked: boolean;
  /** The local model was in effect at some moment of the run (or at its start). */
  localSeen: boolean;
  /** The run's last attempt to put Claude on disk (a write, the removal's
   *  rename, the emptying, the delete) failed, after the last request was
   *  issued: only then may a residual below excuse a "local" left on disk. */
  lastClaudeWriteFailed: boolean;
  /** After the last request was issued, a write of "local" to the switch
   *  file failed and a read of it was refused (locked) after that: the
   *  latest local request could neither land its value nor see the disk. */
  localWriteFailedThenLocked: boolean;
  after: Value;
  disk: Value;
  /** How many requests began while an earlier one's write was in flight, or
   *  after a write landed and before its caller resumed. */
  overlapped: number;
}

/**
 * Run `requests` so that they OVERLAP: request k+1 is issued from inside an
 * earlier request's async write (its local write, its record write or the
 * async Claude write) at a generated point — while the write is in flight, or
 * after it has landed and before the awaiting step resumes (round-2 item 3) —
 * never all up front, where each request's queued step would only see that a
 * later one exists. Every write the generator picks fails: the async writes,
 * the synchronous Claude write's and the removal's renames, the in-place
 * emptying and the delete; and with `locked`, reads of the switch file fail
 * too (a file a scanner holds without letting it be read, which Windows can
 * produce, R7.5).
 */
async function runSequence(
  input: Array<Value | Req>,
  rand: () => number,
  opts: { failP: number; locked?: number; decide?: (file: string) => boolean } = { failP: 0 },
): Promise<Outcome> {
  const requests: Req[] = input.map((q) =>
    typeof q === "string" ? { value: q, source: "own-window" } : q,
  );
  const before = diskAnswerer();
  const beforeMarked = (diskJson() as { setBy?: unknown } | null)?.setBy === "own-window";
  const fail = () => rand() < opts.failP;
  let localSeen = chatAnswerer() === "local";
  const unsubscribe = onChatAnswererChanged((now) => {
    if (now === "local") localSeen = true;
  });
  const results: Array<Promise<SetChatAnswererResult>> = [];
  let next = 0;
  let overlapped = 0;
  let inFlight = 0;
  let clock = 0;
  let lastLaunchAt = 0;
  let lastClaude: { ok: boolean; at: number } | null = null;
  let lastLockedAt = 0;
  let lastLocalWrite: { ok: boolean; at: number } | null = null;
  const claudeAttempt = (ok: boolean): void => {
    lastClaude = { ok, at: ++clock };
  };
  const launch = (): void => {
    if (next >= requests.length) return;
    lastLaunchAt = ++clock;
    if (inFlight > 0) overlapped += 1;
    const { value, source } = requests[next++];
    inFlight += 1;
    results.push(
      setChatAnswerer(value, source).finally(() => {
        inFlight -= 1;
      }),
    );
  };
  writeControl.before = (file) => {
    if ((isSwitch(file) || isRecord(file)) && rand() < 0.6) launch();
  };
  writeControl.after = (file) => {
    if ((isSwitch(file) || isRecord(file)) && rand() < 0.3) launch();
  };
  const decide = opts.decide ?? ((file: string) => (isSwitch(file) || isRecord(file)) && fail());
  writeControl.decide = (file, content) => {
    const failed = decide(file);
    if (isSwitch(file) && content.includes('"claude"')) claudeAttempt(!failed);
    if (isSwitch(file) && content.includes('"local"'))
      lastLocalWrite = { ok: !failed, at: ++clock };
    return failed;
  };
  const realRename = fs.renameSync;
  const realRm = fs.rmSync;
  const realOpen = fs.openSync;
  const realRead = fs.readFileSync;
  const ioError = () => Object.assign(new Error("EIO"), { code: "EIO" });
  // Each of these is one way of putting Claude on disk; the attempt is noted.
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (isSwitch(to) || String(to) === markerFile()) {
      const failed = fail();
      claudeAttempt(!failed);
      if (failed) throw ioError();
    }
    return realRename(from, to);
  });
  vi.spyOn(fs, "rmSync").mockImplementation(((p: fs.PathLike, o?: fs.RmOptions) => {
    if (isSwitch(p)) {
      const failed = fail();
      claudeAttempt(!failed);
      if (failed) throw ioError();
    }
    return realRm(p, o);
  }) as typeof fs.rmSync);
  vi.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    if (isSwitch(p)) {
      const failed = fail();
      claudeAttempt(!failed);
      if (failed) throw ioError();
    }
    return (realOpen as (...a: unknown[]) => number)(p, ...rest);
  }) as typeof fs.openSync);
  if (opts.locked !== undefined) {
    const lockedP = opts.locked;
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) => {
      if (isSwitch(p) && rand() < lockedP) {
        lastLockedAt = ++clock;
        throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      }
      return (realRead as (p: fs.PathOrFileDescriptor, o?: unknown) => unknown)(p, o);
    }) as typeof fs.readFileSync);
  }
  launch();
  // Issue whatever was not issued from inside a write once the run settles.
  for (;;) {
    const issued = results.length;
    await Promise.all(results);
    if (results.length === issued) {
      if (next >= requests.length) break;
      launch();
    }
  }
  const settled = await Promise.all(results);
  unsubscribe();
  await __flushLocalModelAnnouncedForTests();
  vi.restoreAllMocks();
  quietConsole();
  writeControl.before = null;
  writeControl.after = null;
  writeControl.decide = null;
  return {
    requests,
    results: settled,
    before,
    beforeMarked,
    localSeen,
    lastClaudeWriteFailed:
      (lastClaude as { ok: boolean; at: number } | null)?.ok === false &&
      (lastClaude as { ok: boolean; at: number } | null)!.at > lastLaunchAt,
    localWriteFailedThenLocked: (() => {
      const w = lastLocalWrite as { ok: boolean; at: number } | null;
      return w !== null && !w.ok && w.at > lastLaunchAt && lastLockedAt > w.at;
    })(),
    after: chatAnswerer(),
    disk: diskAnswerer(),
    overlapped,
  };
}

const CLAUDE_AGAIN = "Chat in Tandem is now answered by Claude, not by a local model.";

function recordJson(): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(recordFile(), "utf8"));
  } catch {
    return null;
  }
}

/**
 * R7.2's outcome, the brief's sentence: once the requests have settled, either
 * the disk agrees with what is in effect, or the last response said
 * `persisted: false` and both what is in effect and the disk are what they
 * were before the run began (round-2 item 1: a flipped disk passes only as the
 * announced flip below). Then, in every branch:
 * - the restart reads what was in effect (or, for the announced flip, the
 *   local model WITH its notice) — checked by the product's own start-up
 *   read, not only by this file's parser;
 * - a Claude the last request reported saved carries the user's mark when
 *   that request was the user's own (or the record no longer says the local
 *   model was chosen, round 3's contract), and a mark nothing in the run (or
 *   before it) could have written is never there (round-2 item 3);
 * - after a saved last response, the restart says chat is answered by Claude
 *   again only when that announcement was owed (round-2 item 2);
 * - a run of the user's own requests whose last one was saved raises no
 *   notice at the restart.
 */
async function checkOutcome(r: Outcome, label: string): Promise<void> {
  const last = r.results[r.results.length - 1];
  const lastReq = r.requests[r.requests.length - 1];
  const allOwn = r.requests.every((q) => q.source === "own-window");
  const agrees = r.disk === r.after;
  const fallback = last.persisted === false && r.after === r.before && r.disk === r.before;
  const disk = diskJson() as Record<string, unknown> | null;
  const rec = recordJson();
  // Raised during the run (or at its start) and still standing.
  const claudeAgainRaised = getStartupNotices().some((n) => n.message.startsWith(CLAUDE_AGAIN));
  const ctx = () =>
    `${label}: ${JSON.stringify(r)} disk ${JSON.stringify(disk)} record ${JSON.stringify(rec)}`;
  restart();
  prime();
  const notices = getStartupNotices();
  // The stated residual: a refused switch whose every way of putting Claude
  // back fails (and A1's lone Claude request with every fallback failing)
  // leaves "local" on disk with Claude in effect. R7.1 keeps Claude in effect;
  // the flip is then never silent — the next start announces it.
  const announcedFlip =
    !agrees &&
    r.lastClaudeWriteFailed &&
    last.persisted === false &&
    r.after === "claude" &&
    r.disk === "local" &&
    notices.some((n) => n.message === SETTINGS_CHANGED_ANSWERER_LOCAL_NOTICE);
  // The second stated residual (for Bryan's ruling, round 2): the latest
  // request asked for the local model and could not take effect — its record
  // write failed and every way of putting Claude back failed too, or its own
  // write failed and the read that followed was refused (a locked file) — and
  // "local" is on disk, held from before the run or left by an earlier
  // request's write. The response said unsaved, and the restart reads the
  // value the latest request asked for: nothing answers that the last request
  // did not ask for.
  const latestAskedLocal =
    !agrees &&
    (r.lastClaudeWriteFailed || r.localWriteFailedThenLocked) &&
    last.persisted === false &&
    lastReq.value === "local" &&
    r.after === "claude" &&
    r.disk === "local";
  // A1's residual, stated at the review's request in round 1: the latest
  // request asked for Claude over a stored "local" and every way of writing
  // Claude failed, so the disk never changed. Claude answers for this run;
  // the restart reads the "local" the disk held before, and the response
  // said unsaved.
  const claudeNeverLanded =
    !agrees &&
    r.lastClaudeWriteFailed &&
    last.persisted === false &&
    lastReq.value === "claude" &&
    r.after === "claude" &&
    r.before === "local" &&
    r.disk === "local";
  expect(agrees || fallback || announcedFlip || latestAskedLocal || claudeNeverLanded, ctx()).toBe(
    true,
  );
  expect(chatAnswerer(), `${ctx()}: the restart reads`).toBe(
    agrees || fallback ? r.after : "local",
  );
  if (last.persisted) {
    expect(agrees, `${ctx()}: a saved response agrees with the disk`).toBe(true);
  }
  if (
    last.persisted &&
    lastReq.value === "claude" &&
    r.after === "claude" &&
    disk !== null &&
    disk.answerer === "claude"
  ) {
    // The user's own: always marked. Not the user's own: never strips a mark
    // already there (round 4 P12), and never invents one.
    const markPossible =
      r.beforeMarked || r.requests.some((q) => q.source === "own-window" && q.value === "claude");
    // The user's own switch reported saved: its mark is on disk, or the record
    // no longer says the local model was chosen (round 3's contract — a
    // Claude file whose mark could not be written is silent only then).
    if (lastReq.source === "own-window") {
      expect(
        disk.setBy === "own-window" || rec?.answererChosen !== true,
        `${ctx()}: the user's mark`,
      ).toBe(true);
    } else if (!markPossible) {
      expect(disk.setBy, `${ctx()}: no invented mark`).toBeUndefined();
    }
  }
  // "Chat in Tandem is now answered by Claude, not by a local model" at the
  // restart, after a run whose last response was saved, only when such an
  // announcement was owed before the restart (an allowance switch to Claude
  // over the user's recorded choice, or a failed start-up read of it), or the
  // local model really answered during the run and Claude answers now (the
  // owed field's own write may have failed; the record's "chosen" then says
  // the same). A "chosen" left on record by a superseded request that never
  // took effect is neither (round-2 item 2). An announcement raised during
  // the run and still standing is owed, even when the write that records it
  // failed: an allowance switch to Claude that found the user's choice of the
  // local model on record (just recorded, before its request resumed).
  if (
    last.persisted &&
    !r.localSeen &&
    !claudeAgainRaised &&
    notices.some((n) => n.message.startsWith(CLAUDE_AGAIN))
  ) {
    expect(rec?.claudeAgainOwed ?? null, `${ctx()}: an unowed "answered by Claude"`).not.toBe(null);
  }
  if (allOwn && last.persisted) {
    expect(notices, `${ctx()}: no notice for the user's own switches`).toEqual([]);
  }
  // The restart's own record writes land here, not in the next seed's files.
  await __flushLocalModelAnnouncedForTests();
}

describe("R7.2: overlapping requests never leave the disk differing from what is in effect", () => {
  it("P11: own local, then local (its write in flight) / Claude / local (failing)", async () => {
    markNotFirstLitStart();
    prime();
    await setChatAnswerer("local", "own-window");
    await __flushLocalModelAnnouncedForTests();
    let switchWrites = 0;
    const r = await runSequence(["local", "claude", "local"], () => 0.1, {
      failP: 0,
      // Every request is issued from the first one's write (rand 0.1 < 0.6);
      // the third request's local write fails.
      decide: (file) => isSwitch(file) && ++switchWrites === 2,
    });
    expect(r.overlapped).toBe(2);
    expect(r.after).toBe("claude");
    expect(r.disk).toBe("claude");
    await checkOutcome(r, "P11");
  });

  for (const start of ["local", "claude"] as const) {
    it(`P${start === "local" ? "A" : "B"}: two local requests over the user's stored ${start}, the second issued during the first's write and failing`, async () => {
      markNotFirstLitStart();
      prime();
      await setChatAnswerer(start, "own-window");
      await __flushLocalModelAnnouncedForTests();
      restart();
      prime();
      let switchWrites = 0;
      const r = await runSequence(["local", "local"], () => 0.1, {
        failP: 0,
        decide: (file) => isSwitch(file) && ++switchWrites === 2,
      });
      expect(r.overlapped).toBe(1);
      // The first write landed "local"; the latest request reconciles to it
      // (PB: accepted by the review session's ruling, item 12).
      expect(r.after).toBe("local");
      await checkOutcome(r, `P-${start}`);
    });
  }

  /** One chunk of seeds. Every write is real but unflushed (`fast`, and the
   *  synchronous Claude write's fsync stubbed), so a seed costs no fsync. */
  async function runSeeds(from: number, to: number): Promise<number> {
    writeControl.fast = true;
    let overlapped = 0;
    for (let seed = from; seed <= to; seed++) {
      if (stopGenerating) return overlapped;
      const rand = rng(seed);
      // Spied again each seed: `runSequence` restores every mock when it ends.
      vi.spyOn(fs, "fsyncSync").mockImplementation(() => {});
      restart();
      await fs.promises.rm(switchFile(), { force: true });
      await fs.promises.rm(recordFile(), { force: true });
      markNotFirstLitStart();
      prime();
      const startPick = rand();
      if (startPick < 0.33) await setChatAnswerer("claude", "own-window");
      else if (startPick < 0.66) await setChatAnswerer("local", "own-window");
      await __flushLocalModelAnnouncedForTests();
      restart();
      if (rand() < 0.2) primeWithFailedRead();
      else prime();
      const n = 2 + Math.floor(rand() * 4);
      const values: Req[] = Array.from({ length: n }, () => ({
        value: rand() < 0.5 ? "local" : "claude",
        source: rand() < 0.3 ? "allowance" : "own-window",
      }));
      const r = await runSequence(values, rand, {
        failP: [0.2, 0.4, 0.6][Math.floor(rand() * 3)],
        ...(rand() < 0.3 ? { locked: 0.3 } : {}),
      });
      overlapped += r.overlapped;
      await checkOutcome(
        r,
        `seed ${seed} ${values.map((q) => `${q.source === "allowance" ? "A:" : ""}${q.value}`).join(",")}`,
      );
    }
    return overlapped;
  }

  // 80 seeds in chunks of 10, each its own test inside the suite's default
  // timeout (round 2: one 80-seed test with real fsyncs timed out on a loaded
  // Windows machine). They catch the put-back (round-2 item 1) at seed 8 and
  // the in-queue re-assert at seed 1. `TANDEM_GEN_SEEDS` runs more by hand
  // (10,000 pass); each chunk stays 10 seeds.
  const CHUNK = 10;
  const SEEDS = Number(process.env.TANDEM_GEN_SEEDS ?? 80);
  for (let from = 1; from <= SEEDS; from += CHUNK) {
    const to = Math.min(SEEDS, from + CHUNK - 1);
    it(`generated, seeds ${from}–${to}: 2–5 overlapping own-window and allowance requests with injected failures, a failed start-up read and a locked file, each followed by a restart`, async () => {
      const run = runSeeds(from, to);
      generating = run.then(() => undefined);
      const overlapped = await run;
      // The generator really overlaps requests (about one a seed on average;
      // the default 80 seeds overlap at least once a seed in every chunk).
      expect(overlapped).toBeGreaterThan(0);
    });
  }
});
