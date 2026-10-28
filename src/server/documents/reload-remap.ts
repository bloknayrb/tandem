/**
 * Carrying annotations across a content-replacing reload (#2269).
 *
 * Three paths replace an open document's whole body while its annotation map
 * stays: the file-watcher reload (`reloadFromDisk`, which restore-from-backup
 * and the external-conflict Reload reach too), `tandem_open force:true`, and
 * the source-view commit (both through `clearAndReload`). Replacing the
 * XmlFragment kills every RelativePosition anchored into it, so each record's
 * range has to be carried over by arithmetic. This module is that arithmetic,
 * run INSIDE the transaction that swaps the content, so no read can ever see a
 * record pointing into the destroyed fragment:
 *
 *   1. {@link captureRemapInput}, while the OLD fragment is still live: the old
 *      flat text and, per record, its old range — resolved through
 *      `refreshRange` against the old fragment, so a live relRange wins over a
 *      stale stored range, and the verdicts `refreshRange` deliberately
 *      withholds (`degraded`, `failed`) stay withheld.
 *   2. The caller replaces the content.
 *   3. {@link applyRemap}: diff old text against new ({@link lineHunks}: jsdiff's
 *      line diff, each hunk then narrowed to its first and last differing code
 *      unit) and move each record:
 *        - **Both endpoints outside every replaced region** — the record's own
 *          text is unchanged, or a hunk lies wholly inside it, or a pure
 *          DELETION clipped it. Each endpoint maps exactly, with the stick-right
 *          `from` / stick-left `to` convention a CRDT anchor follows (an
 *          endpoint inside a deletion goes to the deletion point, which is
 *          where such an anchor resolves; a point record sticks right), and the
 *          record is re-anchored there. That is what the same edit made in the
 *          editor would have done. A record whose every character was deleted
 *          maps to an empty range and collapses (below).
 *        - **An endpoint inside a replaced region** — the record is relocated by
 *          probing for its old text inside that hunk's new span (widened to the
 *          record's own mapped edges). A match in UNCHANGED text is never taken:
 *          everything outside the hunks held no such edit, so a copy there is a
 *          different copy.
 *        - **Moved text** — a line diff records a move as a deletion in one hunk
 *          and an insertion in ANOTHER, so the moved copy sits in that other
 *          hunk's new span, which the steps above never search. Only a TRUSTED,
 *          non-empty record whose every character was DELETED looks for it
 *          ({@link uniqueMovedMatch}), and the match is structural, not textual:
 *          the record's whole enclosing old line(s) must reappear verbatim, as
 *          whole lines, WHOLLY inside one other hunk's new span, with the record
 *          at the same offset in them — and the record's text must occur
 *          EXACTLY ONCE in the whole new text. That is what a line-diff move
 *          is; a probe that merely overlaps some other edit (a narrowed hunk is
 *          often one character) is a different copy, and so is text that also
 *          occurs anywhere else. A record whose own window held no match was
 *          edited in place, not moved, and detaches; so does an untrusted
 *          record, which has no verified old line to match.
 *        - **No match** — the record collapses to a point at the hunk start with
 *          its relRange stripped, and gains a `textSnapshot` of its OLD text if
 *          it had none. `refreshRange`'s lazy-attach gate then answers
 *          `degraded` for it forever: honest, and it paints nothing. Each
 *          collapse logs one `[reload-remap] detached annotation <id>` line.
 *        - **Found, but an endpoint cannot be anchored** (a heading prefix, an
 *          empty block's separator) — the range is kept without a relRange,
 *          which is what `anchoredRange`'s `fullyAnchored: false` means; it is
 *          not a failure.
 *
 *      Line granularity is the limit: two adjacent changed lines form one hunk,
 *      so a record whose text was cut inside such a merged region is detached
 *      rather than shrunk.
 *   4. {@link remapEnvelopeWins}, for the two `clearAndReload` paths on a
 *      file-backed document: the durable envelope is re-merged after the
 *      content swap, and wherever its copy of a record wins the merge, that copy
 *      still carries pre-reload coordinates. The same remap moves it, inside the
 *      merge's own transaction.
 *
 * ## Which old range, and which probe
 *
 * A record whose old range came from a LIVE relRange (`ok`/`updated`) or from a
 * stored range `refreshRange` verified (`attached`/`repaired`, or a `degraded`
 * whose stored range still holds its snapshot) is TRUSTED: its old text is
 * `oldText.slice(range)`, and that slice — not the creation-time `textSnapshot`,
 * which predates any edit the editor made inside a live anchor — is the probe.
 * The stored snapshot is left as it is, so `snapshotContradicts` still refuses an
 * Accept over text that changed since the suggestion was written.
 *
 * A record whose stored range CONTRADICTS its snapshot (no live relRange to say
 * where it really is) is UNTRUSTED. It is never minted a relRange from shifted
 * offsets — that would be the durable mispin #1764 removed. Outside every hunk
 * its stored range is shifted and left unanchored, so it reads `degraded` exactly
 * as before; inside a hunk its snapshot is the probe, and a match re-anchors it.
 *
 * ## What it never does
 *
 * Take a copy of the text found in unchanged regions, or one of several copies,
 * or one that merely overlaps some other edit. The watcher's old relocation pass
 * searched the whole document and took the nearest, which is how a record whose
 * text was deleted jumped onto another copy of it — and a false re-anchor is
 * worse than a detach: it reads `ok` with a fresh relRange, and a suggestion's
 * Accept then rewrites the wrong span with nothing to object, because the probe
 * IS the record's own text.
 *
 * `surrogates: "ignore"` below is one of Critical Rule 4's stored/derived-offset
 * callers: every offset here is derived from a stored range or a diff, nothing is
 * written to a file, and a mid-pair endpoint (a range whose emoji was edited in
 * the editor) is legitimate.
 */

