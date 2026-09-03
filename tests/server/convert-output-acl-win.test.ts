/**
 * #1796 — real-`icacls` proof that `tandem_convertToMarkdown` reports a
 * permission failure on the output directory as `PERMISSION_DENIED`, from
 * whichever syscall trips on it.
 *
 * Why this has to be a Windows spec, and a real-ACL one:
 *
 * `convert.ts` first classified only `fs.realpath`'s errno. But `realpath`,
 * `findAvailablePath`'s `fs.access` probe and `atomicWrite`'s write are three
 * mouths of ONE funnel — no write permission on the output directory — and
 * which of them fails first is a function of the ACL's SHAPE, not of the
 * cause. Measured on Windows 11 (26200), unprivileged:
 *
 *   /deny (W)      → `fs.realpath` fails EPERM.
 *   /deny (WD,AD)  → realpath OK, `fs.stat` OK, `fs.access` ENOENT, and
 *                    `atomicWrite`'s writeFile fails EPERM.
 *
 * The second is the ORDINARY read-but-not-write directory. Unclassified it
 * surfaced over MCP as `INTERNAL_ERROR` and over `/api` as a 423 whose body
 * `sendApiError` overrides with "File is locked by another program." — so the
 * user closes Word, retries, and fails forever.
 *
 * POSIX cannot stand in for either half. It reports `EACCES` where Windows
 * reports `EPERM`, so the `EPERM` arm in `convert.ts` is reachable on Windows
 * ONLY — it is not a defensive extra alongside `EACCES`, it is the whole of the
 * Windows path, and a future reader who deletes it as dead code breaks
 * permission reporting on the one platform ubuntu `check` cannot see.
 *
 * Registered in `scripts/ci/windows-acl-proof.mjs` and run by the
 * `windows-acl-proof` CI job: a Windows-gated describe that no Windows job runs
 * is green forever and reads exactly like a pass (#1529). That runner requires
 * this suite to report >=1 passed, 0 skipped, 0 failed — hence `describe.runIf`
 * rather than per-`it` gating, and hence the preconditions below THROW rather
 * than skip when the host's ACL semantics differ.
 */

import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addDoc, removeDoc, setActiveDocId } from "../../src/server/documents/registry-testing.js";
import { convertToMarkdown } from "../../src/server/mcp/convert.js";
import { populateYDoc } from "../../src/server/mcp/document.js";
import { getOpenDocs } from "../../src/server/mcp/document-service.js";
import { systemBin } from "../../src/server/platform.js";
import { getOrCreateDocument } from "../../src/server/yjs/provider.js";

const WIN = process.platform === "win32";
const execFileAsync = promisify(execFile);

