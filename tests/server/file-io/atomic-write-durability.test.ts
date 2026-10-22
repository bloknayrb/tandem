/**
 * Durability and write ordering of `atomicWrite` / `atomicWriteBuffer` — see
 * `writeTempThenRename` and `runSerialized` in src/server/file-io/index.ts.
 */

import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  atomicWrite,
  atomicWriteBuffer,
  runSerialized,
} from "../../../src/server/file-io/index.js";
import { ATOMIC_TEMP_RE } from "../../../src/server/file-io/reaper.js";
import { atomicWriteConfigFile } from "../../../src/server/integrations/storage.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "tandem-atomic-durable-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

async function leakedTemps(): Promise<string[]> {
  return (await fs.readdir(dir)).filter((n) => ATOMIC_TEMP_RE.test(n));
}

/** Holds the first `fs.writeFile` open until `release()`; counts every call. */
function gateFirstWrite() {
  const real = fs.writeFile;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const counter = { calls: 0 };
  vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    counter.calls += 1;
    if (counter.calls === 1) await gate;
    return real.apply(fs, args as never);
  });
  return { counter, release };
}

/** Rejects every flushed `fs.writeFile` with `code`, after writing a partial temp. */
function refuseFlush(code: string) {
  const real = fs.writeFile;
  return vi.spyOn(fs, "writeFile").mockImplementation(async (p, data, opts) => {
    if ((opts as { flush?: boolean }).flush) {
      await real.call(fs, p, "partial", opts as never);
      throw errno(code);
    }
    return real.call(fs, p, data, opts as never);
  });
}

describe("atomicWrite flushes the temp before the rename", () => {
  it("writes text and binary temps with flush: true", async () => {
    const write = vi.spyOn(fs, "writeFile");
    await atomicWrite(path.join(dir, "a.md"), "text");
    await atomicWriteBuffer(path.join(dir, "b.docx"), Buffer.from("bin"));

    expect(write.mock.calls[0]?.[2]).toMatchObject({ flag: "wx", flush: true });
    expect(write.mock.calls[1]?.[2]).toMatchObject({ flag: "wx", flush: true });
  });

  it.each(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"])(
    "falls back to an unflushed write when the filesystem refuses fsync (%s)",
    async (code) => {
      const target = path.join(dir, "doc.md");
      const write = refuseFlush(code);

      await atomicWrite(target, "full content");

      expect(await fs.readFile(target, "utf-8")).toBe("full content");
      expect(write).toHaveBeenCalledTimes(2);
      expect(write.mock.calls[1]?.[2]).toMatchObject({ flag: "wx", flush: false });
      // A fresh temp name: the refused one was already unlinked.
      expect(write.mock.calls[1]?.[0]).not.toBe(write.mock.calls[0]?.[0]);
      expect(await leakedTemps()).toEqual([]);
    },
  );

  it("remembers the refusal, so later saves in that folder skip the flush", async () => {
    const write = refuseFlush("ENOTSUP");
    await atomicWrite(path.join(dir, "first.md"), "1");
    write.mockClear();

    await atomicWrite(path.join(dir, "second.md"), "2");

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[2]).toMatchObject({ flush: false });
    expect(await fs.readFile(path.join(dir, "second.md"), "utf-8")).toBe("2");
  });

  it("a real write failure is not retried", async () => {
    const target = path.join(dir, "doc.md");
    await fs.writeFile(target, "old");
    const write = vi.spyOn(fs, "writeFile").mockRejectedValue(errno("ENOSPC"));

    await expect(atomicWrite(target, "new")).rejects.toMatchObject({ code: "ENOSPC" });
    expect(write).toHaveBeenCalledTimes(1);
    write.mockRestore();
    expect(await fs.readFile(target, "utf-8")).toBe("old");
  });
});

describe("writes to one path land in call order", () => {
  it("a second write waits for the first, so the newer content wins", async () => {
    const target = path.join(dir, "doc.md");
    const { counter, release } = gateFirstWrite();

    const older = atomicWrite(target, "older");
    const newer = atomicWrite(target, "newer");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(counter.calls, "the second write must not start while the first is in flight").toBe(1);

    release();
    await Promise.all([older, newer]);
    expect(await fs.readFile(target, "utf-8")).toBe("newer");
  });

  it("a failed write does not stall the next one on the same path", async () => {
    const target = path.join(dir, "doc.md");
    const real = fs.writeFile;
    vi.spyOn(fs, "writeFile")
      .mockRejectedValueOnce(errno("ENOSPC"))
      .mockImplementation((...args) => real.apply(fs, args as never));

    const first = atomicWrite(target, "lost");
    const second = atomicWrite(target, "kept");
    await expect(first).rejects.toMatchObject({ code: "ENOSPC" });
    await second;
    expect(await fs.readFile(target, "utf-8")).toBe("kept");
  });

  it("writes to different paths do not wait on each other", async () => {
    const { counter, release } = gateFirstWrite();

    const a = atomicWrite(path.join(dir, "a.md"), "a");
    await atomicWrite(path.join(dir, "b.md"), "b");
    expect(counter.calls).toBe(2);
    release();
    await a;
  });
});

describe("runSerialized", () => {
  it("drops the key once its queue drains", async () => {
    const chains = new Map<string, Promise<void>>();
    await runSerialized(chains, "k", async () => {});
    await chains.get("k");
    await Promise.resolve();
    expect(chains.size).toBe(0);
  });
});

describe("atomicWriteConfigFile", () => {
  it("syncs before the rename, and keeps the write when the filesystem refuses fsync", async () => {
    const realOpen = nodeFs.promises.open;
    const syncs: string[] = [];
    vi.spyOn(nodeFs.promises, "open").mockImplementation(async (...args) => {
      const fh = await realOpen.apply(nodeFs.promises, args as never);
      vi.spyOn(fh, "sync").mockImplementation(async () => {
        syncs.push(String(args[0]));
        throw errno("EINVAL");
      });
      return fh;
    });
    const target = path.join(dir, "integrations.json");

    await atomicWriteConfigFile(target, '{"ok":true}');

    expect(syncs).toHaveLength(1);
    expect(await fs.readFile(target, "utf-8")).toBe('{"ok":true}');
  });
});
