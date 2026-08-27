import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnreadableFile } from "../../src/cli/annotation-store-scan.js";
import {
  ANNOTATION_SCAN_MAX_FILE_BYTES,
  ANNOTATION_SCAN_MAX_FILES,
  ANNOTATION_SCAN_MAX_SAMPLE_NAMES,
  ANNOTATION_SCAN_MAX_TOTAL_BYTES,
  resolveScanLimits,
  scanAnnotationStore,
} from "../../src/cli/annotation-store-scan.js";
import { LOCAL_EXTENDED_PATHS, NETWORK_PATHS } from "../helpers/unc-fixtures.js";

/**
 * Behaviour of the bounded annotation-store scan.
 *
 * **The failure this suite exists for is a `pass` over data nobody read.** The
 * predecessor check counted "corrupt" files by *filename* and swallowed its own
 * parse failures in an empty catch, so a store whose every active file was
 * garbage reported a healthy doc count and no warning. Every assertion about
 * `unreadableActive` below is pinning that specific lie.
 *
 * Caps are exercised through the test-only `limits` override rather than by
 * writing 512 files or an 8 MiB one. That makes it possible for a shrunken
 * default to hide behind a passing limit test, so the defaults are pinned
 * separately in "scan defaults match the exported caps" — treat those two as
 * one check.
 */

/**
 * `vi.hoisted` + `vi.mock`, not `vi.spyOn`: the scanner imports `readdir` /
 * `stat` / `readFile` from `node:fs/promises` directly, and an ESM module
 * namespace is not configurable, so `vi.spyOn(fsp, …)` throws. Same technique
 * as `tests/cli/doctor-path-safety.test.ts`.
 */
const { _readdirSpy, _statSpy, _readFileSpy } = vi.hoisted(() => ({
  _readdirSpy: vi.fn(),
  _statSpy: vi.fn(),
  _readFileSpy: vi.fn(),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  _readdirSpy.mockImplementation(actual.readdir as never);
  _statSpy.mockImplementation(actual.stat as never);
  _readFileSpy.mockImplementation(actual.readFile as never);
  return { ...actual, readdir: _readdirSpy, stat: _statSpy, readFile: _readFileSpy };
});

const VALID_DOC = {
  schemaVersion: 1,
  docHash: "abc123",
  meta: { filePath: "/tmp/doc.md", lastUpdated: 0 },
  annotations: [],
  tombstones: [],
  replies: [],
};

let dir: string;
let consoleErrorSpy: MockInstance;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tandem-scan-"));
  // `parseAnnotationDoc` logs its own reason for every refusal. That is
  // deliberate in production (see the module header) and pure noise here.
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  // Clear counts only. `mockRestore`/`restoreAllMocks` would drop the
  // implementations installed in the factory above, and every later test would
  // then call a `vi.fn()` that returns undefined instead of touching the disk.
  _readdirSpy.mockClear();
  _statSpy.mockClear();
  _readFileSpy.mockClear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  consoleErrorSpy.mockRestore();
});

function writeDoc(name: string, body: unknown): void {
  writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
}

describe("scanAnnotationStore — path screening", () => {
  for (const [label, hostile] of [...NETWORK_PATHS, ...LOCAL_EXTENDED_PATHS]) {
    it(`refuses a ${label} before any filesystem call`, async () => {
      // The vulnerability is that the syscall happened, not what it returned:
      // on Windows a UNC read performs the SMB handshake that leaks an NTLM
      // hash, and an unreachable host produces the same refusal either way, so
      // asserting on the return value passes against the vulnerable code.
      const result = await scanAnnotationStore(hostile);

      expect(result.kind).toBe("unsafe-path");
      expect(_readdirSpy).not.toHaveBeenCalled();
      expect(_statSpy).not.toHaveBeenCalled();
      expect(_readFileSpy).not.toHaveBeenCalled();
    });
  }

  it("reports absent rather than unreadable for a directory that does not exist", async () => {
    const result = await scanAnnotationStore(join(dir, "nope"));
    expect(result.kind).toBe("absent");
  });
});

