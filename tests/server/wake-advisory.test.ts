import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isErrorEnvelope,
  mcpError,
  mcpStructured,
  mcpSuccess,
  withErrorBoundary,
} from "../../src/server/mcp/response.js";
import {
  resetWakeAdvisoryForTests,
  takeWakeAdvisory,
  WAKE_ADVISORY_TEXT,
} from "../../src/server/mcp/wake-advisory.js";
import { setCtrlMode } from "../helpers/ctrl-mode.js";

/**
 * The wake advisory (Track D-3).
 *
 * Two classes of test here and they guard different failures. The `takeWakeAdvisory`
 * block guards the RATE LIMIT — the draft this replaces fired on 100% of tool
 * calls, which is 30–120 per session under the shipped skill's polling cadence.
 * The `withErrorBoundary` block guards the ENVELOPE invariants, which fail
 * silently: a leading block breaks four call sites that index `content[0].text`,
 * and anything in `structuredContent` makes a spec-compliant client reject the
 * call via Ajv.
 */

describe("takeWakeAdvisory", () => {
  beforeEach(() => {
    resetWakeAdvisoryForTests();
    setCtrlMode("tandem");
  });
  afterEach(resetWakeAdvisoryForTests);

  it("fires when nothing is attached — the one sound negative", () => {
    expect(takeWakeAdvisory(0)).toBe(WAKE_ADVISORY_TEXT);
  });

  it("fires at most ONCE per period with nothing attached", () => {
    expect(takeWakeAdvisory(0)).not.toBeNull();
    for (let i = 0; i < 50; i++) expect(takeWakeAdvisory(0)).toBeNull();
  });

  it("stays silent while a consumer is attached", () => {
    // Includes the default desktop install, where the supervisor is subscribed
    // and the launched session genuinely IS being woken. Firing there would nag
    // the one population that is already covered.
    expect(takeWakeAdvisory(1)).toBeNull();
    expect(takeWakeAdvisory(3)).toBeNull();
  });

  it("re-arms when the wake path is lost again", () => {
    // A real transition, not a timer. If the shim dies later in the session,
    // the advice becomes true again and should be said again.
    expect(takeWakeAdvisory(0)).not.toBeNull();
    expect(takeWakeAdvisory(0)).toBeNull();
    expect(takeWakeAdvisory(1)).toBeNull(); // consumer attaches — re-arms
    expect(takeWakeAdvisory(0)).toBe(WAKE_ADVISORY_TEXT);
  });

  it("stays silent in Solo, the mode whose promise is to leave the user alone", () => {
    setCtrlMode("solo");
    expect(takeWakeAdvisory(0)).toBeNull();
  });

  it("fails CLOSED when mode is indeterminate", () => {
    // Matches every other push-path gate: a lost or not-yet-broadcast mode key
    // means "we may have been in Solo and no longer know", so the speak branch
    // is the one it must never take.
    setCtrlMode(undefined);
    expect(takeWakeAdvisory(0)).toBeNull();
  });

  it("does not consume the one shot while in Solo", () => {
    // Solo returns before the rate-limit bookkeeping, so leaving Solo with the
    // wake path still down must still produce the advisory.
    setCtrlMode("solo");
    expect(takeWakeAdvisory(0)).toBeNull();
    setCtrlMode("tandem");
    expect(takeWakeAdvisory(0)).toBe(WAKE_ADVISORY_TEXT);
  });

  it("observes a consumer that attached and detached entirely inside Solo", () => {
    // The re-arm is deliberately ABOVE the Solo gate. With it below, this exact
    // sequence strands the latch forever: the session ends up genuinely
    // uncovered AND permanently silent about it, which is the failure this
    // module exists to prevent, reintroduced by its own rate limit.
    expect(takeWakeAdvisory(0)).toBe(WAKE_ADVISORY_TEXT); // spoken while uncovered

    setCtrlMode("solo");
    expect(takeWakeAdvisory(1)).toBeNull(); // a shim attaches — silent, but SEEN
    expect(takeWakeAdvisory(0)).toBeNull(); // and detaches again

    setCtrlMode("tandem");
    expect(takeWakeAdvisory(0)).toBe(WAKE_ADVISORY_TEXT);
  });

  it("does not let a Solo-period consumer hand out a second advisory in one period", () => {
    // The flip side: observing the attach must re-arm exactly once, not turn
    // every subsequent call into a fresh advisory.
    setCtrlMode("solo");
    expect(takeWakeAdvisory(1)).toBeNull();
    setCtrlMode("tandem");
    expect(takeWakeAdvisory(0)).toBe(WAKE_ADVISORY_TEXT);
    expect(takeWakeAdvisory(0)).toBeNull();
  });

  describe("what the text may never contain", () => {
    it("carries no executable command", () => {
      // Emitting a shell command into the same `content` array as document text
      // teaches Claude that Tandem tool output legitimately carries commands to
      // run — which a malicious .docx or an imported Word comment can imitate.
      // The command lives in SKILL.md, one place.
      for (const fragment of ["curl", "grep", "npx", "|", "&&", "ws://", "http://"]) {
        expect(WAKE_ADVISORY_TEXT).not.toContain(fragment);
      }
    });

    it("carries no counts", () => {
      // A pending count needs a read-only, ledger-non-mutating, hideFromAI-exact
      // replica of the checkInbox filter chain. Approximating it leaks in Solo.
      expect(WAKE_ADVISORY_TEXT).not.toMatch(/\d/);
    });

    it("still points somewhere actionable", () => {
      expect(WAKE_ADVISORY_TEXT).toContain("tandem_checkInbox");
      expect(WAKE_ADVISORY_TEXT).toContain("skill");
    });
  });
});

