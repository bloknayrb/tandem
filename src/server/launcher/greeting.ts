/**
 * `first-run-greeting.json` — whether Tandem's Claude still owes the user its
 * one-time hello (#2197).
 *
 * The greeting is the ONE turn on which Tandem's Claude does something nobody
 * asked for (Bryan, 2026-10-12), so this file's job is to make "once" true:
 *
 *   - **Armed at boot** (`armFirstRunGreeting`) on a first install, and once
 *     for everyone on the first run of v1.0 ("we will treat the first run of
 *     v1.0 as a first run of tandem, no matter what"). Arming persists `owed`,
 *     so a user who quits before finishing setup is still greeted when they do.
 *   - **Read by the supervisor at every spawn** (`isGreetingOwed`) —
 *     synchronously, like the saved session, so it adds no await to the crash
 *     restart path.
 *   - **Marked done** (`markGreeted`) once the greeting turn has RUN — its
 *     first non-errored `result`, or a `tandem_reply` from Tandem's own child
 *     before that — never when the turn was merely sent. "Once" does not hang
 *     on spotting a chat reply (a hello left in a comment thread would repeat
 *     on every spawn). Only an errored turn (not signed in, among others)
 *     leaves it owed, so the start after the user fixes it greets. A turn that
 *     ran but could not use Tandem's tools has spent it: the "hasn't said
 *     hello" note is the visible fallback for that case.
 *
 * Every failure reads as "not owed". A missed greeting costs a hello; a
 * repeated one is Claude acting unasked twice.
 */

import path from "node:path";

import { atomicWriteConfigFile, readBoundedJsonFileSync } from "../integrations/storage.js";
import { isV1Release } from "../version-check.js";

export const GREETING_FILE_NAME = "first-run-greeting.json";
const GREETING_VERSION = 1;
const MAX_GREETING_BYTES = 1024;

interface GreetingRecord {
  version: number;
  state: "owed" | "done";
  /** The app version that delivered the greeting, for the v1.0 re-arm. */
  greetedOn?: string;
}

export function greetingPath(base: string): string {
  return path.join(base, GREETING_FILE_NAME);
}

/** The record on disk, `null` when there is none, or `"unreadable"`. */
function readRecord(base: string): GreetingRecord | null | "unreadable" {
  const raw = readBoundedJsonFileSync(greetingPath(base), MAX_GREETING_BYTES);
  if (raw === null || raw === "unreadable") return raw;
  const parsed = raw as Partial<GreetingRecord> | null;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof parsed.version !== "number" ||
    (parsed.state !== "owed" && parsed.state !== "done")
  ) {
    return "unreadable";
  }
  return {
    version: parsed.version,
    state: parsed.state,
    ...(typeof parsed.greetedOn === "string" ? { greetedOn: parsed.greetedOn } : {}),
  };
}

/** Whether Tandem's Claude still owes the greeting. Synchronous; never throws. */
export function isGreetingOwed(base: string): boolean {
  const record = readRecord(base);
  return record !== null && record !== "unreadable" && record.state === "owed";
}

/**
 * Decide at boot whether the greeting is owed, and persist it. `firstInstall`
 * is `checkVersionChange`'s `"first-install"`.
 *
 *   - first install, no record → owed.
 *   - running a v1.0 release, and no record or one greeted before v1.0 → owed
 *     (the v1.0 re-arm, for every user).
 *   - otherwise nothing: an existing user upgrading within 0.x is not on a
 *     first run.
 *
 * Errors are logged and swallowed: a boot must not fail over a hello.
 */
export async function armFirstRunGreeting(
  base: string,
  input: { firstInstall: boolean; appVersion: string },
): Promise<"armed" | "unchanged"> {
  const record = readRecord(base);
  if (record === "unreadable") return "unchanged";
  if (record?.state === "owed") return "unchanged";
  const v1Rearm =
    isV1Release(input.appVersion) && (record === null || !isV1Release(record.greetedOn));
  const firstRun = input.firstInstall && record === null;
  if (!v1Rearm && !firstRun) return "unchanged";
  try {
    await write(base, { version: GREETING_VERSION, state: "owed" });
    return "armed";
  } catch (err) {
    console.error("[Launcher] Could not record the first-run greeting:", err);
    return "unchanged";
  }
}

/** The greeting landed in the chat: never send it again (until the v1.0 re-arm,
 * when `appVersion` is pre-1.0). */
export async function markGreeted(base: string, appVersion: string): Promise<void> {
  await write(base, { version: GREETING_VERSION, state: "done", greetedOn: appVersion });
}

async function write(base: string, record: GreetingRecord): Promise<void> {
  await atomicWriteConfigFile(greetingPath(base), `${JSON.stringify(record, null, 2)}\n`);
}
