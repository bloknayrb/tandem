/**
 * Who answers chat, part A2's items carried from A1's last review (#1123,
 * R7.1–R7.5). Every case runs against a per-test temp dir; a write is failed by
 * replacing the call for the named file only — never by permissions — so the
 * cases mean the same on Windows and POSIX. The one symlink case is gated off
 * Windows (creating a link there needs a privilege CI does not have); the
 * marker logic it exercises is platform-neutral and covered by the plain-file
 * cases.
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
  LOCAL_MODEL_ANNOUNCED_FILE_NAME,
} from "../../../src/server/models/local-model-announced.js";
import {
  __resetLocalModelSettingsForTests,
  primeLocalModelSettings,
} from "../../../src/server/models/local-model-settings.js";
import { __resetModelRegistryForTests } from "../../../src/server/models/registry.js";
import { resetForTesting as resetNotifications } from "../../../src/server/notifications.js";
import { clearStartupNotices, getStartupNotices } from "../../../src/server/startup-notices.js";

/** Per-call failure decisions for the named files' writes. */
const writeControl = vi.hoisted(() => ({
  fail: new Set<string>(),
  decide: null as null | ((file: string) => boolean),
}));

vi.mock("../../../src/server/integrations/storage.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/server/integrations/storage.js")>();
  return {
    ...actual,
    atomicWriteConfigFile: async (file: string, content: string): Promise<void> => {
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
const CLAUDE_OWN = { version: 1, answerer: "claude", setBy: "own-window" };

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

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-chat-answerer-a2-"));
  writeControl.fail.clear();
  writeControl.decide = null;
  restart();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  writeControl.fail.clear();
  writeControl.decide = null;
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
    // Back on disk, with the user's own mark: the next start is silent.
    expect(JSON.parse(fs.readFileSync(switchFile(), "utf8"))).toEqual(CLAUDE_OWN);
    writeControl.fail.clear();
    await __flushLocalModelAnnouncedForTests();
    restart();
    prime();
    expect(chatAnswerer()).toBe("claude");
    expect(getStartupNotices()).toEqual([]);
  });

  it("the announcement cannot go silent: chosen earlier, a refused re-choice, then a program sets Claude — the next start announces", async () => {
    markNotFirstLitStart();
    prime();
    // The user's own earlier choice of the local model is on record.
    expect(await setChatAnswerer("local", "own-window")).toEqual({
      answerer: "local",
      persisted: true,
    });
    await __flushLocalModelAnnouncedForTests();
    // A re-choice whose record write fails changes nothing.
    writeControl.fail.add(LOCAL_MODEL_ANNOUNCED_FILE_NAME);
    expect((await setChatAnswerer("local", "own-window")).persisted).toBe(false);
    writeControl.fail.clear();
    expect(chatAnswerer()).toBe("local");
    await __flushLocalModelAnnouncedForTests();
    // A program sets Claude while Tandem is down.
    fs.writeFileSync(switchFile(), JSON.stringify({ version: 1, answerer: "claude" }));
    restart();
    prime();
    expect(chatAnswerer()).toBe("claude");
    expect(getStartupNotices().length).toBe(1);
  });

  it("positive control: with the record write working, the switch happens", async () => {
    markNotFirstLitStart();
    prime();
    expect(await setChatAnswerer("local", "own-window")).toEqual({
      answerer: "local",
      persisted: true,
    });
    expect(diskAnswerer()).toBe("local");
  });
});

describe("R7.5: the start-up seed of 'the Claude in effect is the user's own' is pinned", () => {
  it("a refused own switch after a start that read the user's marked Claude puts the MARK back", async () => {
    markNotFirstLitStart();
    prime();
    await setChatAnswerer("claude", "own-window");
    await __flushLocalModelAnnouncedForTests();
    restart();
    prime(); // reads the marked file: the seed
    writeControl.fail.add(LOCAL_MODEL_ANNOUNCED_FILE_NAME);
    await setChatAnswerer("local", "own-window");
    expect(JSON.parse(fs.readFileSync(switchFile(), "utf8"))).toEqual(CLAUDE_OWN);
  });
});