import { diffLines } from "diff";
import type * as Y from "yjs";
import { Y_MAP_ANNOTATIONS } from "../../shared/constants.js";
import { type DocumentRange, toFlatOffset } from "../../shared/positions/types.js";
import { sanitizeAnnotation } from "../../shared/sanitize.js";
import { isSnapshotTruncated, snapshotSearchPrefix } from "../../shared/snapshot.js";
import type { Annotation } from "../../shared/types.js";
import { docHash } from "../annotations/doc-hash.js";
import { relaySanitizationEvent } from "../annotations/migration-log.js";
import { extractText, extractTextWithBreaks, type FlatBreak } from "../mcp/document-model.js";
import {
  anchoredRange,
  captureSnapshotFromText,
  describeRangeFailure,
  refreshRange,
  splitsSurrogatePair,
  storedRangeStillMatches,
} from "../positions.js";

/** One changed region: old `[oldFrom, oldTo)` became new `[newFrom, newTo)`. */
export interface Hunk {
  oldFrom: number;
  oldTo: number;
  newFrom: number;
  newTo: number;
}

/**
 * Edit-distance budget, in LINES, before the diff gives up. Past it `diffLines`
 * returns `undefined` and {@link lineHunks} falls back to one hunk spanning
 * everything between the common prefix and suffix — correct, merely coarse
 * (every record inside it is probed rather than shifted). A whole-file rewrite
 * is the realistic way to reach it, and there a coarse hunk costs nothing.
 */
const MAX_EDIT_LINES = 2000;

/**
 * The changed regions between two flat texts, ascending and disjoint, each
 * narrowed to its first and last differing code unit.
 *
 * Both texts get a trailing `"\n"` sentinel before the line diff, so the last
 * line compares like every other one (`"b"` against `"b\n"` would otherwise be
 * a changed line whenever text is appended), and the sentinel is then cut back
 * off. Narrowing never splits a surrogate pair: a boundary that would is moved
 * one unit outward, into the hunk.
 */
export function lineHunks(oldText: string, newText: string): Hunk[] {
  if (oldText === newText) return [];
  const whole: Hunk = { oldFrom: 0, oldTo: oldText.length, newFrom: 0, newTo: newText.length };
  const changes = diffLines(`${oldText}\n`, `${newText}\n`, { maxEditLength: MAX_EDIT_LINES });
  if (changes === undefined) {
    console.error(
      "[reload-remap] line diff exceeded %d edits; remapping through one hunk",
      MAX_EDIT_LINES,
    );
    const narrowed = narrowHunk(oldText, newText, whole);
    return narrowed ? [narrowed] : [];
  }

  const raw: Hunk[] = [];
  let o = 0;
  let n = 0;
  let open: Hunk | null = null;
  for (const change of changes) {
    const len = change.value.length;
    if (change.added || change.removed) {
      open ??= { oldFrom: o, oldTo: o, newFrom: n, newTo: n };
      if (change.added) {
        n += len;
        open.newTo = n;
      } else {
        o += len;
        open.oldTo = o;
      }
    } else {
      if (open) raw.push(open);
      open = null;
      o += len;
      n += len;
    }
  }
  if (open) raw.push(open);

  const out: Hunk[] = [];
  for (const h of raw) {
    const narrowed = narrowHunk(oldText, newText, dropSentinel(h, oldText.length, newText.length));
    if (narrowed) out.push(narrowed);
  }
  return out;
}

