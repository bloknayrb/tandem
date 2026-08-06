import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetSizeFieldWarningForTests,
  assertDocxWithinSizeLimits,
  DocxTooLargeError,
  declaredSize,
  MAX_DOCX_PART_BYTES,
  MAX_DOCX_TOTAL_BYTES,
} from "../../src/server/file-io/docx-size-gate.js";
import { rawDocx } from "../helpers/docx-corpus.js";

/**
 * #1310 — the decompressed-size ceiling.
 *
 * Two tests here exist specifically to fail the two designs this fix went through before landing.
 * They are marked in place, because without them a future simplification can quietly restore either
 * mistake and every other test in this file will still pass.
 */

/** An archive whose named entry inflates to `size` bytes but compresses to almost nothing. */
async function bombDocx(entry: string, size: number): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file(entry, Buffer.alloc(size, 0x41));
  return (await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })) as Buffer;
}

/**
 * Overwrite the uncompressed-size field in every central-directory record.
 *
 * Central-directory file header (PKWARE APPNOTE 4.3.12): signature `PK\x01\x02` = 0x02014b50, with
 * the uncompressed size a 4-byte little-endian value at offset 24. JSZip builds its entry list from
 * these records and deliberately ignores the local header's copy, so this is the field it reads —
 * and nothing validates it against the deflate stream.
 */
function patchCentralDirectoryUncompressedSize(
  buf: Buffer,
  entryName: string,
  lie: number,
): Buffer {
  const out = Buffer.from(buf);
  const target = Buffer.from(entryName, "utf8");
  let patched = 0;
  for (let i = 0; i + 46 <= out.length; i++) {
    if (out.readUInt32LE(i) !== 0x02014b50) continue;
    // Patch ONLY the named entry. Rewriting every record also breaks the tiny parts (a 9-byte
    // [Content_Types].xml suddenly claiming 128), which makes the archive fail for a reason that has
    // nothing to do with the bomb — the first draft of this helper did exactly that and the test
    // passed for the wrong reason.
    const nameLen = out.readUInt16LE(i + 28);
    if (out.subarray(i + 46, i + 46 + nameLen).equals(target)) {
      out.writeUInt32LE(lie, i + 24);
      patched++;
    }
  }
  if (patched !== 1) throw new Error(`expected 1 central-directory record, patched ${patched}`);
  return out;
}

afterEach(() => {
  _resetSizeFieldWarningForTests();
  vi.restoreAllMocks();
});

