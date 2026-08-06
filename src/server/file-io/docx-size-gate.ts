import JSZip from "jszip";

/**
 * Decompressed-size ceiling for untrusted `.docx` archives (#1310).
 *
 * ## Why this is a gate on the buffer, not a check inside each reader
 *
 * `docxAdapter.parse` hands one untrusted buffer to four readers concurrently, and the FIRST of them
 * is mammoth — which vendors its own JSZip (`mammoth/lib/zipfile.js`) and does its own unguarded
 * `.async("uint8array")`. Mammoth exposes no size option and runs its own zip load, so nothing
 * applied to *this* codebase's `.async("text")` call sites can reach it. It also reads more parts
 * than Tandem's own readers combined, following OPC relationships rather than fixed literal paths.
 *
 * The first attempt at this fix did exactly that — gated our four call sites — and would have
 * shipped green while leaving the largest reader completely unguarded. That is why the check lives
 * here, ahead of everyone: a reader that never receives a hostile buffer needs no guard of its own,
 * including readers added later.
 *
 * ## Why both a declared-size check and a streaming one
 *
 * `uncompressedSize` is read raw off the ZIP central directory (`jszip/lib/zipEntry.js`) with no
 * cross-check against actual bytes or CRC, so a crafted archive can declare anything. Declared size
 * alone is defeated by a one-field edit — which is exactly the weakness the sibling header/footer
 * guard in `docx-lost-features.ts` documents about itself.
 *
 * So the declared pass is a free early-out for the honest case, and the streaming pass is the actual
 * guarantee. Measured on this repo's jszip: 64 MiB of compressible XML packs to 65,451 bytes
 * (1025:1 — ordinary, not exotic), and aborting a `nodeStream()` past a 1 MiB cap stops at 1,064,960
 * bytes in 57 ms. The overshoot is one 16 KiB `DataWorker` chunk, because `pause()` propagates back
 * up the worker chain and genuinely halts inflation rather than merely discarding output.
 *
 * ## Why a total across all entries, not an allowlist of known parts
 *
 * Mammoth resolves what to read through relationships, and a hostile package can point a
 * relationship at any archive member. "The parts mammoth reads" is therefore not a static set, and
 * an allowlist keyed to conventional names (`document.xml`, `styles.xml`, …) is the same shape of
 * mistake as guarding only our own call sites: correct against the sample in front of you, blind to
 * the next one.
 */

/**
 * Per-entry ceiling. A `word/document.xml` at this size is an enormous document — the largest real
 * fixture in this repo is 11.7 KB.
 */
export const MAX_DOCX_PART_BYTES = 32 * 1024 * 1024;

/**
 * Ceiling on the sum across every entry.
 *
 * Sized against `docx-verify.ts`'s `MAX_VERIFY_BYTES` (25 MiB), which is the largest *compressed*
 * buffer Tandem will re-import to verify its own export: a `.docx` that big is mostly already-
 * compressed images at ~1:1, with XML a small fraction, so a legitimate worst case decompresses to
 * tens of MiB rather than hundreds. Peak memory is bounded at roughly this times three concurrent
 * main-part readers times two for UTF-16, i.e. ~384 MB.
 *
 * NO IN-REPO EVIDENCE SETS THIS NUMBER. Every `.docx` fixture here is KB-scale, so nothing available
 * measures a realistically large legitimate document. It is a judgement call with headroom, pinned
 * by tests so that changing it is a decision rather than a drift.
 */
export const MAX_DOCX_TOTAL_BYTES = 64 * 1024 * 1024;

export interface DocxSizeLimits {
  maxPartBytes?: number;
  maxTotalBytes?: number;
}

export class DocxTooLargeError extends Error {
  readonly code = "DOCX_TOO_LARGE";
  constructor(
    message: string,
    readonly entryCount: number,
  ) {
    super(message);
    this.name = "DocxTooLargeError";
  }
}

/**
 * Best-effort declared uncompressed size.
 *
 * `_data` is a JSZip internal with no compatibility guarantee. If it moves, every entry looks
 * size-less and the early-out silently stops existing — and a dead guard is indistinguishable from a
 * working one on benign input. Say so once. The streaming pass below still holds, which is the whole
 * reason it is not optional.
 *
 * The tag is caller-supplied because every module in this directory labels its own diagnostics, and
 * Copy Diagnostics is read by humans trying to work out which component failed.
 */
let warnedMissingSizeField = false;
export function declaredSize(file: unknown, tag: string): number | undefined {
  const size = (file as { _data?: { uncompressedSize?: unknown } })?._data?.uncompressedSize;
  if (typeof size === "number") return size;
  if (file && !warnedMissingSizeField) {
    warnedMissingSizeField = true;
    console.error(
      `[${tag}] JSZip no longer exposes _data.uncompressedSize; the declared-size ` +
        "early-out is inactive (the streaming ceiling still applies)",
    );
  }
  return undefined;
}

/** Test seam: the warn-once latch is module state and would otherwise leak between tests. */
export function _resetSizeFieldWarningForTests(): void {
  warnedMissingSizeField = false;
}