/** Current user's SID — the principal the deny ACE is written for. */
async function currentUserSid(): Promise<string> {
  const { stdout } = await execFileAsync(systemBin("whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
  return stdout.split(",")[1].replace(/"/g, "").trim();
}

async function icacls(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(systemBin("icacls.exe"), args);
  return stdout;
}

describe.runIf(WIN)("convert output permissions — Windows ACL proof (#1796)", () => {
  let counter = 0;
  /** [directory, sid] pairs whose deny ACE must come off before cleanup. */
  const denied: Array<[string, string]> = [];
  const roots: string[] = [];

  beforeEach(() => {
    for (const id of [...getOpenDocs().keys()]) removeDoc(id);
    setActiveDocId(null);
    counter += 1;
  });

  afterEach(async () => {
    // An unremoved deny ACE defeats `fs.rm` just as it defeated the write.
    for (const [dir, sid] of denied.splice(0)) {
      await icacls([dir, "/remove:d", `*${sid}`]).catch(() => {});
    }
    for (const root of roots.splice(0)) {
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  /** An open .docx whose conversion will target `outDir`. */
  function openDocxDoc(dir: string): string {
    const id = `convert-acl-doc-${counter}`;
    populateYDoc(getOrCreateDocument(id), "Hello world");
    addDoc(id, {
      id,
      filePath: path.join(dir, `${id}.docx`),
      format: "docx",
      readOnly: false,
      source: "file",
    });
    setActiveDocId(id);
    return id;
  }

  /**
   * A fresh output directory carrying `denySpec` against the current user.
   *
   * `denySpec` is an `icacls` rights string: `(W)` denies write broadly and
   * `(WD,AD)` denies only "create files" / "create folders", leaving traversal
   * and read intact. The difference between them is the entire point of this
   * suite — it decides WHICH syscall reports the failure.
   */
  async function deniedOutputDir(denySpec: string): Promise<{ id: string; outDir: string }> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tandem-convert-acl-"));
    roots.push(root);
    const id = openDocxDoc(root);
    const outDir = path.join(root, "out");
    await fsp.mkdir(outDir);
    const sid = await currentUserSid();
    await icacls([outDir, "/deny", `*${sid}:${denySpec}`]);
    denied.push([outDir, sid]);
    return { id, outDir };
  }

  /**
   * THROWS rather than skips, deliberately. A host where the deny ACE did not
   * bite has not shown the product is fine — it has shown this test is void,
   * and silently passing on a void fixture is the #1529 defect the
   * `windows-acl-proof` job exists to close. The DACL goes in the message
   * because the cause is always a host difference in how `icacls` computed it.
   */
  async function assertDenyTook(outDir: string, expectFailingCall: () => Promise<unknown>) {
    try {
      await expectFailingCall();
    } catch {
      return; // Denied, as intended.
    }
    const dump = await icacls([outDir]).catch((err) => `<icacls failed: ${String(err)}>`);
    throw new Error(
      `#1796 fixture precondition failed: the deny ACE on ${outDir} did not bite, so nothing ` +
        `this spec asserts about permission classification would mean anything.\n` +
        `DACL:\n${dump}`,
    );
  }

  it("deny (W): realpath itself fails EPERM and is reported as PERMISSION_DENIED", async () => {
    const { id, outDir } = await deniedOutputDir("(W)");
    // Precondition AND the measurement this spec pins: on Windows the errno is
    // EPERM, so `convert.ts`'s EACCES/EPERM arm is load-bearing here and the
    // EACCES half alone (all POSIX can prove) would let this through unmapped.
    await assertDenyTook(outDir, () => fsp.realpath(outDir));
    await expect(fsp.realpath(outDir)).rejects.toMatchObject({ code: "EPERM" });

    await expect(convertToMarkdown(id, outDir)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      message: expect.stringContaining(outDir),
    });
    // Which arm fired: the resolver's, not the writer's.
    await expect(convertToMarkdown(id, outDir)).rejects.toMatchObject({
      message: expect.stringContaining("resolving output directory"),
    });
  });

  it("deny (WD,AD): realpath/stat/access all succeed and the WRITE fails as PERMISSION_DENIED", async () => {
    const { id, outDir } = await deniedOutputDir("(WD,AD)");
    // The shape that was reported wrongly. Every check `convert.ts` performs
    // BEFORE the write passes cleanly, which is why classifying `realpath`
    // alone could not catch it — pinned here so a "realpath already covers
    // this" simplification of the write-path catch fails loudly.
    await expect(fsp.realpath(outDir)).resolves.toBeTypeOf("string");
    await expect(fsp.stat(outDir).then((s) => s.isDirectory())).resolves.toBe(true);
    await assertDenyTook(outDir, () => fsp.writeFile(path.join(outDir, "probe.tmp"), "x"));

    await expect(convertToMarkdown(id, outDir)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      message: expect.stringContaining(outDir),
    });
    // Which arm fired: the writer's, not the resolver's. Without this the spec
    // above would pass on a build where only `realpath` is classified.
    await expect(convertToMarkdown(id, outDir)).rejects.toMatchObject({
      message: expect.stringContaining("writing to output directory"),
    });
  });
});
