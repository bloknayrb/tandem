import type { AiChip, PushDelivery } from "../hooks/useAiReadiness.svelte";

/**
 * Which notice (if any) a `tandem:addressed-ai` event should raise.
 *
 * Extracted rather than inlined in `App.svelte`, for the same reason
 * `status-ai-view.ts` was: the ordering between these branches is load-bearing
 * and easy to get subtly wrong, and a pure function can be unit-tested without
 * mounting the whole app. The precedent is not decoration — the CTA this
 * handler renders has already shipped one wrong-branch bug (see `AI_CTA`'s doc
 * comment, where a binary ternary sent `setup` users down the restart path).
 *
 * There are FOUR distinct silences, and conflating them is the bug this exists
 * to prevent:
 *
 *   - `offline`  — the SERVER is gone, so the question "is an AI attached" has
 *     no meaningful answer. It exists because `no-agent` and `no-push` both
 *     imply a working server. Without it the case fell into the
 *     `chip === null` hole below and produced NO notice at all: `state` is
 *     `booting` whenever `connected()` is false, so a send into a dead server
 *     was silent. That silence replaced a wrong message with no message, which
 *     is not the same as fixing it.
 *   - `ai-off`   — the licence refuses the AI (#1521). Nothing can be attached,
 *     and nothing will connect until a license is activated, so `no-agent`'s
 *     "will be seen when one connects" would be a false promise.
 *   - `no-agent` — the server is fine, nothing is attached. The message waits.
 *   - `no-push`  — an agent IS attached and can read the document, but no
 *     real-time consumer is delivering to it, so it won't look until its next
 *     `tandem_checkInbox`. This is the hand-launched session, and it is the
 *     COMMON case: the channel shim needs a flag most users never type, and the
 *     supervisor's stdin wake only reaches sessions Tandem itself spawned.
 *
 * Ordering rules (order is load-bearing):
 *   1. Solo outranks everything. The user deliberately opted out of AI
 *      surfacing, so every notice contradicts that intent — the same
 *      reasoning that makes `chip` null in Solo.
 *   2. Server-reachability outranks the AI questions, because both of those
 *      presuppose a server to be attached to. `sessionLive` is false when the
 *      server is gone, but only as a CONSEQUENCE — reading it as "no AI" and
 *      promising the message will be seen "when one connects" is a second false
 *      promise in place of the one this whole change removed.
 *   2b. The licence refusal outranks the AI questions below: while it holds,
 *      no agent can be connected and no restart would be allowed.
 *   2c. A chat that is starting Tandem's Claude (#2196) gets no notice: the
 *      chat panel's resume row is already saying what happens to it, and the
 *      `start` chip's "nothing will answer until you start it" would
 *      contradict that row. After rules 2 and 2b, because a server that has gone away
 *      since the send makes the resume row's promise moot.
 *   3. A live session decides which of the remaining branches applies. Without
 *      one, only the agent-absence notice can be correct; with one, only the
 *      delivery notice can be.
 *   5. An affirmative claim needs a read that answered. `sessionLive` launders
 *      a stale value into a fresh-looking `true` when the probe fails, and
 *      `no-push` is the only branch that asserts connectivity off it.
 *   6. `no-push` fires ONLY on a confirmed zero. `routes/health.ts:43-45` is
 *      explicit that `subscribers: 0` is a sound negative while any positive
 *      count includes an attached-but-inert shim — so `true` and `null` (field
 *      absent, redacted, or not yet read) must both stay silent. Guessing here
 *      would tell a working user their comment went nowhere.
 */
export type AddressedAiNotice =
  | { kind: "offline" }
  | { kind: "ai-off" }
  | { kind: "no-agent"; chip: Exclude<AiChip, null | "ai-off"> }
  | { kind: "no-push" };