describe("R7.3: Tandem's own removal never says 'was removed'", () => {
  it("a rename that fails empties the file instead: it reads Claude, not missing", async () => {
    markNotFirstLitStart();
    prime();
    await setChatAnswerer("local", "own-window");
    await __flushLocalModelAnnouncedForTests();
    const realRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      // The synchronous Claude write's rename, and the rename to the marker.
      if (String(to).endsWith(CHAT_ANSWERER_FILE_NAME) || String(to) === markerFile()) {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      }
      return realRename(from, to);
    });
    writeControl.fail.add(CHAT_ANSWERER_FILE_NAME);
    const result = await setChatAnswerer("claude", "allowance");
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeControl.fail.clear();
    expect(result.answerer).toBe("claude");
    expect(result.persisted).toBe(true);
    expect(fs.existsSync(switchFile())).toBe(true);
    expect(fs.readFileSync(switchFile(), "utf8")).toBe("");
    await __flushLocalModelAnnouncedForTests();
    restart();
    prime();
    expect(chatAnswerer()).toBe("claude");
    const notices = getStartupNotices();
    expect(notices.length).toBe(1);
    expect(JSON.stringify(notices)).not.toContain("was removed");
  });

  it.skipIf(process.platform === "win32")(
    "a linked settings file: Tandem's rename moves the link, which counts as its marker",
    async () => {
      markNotFirstLitStart();
      prime();
      await setChatAnswerer("local", "own-window");
      await __flushLocalModelAnnouncedForTests();
      const target = path.join(dir, "elsewhere.json");
      fs.writeFileSync(target, JSON.stringify({ version: 1, answerer: "local" }));
      fs.rmSync(switchFile());
      fs.symlinkSync(target, switchFile());
      writeControl.fail.add(CHAT_ANSWERER_FILE_NAME);
      const realOpen = fs.openSync;
      vi.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
        if (String(p).includes(".tmp"))
          throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
        return (realOpen as (...a: unknown[]) => number)(p, ...rest);
      }) as typeof fs.openSync);
      await setChatAnswerer("claude", "allowance");
      vi.restoreAllMocks();
      vi.spyOn(console, "error").mockImplementation(() => {});
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

/**
 * Run `values` as overlapping own-window requests, failing each write the
 * generator picks (the local write, the synchronous Claude write's rename,
 * the removal's rename / truncate / delete, the async Claude write, and the
 * record write), then check R7.2's outcome and restart.
 */
async function runSequence(
  values: Value[],
  failP: number,
  rand: () => number,
  decide?: (file: string) => boolean,
): Promise<{ results: SetChatAnswererResult[]; before: Value; after: Value; disk: Value }> {
  const before = diskAnswerer();
  const effectiveBefore = chatAnswerer();
  expect(effectiveBefore).toBe(before);
  const fail = () => rand() < failP;
  writeControl.decide =
    decide ??
    ((file) =>
      (file.endsWith(CHAT_ANSWERER_FILE_NAME) || file.endsWith(LOCAL_MODEL_ANNOUNCED_FILE_NAME)) &&
      fail());
  const realRename = fs.renameSync;
  const realRm = fs.rmSync;
  const realOpen = fs.openSync;
  const ioError = () => Object.assign(new Error("EIO"), { code: "EIO" });
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to).endsWith(CHAT_ANSWERER_FILE_NAME) || String(to) === markerFile()) {
      if (fail()) throw ioError();
    }
    return realRename(from, to);
  });
  vi.spyOn(fs, "rmSync").mockImplementation(((p: fs.PathLike, o?: fs.RmOptions) => {
    if (String(p).endsWith(CHAT_ANSWERER_FILE_NAME) && fail()) throw ioError();
    return realRm(p, o);
  }) as typeof fs.rmSync);
  vi.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    if (String(p).endsWith(CHAT_ANSWERER_FILE_NAME) && fail()) throw ioError();
    return (realOpen as (...a: unknown[]) => number)(p, ...rest);
  }) as typeof fs.openSync);
  const results = await Promise.all(values.map((v) => setChatAnswerer(v, "own-window")));
  await __flushLocalModelAnnouncedForTests();
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  writeControl.decide = null;
  return { results, before, after: chatAnswerer(), disk: diskAnswerer() };
}