describe("withErrorBoundary decoration", () => {
  beforeEach(() => {
    resetWakeAdvisoryForTests();
    setCtrlMode("tandem");
  });
  afterEach(resetWakeAdvisoryForTests);

  const wrap = (fn: () => Promise<ReturnType<typeof mcpSuccess>>) =>
    withErrorBoundary("tandem_test", fn);

  it("appends the advisory as a TRAILING block", async () => {
    const result = await wrap(async () => mcpSuccess({ ok: true }))({});
    expect(result.content).toHaveLength(2);
    // Four helper sites index content[0].text. A leading block breaks all of them.
    expect(JSON.parse(result.content[0].text)).toEqual({ error: false, data: { ok: true } });
    expect(result.content[1].text).toBe(WAKE_ADVISORY_TEXT);
  });

  it("never decorates an error envelope", async () => {
    // LICENSE_REQUIRED and its siblings are written FOR Claude as their reader;
    // appending an unrelated advisory changes what the message asks it to do.
    const result = await wrap(async () => mcpError("LICENSE_REQUIRED", "Activate Tandem."))({});
    expect(result.content).toHaveLength(1);
    expect(isErrorEnvelope(result)).toBe(true);
  });

  it("never decorates the INTERNAL_ERROR fallback either", async () => {
    const result = await wrap(async () => {
      throw new Error("boom");
    })({});
    expect(result.content).toHaveLength(1);
    expect(JSON.parse(result.content[0].text).code).toBe("INTERNAL_ERROR");
  });

  it("leaves structuredContent byte-identical to the envelope's data", async () => {
    // Seven tools publish schemas the SDK emits with `additionalProperties: false`.
    // An advisory field here is rejected by a spec-compliant client via Ajv —
    // server-side the strip is silent, so the failure lands on the client and is
    // still fatal to the call.
    const data = { ok: true, count: 2 };
    const result = await wrap(async () => mcpStructured(data))({});
    expect(result.content).toHaveLength(2); // advisory present…
    expect(result.structuredContent).toEqual(data); // …and not in here
    expect(JSON.parse(result.content[0].text).data).toEqual(result.structuredContent);
  });

  it("does not decorate the next call, having already spoken", async () => {
    await wrap(async () => mcpSuccess({ n: 1 }))({});
    const second = await wrap(async () => mcpSuccess({ n: 2 }))({});
    expect(second.content).toHaveLength(1);
  });
});