/**
 * Cut the trailing sentinel back off a hunk computed over `text + "\n"`.
 *
 * A hunk can reach the sentinel only as the LAST hunk, whose old and new sides
 * then both end at the augmented length (everything after it is common, and
 * nothing is). Clamping each end to the real length removes one unit from each
 * side; a start that sat past the real end moves back by the same amount on
 * both sides, so the two sides still describe the same replacement.
 */
function dropSentinel(h: Hunk, oldLen: number, newLen: number): Hunk {
  const out = { ...h };
  if (out.oldTo > oldLen || out.newTo > newLen) {
    out.oldTo = Math.min(out.oldTo, oldLen);
    out.newTo = Math.min(out.newTo, newLen);
  }
  if (out.oldFrom > oldLen) {
    out.newFrom -= out.oldFrom - oldLen;
    out.oldFrom = oldLen;
  }
  if (out.newFrom > newLen) {
    out.oldFrom -= out.newFrom - newLen;
    out.newFrom = newLen;
  }
  return out;
}

/**
 * Shrink a hunk past the code units its two sides share at either end, or
 * `null` when nothing in it differs. Never cuts between the halves of a
 * surrogate pair.
 */
function narrowHunk(oldText: string, newText: string, h: Hunk): Hunk | null {
  const oldLen = h.oldTo - h.oldFrom;
  const newLen = h.newTo - h.newFrom;
  const max = Math.min(oldLen, newLen);
  let pre = 0;
  while (pre < max && oldText[h.oldFrom + pre] === newText[h.newFrom + pre]) pre++;
  if (pre > 0 && splitsSurrogatePair(oldText, h.oldFrom + pre)) pre--;
  if (pre > 0 && splitsSurrogatePair(newText, h.newFrom + pre)) pre--;
  let suf = 0;
  while (suf < max - pre && oldText[h.oldTo - 1 - suf] === newText[h.newTo - 1 - suf]) {
    suf++;
  }
  if (suf > 0 && splitsSurrogatePair(oldText, h.oldTo - suf)) suf--;
  if (suf > 0 && splitsSurrogatePair(newText, h.newTo - suf)) suf--;
  const out = {
    oldFrom: h.oldFrom + pre,
    oldTo: h.oldTo - suf,
    newFrom: h.newFrom + pre,
    newTo: h.newTo - suf,
  };
  return out.oldFrom === out.oldTo && out.newFrom === out.newTo ? null : out;
}

// ---------------------------------------------------------------------------
// Endpoint arithmetic
// ---------------------------------------------------------------------------

/**
 * Map a range's START across the hunks, or `null` when it sits inside one.
 *
 * Sticks right, like an assoc-0 anchor: text inserted exactly at it lands
 * BEFORE it. A start on the first unit of a REPLACED region is inside — that
 * unit is gone and its replacement is not the same text. A start inside a pure
 * DELETION maps to the deletion point, which is where a CRDT anchor to a
 * deleted character resolves; there is no other candidate.
 */
export function mapStart(p: number, hunks: readonly Hunk[]): number | null {
  let delta = 0;
  for (const h of hunks) {
    const shift = h.newTo - h.newFrom - (h.oldTo - h.oldFrom);
    if (p < h.oldFrom) return p + delta;
    if (h.oldFrom === h.oldTo || p >= h.oldTo) {
      delta += shift;
      continue;
    }
    return h.newFrom === h.newTo ? h.newFrom : null;
  }
  return p + delta;
}

/**
 * Map a range's END across the hunks, or `null` when it sits inside one.
 *
 * Sticks left, like an assoc-(-1) anchor: text inserted exactly at it lands
 * AFTER it. An end just past the last unit of a replaced region is inside —
 * that unit is gone. Inside a pure deletion it maps to the deletion point, as
 * {@link mapStart} does.
 */
