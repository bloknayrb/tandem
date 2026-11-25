import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ownershipEnabled } from "../../src/server/ownership-flag.js";
import { OWNERSHIP_ENABLED } from "../../src/shared/constants.js";
import {
  type FlipBlocker,
  flipBlockerViolations,
  OWNERSHIP_FLIP_BLOCKERS,
} from "./ownership-flip-blockers.js";

/**
 * The ownership flag ships dark (#2358, ADR-054; ownership design §12).
 *
 * - Release builds never carry it on: the literal is `false`, declared once.
 * - A shell export cannot make a half-on build: `tsup.config.ts` derives the
 *   define from that literal and reads no environment at all, and the
 *   identifier `ownership-flag.ts` reads is the key tsup injects.
 * - The default test run is flag-off: no vitest `test.env` and no setup file
 *   sets `TANDEM_OWNERSHIP` (this file is the one owner of that fact).
 *
 * What it cannot see is the built artifact; `scripts/ci/ownership-bundle-probe.mjs`
 * checks that, in `check` (off) and in `ownership-flag-on` (on).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf-8");

/** `//` line comments removed (a `://` in a URL survives), as license-flip-consts does. */
const stripLineComments = (src: string) => src.replace(/(^|[^:])\/\/.*$/gm, "$1");
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ownershipEnabled() without a build define (tsx, vitest)", () => {
  it("is on only for exactly TANDEM_OWNERSHIP=1, read on every call", () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    expect(ownershipEnabled()).toBe(false);
    vi.stubEnv("TANDEM_OWNERSHIP", "1");
    expect(ownershipEnabled()).toBe(true);
    for (const v of ["0", "true", "yes", " 1", "1 "]) {
      vi.stubEnv("TANDEM_OWNERSHIP", v);
      expect(ownershipEnabled(), JSON.stringify(v)).toBe(false);
    }
  });
});

describe("the release literal", () => {
  // The flip-blocker check below is redundant with this pin until the flip PR
  // edits it: while this says `false`, that check passes whatever the list
  // holds. It bites at the moment someone changes this line.
  it("is false", () => {
    expect(OWNERSHIP_ENABLED).toBe(false);
  });

  it("is declared exactly once, as a top-level boolean literal", () => {
    // Anchored and counted, so a commented-out or duplicated copy cannot answer.
    const src = stripLineComments(read("src/shared/constants.ts"));
    const matches = [...src.matchAll(/^export const OWNERSHIP_ENABLED\s*=\s*(true|false)\s*;/gm)];
    expect(matches.map((m) => m[1])).toEqual(["false"]);
  });
});

describe("tsup.config.ts derives the define from the literal, and from nothing else", () => {
  // Line comments only: a block-comment stripper reads the `src/server/license/*`
  // glob in tsup.config.ts's own comments as an opener and eats the code (the
  // trap tests/docs/license-flip-consts.test.ts records). The `^`-anchored
  // matches below are what keep a block-commented copy from answering.
  const src = stripLineComments(read("tsup.config.ts"));

  it("imports the literal and stringifies it, with no environment read anywhere", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\bOWNERSHIP_ENABLED\b[^}]*\}\s*from\s*"\.\/src\/shared\/constants\.js"/,
    );
    expect(src.match(/^const OWNERSHIP_DEFINE = .*$/gm)).toEqual([
      "const OWNERSHIP_DEFINE = JSON.stringify(OWNERSHIP_ENABLED);",
    ]);
    expect(src).not.toMatch(/process\s*\.\s*env|import\.meta\.env/);
  });

  it("puts it in the server and cli blocks of the real config", async () => {
    type Entry = { outDir?: string; define?: Record<string, string> };
    const config = (await import(pathToFileURL(path.join(ROOT, "tsup.config.ts")).href))
      .default as Entry[];
    const carrying = config.filter((e) => e.define && "__OWNERSHIP_ENABLED__" in e.define);
    expect(carrying.map((e) => e.outDir).sort()).toEqual(["dist/cli", "dist/server"]);
    for (const e of carrying) {
      expect(e.define?.__OWNERSHIP_ENABLED__).toBe(JSON.stringify(OWNERSHIP_ENABLED));
    }
  });

  it("is the identifier ownership-flag.ts reads", () => {
    const flag = read("src/server/ownership-flag.ts");
    expect(new Set([...flag.matchAll(/typeof\s+(__\w+__)/g)].map((m) => m[1]))).toEqual(
      new Set(["__OWNERSHIP_ENABLED__"]),
    );
    expect(flag).toMatch(/declare const __OWNERSHIP_ENABLED__: boolean;/);
  });
});