describe("docx size gate", () => {
  it("admits an ordinary document untouched", async () => {
    const buf = await rawDocx({ body: "<w:p><w:r><w:t>hello</w:t></w:r></w:p>" });
    await expect(assertDocxWithinSizeLimits(buf)).resolves.toBeUndefined();
  });

  it("refuses a part that expands past the per-part ceiling", async () => {
    const buf = await bombDocx("word/document.xml", 4 * 1024 * 1024);
    await expect(
      assertDocxWithinSizeLimits(buf, {
        maxPartBytes: 1024 * 1024,
        maxTotalBytes: 8 * 1024 * 1024,
      }),
    ).rejects.toBeInstanceOf(DocxTooLargeError);
  });

  it("refuses on the SUM across entries, not just any single one", async () => {
    // Each part is comfortably under the per-part ceiling; together they are not. A per-part-only
    // guard passes this, which is why the total exists — mammoth resolves what to read through
    // relationships, so a hostile package can spread the payload across parts it chooses.
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    for (const name of ["word/document.xml", "word/styles.xml", "word/numbering.xml"]) {
      zip.file(name, Buffer.alloc(600 * 1024, 0x41));
    }
    const buf = (await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })) as Buffer;

    await expect(
      assertDocxWithinSizeLimits(buf, {
        maxPartBytes: 1024 * 1024,
        maxTotalBytes: 1024 * 1024,
      }),
    ).rejects.toBeInstanceOf(DocxTooLargeError);
  });

  /**
   * REGRESSION GUARD — kills the declared-size-only design.
   *
   * The first attempt gated on `_data.uncompressedSize`, which JSZip reads raw off the ZIP central
   * directory with no cross-check against the actual stream. An archive can simply lie about it.
   *
   * The lie has to be written into the BUFFER's bytes, not into a loaded JSZip object: the gate
   * calls `loadAsync` itself, so tampering with an in-memory instance proves nothing — the gate
   * would re-read the honest value and this test would pass against the very design it exists to
   * kill. (It did, in its first draft.) So patch the central-directory record and assert the lie
   * survives a reload, which is the positive control.
   */
  it("refuses an archive that LIES about its declared size", async () => {
    const buf = await bombDocx("word/document.xml", 4 * 1024 * 1024);
    const tampered = patchCentralDirectoryUncompressedSize(buf, "word/document.xml", 128);

    // Positive control: the gate's own view of the declared size must actually be the lie. Without
    // this, a failure to patch would look like the streaming pass succeeding.
    const reloaded = await JSZip.loadAsync(tampered);
    expect(declaredSize(reloaded.file("word/document.xml"), "test")).toBe(128);

    // 128 declared sails under any declared-size check. Only the streaming pass is left.
    const err = await assertDocxWithinSizeLimits(tampered, {
      maxPartBytes: 1024 * 1024,
      maxTotalBytes: 1024 * 1024,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DocxTooLargeError);

    // And it must be the CAP that refused, not JSZip's own declared-vs-actual assertion. Both now
    // surface as DocxTooLargeError, so without this the test would still pass if the early abort
    // stopped working and the entry inflated fully before anything complained — which is precisely
    // the failure this guard is about.
    expect(err.message).toMatch(/expands past/);
    expect(err.message).not.toMatch(/could not be read/);
  });

  it("bounds the work it does — a 64 MiB bomb is refused without inflating 64 MiB", async () => {
    // The point of streaming is that `destroy()` propagates pause() back through JSZip's worker
    // chain and actually stops inflation. If it ever silently degrades to "decompress everything,
    // then check the length", this stays correct but stops being a defence. Time is the only
    // available proxy for that, so the bound is deliberately loose enough not to flake.
    const buf = await bombDocx("word/document.xml", 64 * 1024 * 1024);
    expect(buf.length).toBeLessThan(1024 * 1024); // ~1000:1, an ordinary deflate ratio

    const started = Date.now();
    await expect(
      assertDocxWithinSizeLimits(buf, { maxPartBytes: 1024 * 1024, maxTotalBytes: 1024 * 1024 }),
    ).rejects.toBeInstanceOf(DocxTooLargeError);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("stays silent on corrupt or non-ZIP input, leaving the real parser to report it", async () => {
    // A size gate answering "too large" for a truncated file sends the reader somewhere useless.
    await expect(assertDocxWithinSizeLimits(Buffer.from("not a zip"))).resolves.toBeUndefined();
  });

  it("says so once when JSZip stops exposing the declared-size field", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // A dead guard and a working guard are indistinguishable on benign input, so the disappearance
    // has to announce itself rather than degrade in silence.
    expect(declaredSize({ _data: {} }, "docx-size-gate")).toBeUndefined();
    expect(declaredSize({ _data: {} }, "docx-size-gate")).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain("[docx-size-gate]");
  });

  it("tags the warning with the CALLER, not this module", async () => {
    // Every module in file-io/ labels its own diagnostics, and Copy Diagnostics is read by humans
    // working out which component failed. A hardcoded tag would misattribute every caller.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    declaredSize({ _data: {} }, "docx-apply");
    expect(spy.mock.calls[0][0]).toContain("[docx-apply]");
  });

  it("ships ceilings that are ordered and non-trivial", async () => {
    // Pinned so that changing them is a decision rather than a drift. No in-repo evidence sets
    // these numbers — every .docx fixture here is KB-scale — so the test guards the shape, not the
    // magnitude: a per-part ceiling above the total would make the total unreachable.
    expect(MAX_DOCX_PART_BYTES).toBeLessThanOrEqual(MAX_DOCX_TOTAL_BYTES);
    expect(MAX_DOCX_PART_BYTES).toBeGreaterThan(1024 * 1024);
  });
});

describe("the assumption the gate rests on", () => {
  /**
   * REGRESSION GUARD — kills the design silently, with no other test failing.
   *
   * The gate and mammoth open the SAME buffer through SEPARATE JSZip instances. That is only safe
   * because both parses are identical, which holds because JSZip builds its file list from the
   * central directory and distrusts local headers — and because exactly one jszip exists in the
   * tree. If mammoth ever denests its own copy at a different version with different
   * ZIP64/duplicate-name handling, the two reads stop being guaranteed to agree and the gate can be
   * made to see something mammoth does not.
   *
   * That is a lockfile fact, not a design property. Nothing else in this suite would notice.
   */
  it("resolves exactly one jszip for both Tandem and mammoth", async () => {
    const ours = await import("jszip/package.json", { with: { type: "json" } });
    const theirs = await import("mammoth/node_modules/jszip/package.json", {
      with: { type: "json" },
    }).then(
      (m) => m.default.version as string,
      () => undefined, // no nested copy — this is the state we want
    );

    expect(
      theirs,
      "mammoth has denested its own jszip; the size gate and mammoth may no longer parse the " +
        "archive identically. Re-verify the gate before relaxing this test.",
    ).toBeUndefined();
    expect(ours.default.version).toMatch(/^3\./);
  });
});
