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
  decide: null as null | ((file: string) => boolean),
  before: null as null | ((file: string) => void),
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
      if (writeControl.decide?.(file)) throw new Error("simulated write failure");
      return actual.atomicWriteConfigFile(file, content);
    },
  };
});

let dir = "";
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
  restart();
  quietConsole();
});

afterEach(async () => {
  writeControl.fail.clear();
  writeControl.decide = null;
  writeControl.before = null;
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
    writeControl.decide = (file) => isRecord(file) && recordWrites === 2;
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
    await setChatAnswerer("local", "own-window");
    vi.restoreAllMocks();
    quietConsole();
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

interface Outcome {
  results: SetChatAnswererResult[];
  before: Value;
  after: Value;
  disk: Value;
  /** How many requests began while an earlier one's write was in flight. */
  overlapped: number;
}

/**
 * Run `values` as own-window requests that OVERLAP: request k+1 is issued from
 * inside an earlier request's in-flight async write (its local write, its
 * record write or the async Claude write) at a generated point — never all up
 * front, where each request's queued step would only see that a later one
 * exists. Every write the generator picks fails: the async writes, the
 * synchronous Claude write's and the removal's renames, the in-place
 * emptying and the delete; and with `locked`, reads of the switch file fail
 * too (a file a scanner holds without letting it be read, which Windows can
 * produce, R7.5).
 */
async function runSequence(
  values: Value[],
  rand: () => number,
  opts: { failP: number; locked?: number; decide?: (file: string) => boolean } = { failP: 0 },
): Promise<Outcome> {
  const before = diskAnswerer();
  const fail = () => rand() < opts.failP;
  const results: Array<Promise<SetChatAnswererResult>> = [];
  let next = 0;
  let overlapped = 0;
  let inFlight = 0;
  const launch = (): void => {
    if (next >= values.length) return;
    if (inFlight > 0) overlapped += 1;
    const value = values[next++];
    inFlight += 1;
    results.push(
      setChatAnswerer(value, "own-window").finally(() => {
        inFlight -= 1;
      }),
    );
  };
  writeControl.before = (file) => {
    if ((isSwitch(file) || isRecord(file)) && rand() < 0.6) launch();
  };
  writeControl.decide = opts.decide ?? ((file) => (isSwitch(file) || isRecord(file)) && fail());
  const realRename = fs.renameSync;
  const realRm = fs.rmSync;
  const realOpen = fs.openSync;
  const realRead = fs.readFileSync;
  const ioError = () => Object.assign(new Error("EIO"), { code: "EIO" });
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if ((isSwitch(to) || String(to) === markerFile()) && fail()) throw ioError();
    return realRename(from, to);
  });
  vi.spyOn(fs, "rmSync").mockImplementation(((p: fs.PathLike, o?: fs.RmOptions) => {
    if (isSwitch(p) && fail()) throw ioError();
    return realRm(p, o);
  }) as typeof fs.rmSync);
  vi.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    if (isSwitch(p) && fail()) throw ioError();
    return (realOpen as (...a: unknown[]) => number)(p, ...rest);
  }) as typeof fs.openSync);
  if (opts.locked !== undefined) {
    const lockedP = opts.locked;
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) => {
      if (isSwitch(p) && rand() < lockedP) {
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
      if (next >= values.length) break;
      launch();
    }
  }
  const settled = await Promise.all(results);
  await __flushLocalModelAnnouncedForTests();
  vi.restoreAllMocks();
  quietConsole();
  writeControl.before = null;
  writeControl.decide = null;
  return { results: settled, before, after: chatAnswerer(), disk: diskAnswerer(), overlapped };
}

/**
 * R7.2's outcome, the brief's sentence: once the requests have settled, either
 * the disk agrees with what is in effect, or the last response said
 * `persisted: false` and what is in effect is what the disk held before the
 * run began. Then the restart: when the disk agrees, the next start reads
 * what was in effect, with no notice (every request was the user's own), and
 * a Claude on disk is either the user's marked file or one that reads Claude
 * without a value (missing or emptied).
 */
async function checkOutcome(r: Outcome, label: string): Promise<void> {
  const last = r.results[r.results.length - 1];
  const agrees = r.disk === r.after;
  const fallback = last.persisted === false && r.after === r.before;
  expect(agrees || fallback, `${label}: ${JSON.stringify(r)}`).toBe(true);
  restart();
  prime();
  if (agrees) {
    expect(chatAnswerer(), `${label}: the restart reads what was in effect`).toBe(r.after);
    if (last.persisted) {
      expect(getStartupNotices(), `${label}: no notice for the user's own switches`).toEqual([]);
    }
  }
}

describe("R7.2: overlapping own-window requests never leave the disk differing from what is in effect", () => {
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

  it("generated: 2–5 overlapping requests with injected failures, a failed start-up read and a locked file, each followed by a restart", async () => {
    const SEEDS = 80;
    let overlapped = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rand = rng(seed);
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
      const values: Value[] = Array.from({ length: n }, () => (rand() < 0.5 ? "local" : "claude"));
      const r = await runSequence(values, rand, {
        failP: 0.3,
        ...(rand() < 0.3 ? { locked: 0.3 } : {}),
      });
      overlapped += r.overlapped;
      await checkOutcome(r, `seed ${seed} ${values.join(",")}`);
    }
    // The generator really overlaps requests.
    expect(overlapped).toBeGreaterThan(SEEDS);
  });
});