export function addressedAiNotice(input: {
  /** Must be re-read after any await — see the caller. */
  soloMode: boolean;
  /**
   * `/health` has gone quiet for a full strike run — the server itself is gone,
   * not merely un-attached. Keyed on the run rather than a single failed read
   * so a blip cannot raise an alarm about data loss.
   */
  serverUnreachable: boolean;
  /**
   * Did the probe's `/health` read reach our server at all?
   *
   * Separate from `sessionLive` because that value falls back to the last
   * polled result when the read fails, so a stale `true` is indistinguishable
   * from a fresh one at this boundary. Only rule 5 consults it — see there.
   */
  probeAnswered: boolean;
  /** Fresh `/health` confirmation that a LIVE MCP session is attached (a
   *  leftover from a client that went away does not count). */
  sessionLive: boolean;
  /** Re-read after the probe — readiness may have settled while it was in flight. */
  chip: AiChip;
  /** Only `"none"` is actionable; `"attached"` and `"unknown"` stay silent. */
  pushDelivery: PushDelivery;
  /** This send is a chat that is starting Tandem's Claude (rule 2c). */
  startingForMessage: boolean;
}): AddressedAiNotice | null {
  // Rule 1. Belt-and-braces: the production caller short-circuits on Solo
  // before reaching here (to skip the probe), so this branch is defensive —
  // it exists so the decision is total for any future caller rather than
  // depending on every call site remembering.
  if (input.soloMode) return null;

  // Rule 2 — the server, before the AI. Deliberately ahead of the `sessionLive`
  // branch: with the server gone `sessionLive` is false too, so ordering these
  // the other way round would report the consequence and hide the cause.
  if (input.serverUnreachable) return { kind: "offline" };

  // Rule 2b — the licence refuses the AI (#1521).
  if (input.chip === "ai-off") return { kind: "ai-off" };

  // Rule 2c — the chat panel's resume row speaks for this message.
  if (input.startingForMessage) return null;

  // Rule 3 — no agent attached.
  if (!input.sessionLive) {
    // `chip` is null while booting, and in the launcher's running-but-no-session
    // startup window. Neither is a state worth alarming about.
    return input.chip === null ? null : { kind: "no-agent", chip: input.chip };
  }

  // Rule 5 — `no-push` is the ONLY branch here that makes an affirmative
  // connectivity claim ("Claude is connected but isn't being notified"). It is
  // therefore the only one that must not be built on a stale `sessionLive`.
  //
  // The gap this closes: a hand-launched session never takes the caller's fast
  // path, so every send probes. If the server has just died, that probe fails,
  // `probeSession` falls back to the last polled `true`, and probe reads do not
  // accrue strikes — so `serverUnreachable` is still false and rule 2 above
  // cannot catch it. The user was told Claude was connected on the strength of
  // a read that had failed a millisecond earlier, for a message written into a
  // local Y.Doc with nowhere to sync.
  //
  // Silence, not `offline`: one failed read is not evidence the server is gone
  // (that is exactly what the strike floor exists to establish), and the HTTP
  // API going quiet does not imply the Hocuspocus socket did — so "it wasn't
  // delivered" would be its own false claim. We genuinely do not know, and the
  // residual cost is bounded and visible: if the server really is gone, the
  // next two polls set `serverUnreachable` within ~16s and the pill stops
  // claiming a session. No notice fires retroactively for THIS message, which
  // is a real gap, not a fixed one.
  //
  // Rules 3-4 are deliberately NOT gated on this. Their evidence is `chip`,
  // derived from the launcher route, which has its own independent floor — an
  // unrelated route blipping is no reason to suppress a notice that route
  // supports.
  if (!input.probeAnswered) return null;

  // Rule 6 — attached, but is anything delivering?
  return input.pushDelivery === "none" ? { kind: "no-push" } : null;
}

/** What App pushes for a notice: the toast, and the CTA chip it offers, if any. */
export interface AddressedAiToast {
  /** Id and dedup prefix; App appends the `via` key (and a timestamp for the id). */
  idPrefix: string;
  severity: "info" | "warning";
  message: string;
  /** The `AI_CTA` entry to offer, or null for no CTA. */
  cta: Exclude<AiChip, null> | null;
}

/**
 * The toast for each notice kind. An exhaustive `switch` with a `never`
 * default, so a new kind is a compile error here rather than falling through to
 * the `no-push` toast in App (#1521).
 */
export function noticeAction(notice: AddressedAiNotice, noun: string): AddressedAiToast {
  switch (notice.kind) {
    case "offline":
      // The server is gone, so this is not an AI problem and must not be
      // dressed as one. It is also the only branch here where the message may
      // not survive: `chatState.send` writes to a LOCAL Y.Doc with nowhere to
      // sync, and if the server returns on a new generation the stale-tab gate
      // tears down every doc and rebuilds from empty ones — the write is
      // dropped. So no "it'll be seen when one connects" promise, and no CTA:
      // neither the wizard nor a Claude restart addresses a dead Tandem server,
      // and offering one would repeat the #1268 mistake of pointing a user at a
      // remedy for a different problem.
      return {
        idPrefix: "ai-offline",
        severity: "warning",
        message: `${noun} saved locally, but Tandem couldn't reach its server, so it wasn't delivered. If the server restarted, send it again.`,
        cta: null,
      };
    case "ai-off":
      // Reachable only for a send that races the licence flip: the chat
      // composer and the comment segment are disabled while the AI is off.
      // Kind-neutral copy — it serves both the unlicensed and unverifiable
      // reader, so it says neither "unlicensed" nor "activate".
      return {
        idPrefix: "ai-off",
        severity: "warning",
        message: `${noun} saved. Claude won't see it while AI features are off. See Settings → License.`,
        cta: "ai-off",
      };
    case "no-agent":
      return {
        idPrefix: "ai-not-ready",
        severity: "warning",
        // Past tense on the observation because `warning` never expires —
        // see the tense rule on `TandemNotification.severity`.
        // The `start` chip (#2195) is Tandem's Claude stopped by choice:
        // "when one connects" would be wrong — nothing is going to connect
        // until the user starts it.
        message:
          notice.chip === "start"
            ? `${noun} saved. Tandem's Claude isn't running, so nothing will answer until you start it.`
            : `${noun} saved while no AI was connected. It'll be seen when one connects.`,
        cta: notice.chip,
      };
    case "no-push":
      // An agent is attached, so nothing is wrong — this is a latency
      // expectation, not a failure, hence `info` rather than `warning` and no CTA.
      //
      // The copy names the contradiction on purpose. The status pill says "AI
      // attached" (truthfully — something IS connected), so a bare "it'll be seen
      // later" reads as a non-sequitur. Saying "connected, but not being notified"
      // is the whole point of the notice. Same voice as the pill's
      // `CONNECTED_NO_PUSH`: "something", and a conditional check-in, because the
      // attached client may be a script or a dead session's leftover connection.
      return {
        idPrefix: "ai-no-push",
        severity: "info",
        message: `${noun} saved. Something is connected to Tandem but isn't being notified. If it's a session you're using, it'll see this the next time it checks in.`,
        cta: null,
      };
    default: {
      const _exhaustive: never = notice;
      return _exhaustive;
    }
  }
}