describe("R7.2: overlapping own-window requests never leave the disk differing from what is in effect", () => {
  /**
   * The brief's outcome, verbatim: once they have all settled, either the disk
   * agrees with what is in effect, or the last response said
   * `persisted: false` and what is in effect is what the disk held before the
   * run began. Then a restart reads what was in effect.
   */
  function checkOutcome(r: Awaited<ReturnType<typeof runSequence>>, label: string): void {
    const last = r.results[r.results.length - 1];
    const agrees = r.disk === r.after;
    const fallback = last.persisted === false && r.after === r.before;
    expect(agrees || fallback, `${label}: ${JSON.stringify(r)}`).toBe(true);
  }

  // A1's named sequences, kept as cases.
  it("P11: own local, then local (held) / Claude / local (failing)", async () => {
    markNotFirstLitStart();
    prime();
    await setChatAnswerer("local", "own-window");
    await __flushLocalModelAnnouncedForTests();
    // Every local write of the chat-answerer file fails: the last request
    // (local) cannot land, and Claude, which the middle request made
    // immediate, must be what the disk says.
    const r = await runSequence(
      ["local", "claude", "local"],
      0,
      () => 0.5,
      (file) => file.endsWith(CHAT_ANSWERER_FILE_NAME),
    );
    checkOutcome(r, "P11");
    expect(r.after).toBe("claude");
    expect(r.disk).toBe("claude");
  });

  it("PA and PB: two local requests, the second failing, over a stored local and over the user's marked Claude", async () => {
    for (const start of ["local", "claude"] as const) {
      restart();
      markNotFirstLitStart();
      prime();
      await setChatAnswerer(start, "own-window");
      await __flushLocalModelAnnouncedForTests();
      restart();
      prime();
      // The second local write fails; the first, if it ran, landed.
      let calls = 0;
      const r = await runSequence(
        ["local", "local"],
        0,
        () => 0.5,
        (file) => (file.endsWith(CHAT_ANSWERER_FILE_NAME) ? ++calls === 2 : false),
      );
      checkOutcome(r, `P-${start}`);
      restart();
      prime();
      expect(chatAnswerer(), `restart after P-${start}`).toBe(r.disk);
    }
  });

  it("generated: 2–5 overlapping requests with injected write failures, each followed by a restart", async () => {
    const SEEDS = 60;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rand = rng(seed);
      restart();
      await fs.promises.rm(switchFile(), { force: true });
      markNotFirstLitStart();
      prime();
      // A random starting point: nothing, the user's own Claude, or their local.
      const startPick = rand();
      if (startPick < 0.33) await setChatAnswerer("claude", "own-window");
      else if (startPick < 0.66) await setChatAnswerer("local", "own-window");
      await __flushLocalModelAnnouncedForTests();
      restart();
      prime();
      const n = 2 + Math.floor(rand() * 4);
      const values: Value[] = Array.from({ length: n }, () => (rand() < 0.5 ? "local" : "claude"));
      const r = await runSequence(values, 0.3, rand);
      checkOutcome(r, `seed ${seed} ${values.join(",")}`);
      restart();
      prime();
      expect(chatAnswerer(), `seed ${seed}: the restart reads the disk`).toBe(r.disk);
    }
  });
});