describe("scanAnnotationStore — verdicts", () => {
  it("reports a clean store as complete with nothing unreadable", async () => {
    writeDoc("a.json", VALID_DOC);
    writeDoc("b.json", VALID_DOC);

    const result = await scanAnnotationStore(dir);
    expect(result).toMatchObject({
      kind: "scanned",
      scan: "complete",
      docCount: 2,
      examined: 2,
      unreadableActive: 0,
      futureActive: 0,
      oversize: 0,
      schemaVersion: 1,
    });
  });

  it("counts a malformed ACTIVE file — the case the old check reported as healthy", async () => {
    writeDoc("good.json", VALID_DOC);
    writeDoc("broken.json", "{ this is not json");

    const result = await scanAnnotationStore(dir);
    expect(result).toMatchObject({
      kind: "scanned",
      docCount: 2,
      unreadableActive: 1,
      // The name matters: `parseAnnotationDoc` logs a reason but never says
      // which file, so this is the only place an operator learns where to look.
      unreadableSample: [{ name: "broken.json", reason: "not-json" }],
    });
  });

  it("counts a file that parses as JSON but is not a valid envelope", async () => {
    // A plain `JSON.parse` check would call this healthy. The loader would not
    // load it, which is the question the check is actually asked.
    writeDoc("shaped-wrong.json", { schemaVersion: 1, annotations: "not an array" });

    const result = await scanAnnotationStore(dir);
    expect(result).toMatchObject({ unreadableActive: 1, docCount: 1 });
  });

  it("separates a future-schema ACTIVE file from an unreadable one", async () => {
    writeDoc("future.json", { ...VALID_DOC, schemaVersion: 99 });

    const result = await scanAnnotationStore(dir);
    expect(result).toMatchObject({
      futureActive: 1,
      unreadableActive: 0,
      // Reported even though the loader refuses the file: an operator who just
      // downgraded needs the number, and it is the whole explanation.
      schemaVersion: 99,
    });
  });

  it("counts quarantined and parked files by name, without reading them", async () => {
    writeDoc("a.json", VALID_DOC);
    writeDoc("a.json.corrupt.1700000000000", "garbage");
    writeDoc("b.json.future", "garbage");

    const result = await scanAnnotationStore(dir);
    expect(result).toMatchObject({
      docCount: 1,
      quarantined: 1,
      parkedFuture: 1,
      unreadableActive: 0,
    });
  });

  it("ignores the lockfile and any non-.json entry", async () => {
    writeDoc("a.json", VALID_DOC);
    writeFileSync(join(dir, "store.lock"), "1234");
    mkdirSync(join(dir, "subdir"));

    const result = await scanAnnotationStore(dir);
    expect(result).toMatchObject({ docCount: 1, examined: 1, unreadableActive: 0 });
  });

  it("reports the FIRST schema version it sees, not the last", async () => {
    // Two files disagreeing is the only shape that distinguishes the two, and
    // the field's docblock claims "first". Without this the guard can be
    // deleted and nothing notices.
    writeDoc("a.json", VALID_DOC);
    writeDoc("b.json", { ...VALID_DOC, schemaVersion: 99 });
    utimesSync(join(dir, "a.json"), new Date(1_000_000), new Date(1_000_000));

    const result = await scanAnnotationStore(dir);
    // `readdir` returns a.json first, so "first observed" is a.json's 1.
    expect(result).toMatchObject({ schemaVersion: 1, futureActive: 1 });
  });

  it("picks the newest file by mtime, not by scan order", async () => {
    writeDoc("a.json", VALID_DOC);
    writeDoc("b.json", VALID_DOC);
    // Explicit mtimes: two writes in the same tick can tie on a coarse clock,
    // and a tie would let "last one processed" pass for the right reason.
    utimesSync(join(dir, "a.json"), new Date(9_000_000), new Date(9_000_000));
    utimesSync(join(dir, "b.json"), new Date(1_000_000), new Date(1_000_000));

    const result = await scanAnnotationStore(dir);
    expect((result as { newest: { name: string } }).newest.name).toBe("a.json");
  });

  it("reports an existing but empty store as a complete scan of nothing", async () => {
    // Materially different from `absent`: the directory exists, so the message
    // and the result shape both differ, and neither was covered.
    const result = await scanAnnotationStore(dir);
    expect(result).toMatchObject({
      kind: "scanned",
      scan: "complete",
      docCount: 0,
      examined: 0,
      unreadableActive: 0,
      schemaVersion: null,
      newest: null,
    });
  });

  it("reports a store holding only quarantined and parked files", async () => {
    writeDoc("a.json.corrupt.1700000000000", "garbage");
    writeDoc("b.json.future", "garbage");

    const result = await scanAnnotationStore(dir);
    expect(result).toMatchObject({
      docCount: 0,
      quarantined: 1,
      parkedFuture: 1,
      unreadableActive: 0,
    });
  });

  it("counts a file holding literal JSON null as unreadable", async () => {
    writeDoc("null.json", "null");
    const result = await scanAnnotationStore(dir);
    expect(result).toMatchObject({
      unreadableActive: 1,
      unreadableSample: [{ name: "null.json", reason: "invalid-envelope" }],
    });
  });

  it("counts a directory named like a store file as unreadable, not as a race", async () => {
    // `stat` succeeds and `readFile` throws EISDIR. That is not ENOENT, so it
    // must not take the benign-race path — a mutation that widened the race
    // check to any read error would make it vanish from the report.
    mkdirSync(join(dir, "weird.json"));
    const result = await scanAnnotationStore(dir);
    expect(result).toMatchObject({
      unreadableActive: 1,
      unreadableSample: [{ name: "weird.json", reason: "io-error", code: "EISDIR" }],
    });
  });

  it("counts a file that vanishes between the listing and the read", async () => {
    // The real interleaving: quarantining an unloadable file is a `rename`, so
    // a live server can make a file doctor is examining stop existing under
    // that name mid-scan. Before `vanished` existed this file was in no bucket
    // at all — not unreadable, not quarantined under its new name — so the one
    // failure mode with no trace anywhere in the report was the one where the
    // store was actively dealing with corruption.
    writeDoc("racing.json", VALID_DOC);
    _readFileSpy.mockImplementationOnce(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const result = await scanAnnotationStore(dir);
    expect(result).toMatchObject({
      kind: "scanned",
      scan: "complete",
      docCount: 1,
      // Stat'd, so examined; never opened, so not validated. `vanished` is
      // what makes that distinction legible.
      examined: 1,
      vanished: 1,
      unreadableActive: 0,
    });
  });

  it("does not treat a non-ENOENT read failure as a race", async () => {
    // Positive control for the row above: widening `isBenignRace` to any read
    // error would silently move real corruption into the benign bucket.
    writeDoc("denied.json", VALID_DOC);
    _readFileSpy.mockImplementationOnce(() => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });

    const result = await scanAnnotationStore(dir);
    expect(result).toMatchObject({
      vanished: 0,
      unreadableActive: 1,
      unreadableSample: [{ name: "denied.json", reason: "io-error", code: "EACCES" }],
    });
  });

  it("contains a validator that throws to the one file that caused it", async () => {
    // Every other fallible step in the loop is contained per file. If this one
    // were not, a future migration throwing on one malformed record would take
    // the whole check down and lose every other file's verdict with it.
    writeDoc("good.json", VALID_DOC);
    writeDoc("boom.json", VALID_DOC);
    const schema = await import("../../src/server/annotations/schema.js");
    const spy = vi.spyOn(schema, "parseAnnotationDoc");
    spy.mockImplementationOnce(() => {
      throw new Error("migration exploded");
    });

    const result = await scanAnnotationStore(dir);
    expect(result).toMatchObject({
      kind: "scanned",
      examined: 2,
      unreadableActive: 1,
      unreadableSample: [{ name: "boom.json", reason: "validator-threw" }],
    });
    spy.mockRestore();
  });

  it("caps the unreadable-name sample without capping the count", async () => {
    const n = ANNOTATION_SCAN_MAX_SAMPLE_NAMES + 3;
    for (let i = 0; i < n; i++) writeDoc(`bad-${i}.json`, "{");

    const result = await scanAnnotationStore(dir);
    expect(result).toMatchObject({ unreadableActive: n });
    expect((result as { unreadableSample: UnreadableFile[] }).unreadableSample).toHaveLength(
      ANNOTATION_SCAN_MAX_SAMPLE_NAMES,
    );
  });
});