export function mapEnd(p: number, hunks: readonly Hunk[]): number | null {
  let delta = 0;
  for (const h of hunks) {
    const shift = h.newTo - h.newFrom - (h.oldTo - h.oldFrom);
    if (p <= h.oldFrom) return p + delta;
    if (h.oldFrom === h.oldTo || p > h.oldTo) {
      delta += shift;
      continue;
    }
    return h.newFrom === h.newTo ? h.newFrom : null;
  }
  return p + delta;
}

/**
 * Map a whole range: each endpoint independently, or `null` when either sits
 * inside a replaced region. A point maps as a start (it stays with the text that
 * follows it, so a paragraph inserted above it does not capture it), falling
 * back to the end rule when it sits exactly at a replaced region's START (where
 * {@link mapStart} answers `null` and {@link mapEnd} does not) — so a point there
 * stays before the replacement. That is the only place the two rules disagree
 * for a point.
 */
export function mapRange(range: DocumentRange, hunks: readonly Hunk[]): DocumentRange | null {
  if (range.from === range.to) {
    const at = mapStart(range.from, hunks) ?? mapEnd(range.from, hunks);
    return at === null ? null : { from: toFlatOffset(at), to: toFlatOffset(at) };
  }
  const from = mapStart(range.from, hunks);
  const to = mapEnd(range.to, hunks);
  if (from === null || to === null) return null;
  return { from: toFlatOffset(from), to: toFlatOffset(to) };
}

/**
 * The hunks a range touches, first and last, for the probe window. A non-empty
 * hunk touches when it overlaps the range; an insertion when it falls strictly
 * inside it; and a point inside a hunk touches that hunk.
 */
function touchedHunks(range: DocumentRange, hunks: readonly Hunk[]): [Hunk, Hunk] | null {
  let first: Hunk | null = null;
  let last: Hunk | null = null;
  const { from: f, to: t } = range;
  for (const h of hunks) {
    const touches =
      f === t
        ? h.oldFrom <= f && f <= h.oldTo
        : h.oldFrom === h.oldTo
          ? f < h.oldFrom && h.oldFrom < t
          : h.oldFrom < t && h.oldTo > f;
    if (!touches) continue;
    first ??= h;
    last = h;
  }
  return first && last ? [first, last] : null;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

interface RemapEntry {
  id: string;
  /** The Y.Map value as captured — an identity witness, see {@link applyRemap}. */
  raw: unknown;
  ann: Annotation;
  /** The record's range in OLD-text coordinates. */
  oldRange: DocumentRange;
  /** See the module header: does `oldRange` hold the record's real old text? */
  trusted: boolean;
}

/** Everything {@link applyRemap} and {@link remapEnvelopeWins} need. */
export interface ReloadRemap {
  oldText: string;
  oldBreaks: FlatBreak[];
  newText: string;
  hunks: Hunk[];
  entries: Map<string, RemapEntry>;
  filePath: string;
}

/** The capture half, before the new content lands. */
export interface RemapInput {
  oldText: string;
  oldBreaks: FlatBreak[];
  entries: Map<string, RemapEntry>;
  filePath: string;
}

function hasRangeShape(value: unknown): value is { id: string; range: DocumentRange } {
  const v = value as { id?: unknown; range?: { from?: unknown; to?: unknown } } | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.id === "string" &&
    typeof v.range === "object" &&
    v.range !== null &&
    Number.isInteger(v.range.from) &&
    Number.isInteger(v.range.to)
  );
}

function clampRange(range: DocumentRange, length: number): DocumentRange {
  const clamp = (n: number) => toFlatOffset(Math.min(Math.max(n, 0), length));
  const from = clamp(range.from);
  const to = clamp(range.to);
  return { from, to };
}

/**
 * The old range for a record, from `refreshRange` run against the OLD fragment
 * with no map (so it writes nothing). See the module header for `trusted`.
 */
function entryFor(raw: unknown, ann: Annotation, ydoc: Y.Doc, oldText: string): RemapEntry {
  const result = refreshRange(ann, ydoc, undefined, () => oldText);
  switch (result.kind) {
    case "ok":
    case "updated":
    case "attached":
    case "repaired":
      return {
        id: ann.id,
        raw,
        ann,
        oldRange: clampRange(result.annotation.range, oldText.length),
        trusted: true,
      };
    case "degraded":
    case "failed":
      return storedEntry(raw, ann, oldText);
  }
}

