/**
 * #2436: the refusal contract of two `applyConfig` calls on one path, forced
 * deterministically on every platform.
 *
 * On Windows two renames onto one destination can collide and one is refused
 * (EPERM, EBUSY or EACCES). `applyConfig` deliberately does not retry: in
 * apply.ts's `atomicWrite`, "Unprepared temps keep a single try: their ACL step
 * runs between the close and the rename". Reading of this test (not the code's
 * stated reason): a retry with nothing to re-check against could also replace a
 * write that finished during the back-off, which is the lost update #1599
 * accepts, delivered silently. So the refused caller rejects, the other lands
 * whole, and nothing is left behind.
 *
 * This file pins TODAY's single try. Whether `applyConfig` should retry is a
 * product question for Bryan (#2436), not a test question: change it on
 * purpose, with this file. `node:fs/promises`' `rename` is refused here by the
 * temp's content, so no timing is involved. The second describe reads
 * `process.platform` as "win32", because the retry helper acts only there.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refusal = vi.hoisted(() => ({
  /** Refuse the rename whose source temp contains this text, once. */
  armedToken: undefined as string | undefined,
  code: "EPERM",
  refused: 0,
  renames: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const rename: typeof actual.rename = async (from, to) => {
    refusal.renames++;
    if (refusal.armedToken !== undefined) {
      const text = await actual.readFile(from, "utf-8");
      if (text.includes(refusal.armedToken)) {
        refusal.armedToken = undefined;
        refusal.refused++;
        throw Object.assign(new Error(`${refusal.code}: operation not permitted, rename`), {
          code: refusal.code,
          syscall: "rename",
        });
      }
    }
    return actual.rename(from, to);
  };
  return { ...actual, rename, default: { ...actual, rename } };
});

import { applyConfig } from "../../../src/server/integrations/apply.js";

const TOKEN_A = "sentinel-token-AAA";
const TOKEN_B = "sentinel-token-BBB";
const CODES = ["EPERM", "EBUSY", "EACCES"];
const ITERATIONS = 20;

const opsFor = (token: string) => ({
  create: {
    tandem: {
      type: "http" as const,
      url: "http://127.0.0.1:3479/mcp",
      headers: { Authorization: `Bearer ${token}` },
    },
  },
  remove: [],
});
const expectedFor = (token: string) =>
  `${JSON.stringify({ mcpServers: opsFor(token).create }, null, 2)}\n`;

async function withPlatform<T>(platform: NodeJS.Platform | undefined, run: () => Promise<T>) {
  if (platform === undefined) return run();
  const real = process.platform;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", { value: real });
  }
}

describe.each([
  ["the host platform", undefined],
  ["win32", "win32" as const],
])("applyConfig refuses, never retries, a refused rename (%s)", (_name, platform) => {
  let tmpDir: string;
  let savedAppData: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-refusal-"));
    savedAppData = process.env.TANDEM_APP_DATA_DIR;
    process.env.TANDEM_APP_DATA_DIR = path.join(tmpDir, "appdata");
    refusal.armedToken = undefined;
    refusal.refused = 0;
    refusal.renames = 0;
  });

  afterEach(async () => {
    if (savedAppData === undefined) delete process.env.TANDEM_APP_DATA_DIR;
    else process.env.TANDEM_APP_DATA_DIR = savedAppData;
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects the refused caller, lands the other whole and leaves no temp", async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const dir = await fs.promises.mkdtemp(path.join(tmpDir, `iter-${i}-`));
      const target = path.join(dir, ".claude.json");
      fs.writeFileSync(target, JSON.stringify({ mcpServers: {} }));

      const refusedIsB = i % 2 === 0;
      const [refusedToken, keptToken] = refusedIsB ? [TOKEN_B, TOKEN_A] : [TOKEN_A, TOKEN_B];
      refusal.armedToken = refusedToken;
      refusal.code = CODES[i % CODES.length];
      const before = refusal.refused;
      const renamesBefore = refusal.renames;

      const results = await withPlatform(platform, () =>
        Promise.allSettled([
          applyConfig(target, opsFor(TOKEN_A)),
          applyConfig(target, opsFor(TOKEN_B)),
        ]),
      );
      const ctx = `iteration ${i}, code ${refusal.code}`;
      const [refusedResult, keptResult] = refusedIsB
        ? [results[1], results[0]]
        : [results[0], results[1]];

      expect(refusedResult.status, ctx).toBe("rejected");
      const err = (refusedResult as PromiseRejectedResult).reason as NodeJS.ErrnoException;
      expect(err.code, ctx).toBe(refusal.code);
      expect(err.syscall, ctx).toBe("rename");
      expect(keptResult.status, ctx).toBe("fulfilled");

      expect(fs.readFileSync(target, "utf-8"), ctx).toBe(expectedFor(keptToken));
      expect(fs.readFileSync(target, "utf-8"), ctx).not.toContain(refusedToken);
      expect(fs.readdirSync(dir), ctx).toEqual([".claude.json"]);
      // One refusal, and one rename per caller: no retry, no extra write.
      expect(refusal.refused - before, ctx).toBe(1);
      expect(refusal.renames - renamesBefore, ctx).toBe(2);
    }
    expect(refusal.refused).toBe(ITERATIONS);
  });
});
