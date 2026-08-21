import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetClientLog,
  logClientError,
  logClientWarning,
  readClientLog,
} from "../../src/client/utils/client-log";

/**
 * The ring buffer behind #1439. Most of what is asserted here is the PRIVACY
 * contract, not the data structure: entries land in a report a user pastes into
 * a public GitHub issue, and `buildBugReportUrl` prefills that body, so the
 * user's review step is an opt-out rather than a gate.
 */

function quiet() {
  return {
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
}

beforeEach(() => {
  _resetClientLog();
  vi.restoreAllMocks();
});

describe("ring buffer", () => {
  it("keeps the newest CAPACITY entries and drops the oldest", () => {
    quiet();
    for (let i = 0; i < 25; i++) logClientWarning("scope", `event ${i}`);
    const log = readClientLog();
    expect(log).toHaveLength(20);
    expect(log[0].event).toBe("event 5");
    expect(log[19].event).toBe("event 24");
  });

  it("coalesces a repeat that is NOT the newest entry", () => {
    // The alternating case (A,B,A,B…) is the one a newest-only comparison
    // misses, and it is the expected shape: the Cowork pre-flight is
    // retry-driven and its catch covers several distinct causes. Without
    // whole-buffer coalescing this fills 20 slots with 2 facts.
    quiet();
    for (let i = 0; i < 3; i++) {
      logClientWarning("a", "first");
      logClientError("b", "second");
    }
    const log = readClientLog();
    expect(log).toHaveLength(2);
    expect(log.map((e) => [e.scope, e.count])).toEqual([
      ["a", 3],
      ["b", 3],
    ]);
    // Most recently seen sorts last, so newest-first rendering leads with it.
    expect(log[1].scope).toBe("b");
  });

  it("keeps two long causes distinct when they differ past the display cap", () => {
    // Coalescing on the CLAMPED detail merges these and renders `(x2)` —
    // actively asserting a repeat that never happened, which is worse than two
    // lines. The key is a fingerprint of the full scrubbed cause.
    quiet();
    const prefix = "z".repeat(200);
    logClientWarning("cowork", "probe failed", new Error(`${prefix} FIRST`));
    logClientWarning("cowork", "probe failed", new Error(`${prefix} SECOND`));
    const log = readClientLog();
    expect(log).toHaveLength(2);
    expect(log.map((e) => e.count)).toEqual([1, 1]);
    // Both render identically — the point is that they are two events, not one
    // that recurred.
    expect(log[0].detail).toBe(log[1].detail);
  });

  it("tracks first and last occurrence separately", () => {
    // `at` alone cannot tell a 300ms burst from three failures a quarter of an
    // hour apart, and those are different bugs.
    quiet();
    logClientWarning("a", "e");
    logClientWarning("a", "e");
    const [entry] = readClientLog();
    expect(entry.count).toBe(2);
    expect(entry.firstAt).toBeLessThanOrEqual(entry.at);
  });

  it("does not leak the internal coalescing key to callers", () => {
    quiet();
    logClientWarning("a", "e", new Error("boom"));
    expect(Object.keys(readClientLog()[0]).sort()).toEqual([
      "at",
      "count",
      "detail",
      "event",
      "firstAt",
      "level",
      "scope",
    ]);
  });

  it("keeps entries distinct when only the detail differs", () => {
    quiet();
    logClientWarning("wizard", "clipboard write failed", new Error("denied"));
    logClientWarning("wizard", "clipboard write failed", new TypeError("no clipboard"));
    expect(readClientLog().map((e) => e.detail)).toEqual([
      "Error: denied",
      "TypeError: no clipboard",
    ]);
  });

  it("hands out copies, not the live entries coalescing mutates", () => {
    // `useBugReportUrl` holds this array across an await; a shallow copy would
    // let the `(x3)` a user sees drift from what was rendered.
    quiet();
    logClientWarning("a", "e");
    const snapshot = readClientLog();
    logClientWarning("a", "e");
    expect(snapshot[0].count).toBe(1);
    expect(readClientLog()[0].count).toBe(2);
  });

  it("_resetClientLog empties it", () => {
    quiet();
    logClientWarning("a", "e");
    _resetClientLog();
    expect(readClientLog()).toEqual([]);
  });
});

describe("console fidelity", () => {
  it("logs exactly what the hand-written call logged, with the RAW cause", () => {
    // `integration-wizard-push-support.test.ts` asserts this exact shape; a
    // developer with an inspector open must keep the object and its stack.
    const { warn, error } = quiet();
    const err = new Error("denied");
    logClientWarning("wizard", "clipboard write failed", err);
    expect(warn).toHaveBeenCalledWith("[wizard] clipboard write failed:", err);
    logClientError("cowork", "subnet pre-flight threw", err);
    expect(error).toHaveBeenCalledWith("[cowork] subnet pre-flight threw:", err);
  });

  it("omits the colon when there is no cause", () => {
    const { warn } = quiet();
    logClientWarning("wizard", "nothing to copy");
    expect(warn).toHaveBeenCalledWith("[wizard] nothing to copy");
  });
});

describe("describeCause — privacy contract", () => {
  it("records the error name, which is the whole diagnostic point", () => {
    // NotAllowedError vs TypeError vs SecurityError is what separates the three
    // clipboard bugs #1439 opens with.
    quiet();
    const denied = new DOMException("Write permission denied", "NotAllowedError");
    logClientWarning("wizard", "clipboard write failed", denied);
    expect(readClientLog()[0].detail).toBe("NotAllowedError: Write permission denied");
  });

  it("captures a string cause — the Tauri invoke shape — scrubbed and capped", () => {
    // `invoke` rejects with the Rust error's Display string, not an Error, so
    // this branch is the ONLY thing that carries a Cowork pre-flight failure.
    quiet();
    // The path goes at the FRONT: with it past the 160-char cut this assertion
    // passes with the scrubbing deleted entirely, and reads as if it covers it.
    const rejection = `subnet probe failed at /home/bryan/tandem: ${"x".repeat(1000)}`;
    logClientError("cowork", "subnet pre-flight threw", rejection);
    const { detail } = readClientLog()[0];
    expect(detail).toContain("/home/[user]/tandem");
    expect(detail).not.toContain("bryan");
    expect(detail.length).toBeLessThanOrEqual(161);
    expect(detail.endsWith("…")).toBe(true);
  });

  it("caps a long Error message but keeps the name", () => {
    quiet();
    logClientWarning("scope", "event", new RangeError("y".repeat(1000)));
    const { detail } = readClientLog()[0];
    expect(detail.startsWith("RangeError: y")).toBe(true);
    expect(detail.length).toBeLessThanOrEqual(161);
  });

  it("drops a lone surrogate that was already in the message", () => {
    // Not a theoretical shape: `encodeURIComponent` throws URIError on one, and
    // `buildBugReportUrl` answers a throw by returning the BARE issue URL — the
    // whole prefill gone, on the surface this feature exists to fix. Nothing
    // upstream can remove one (every scrub pattern is ASCII), so the buffer is
    // where it has to be handled.
    quiet();
    logClientWarning("scope", "event", `boom ${String.fromCharCode(0xd800)} tail`);
    const { detail } = readClientLog()[0];
    expect(detail).toBe("boom  tail");
    expect(() => encodeURIComponent(detail)).not.toThrow();

    // A trailing low surrogate is the same hazard from the other end.
    logClientWarning("scope", "other", `tail ${String.fromCharCode(0xdc00)}`);
    expect(() => encodeURIComponent(readClientLog()[1].detail)).not.toThrow();
  });

  it("keeps well-formed pairs intact", () => {
    quiet();
    logClientWarning("scope", "event", "ok 🙂 done");
    expect(readClientLog()[0].detail).toBe("ok 🙂 done");
  });

  it("never truncates into a lone surrogate", () => {
    // `encodeURIComponent` throws URIError on one, and `buildBugReportUrl`
    // answers a throw by dropping the entire prefill.
    //
    // The leading `"x"` is the whole point of the fixture and must not be
    // "tidied" away. Every emoji is two UTF-16 units, so a bare
    // `"🙂".repeat(200)` puts a LOW surrogate at index 159 and the 160-char cut
    // lands neatly BETWEEN pairs — deleting the cut-site strip in `clamp` left
    // this test green, which is how it shipped asserting nothing. One BMP
    // character of offset puts a HIGH surrogate at index 159 so the cut splits a
    // pair, which is the case the strip exists for.
    quiet();
    logClientWarning("scope", "event", `x${"🙂".repeat(200)}`);
    const { detail } = readClientLog()[0];
    expect(() => encodeURIComponent(detail)).not.toThrow();
    expect(/[\uD800-\uDBFF]$/.test(detail.slice(0, -1))).toBe(false);
    // Pin the geometry itself, so a later change to `MAX_DETAIL_CHARS` cannot
    // silently move the cut back between pairs and re-vacuate the assertion.
    expect(`x${"🙂".repeat(200)}`.charCodeAt(159)).toBeGreaterThanOrEqual(0xd800);
    expect(`x${"🙂".repeat(200)}`.charCodeAt(159)).toBeLessThanOrEqual(0xdbff);
  });

  it("still handles a cut that falls between surrogate pairs", () => {
    // The even case the fixture above used to be. Kept: the two differ in which
    // branch of `clamp` does the work, and only the odd one exercises the strip.
    quiet();
    logClientWarning("scope", "event", "🙂".repeat(200));
    const { detail } = readClientLog()[0];
    expect(() => encodeURIComponent(detail)).not.toThrow();
    expect(detail.endsWith("…")).toBe(true);
  });

  it("bounds the RAW cause before scrubbing, not just the stored detail", () => {
    // The ReDoS half of the fix, pinned by SHAPE rather than by a clock.
    //
    // `describeCause` scrubs the full cause and only then clamps, so cost was a
    // function of raw input on the UI thread inside a `catch`. Two passes are
    // super-linear on their own — `collapseLines`' leading `\s*` over a
    // whitespace run, and the URL rule's two runs either side of a `:` over a
    // colon run (`"https://" + "a:".repeat(50000)` took 33s) — and no regex
    // rewrite removes the second one. The cap is what bounds them.
    //
    // Observable consequence, with no timing involved: two causes that agree for
    // the first `MAX_CAUSE_CHARS` are indistinguishable to `fingerprint`, so
    // they COALESCE. Delete the `cap(...)` call and they become two entries.
    quiet();
    const shared = "z".repeat(2000);
    logClientWarning("scope", "event", `${shared}AAA`);
    logClientWarning("scope", "event", `${shared}BBB`);
    const entries = readClientLog();
    expect(entries).toHaveLength(1);
    expect(entries[0].count).toBe(2);
    // And the converse, so the test cannot pass by coalescing everything: a
    // difference INSIDE the cap still separates them.
    _resetClientLog();
    logClientWarning("scope", "event", `A${shared}`);
    logClientWarning("scope", "event", `B${shared}`);
    expect(readClientLog()).toHaveLength(2);
  });

  it("never lets a throwing cause escape into the caller's catch block", () => {
    // `src/client/sentry.ts`'s stated norm — never let telemetry throw into the
    // app's error path — applied here, because this module is the declared
    // intake for the other ~150 `console.warn` sites. `describeCause` reads
    // `cause.name`, so a throwing getter would abort the CALLER's `catch` and
    // the user-facing recovery line after the warn would never run.
    const { warn } = quiet();
    const hostile = {
      get name(): string {
        throw new Error("boom");
      },
      message: "x",
    };
    expect(() => logClientWarning("scope", "event", hostile)).not.toThrow();
    // The console line is the part that predates the ring buffer, so it must be
    // emitted whether or not the buffer write survives. Asserted by IDENTITY,
    // not `toHaveBeenCalledWith`: a deep-equality check would itself read the
    // throwing getter and fail the test from the assertion rather than the code.
    expect(warn.mock.calls).toHaveLength(1);
    expect(warn.mock.calls[0][0]).toBe("[scope] event:");
    expect(warn.mock.calls[0][1]).toBe(hostile);
    expect(readClientLog()).toHaveLength(0);
  });

  it("scrubs user paths and secrets on the way IN", () => {
    // On the way in, so the buffer never holds unscrubbed text for some other
    // reader (a Sentry breadcrumb, a heap dump) to pick up.
    quiet();
    logClientWarning(
      "scope",
      "event",
      new Error("ENOENT /Users/alice/x.md and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"),
    );
    const { detail } = readClientLog()[0];
    expect(detail).toContain("/Users/[user]/x.md");
    expect(detail).toContain("ghp_[redacted]");
    expect(detail).not.toContain("alice");
  });

  it("never reads .stack or .cause", () => {
    // A stated rule, not an emergent one: the obvious "make detail more useful"
    // follow-up is `err.cause?.message`, and a stack is almost entirely
    // absolute file paths.
    quiet();
    const inner = new Error("INNER_MARKER_/Users/alice/private.md");
    const outer = new Error("outer failed", { cause: inner });
    outer.stack = "Error: outer failed\n    at boom (/Users/alice/app/main.js:1:1)";
    logClientWarning("scope", "event", outer);
    const serialized = JSON.stringify(readClientLog()[0]);
    expect(serialized).not.toContain("INNER_MARKER");
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain(" at ");
    expect(readClientLog()[0].detail).toBe("Error: outer failed");
  });

  it("records only the TYPE of a non-error object, never its fields", () => {
    quiet();
    class RejectedPayload {
      secretPath = "/Users/alice/x";
      body = "the whole document";
    }
    logClientWarning("scope", "event", new RejectedPayload());
    const { detail } = readClientLog()[0];
    expect(detail).toBe("RejectedPayload");
    logClientWarning("scope", "other", { secretPath: "/Users/alice/x", body: "doc" });
    expect(readClientLog()[1].detail).toBe("Object");
    expect(JSON.stringify(readClientLog())).not.toContain("secretPath");
  });

  it("survives a null-prototype object", () => {
    quiet();
    logClientWarning("scope", "event", Object.assign(Object.create(null), { a: 1 }));
    expect(readClientLog()[0].detail).toBe("object");
  });

  it("records nothing for an absent cause", () => {
    quiet();
    logClientWarning("scope", "event");
    expect(readClientLog()[0].detail).toBe("");
  });

  it("collapses newlines so one entry cannot forge report structure", () => {
    // `stripControlChars` deliberately preserves \n (that is why `fenceFor`
    // exists), and multi-line messages are routine for Tauri and JSON errors.
    // Left alone, a message can inject a convincing `[ok]` check line into a
    // public issue body.
    quiet();
    logClientWarning("scope", "event", new Error("boom\n[ok]   fake-check — nothing to see"));
    const { detail } = readClientLog()[0];
    // Interior runs are left alone — only the newline (and whitespace
    // adjacent to it) collapses. One line is what matters.
    expect(detail).toBe("Error: boom [ok]   fake-check — nothing to see");
    expect(detail).not.toContain("\n");
  });
});
