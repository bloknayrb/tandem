import type { AiReadiness } from "../hooks/useAiReadiness.svelte";
import {
  type ChatResume,
  type ChatResumeRequest,
  chatResume,
  RESUME_GRACE_MS,
} from "./chat-resume";

/** The readiness fields the resume row reads — a narrow slice, so a test can
 *  drive it with a plain reactive object. */
export type ChatResumeReadiness = Pick<
  AiReadiness,
  | "launcherRunning"
  | "launcherRestarting"
  | "launcherStarting"
  | "launcherStandby"
  | "launcherStartsOnMessage"
  | "launcherRemedy"
  | "serverUnreachable"
  | "refreshLauncherStatus"
>;

/** When to re-read the launcher status after a send that is starting Claude.
 *  The server marks the start pending as the message lands, so one quick read
 *  shows "Starting" without waiting out the 8 s poll; the launcher action's
 *  own schedule then catches it running. */
export const RESUME_FIRST_READ_MS = 500;

/**
 * The chat panel's resume row, as state (#2196): see `chat-resume.ts` for what
 * it says. Call during component init — it owns two `$effect`s.
 *
 * `noteSent()` runs at send time, BEFORE the `tandem:addressed-ai` dispatch,
 * because the no-agent toast reads `pending` to stand aside.
 */
export function createChatResume(
  r: ChatResumeReadiness,
  /** The re-reads every launcher action takes afterwards (App's
   *  `refreshAiReadinessAfterLauncherAction`): a message start is one. */
  afterLauncherAction: () => void,
  /** When the newest Claude-authored chat message landed, or null. A reply
   *  after the send means some AI answered (another one attached meanwhile,
   *  say), so the row has nothing left to say. */
  lastClaudeMessageAt: () => number | null,
  /**
   * Chat is set to the local model (#1123 part B, R5.6). Then a send records
   * no request, and no resume row shows ("Starting Tandem's Claude… it will
   * answer when it's ready" would be false: Claude is handed nothing). Always
   * false while the flag is off (App's wiring).
   */
  localPeriod: () => boolean = () => false,
): {
  readonly view: ChatResume | null;
  /** A send is being answered by a start — the toast must not contradict it. */
  readonly pending: boolean;
  noteSent(): void;
} {
  let request = $state<ChatResumeRequest | null>(null);
  // The clock `chatResume` reads, bumped once when the grace runs out.
  let now = $state(Date.now());

  const view = $derived(
    localPeriod()
      ? null
      : chatResume(request, {
          running: r.launcherRunning,
          serverUnreachable: r.serverUnreachable,
          restarting: r.launcherRestarting,
          standby: r.launcherStandby,
          remedy: r.launcherRemedy,
          now: Math.max(now, request?.at ?? 0),
        }),
  );

  // Cleared once Claude runs, so a later idle stop does not resurrect it; and
  // once any Claude reply lands after the send.
  $effect(() => {
    if (request === null) return;
    const replied = lastClaudeMessageAt();
    if (r.launcherRunning || (replied !== null && replied >= request.at)) request = null;
  });

  // Per request: a second send restarts the schedule.
  $effect(() => {
    if (request === null) return;
    const graceEnds = request.at + RESUME_GRACE_MS;
    const timers = [
      setTimeout(() => r.refreshLauncherStatus(), RESUME_FIRST_READ_MS),
      // At least the grace's end: a timer that fires a hair early, or a clock
      // stepped back, must not leave "resuming" up with nothing to bump it.
      setTimeout(() => {
        now = Math.max(Date.now(), graceEnds);
      }, RESUME_GRACE_MS),
    ];
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  });

  return {
    get view() {
      return view;
    },
    get pending() {
      return request !== null && !localPeriod();
    },
    noteSent() {
      // Recorded only when the server said a message would start Claude, or a
      // start (the user's Start) is already under way and will answer it. Any
      // other send clears an old request, so a stale "couldn't start" never
      // swallows the next message's notice.
      const standby = r.launcherStandby;
      // The lit editor's local period records nothing (R5.6). Outside it, a
      // notice row still feeds `lastClaudeMessageAt` and clears a request, as
      // any Claude row does today.
      request =
        !localPeriod() && standby !== null && (r.launcherStartsOnMessage || r.launcherStarting)
          ? { at: Date.now(), from: standby }
          : null;
      if (request !== null) afterLauncherAction();
    },
  };
}
