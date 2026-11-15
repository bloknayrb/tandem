/**
 * Hide a model's inline reasoning from the chat (#1123 part C, Decision D-C2,
 * Ruling C-6). A "thinking" model can put its reasoning in `content` as
 * `<think>…</think>`; chat shows only the answer. Only what is SHOWN changes:
 * the loop still echoes each turn's raw content back to the model (R2.8).
 *
 * A streaming filter, one per turn (the sink calls `finish` at each turn's
 * end, which resets it):
 *  - a closed block is never shown, wherever it is (R2.1);
 *  - an unclosed `<think>` that opens the turn — after leading whitespace and
 *    leading closed blocks (and format characters such as U+200B) — hides
 *    the rest of the turn (R2.2);
 *  - a `<think>` later in the text is HELD until it closes (then dropped) or
 *    the turn ends; it is released as text only when `finish(true)` is called,
 *    which the sink does only at a `clean` end; otherwise it is dropped (R2.3);
 *  - blocks do not nest: the first `</think>` after an opening tag closes it;
 *  - the tags are exactly `<think>` and `</think>`, ASCII case-insensitive, no
 *    attributes; `<think foo>`, `<thinking>`, `<reasoning>` and a lone
 *    `</think>` are text (R2.5). A tag split across deltas is matched.
 *
 * Cost (R2.6): each input character is examined at most twice — once as it
 * arrives and, when it ends a candidate tag that turns out not to be one, once
 * more as the possible start of the next (a tag holds `<` only at index 0, so
 * no other character can start one). Memory is the held text (capped at
 * the sink's cap plus one tag) plus a tail of at most seven characters; a block that
 * opens the turn is dropped as it streams.
 *
 * Whitespace and format characters before the first visible character pass
 * straight through: the sink never mints a row for a buffer that is only these
 * (`isShownTextEmpty`), so they are invisible, and text with no `<think>`
 * reaches the sink exactly as it arrived.
 *
 * Leading is judged per code point (#1123 part B, R0.3): a format character
 * outside the BMP (U+E0001…) arrives as two UTF-16 code units, neither of
 * which is `\p{Cf}` alone, so a high surrogate in the lead is judged with the
 * code unit after it.
 */

const OPEN = "<think>";
const CLOSE = "</think>";

type Mode =
  /** Nothing visible yet this turn: only whitespace and closed blocks. */
  | "lead"
  /** Visible text has been shown. */
  | "shown"
  /** Inside a block that opened the turn: dropped. */
  | "hiding"
  /** Inside a block that opened after visible text: held. */
  | "holding";

let scannedForTests = 0;
let maxBufferedForTests = 0;

/** Characters examined by every filter since the last reset (test seam, R2.6). */
export function thinkFilterScannedForTests(): number {
  return scannedForTests;
}
export function resetThinkFilterScannedForTests(): void {
  scannedForTests = 0;
  maxBufferedForTests = 0;
}
/**
 * The most text any filter has held at once since the last reset (held block
 * plus tail): pins, through the shipped sink, that the filter it builds is
 * bounded by the sink's cap plus one tag (#1123 part B, R0.2).
 */
export function thinkFilterMaxBufferedForTests(): number {
  return maxBufferedForTests;
}

/**
 * Whitespace and Unicode format characters (`\p{Cf}`: zero-width space and
 * joiners, bidi marks, word joiner, soft hyphen, BOM, tag characters) show
 * nothing. Text that is only these is not shown text: the sink mints no row
 * for it, and the harness does not count it as text the user saw (#1123 part
 * B, R0.1). `trim()` alone keeps U+200B, U+200C, U+200D, U+200E, U+200F,
 * U+2060, U+202E and U+00AD. Judged per code point.
 */
export function isShownTextEmpty(text: string): boolean {
  return /^[\s\p{Cf}]*$/u.test(text);
}

/**
 * Leading for the "opens the turn" rule: whitespace, and Unicode format
 * characters (zero-width space, BOM, bidi marks — `\p{Cf}`), which show
 * nothing either. Both still pass through; the sink never mints a row for a
 * buffer that is only these, because its emptiness check is
 * `isShownTextEmpty`, not `trim()`. `c` is one code point.
 */
const isLeading = (c: string) => isShownTextEmpty(c);

const isHighSurrogate = (c: string) => c >= "\uD800" && c <= "\uDBFF";
const isLowSurrogate = (c: string) => c >= "\uDC00" && c <= "\uDFFF";

/** ASCII-only case folding: `<THINK>` is a tag, the Kelvin sign is not a "k". */
const asciiLower = (s: string) =>
  s.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));

export class ThinkFilter {
  private mode: Mode = "lead";
  /** A candidate tag: a prefix of the tag this mode is looking for. */
  private tail = "";
  /** The held block, its opening tag as written included. */
  private held = "";
  private heldOverflow = false;
  /** A high surrogate seen in the lead, waiting for its low half to be judged
   *  as one code point (R0.3). It has already been passed through. */
  private leadHigh = "";
  /**
   * Held text beyond this is never shown: on release it goes through the
   * sink's cap, which keeps at most that many characters plus a marker. One
   * tag above it, so a held block is never cut below what the cap keeps.
   */
  private readonly heldCap: number;