/**
 * Count an entry's real decompressed bytes, abandoning the stream once it passes `limit`.
 *
 * Returns the bytes seen, which is `> limit` exactly when the entry is oversized. We deliberately do
 * not decode to a string: this counts bytes to decide admission, and building the string is the very
 * allocation being guarded against.
 */
function measureEntry(file: JSZip.JSZipObject, limit: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let seen = 0;
    let settled = false;
    // JSZip types this as a bare `ReadableStream`, but it returns its own
    // `NodejsStreamOutputAdapter`, which extends `stream.Readable` and does implement `destroy()`.
    // The cast is to the runtime truth, and it is load-bearing: `destroy()` is what propagates
    // `pause()` back through the worker chain and actually stops inflation. Without it this measures
    // a bomb by decompressing all of it, which is the thing being prevented.
    const stream = file.nodeStream("nodebuffer") as NodeJS.ReadableStream & { destroy(): void };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    stream.on("data", (chunk: Buffer) => {
      seen += chunk.length;
      if (seen > limit) {
        // Destroying propagates pause() back through the worker chain, so inflation stops here
        // rather than running to completion with the output thrown away.
        stream.destroy();
        finish(() => resolve(seen));
      }
    });
    stream.on("end", () => finish(() => resolve(seen)));
    stream.on("close", () => finish(() => resolve(seen)));
    stream.on("error", (err: Error) => finish(() => reject(err)));
    // NOTE on JSZip's own size check: it throws "Bug : uncompressed data size mismatch" when the
    // inflated length disagrees with the declared one — but measured, that fires only AFTER the
    // entry is fully inflated (67,108,864 bytes in 165 ms for a 64 MiB bomb). It is a post-hoc
    // integrity assertion, not a ceiling: by the time it throws, the allocation this module exists
    // to prevent has already happened. So it is not a substitute for the cap above, and an archive
    // that trips it is malformed rather than merely large — `assertDocxWithinSizeLimits` classifies
    // it accordingly instead of surfacing a message with the word "Bug" in it.
  });
}

/**
 * Throw unless every entry, and their sum, decompress within the limits.
 *
 * Call this before the buffer reaches any reader. Corrupt or non-ZIP input is NOT this function's
 * problem — it resolves quietly and lets the real parser produce the honest error, because a size
 * gate reporting "too large" for a truncated file would send the reader somewhere useless.
 */
export async function assertDocxWithinSizeLimits(
  buffer: Buffer,
  limits: DocxSizeLimits = {},
): Promise<void> {
  const maxPart = limits.maxPartBytes ?? MAX_DOCX_PART_BYTES;
  const maxTotal = limits.maxTotalBytes ?? MAX_DOCX_TOTAL_BYTES;

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return; // Not our error to report.
  }

  const entries: JSZip.JSZipObject[] = [];
  zip.forEach((_path, file) => {
    if (!file.dir) entries.push(file);
  });

  // Pass 1 — declared sizes. Free, and rejects an honest bomb without inflating a byte. A liar
  // survives this and is caught below; that is the division of labour, not a gap.
  let declaredTotal = 0;
  for (const entry of entries) {
    const declared = declaredSize(entry, "docx-size-gate");
    if (declared === undefined) continue;
    if (declared > maxPart) {
      throw new DocxTooLargeError(
        `A part of this .docx declares ${mib(declared)} uncompressed, over the ${mib(maxPart)} limit.`,
        entries.length,
      );
    }
    declaredTotal += declared;
    if (declaredTotal > maxTotal) {
      throw new DocxTooLargeError(
        `This .docx declares more than ${mib(maxTotal)} of uncompressed content.`,
        entries.length,
      );
    }
  }

  // Pass 2 — actual bytes. Sequential on purpose: the point is to bound peak memory, and measuring
  // every entry at once would reintroduce the concurrency this exists to survive.
  let actualTotal = 0;
  for (const entry of entries) {
    const remaining = Math.min(maxPart, maxTotal - actualTotal);
    let seen: number;
    try {
      seen = await measureEntry(entry, remaining);
    } catch (err) {
      // An entry that completes under the cap and still fails to inflate is malformed — most often
      // JSZip's declared-vs-actual mismatch. Refuse it here rather than letting a reader meet it
      // later: the readers downstream are more forgiving than they look (htmlparser2 parses garbage
      // into a text node without throwing), so passing a known-inconsistent archive through means
      // importing whatever partial nonsense it yields.
      throw new DocxTooLargeError(
        `This .docx could not be read: ${err instanceof Error ? err.message : String(err)}`,
        entries.length,
      );
    }
    if (seen > remaining) {
      throw new DocxTooLargeError(
        seen > maxPart
          ? `A part of this .docx expands past the ${mib(maxPart)} per-part limit.`
          : `This .docx expands past the ${mib(maxTotal)} total limit.`,
        entries.length,
      );
    }
    actualTotal += seen;
  }
}

function mib(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

export const _internals = { measureEntry };