describe("scanAnnotationStore — bounds", () => {
  it("reports an incomplete scan when the file cap is reached", async () => {
    for (let i = 0; i < 4; i++) writeDoc(`doc-${i}.json`, VALID_DOC);

    const result = await scanAnnotationStore(dir, { maxFiles: 2 });
    expect(result).toMatchObject({
      scan: "incomplete",
      limit: "files",
      examined: 2,
      // `docCount` stays the honest total. Reporting only what was examined
      // would make a truncated scan indistinguishable from a small store.
      docCount: 4,
    });
  });

  it("reports an incomplete scan when the total byte budget is reached", async () => {
    for (let i = 0; i < 4; i++) writeDoc(`doc-${i}.json`, VALID_DOC);

    const result = await scanAnnotationStore(dir, { maxTotalBytes: 1 });
    expect(result).toMatchObject({ scan: "incomplete", limit: "bytes", docCount: 4 });
    // The budget is checked before each file, so exactly one file is read
    // before it trips — the overshoot is one file, by construction.
    expect((result as { examined: number }).examined).toBe(1);
  });

  it("counts an oversize file without reading it, and does not call it unreadable", async () => {
    writeDoc("huge.json", "{ not json at all");

    const result = await scanAnnotationStore(dir, { maxFileBytes: 4 });
    expect(result).toMatchObject({
      oversize: 1,
      // If it had been read it would have failed to parse. That it does not
      // land in `unreadableActive` is the proof the read was skipped.
      unreadableActive: 0,
      scan: "complete",
      // An oversize file WAS examined — stat'd and judged. Counting it as
      // unexamined would understate what the scan looked at, which is the
      // number the incomplete-scan warning is derived from.
      examined: 1,
    });
    expect((result as { totalBytes: number }).totalBytes).toBeGreaterThan(4);
  });

  /**
   * The caps that are NOT exercised end-to-end need their wiring pinned, not
   * just their values.
   *
   * `maxFiles` has a real integration pin — `doctor.test.ts` writes
   * `ANNOTATION_SCAN_MAX_FILES + 1` files with no override. The two byte caps
   * have none, because writing an 8 MiB file per run is not worth it. So a
   * default written as a stray literal (`?? 1024`) rather than its constant
   * would leave every exported value correct and every cap test above green,
   * since those all pass explicit overrides. Pinning the resolver closes it.
   */
  it("resolves every unset cap to its exported constant", () => {
    expect(resolveScanLimits()).toEqual({
      maxFiles: ANNOTATION_SCAN_MAX_FILES,
      maxFileBytes: ANNOTATION_SCAN_MAX_FILE_BYTES,
      maxTotalBytes: ANNOTATION_SCAN_MAX_TOTAL_BYTES,
    });
    // And an override wins, which is what every bounds test above assumes.
    expect(resolveScanLimits({ maxFiles: 7 }).maxFiles).toBe(7);
    expect(resolveScanLimits({ maxFiles: 7 }).maxFileBytes).toBe(ANNOTATION_SCAN_MAX_FILE_BYTES);
  });

  it("keeps the exported caps at their reviewed values", () => {
    // Separate from the wiring test on purpose: one pins that the constant is
    // used, the other pins what it is. A single test conflating them passes
    // when either half is wrong.
    expect(ANNOTATION_SCAN_MAX_FILES).toBe(512);
    expect(ANNOTATION_SCAN_MAX_FILE_BYTES).toBe(8 * 1024 * 1024);
    expect(ANNOTATION_SCAN_MAX_TOTAL_BYTES).toBe(64 * 1024 * 1024);
  });

  it("scans a store well inside every default as complete", async () => {
    for (let i = 0; i < 3; i++) writeDoc(`doc-${i}.json`, VALID_DOC);
    const result = await scanAnnotationStore(dir);
    expect(result).toMatchObject({ scan: "complete", examined: 3 });
  });

  it("treats a file of exactly maxFileBytes as within the cap", async () => {
    // `>` not `>=`. Both existing bound tests use caps far below the real file
    // sizes, so neither discriminates the operator.
    writeDoc("exact.json", VALID_DOC);
    const size = statSync(join(dir, "exact.json")).size;

    expect(await scanAnnotationStore(dir, { maxFileBytes: size })).toMatchObject({ oversize: 0 });
    expect(await scanAnnotationStore(dir, { maxFileBytes: size - 1 })).toMatchObject({
      oversize: 1,
    });
  });
});