  /**
   * `showCap`: the most text the caller will ever show (the sink's cap).
   * Required, so no caller builds an unbounded filter by omission (R0.2);
   * pass `Number.POSITIVE_INFINITY` to mean "no cap" on purpose.
   */
  constructor(showCap: number) {
    this.heldCap = showCap + OPEN.length;
  }

  /** Characters this filter is keeping right now (held block + tail): the
   *  memory bound of R2.6, for tests. */
  bufferedForTests(): number {
    return this.held.length + this.tail.length;
  }

  /** Feed one delta; returns the text that may be shown now. */
  push(delta: string): string {
    let out = "";
    for (let i = 0; i < delta.length; i++) out += this.step(delta[i]);
    return out;
  }

  /**
   * Characters of plain text the filter is holding only because they might
   * start a tag (`<`, `<th`…), outside any block. The sink counts them toward
   * its cap and its flush trigger, so text with no `<think>` trips both at
   * exactly the character master did (R2.4).
   */
  pendingLiteral(): number {
    return this.mode === "lead" || this.mode === "shown" ? this.tail.length : 0;
  }

  /** Give up the pending candidate as plain text (the cap tripped: nothing
   *  after it is shown anyway). */
  takePendingLiteral(): string {
    if (this.pendingLiteral() === 0) return "";
    const t = this.tail;
    this.tail = "";
    return t;
  }

  /**
   * End the turn and reset. Returns what is still owed to the display: a
   * pending candidate tag that never completed (it is plain text), and — only
   * with `release` — a held block, as written.
   */
  finish(release: boolean): string {
    let out = "";
    if (this.mode === "lead" || this.mode === "shown") out = this.tail;
    else if (this.mode === "holding" && release) out = this.held + this.tail;
    this.mode = "lead";
    this.tail = "";
    this.held = "";
    this.heldOverflow = false;
    this.leadHigh = "";
    return out;
  }

  private target(): string {
    return this.mode === "hiding" || this.mode === "holding" ? CLOSE : OPEN;
  }

  private step(c: string): string {
    scannedForTests += 1;
    // A high surrogate in the lead is judged with the unit after it; anything
    // but its low half makes it a lone surrogate, which is not leading.
    if (this.leadHigh !== "" && !isLowSurrogate(c)) {
      this.leadHigh = "";
      if (this.mode === "lead") this.mode = "shown";
    }
    if (this.tail.length === 0 && c !== "<") return this.literal(c);
    const candidate = this.tail + c;
    const target = this.target();
    if (target.startsWith(asciiLower(candidate))) {
      if (candidate.length === target.length) {
        this.tail = "";
        this.tag(candidate);
      } else {
        this.tail = candidate;
      }
      return "";
    }
    // Not a tag: everything before `c` is plain text, and `c` may start the
    // next candidate (only a `<` can).
    let out = "";
    for (const ch of this.tail) out += this.literal(ch);
    this.tail = "";
    return out + this.step(c);
  }

  private literal(c: string): string {
    switch (this.mode) {
      case "lead":
        if (this.leadHigh !== "") {
          // `c` is the low half (checked in `step`): judge the pair.
          const pair = this.leadHigh + c;
          this.leadHigh = "";
          if (!isLeading(pair)) this.mode = "shown";
        } else if (isHighSurrogate(c)) {
          this.leadHigh = c;
        } else if (!isLeading(c)) {
          this.mode = "shown";
        }
        return c;
      case "shown":
        return c;
      case "hiding":
        return "";
      case "holding":
        this.hold(c);
        return "";
    }
  }

  private hold(text: string): void {
    if (this.heldOverflow) return;
    this.held += text;
    if (this.held.length > this.heldCap) {
      this.held = this.held.slice(0, this.heldCap);
      this.heldOverflow = true;
    }
    const buffered = this.held.length + this.tail.length;
    if (buffered > maxBufferedForTests) maxBufferedForTests = buffered;
  }

  private tag(written: string): void {
    switch (this.mode) {
      case "lead":
        this.mode = "hiding";
        return;
      case "shown":
        this.mode = "holding";
        this.held = "";
        this.heldOverflow = false;
        this.hold(written);
        return;
      case "hiding":
        // Closed a block that opened the turn: still at the turn's start, so
        // a block opening next is hidden too.
        this.mode = "lead";
        return;
      case "holding":
        // Closed a later block: drop it.
        this.held = "";
        this.heldOverflow = false;
        this.mode = "shown";
        return;
    }
  }
}

/**
 * What a whole turn's text shows: `release` as the sink would pass it (true
 * only for the text of a `clean` end). For the measurement harness, which
 * judges shown text (R5.2).
 */
export function shownText(raw: string, release: boolean): string {
  const f = new ThinkFilter(Number.POSITIVE_INFINITY);
  return f.push(raw) + f.finish(release);
}