/** An entry built from the stored range alone — trusted only when it holds its snapshot. */
function storedEntry(raw: unknown, ann: Annotation, oldText: string): RemapEntry {
  return {
    id: ann.id,
    raw,
    ann,
    oldRange: clampRange(ann.range, oldText.length),
    trusted: storedRangeStillMatches(ann, oldText),
  };
}

function sanitizeFor(raw: unknown, filePath: string): Annotation | null {
  if (!hasRangeShape(raw)) return null;
  try {
    const hash = docHash(filePath);
    return sanitizeAnnotation(raw as Annotation, (event) => relaySanitizationEvent(hash, event));
  } catch (err) {
    console.error(
      "[reload-remap] skipping an unsanitizable annotation:",
      err instanceof Error ? err.name : typeof err,
    );
    return null;
  }
}

/**
 * Read every annotation's old range while the OLD fragment is live. Must run in
 * the same transaction as the content swap and before it — no await between.
 */
export function captureRemapInput(ydoc: Y.Doc, filePath: string): RemapInput {
  const { text: oldText, breaks: oldBreaks } = extractTextWithBreaks(ydoc);
  const entries = new Map<string, RemapEntry>();
  ydoc.getMap(Y_MAP_ANNOTATIONS).forEach((raw, key) => {
    const ann = sanitizeFor(raw, filePath);
    if (!ann || ann.id !== key) return;
    entries.set(key, entryFor(raw, ann, ydoc, oldText));
  });
  return { oldText, oldBreaks, entries, filePath };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

// The one binding for the policy, shared by every call below (Critical Rule 4).
const surrogates = "ignore" as const;

/**
 * Remap every captured record onto the new content. Must run in the same
 * transaction as the content swap, after it.
 *
 * A record whose map value is no longer the captured object was rewritten by
 * the content swap itself — the `.docx` adapter re-imports Word comments and
 * updates a drifted one in place — so it is already anchored to the new
 * fragment and is left alone.
 */
export function applyRemap(ydoc: Y.Doc, input: RemapInput): ReloadRemap {
  const newText = extractText(ydoc);
  const hunks = lineHunks(input.oldText, newText);
  const remap: ReloadRemap = { ...input, newText, hunks };
  const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
  for (const entry of input.entries.values()) {
    if (map.get(entry.id) !== entry.raw) continue;
    map.set(entry.id, remapOne(ydoc, entry, remap, hunks, newText));
  }
  return remap;
}

/**
 * Remap the records whose DURABLE copy won the post-reload envelope merge
 * (`loadAndMerge`'s `afterMerge`). Their coordinates are pre-reload ones.
 *
 * Old range: the captured one when the envelope copy carries the same anchor as
 * the record captured before the reload (so the live-relRange analysis still
 * applies to it), else the envelope copy's own stored range. Hunks are
 * recomputed when the document has changed since the reload — the merge runs
 * after an await, and the remap must go from the text the old coordinates
 * describe to the text now in the document.
 *
 * Returns whether it wrote anything, so the merge queues a durable write.
 */
export function remapEnvelopeWins(
  ydoc: Y.Doc,
  remap: ReloadRemap | undefined,
  ids: ReadonlySet<string>,
): boolean {
  if (!remap || ids.size === 0) return false;
  const newText = extractText(ydoc);
  const hunks = newText === remap.newText ? remap.hunks : lineHunks(remap.oldText, newText);
  const map = ydoc.getMap(Y_MAP_ANNOTATIONS);
  let wrote = false;
  for (const id of ids) {
    const raw = map.get(id);
    const ann = sanitizeFor(raw, remap.filePath);
    if (!ann || ann.id !== id) continue;
    const captured = remap.entries.get(id);
    const entry: RemapEntry =
      captured && sameAnchor(raw, captured.raw)
        ? { ...captured, raw, ann }
        : storedEntry(raw, ann, remap.oldText);
    map.set(id, remapOne(ydoc, entry, remap, hunks, newText));
    wrote = true;
  }
  return wrote;
}

function sameAnchor(a: unknown, b: unknown): boolean {
  const pick = (v: unknown) => {
    const r = v as { range?: unknown; relRange?: unknown } | null;
    return JSON.stringify([r?.range ?? null, r?.relRange ?? null]);
  };
  return pick(a) === pick(b);
}

/** The record with a new range and (optionally) relRange, nothing else changed. */
function withRange(
  ann: Annotation,
  range: DocumentRange,
  relRange: Annotation["relRange"] | undefined,
): Annotation {
  const { relRange: _dead, ...rest } = ann;
  return (relRange ? { ...rest, range, relRange } : { ...rest, range }) as Annotation;
}

function remapOne(
  ydoc: Y.Doc,
  entry: RemapEntry,
  remap: Pick<ReloadRemap, "oldText" | "oldBreaks">,
  hunks: readonly Hunk[],
  newText: string,
): Annotation {
  const { ann, oldRange, trusted } = entry;
  const opts = { allowEmpty: true, surrogates, text: newText, textTag: "reload/remap" as const };

  // The record's text was deleted or rewritten: a point at the edit, no
  // relRange, and a snapshot of what it covered so `refreshRange`'s lazy-attach
  // gate reads it as `degraded` instead of re-anchoring it somewhere new.
  const collapse = (at: number): Annotation => {
    console.error(
      `[reload-remap] detached annotation ${ann.id}: the text it covered was changed or ` +
        "deleted by the reload. It reads as degraded until it is resolved or removed.",
    );
    const point = toFlatOffset(Math.min(Math.max(at, 0), newText.length));
    const collapsed = withRange(ann, { from: point, to: point }, undefined);
    if (collapsed.textSnapshot !== undefined) return collapsed;
    const snap = captureSnapshotFromText(
      remap.oldText,
      remap.oldBreaks,
      oldRange.from,
      oldRange.to,
    );
    return {
      ...collapsed,
      textSnapshot: snap.text,
      ...(snap.truncated ? { textSnapshotTruncated: true } : {}),
      ...(snap.breaks.length > 0 ? { textSnapshotBreaks: snap.breaks } : {}),
    } as Annotation;
  };

  const anchorOrKeep = (from: number, to: number): Annotation => {
    const anchored = anchoredRange(ydoc, toFlatOffset(from), toFlatOffset(to), undefined, opts);
    if (!anchored.ok) {
      console.error(
        `[reload-remap] re-anchoring ${ann.id} at [${from}, ${to}] failed — ` +
          `${describeRangeFailure(anchored)}. Kept the range unanchored.`,
      );
      return withRange(ann, { from: toFlatOffset(from), to: toFlatOffset(to) }, undefined);
    }
    // A refused mint (an endpoint on a heading prefix, an empty block's
    // separator) keeps the range without a relRange — `ok` with
    // `fullyAnchored: false` is not a failure, and the text IS there.
    return withRange(ann, anchored.range, anchored.fullyAnchored ? anchored.relRange : undefined);
  };

  const truncated = !trusted && isSnapshotTruncated(ann);
  const probe = trusted
    ? remap.oldText.slice(oldRange.from, oldRange.to)
    : snapshotSearchPrefix(ann);
  const span = oldRange.to - oldRange.from;

  // A truncated snapshot is a PREFIX (#1486): it places the start, and the
  // span is carried — clamped to `limit`, which is where the edit ends.
  const anchorFound = (at: number, limit: number): Annotation =>
    anchorOrKeep(
      at,
      truncated ? Math.max(at + probe.length, Math.min(at + span, limit)) : at + probe.length,
    );

  const mapped = mapRange(oldRange, hunks);
  if (mapped !== null) {
    // Every non-empty character of it was deleted (both endpoints fell into
    // deletions and met) — or its lines moved elsewhere. Only a trusted record
    // has old lines worth following (see the module header).
    if (mapped.from === mapped.to && oldRange.from < oldRange.to) {
      const moved = trusted ? uniqueMovedMatch(remap.oldText, oldRange, newText, hunks) : null;
      return moved === null ? collapse(mapped.from) : anchorOrKeep(moved, moved + probe.length);
    }
    // Both endpoints are outside every replaced region. An UNTRUSTED record
    // keeps its shifted stored range unanchored, so it reads `degraded` exactly
    // as it did before the reload rather than being pinned to text nobody
    // verified (#1764).
    if (!trusted) return withRange(ann, mapped, undefined);
    return anchorOrKeep(mapped.from, mapped.to);
  }

  // `mapRange` returned null, so an endpoint sits inside a replaced region,
  // and that hunk touches the range by `touchedHunks`' definition. Unreachable
  // otherwise; kept unanchored at its clamped old offsets rather than thrown,
  // because this runs inside the transaction that swaps the content.
  const touched = touchedHunks(oldRange, hunks);
  if (!touched) return withRange(ann, clampRange(oldRange, newText.length), undefined);
  const [first, last] = touched;

  // The window: the touched hunks' new span, widened to the record's own
  // mapped edges where those lie outside the hunks.
  const windowFrom =
    oldRange.from < first.oldFrom
      ? (mapStart(oldRange.from, hunks) ?? first.newFrom)
      : first.newFrom;
  const windowTo =
    oldRange.to > last.oldTo ? (mapEnd(oldRange.to, hunks) ?? last.newTo) : last.newTo;

  const expected =
    mapStart(oldRange.from, hunks) ?? first.newFrom + (oldRange.from - first.oldFrom);

  let best = -1;
  if (probe.length > 0) {
    for (
      let i = newText.indexOf(probe, windowFrom);
      i !== -1 && i + probe.length <= windowTo;
      i = newText.indexOf(probe, i + 1)
    ) {
      if (best === -1 || Math.abs(i - expected) < Math.abs(best - expected)) best = i;
    }
  }
  // No moved-text search here: the record's own region was REWRITTEN, which
  // is an edit in place, and a copy of its text in some other hunk is not it.
  if (best === -1) return collapse(first.newFrom);
  return anchorFound(best, windowTo);
}

/**
 * Where a deleted record's moved text landed, or `null`. Called only for a
 * trusted, non-empty record whose every character a deletion hunk removed, so
 * `oldText.slice(oldRange)` is its real old text and its own hunks have empty
 * new spans.
 *
 * A line diff moves whole lines, so a move is accepted only in that shape:
 *   - the record's enclosing old line(s) `lines` reappear VERBATIM in the new
 *     text, as whole lines (a line break or a text edge on either side);
 *   - that occurrence lies WHOLLY inside one hunk's new span — where a line
 *     diff puts inserted lines; anything touching unchanged text is a
 *     different copy by construction;
 *   - the record's own text occurs EXACTLY ONCE in the new text, and that one
 *     occurrence sits at the record's own offset inside those lines.
 * Any probe that merely overlaps another edit — narrowing often leaves a hunk
 * one character wide — fails the first two, and text that also occurs
 * elsewhere fails the third, so it detaches rather than jump to a copy
 * (which a suggestion's Accept would then rewrite).
 *
 * The verbatim line match also keeps a probe sliced mid-surrogate-pair
 * (`surrogates: "ignore"`) from matching the low half of a different astral
 * character: the units around each endpoint are the old ones. The explicit
 * surrogate check below states that invariant rather than leaving it implied.
 */
function uniqueMovedMatch(
  oldText: string,
  oldRange: DocumentRange,
  newText: string,
  hunks: readonly Hunk[],
): number | null {
  const { from, to } = oldRange;
  if (from >= to) return null;
  const probe = oldText.slice(from, to);
  const at = newText.indexOf(probe);
  if (at === -1 || newText.indexOf(probe, at + 1) !== -1) return null;
  const end = at + probe.length;

  // The enclosing old line(s). A range ending ON a line break ends that line.
  const lineStart = from === 0 ? 0 : oldText.lastIndexOf("\n", from - 1) + 1;
  const nl = oldText.indexOf("\n", Math.max(from, to - 1));
  const lineEnd = Math.max(nl === -1 ? oldText.length : nl, to);
  const lines = oldText.slice(lineStart, lineEnd);
  const p = at - (from - lineStart);
  const q = p + lines.length;
  if (p < 0 || newText.slice(p, q) !== lines) return null;
  const wholeStart = p === 0 || newText[p - 1] === "\n";
  const wholeEnd = q === newText.length || newText[q] === "\n" || lines.endsWith("\n");
  if (!wholeStart || !wholeEnd) return null;

  if (
    splitsSurrogatePair(newText, at) !== splitsSurrogatePair(oldText, from) ||
    splitsSurrogatePair(newText, end) !== splitsSurrogatePair(oldText, to)
  ) {
    return null;
  }

  return hunks.some((h) => h.newFrom <= p && q <= h.newTo) ? at : null;
}
