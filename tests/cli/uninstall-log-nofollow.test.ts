/**
 * The uninstall log refuses a link at `tandem`, `Logs` or `uninstall.log`
 * (#2163).
 *
 * Real filesystem, no `vi.mock`: `uninstall-scrub.test.ts` mocks `fs.promises`,
 * and what these rows pin is which real syscall follows a real link. A
 * `"junction"` symlink needs no privilege on Windows and is a directory symlink
 * elsewhere, so those rows run on every platform; a file symlink needs privilege
 * on Windows, so those rows are POSIX-only.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { openUninstallLog } from "../../src/cli/uninstall-scrub.js";

type ScrubLogger = Parameters<typeof openUninstallLog>[1];

const POSIX_ONLY = process.platform !== "win32";
const SCRUB_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/cli/uninstall-scrub.ts",
);

describe("openUninstallLog refuses links below %LOCALAPPDATA% (#2163)", () => {
  let base: string;
  let root: string;
  let elsewhere: string;
  let warn: MockInstance<(msg: string) => void>;
  let logger: ScrubLogger;

  const logPath = () => path.join(root, "tandem", "Logs", "uninstall.log");
  const warned = () => warn.mock.calls.map((c) => String(c[0]));

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-2163-log-"));
    root = path.join(base, "Local");
    elsewhere = path.join(base, "elsewhere");
    fs.mkdirSync(root);
    fs.mkdirSync(elsewhere);
    const warnFn = vi.fn<(msg: string) => void>();
    warn = warnFn;
    logger = {
      info: vi.fn(),
      warn: warnFn,
      error: vi.fn(),
      warnings: () => 0,
      close: async () => {},
    };
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("(a) creates the tree on a fresh root and appends rather than truncates", async () => {
    const first = await openUninstallLog(root, logger);
    expect(first).not.toBeNull();
    await first?.write("one\n");
    await first?.close();

    const second = await openUninstallLog(root, logger);
    expect(second).not.toBeNull();
    await second?.write("two\n");
    await second?.close();

    expect(fs.readFileSync(logPath(), "utf8")).toBe("one\ntwo\n");
    expect(warn).not.toHaveBeenCalled();
  });

  it("(b) refuses a junction at tandem", async () => {
    const link = path.join(root, "tandem");
    fs.symlinkSync(elsewhere, link, "junction");

    expect(await openUninstallLog(root, logger)).toBeNull();
    expect(warned()).toContain(`refusing to descend into reparse point: ${link}`);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it("(c) refuses a junction at Logs", async () => {
    fs.mkdirSync(path.join(root, "tandem"));
    const link = path.join(root, "tandem", "Logs");
    fs.symlinkSync(elsewhere, link, "junction");

    expect(await openUninstallLog(root, logger)).toBeNull();
    expect(warned()).toContain(`refusing to descend into reparse point: ${link}`);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it.skipIf(!POSIX_ONLY)("(d) refuses a symlink at uninstall.log to a real file", async () => {
    fs.mkdirSync(path.join(root, "tandem", "Logs"), { recursive: true });
    const victim = path.join(elsewhere, "victim.txt");
    fs.writeFileSync(victim, "orig");
    fs.symlinkSync(victim, logPath());

    expect(await openUninstallLog(root, logger)).toBeNull();
    expect(fs.readFileSync(victim, "utf8")).toBe("orig");
    expect(warned()).toContain(`refusing to follow a reparse point: ${logPath()}`);
  });

  it.skipIf(!POSIX_ONLY)("(e) refuses a dangling symlink at uninstall.log", async () => {
    // The old `open(…, "a")` created the link's target.
    fs.mkdirSync(path.join(root, "tandem", "Logs"), { recursive: true });
    const target = path.join(elsewhere, "new.log");
    fs.symlinkSync(target, logPath());

    expect(await openUninstallLog(root, logger)).toBeNull();
    expect(fs.existsSync(target)).toBe(false);
  });

  it("(f) refuses a directory at uninstall.log", async () => {
    fs.mkdirSync(logPath(), { recursive: true });

    expect(await openUninstallLog(root, logger)).toBeNull();
    expect(warned()).toContain(`not a regular file, skipping: ${logPath()}`);
  });

  it("(g) refuses a junction at uninstall.log", async () => {
    fs.mkdirSync(path.join(root, "tandem", "Logs"), { recursive: true });
    fs.symlinkSync(elsewhere, logPath(), "junction");

    expect(await openUninstallLog(root, logger)).toBeNull();
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });
});

describe("uninstall log wiring (#2163)", () => {
  // `openLogger` is not exported and is reachable only by stubbing HOME and
  // `%LOCALAPPDATA%`, so its use of the screened opener is pinned from source.
  const src = fs.readFileSync(SCRUB_SRC, "utf8");

  it("openLogger opens the log only through openUninstallLog", () => {
    const start = src.indexOf("async function openLogger(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toContain("openUninstallLog(localAppData, stderrLogger)");
    expect(body).not.toContain("recursive: true");
  });

  it("the open adds O_NOFOLLOW where the platform defines it", () => {
    // Defence in depth over the `lstat` screen, for a link swapped in after
    // it. No behavioural row reaches it: the screen refuses every planted link
    // first, so this is the only thing that fails if the flag is dropped.
    const start = src.indexOf("export async function openUninstallLog(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toMatch(/const noFollow = fsConstants\.O_NOFOLLOW \?\? 0;/);
    expect(body).toMatch(/fsPromises\.open\(\s*logPath,[^)]*\| noFollow,?\s*\)/);
  });
});