describe("the default test run is flag-off", () => {
  it("no vitest config and no setup file sets TANDEM_OWNERSHIP", () => {
    // The root `test.env` beats the shell, so a key there would make every run
    // flag-on and the ownership-flag-on job's anchor meaningless; a per-project
    // `test.env` or a setup file could drop it from that job instead.
    const setupDir = path.join(ROOT, "tests/setup");
    const files = [
      "vitest.config.ts",
      ...readdirSync(setupDir).map((f) => path.posix.join("tests/setup", f)),
    ];
    expect(files.length).toBeGreaterThan(1);
    for (const f of files) expect(read(f), f).not.toContain("TANDEM_OWNERSHIP");
  });
});

describe("the flip cannot land with an unaccepted blocker open (tests/server/ownership-flip-blockers.ts)", () => {
  const open: FlipBlocker[] = [
    { gap: "a gap", closedBy: "a PR" },
    { gap: "another", closedBy: "a decision" },
  ];

  it("the check is a pure function of the literal and the list", () => {
    // On with an unaccepted row fails, one message per unaccepted row.
    expect(flipBlockerViolations(true, open)).toHaveLength(2);
    expect(flipBlockerViolations(true, open)[0]).toContain("a gap");
    // On with an empty list, or only accepted rows, passes.
    expect(flipBlockerViolations(true, [])).toEqual([]);
    // Off passes either way.
    expect(flipBlockerViolations(false, open)).toEqual([]);
    expect(flipBlockerViolations(false, [])).toEqual([]);
  });

  it("an accepted row does not stop the flip; the same row without the field, or with a blank one, does", () => {
    const accepted: FlipBlocker = { gap: "a gap", closedBy: "a PR", acceptedFor: "a pick, #1" };
    expect(flipBlockerViolations(true, [accepted])).toEqual([]);
    const { acceptedFor: _dropped, ...unaccepted } = accepted;
    expect(flipBlockerViolations(true, [unaccepted])).toHaveLength(1);
    expect(flipBlockerViolations(true, [{ ...accepted, acceptedFor: "" }])).toHaveLength(1);
    expect(flipBlockerViolations(true, [{ ...accepted, acceptedFor: "  " }])).toHaveLength(1);
    // Mixed: only the unaccepted row is reported.
    expect(flipBlockerViolations(true, [accepted, open[1] as FlipBlocker])).toEqual([
      "OWNERSHIP_ENABLED is true while this is open: another",
    ]);
  });

  it("the accepted rows are exactly these, word for word (a new acceptance, or an edit to one, edits this pin)", () => {
    const acceptedRows = OWNERSHIP_FLIP_BLOCKERS.filter((row) => row.acceptedFor !== undefined);
    expect(acceptedRows.map((row) => row.gap.slice(0, 53))).toEqual([
      "The lone-session re-hand. With one session attached, ",
      "Flag on, a message's delivery round that no poll will",
      "A document claimed by a poll whose items its holder t",
      "After a server restart the delivery registry is empty",
      "The waiting decision's cost is unmeasured (3b-2b1b-ch",
      "Acknowledged but unanswered chat is never started for",
      "Acknowledged but unanswered chat by the channel route",
      "Read but unacknowledged chat is never started for (3b",
    ]);
    expect(acceptedRows).toEqual([
      {
        gap:
          "The lone-session re-hand. With one session attached, a close and reopen of a tab it holds, " +
          "a lapse (a laptop asleep past the grace, a Claude Code restart, the detached-record cap, or " +
          "a session whose stream dropped while it keeps making requests: it is detached, each request " +
          "re-arms the two-minute grace, an idle spell past it lapses it, its next write claims the " +
          "document again with no handover, and the next idle lapse hands over again, so it is " +
          "re-handed on every write-then-idle cycle; how often a dropped stream with live requests " +
          "happens is unverified) or " +
          "any other handover hands it again every pending user comment on that document, answered or " +
          "not, every resolved comment that was ever edited, and every user reply on a Claude-facing " +
          "thread, resolved long ago or not, so the re-hand grows with the document's history until the " +
          "handled filter lands; and a comment edited since it was seen arrives without `edited: true`. " +
          "On master a close and reopen re-hands nothing. Since the notice-rule PR, each lapse also " +
          "settles the accept and dismiss notices from any response that session lost (#2294): in " +
          "the write-then-idle cycle a lost response's notices go to nobody, the session included. " +
          "(A restart that returns under the same owner " +
          "id inside the two-minute grace is no handover: its fresh cursor counts what its earlier " +
          "incarnation acknowledged as seen, as on master, so the outcome turns on the grace.) Since " +
          "the scope PR a detached record also claims a document again on a poll that yields it " +
          "something, so the write-then-idle cycle is also a poll-then-idle cycle.",
        closedBy: "Bryan's answer to it (PR of the handover, 'Needs Bryan').",
        acceptedFor:
          "Bryan picked 'Accept (Recommended)' for the lone-session re-hand, picked from options, " +
          "2026-11-23 (#2360's handled filter shrinks it); tracked as #2358.",
      },
      {
        gap:
          "Flag on, a message's delivery round that no poll will ever hand and no reply will name " +
          "stays open, so the stall banner reports it: until a restart for a user row a client " +
          "deleted whose undo failed (the row is gone, so Clear chat, which drops the rounds of the " +
          "rows it finds, never drops it); until Clear chat for a client-added user row under a key " +
          "that a Claude reply already handles, and for a carried-over key re-added after such a " +
          "delete. Each needs client-written rows. Kept open with no fix in the delivery-rounds PR " +
          "(the reviewing session's ruling); Bryan decides whether to accept it or have the inbox's " +
          "'never handed' answer key such a forward as no round.",
        closedBy: "Bryan's decision, before the flip.",
        acceptedFor:
          "Bryan picked 'Accept (Recommended)', picked from options, 2026-11-23 (it needs " +
          "client-written rows the server undoes); tracked as #2358.",
      },
      {
        gap:
          "A document claimed by a poll whose items its holder then never answers: the holder keeps " +
          "it, and no other session is handed its items until a lapse, a close or a take moves it " +
          "(design §8.5's 'waiting' is what would start or wake the holder; until then nothing does). " +
          "Since the chat owners PR the same holds for a message owned per message that its owner " +
          "never answers: nobody else is handed it while that owner's record exists. An unhandled " +
          "one (an acknowledged one included: since the posts PR an acknowledgement handles nothing) " +
          "is re-owed at the owner's lapse; a handled one (by a final reply or `settles`) is never " +
          "re-owed, and stays the owner's until its record is deleted.",
        closedBy:
          "PR 3b for Tandem's Claude (3b-2b1c-a forwards a change of owner only, not a holder that " +
          "keeps an item unanswered), or Bryan's answer for terminals.",
        acceptedFor:
          "Bryan picked 'Accept, use Release/Assign (Recommended)', picked from options, 2026-11-23 " +
          "(PR 5's controls are the remedy); tracked as #2358.",
      },
      {
        gap:
          "After a server restart the delivery registry is empty, so on a document Tandem's Claude " +
          "holds, and (3b-2b1b-claimable) on every open document nobody holds while no other " +
          "session is connected (after a restart every restored document is unowned), every pending " +
          "user comment reads as waiting, answered or not, as does a resolved " +
          "comment ever edited, and every user thread reply on any Claude-facing comment (replies " +
          "have no status gate). The handled-filter row covers a handover's re-owe, not this, and " +
          "that filter would not close it: a comment answered only in chat is never handled by it.",
        closedBy: "3b-2b4: a durable registry, or a handled rule covering chat answers.",
        acceptedFor:
          "Bryan picked 'Accept (Recommended)', picked from options, 2026-11-23 (the " +
          "written-since-boot rule bounds what can start Tandem's Claude); tracked as #2358.",
      },
      {
        gap:
          "The waiting decision's cost is unmeasured (3b-2b1b-chat): each tandemWorkWaiting ask runs " +
          "one waiting probe per document Tandem's Claude holds, settledChatIds over every chat row, " +
          "one structuredClone and one schema parse per user chat row, and one message read per owed " +
          "key, and, while no other session is connected, one claim read and one waiting probe per " +
          "open, unowned document. Since 3b-2b1c-a wires it as the supervisor's workWaiting, that " +
          "happens at every start-or-wake pass, and a " +
          "document whose waiting read keeps failing logs documentWaiting's unthrottled line at each. " +
          "And (3b-2b1c-b) the message forward's admit runs one tandemChatWaiting scan (every owed " +
          "key's message read and standing, one structuredClone per user chat row) per changed key " +
          "that passes its caller check and departure gate, at the release loop and at " +
          "dropChatOwners, none at setMessageOwner; a deleted record releasing N keys, handled ones " +
          "included, runs up to N such scans.",
        closedBy:
          "Measured by 3b-2b4c (ADR-054's 3b-2b4c amendment; tests/server/ownership-waiting-cost.test.ts): " +
          "about 87 ms per decision at 50 held documents of 200 annotations and 500 chat rows, " +
          "nothing waiting, almost all of it the per-document probe (about 1.7 ms each), and about " +
          "1 to 1.5 ms per chat scan, so a release of N keys can cost N such scans. Closed by a " +
          "cheaper decision (for example a cached or incremental waiting answer), with the " +
          "measurement re-run, or Bryan accepting that cost.",
        acceptedFor:
          "Bryan picked 'Accept (Recommended)' for the measured cost of about 87 ms per decision, " +
          "picked from options, 2026-11-23; tracked as #2358.",
      },
      {
        gap:
          "Acknowledged but unanswered chat is never started for (3b-2b1b-chat): a tandem_reply with " +
          "replyTo and inProgress ('I'm on it') stamps the user message read, so it leaves waiting; if " +
          "no final answer follows (the run dies or gives up), nothing starts or wakes Claude for it, " +
          "and after a server restart it is carried over and never re-owed. The user notices and " +
          "sends the message again.",
        closedBy:
          "A design for acknowledged-but-unanswered chat after 0.32 (#2484), then its change with a test.",
        acceptedFor:
          "Bryan picked 'Known limit for 0.32; design it after (Recommended)', picked from options, " +
          "2026-11-19; tracked as #2484.",
      },
      {
        gap:
          "Acknowledged but unanswered chat by the channel route is never started for (3b-2b1b-chat): " +
          "a POST /api/channel-reply with replyTo and inProgress ('I'm on it') from the session that " +
          "owns the message stamps it read, so it leaves waiting; if no final answer follows (the run " +
          "dies or gives up), nothing starts or wakes Claude for it, and after a server restart it is " +
          "carried over and never re-owed. The user notices and sends the message again. (The same " +
          "route's acknowledgement from a non-owner was the channel-reply row, closed by PR 4b's permit.)",
        closedBy:
          "A design for acknowledged-but-unanswered chat after 0.32 (#2484), then its change with a test.",
        acceptedFor:
          "Bryan picked 'Yes, both routes (Recommended)', picked from options, 2026-11-19, so 'Known " +
          "limit for 0.32; design it after (Recommended)' covers the channel route too; tracked as " +
          "#2484.",
      },
      {
        gap:
          "Read but unacknowledged chat is never started for (3b-2b1b-chat): a cursor acknowledgement, " +
          "or a cursor-less poll's commit at hand-out, stamps a user message read with no 'I'm on it'; " +
          "if Claude never answers, the message leaves waiting for good, and after a server restart it " +
          "is carried over and never re-owed. The pick on acknowledged chat does not cover this.",
        closedBy: "Bryan's answer, then its change with a test.",
        acceptedFor:
          "Bryan picked 'Fold into #2484 (Recommended)', picked from options, 2026-11-23; tracked " +
          "as #2484.",
      },
    ]);
  });

  it("every accepted row names an issue, and ADR-054 names every issue it names", () => {
    const decisions = read("docs/decisions.md");
    const start = decisions.indexOf("## ADR-054");
    const end = decisions.indexOf("## ADR-055");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const adr = decisions.slice(start, end);
    const acceptedRows = OWNERSHIP_FLIP_BLOCKERS.filter((row) => row.acceptedFor !== undefined);
    expect(acceptedRows.length).toBeGreaterThan(0);
    for (const row of acceptedRows) {
      const issues = (row.acceptedFor as string).match(/#\d+/g) ?? [];
      expect(issues.length, row.gap).toBeGreaterThan(0);
      for (const issue of issues) {
        expect(adr, `${issue} (${row.gap.slice(0, 40)})`).toMatch(new RegExp(`${issue}(?!\\d)`));
      }
    }
  });

  it("the source literal and the real list pass it", () => {
    // The imported source literal, never `ownershipEnabled()`: the
    // ownership-flag-on job turns the runtime flag on with the literal still
    // `false`, and must stay green.
    expect(flipBlockerViolations(OWNERSHIP_ENABLED, OWNERSHIP_FLIP_BLOCKERS)).toEqual([]);
  });

  // The gap (a) pins (its test's title exists, and a row names it) went with
  // the row: the scope PR closed gap (a) and flipped that test.
  it("every row names its gap and what closes it", () => {
    for (const row of OWNERSHIP_FLIP_BLOCKERS) {
      expect(row.gap.trim().length, row.gap).toBeGreaterThan(20);
      expect(row.closedBy.trim().length, row.gap).toBeGreaterThan(5);
      if (row.acceptedFor !== undefined) {
        expect(row.acceptedFor.trim().length, row.gap).toBeGreaterThan(20);
      }
    }
    expect(new Set(OWNERSHIP_FLIP_BLOCKERS.map((row) => row.gap)).size).toBe(
      OWNERSHIP_FLIP_BLOCKERS.length,
    );
  });

  it("the plan's flip row points at the list instead of restating it", () => {
    const plan = read("docs/plans/2358-ownership.md");
    const row = plan.split("\n").find((line) => line.startsWith("| **6. Flip** |")) as string;
    expect(row).toContain("tests/server/ownership-flip-blockers.ts");
    expect(row).not.toMatch(/notifications\/cancelled|probeRefusal|callTool/);
  });
});
