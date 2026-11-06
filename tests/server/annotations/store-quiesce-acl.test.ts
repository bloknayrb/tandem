/**
 * `quiesceForTesting` waits for the store's fire-and-forget ACL run as well as
 * its writes.
 *
 * `ensurePrivateStoreDir` starts an icacls run on a fresh store directory and
 * does not await it. On Windows that run holds the directory, so a teardown
 * that removed the directory while it ran failed EBUSY under full-suite load
 * (#2289, #2385, and `rename-recovery.test.ts` in #2379's pre-push). Mocking
 * acl-win file by file fixed only the files that remembered to. The teardown
 * helpers all call `quiesceForTesting`, so waiting there covers every one.
 *
 * The ACL run parks on a gate the test holds, so "still running" is a state,
 * not a race. The platform is set to win32 because `applyPrivateDirAcl` returns
 * at once anywhere else, which would make this pass on Linux CI over nothing.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({ release: undefined as undefined | (() => void), calls: 0 }));

vi.mock(import("../../../src/server/integrations/acl-win.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  setRestrictiveAcl: vi.fn(async () => {
    gate.calls++;
    await new Promise<void>((resolve) => {
      gate.release = resolve;
    });
  }),
}));

import { quiesceForTesting } from "../../../src/server/annotations/store.js";
import {
  _resetPrivateDirAclForTests,
  ensurePrivateStoreDir,
} from "../../../src/server/file-io/private-dir.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("quiesceForTesting and the store's ACL run", () => {
  const realPlatform = process.platform;
  let dir: string;

  beforeEach(() => {
    gate.release = undefined;
    gate.calls = 0;
    _resetPrivateDirAclForTests();
    dir = mkdtempSync(join(tmpdir(), "tandem-quiesce-acl-"));
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    gate.release?.();
    _resetPrivateDirAclForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not resolve while an ACL run on a store directory is still going", async () => {
    await ensurePrivateStoreDir(join(dir, "annotations"));
    // Positive anchor: the ACL run really started and is parked.
    for (let i = 0; i < 100 && gate.calls === 0; i++) await tick(5);
    expect(gate.calls).toBe(1);

    let done = false;
    const quiesced = quiesceForTesting().then(() => {
      done = true;
    });
    await tick(50);
    expect(done, "quiesce returned with icacls still holding the directory").toBe(false);

    gate.release?.();
    await quiesced;
    expect(done).toBe(true);
  });
});
