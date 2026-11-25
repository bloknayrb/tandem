import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CODE_FILES,
  closure,
  IMPORTS,
  sidecarEntries,
  UNRESOLVED,
} from "../helpers/import-graph.js";
import { readTree, SRC_FILES, stripComments } from "../helpers/src-tree.js";

/**
 * The ownership flag's module seam (#2358, ADR-054; ownership design §12).
 *
 * `src/server/ownership-flag.ts` reads `__OWNERSHIP_ENABLED__`. esbuild leaves
 * an absent define as a bare free global, and the flag then falls back to the
 * `TANDEM_OWNERSHIP` env var — a half-on build. So:
 *
 * - every module that imports the flag is pinned, so a new reader is a
 *   reviewed diff;
 * - every tsup bundle whose entry reaches the flag carries the define (derived
 *   from the real config, so a new bundle joins by itself);
 * - the define-less bundles (every sidecar, the stdio bridge's script, the SSE
 *   consumer), `src/shared` and `src/client` never reach it;
 * - only `ownership-flag.ts` reads the define or the variable in `src`.
 *
 * And the test side of shipping dark: which test files turn the flag on or off
 * for themselves is a pinned set (a file stubbing it `""` opts out of the
 * flag-on job, silently shrinking it), nothing mocks the flag module, and only
 * the anchor keys a test on the flag — while never stubbing it, so the anchor
 * proves the job's variable reached the workers.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FLAG = "src/server/ownership-flag.ts";
const ANCHOR = "tests/server/ownership-anchor.test.ts";

/** Every code file under `tests/`, repo-relative → contents, decode-checked. */
const TEST_FILES = readTree(path.join(ROOT, "tests"), (name) =>
  /\.(ts|mts|js|mjs|svelte)$/.test(name),
);

describe("ownership flag module seam", () => {
  it("the import walk resolves every relative specifier in src (fails closed)", () => {
    // The same known prose specifier license-module-seam.test.ts pins.
    expect(UNRESOLVED).toEqual([
      "src/client/svelte-harness/registry.ts -> ../path/to/Component.svelte",
    ]);
  });

  it("is imported by exactly the reviewed modules", () => {
    const importers = [...IMPORTS]
      .filter(([file, targets]) => file !== FLAG && targets.includes(FLAG))
      .map(([file]) => file)
      .sort();
    expect(importers).toEqual([
      // PR 3a: the supervisor reads the flag per spawn (handle, run files,
      // boot sweep) rather than taking an injected boolean, so a forgotten
      // wiring cannot make tests and production disagree.
      "src/server/launcher/supervisor.ts",
      // PR 5a: the ownership routes are registered only while the flag is on
      // (a registered path answers OPTIONS even when its handlers skip), and
      // their gate skips them per request for a flag read after registration.
      "src/server/mcp/api-routes.ts",
      "src/server/mcp/owned-op.ts",
      "src/server/mcp/routes/ownership.ts",
      "src/server/mcp/server.ts",
      "src/server/sessions/caller.ts",
      "src/server/sessions/log-id.ts",
      "src/server/sessions/ownership.ts",
    ]);
  });

  it("every tsup bundle whose entry reaches it carries the define", async () => {
    type Entry = { entry?: string[]; outDir?: string; define?: Record<string, string> };
    const config = (await import(pathToFileURL(path.join(ROOT, "tsup.config.ts")).href))
      .default as Entry[];
    const reaching = config.filter((e) => (e.entry ?? []).some((f) => closure(f).has(FLAG)));
    // Anti-vacuity: the server bundle does reach it.
    expect(reaching.map((e) => e.outDir)).toContain("dist/server");
    for (const e of reaching) {
      expect(e.define, `${e.outDir} reaches ${FLAG}`).toHaveProperty("__OWNERSHIP_ENABLED__");
    }
  });

  it("no define-less bundle, and nothing in src/shared or src/client, reaches it", () => {
    const sidecars = sidecarEntries(readFileSync(path.join(ROOT, "tsup.config.ts"), "utf-8"));
    expect(sidecars).toEqual(
      expect.arrayContaining([
        "src/channel/index.ts",
        "src/monitor/index.ts",
        "src/stdio-bridge/index.ts",
      ]),
    );
    for (const root of [...sidecars, "src/cli/mcp-stdio.ts", "src/shared/sse-consumer.ts"]) {
      const reach = closure(root);
      expect(reach.size, `${root} closure`).toBeGreaterThan(1);
      expect(reach.has(FLAG), `${root} must not reach ${FLAG}`).toBe(false);
    }
    const leaking = CODE_FILES.filter(
      (f) => (f.startsWith("src/shared/") || f.startsWith("src/client/")) && closure(f).has(FLAG),
    );
    expect(leaking).toEqual([]);
  });

  it("only ownership-flag.ts reads the define or the variable in src", () => {
    const readers = CODE_FILES.filter((f) => f !== FLAG).filter((f) =>
      /TANDEM_OWNERSHIP|__OWNERSHIP_ENABLED__/.test(stripComments(SRC_FILES.get(f) as string)),
    );
    expect(readers).toEqual([]);
    expect(SRC_FILES.get(FLAG)).toMatch(/process\.env\.TANDEM_OWNERSHIP === "1"/);
  });
});

describe("tests and the flag", () => {
  /** Files whose source matches `pattern`, sorted. */
  const filesMatching = (pattern: RegExp) =>
    [...TEST_FILES]
      .filter(([, src]) => pattern.test(src))
      .map(([f]) => f)
      .sort();

  it("the walk sees the test tree", () => {
    expect(TEST_FILES.size).toBeGreaterThan(500);
    expect(TEST_FILES.has(ANCHOR)).toBe(true);
  });

  it("only the anchor keys a test on the flag", () => {
    // `ownershipEnabled` imported into a test is the way to write
    // `it.runIf(ownershipEnabled())` or `if (!ownershipEnabled()) return`; a
    // second such file is a test that silently never runs in `check`.
    expect(filesMatching(/import\s*\{[^}]*\bownershipEnabled\b[^}]*\}\s*from/)).toEqual([
      ANCHOR,
      "tests/server/ownership-flag.test.ts",
    ]);
    const keyed = [...TEST_FILES]
      .filter(([, src]) =>
        /\b(?:runIf|skipIf)\s*\([^)]*(?:ownership|OWNERSHIP)/.test(stripComments(src)),
      )
      .map(([f]) => f);
    expect(keyed).toEqual([ANCHOR]);
  });

  it("the anchor never sets the variable or mocks anything", () => {
    // Comments stripped: its docblock explains why it never calls vi.stubEnv.
    const src = stripComments(TEST_FILES.get(ANCHOR) as string);
    expect(src).not.toMatch(/stubEnv|vi\.mock|vi\.doMock|process\.env\.\w+\s*=|process\.env\[/);
    expect(src).toMatch(/expect\(process\.env\.TANDEM_OWNERSHIP\)\.toBe\("1"\)/);
  });

  it("nothing mocks the flag module", () => {
    expect(filesMatching(/vi\.(?:do)?[mM]ock\(\s*["'][^"']*ownership-flag/)).toEqual([]);
  });

  // Every file that stubs the variable, by any argument: a stub through a
  // variable would slip past the two literal sets below.
  const OWNERSHIP_TEST_FILES = [
    // PR 4b: master's channel route pinned dark, with one flag-on case.
    "tests/server/chat-reply-ack.test.ts",
    "tests/server/inbox-cursor.test.ts",
    "tests/server/launcher/owner-handle-chain.test.ts",
    "tests/server/launcher/owner-handle-spawn.test.ts",
    "tests/server/launcher/ownership-forward.test.ts",
    "tests/server/launcher/supervisor-presence.test.ts",
    "tests/server/launcher/supervisor-turn-delivery.test.ts",
    "tests/server/launcher/supervisor.test.ts",
    "tests/server/license-armed-restricted.test.ts",
    "tests/server/local-period.test.ts",
    "tests/server/mcp-context-seam.test.ts",
    "tests/server/mcp-write-precedence.test.ts",
    "tests/server/ownership-api-no-context.test.ts",
    // PR 3b-2e1: the Settings list of bound transports through the real
    // server, booted flag on and (its dark row) flag off, through `boot(flag)`.
    "tests/server/ownership-bound-transports.test.ts",
    "tests/server/ownership-change-notices-http.test.ts",
    "tests/server/ownership-change-notices.test.ts",
    // PR 4b: the /api/channel-reply permit, flag on with a dark row.
    "tests/server/ownership-channel-reply.test.ts",
    "tests/server/ownership-chat-client-undo.test.ts",
    "tests/server/ownership-chat.test.ts",
    "tests/server/ownership-claim-at-outcome.test.ts",
    "tests/server/ownership-claims-table.test.ts",
    // PR 5a: the ownership routes, flag on, with a dark row that boots flag off.
    "tests/server/ownership-control-route.test.ts",
    "tests/server/ownership-dark-enforcement.test.ts",
    "tests/server/ownership-default-rule.test.ts",
    "tests/server/ownership-delivery-rounds.test.ts",
    "tests/server/ownership-enforcement.test.ts",
    "tests/server/ownership-flag.test.ts",
    "tests/server/ownership-greeting.test.ts",
    "tests/server/ownership-handover.test.ts",
    "tests/server/ownership-http-identity.test.ts",
    "tests/server/ownership-inbox-scope.test.ts",
    // PR 5a-2: the message control, flag on, with a dark row.
    "tests/server/ownership-message-control.test.ts",
    "tests/server/ownership-mode-known.test.ts",
    "tests/server/ownership-notice-rule.test.ts",
    "tests/server/ownership-owner-handle-bind.test.ts",
    "tests/server/ownership-posts.test.ts",
    "tests/server/ownership-presence.test.ts",
    // PR 4a: the push stream's narrowing and the ownership-changed nudge.
    "tests/server/ownership-push-narrowing.test.ts",
    "tests/server/ownership-records.test.ts",
    "tests/server/ownership-reowe-rounds.test.ts",
    "tests/server/ownership-take-back.test.ts",
    "tests/server/ownership-tool-modes.test.ts",
    "tests/server/ownership-wait-bound.test.ts",
    "tests/server/ownership-waiting-chat.test.ts",
    "tests/server/ownership-waiting-cost.test.ts",
    "tests/server/ownership-waiting.test.ts",
    "tests/server/ownership-wake-frame.test.ts",
  ];

  it("the files that stub the variable at all are a reviewed set", () => {
    expect(filesMatching(/stubEnv\(\s*["'`]TANDEM_OWNERSHIP["'`]/)).toEqual(OWNERSHIP_TEST_FILES);
  });

  it("the files that turn the flag OFF for themselves are a reviewed set", () => {
    // A file stubbing "" runs that test flag-off even in the ownership-flag-on
    // job: it pins dark behaviour, and the series lists each one (design §12).
    // Every one of these also stubs "1": none opts a whole file out.
    // PR 1c's four: each runs the same rows flag-off and flag-on (the
    // precedence pin, the tool-mode table, the `/api` differential), or pins
    // what enforcement must not do while dark.
    // The handover PR's one (`ownership-handover.test.ts`): it seeds state
    // flag-on and then turns the flag off, to show no path reaches the inbox.
    // The scope PR's one (`ownership-inbox-scope.test.ts`): its dark tests
    // build their server flag-off, to show tandem_checkInbox is master's.
    // #1123 A2's one (`local-period.test.ts`): it runs every local-period case
    // with ownership off and on (the brief's "ownership off and on").
    // The notice-rule PR's one (`ownership-notice-rule.test.ts`): its lone-
    // session script and its dark test run flag-off to compare with master.
    // The change-notice PR's one (`ownership-change-notices.test.ts`): its
    // dark tests build their server flag-off (no `changed`, no sentence).
    // PR 3b-1's one (`launcher/supervisor-presence.test.ts`): the supervisor's
    // run state flag on, with a dark case that builds its supervisor flag-off.
    // PR 3b-2b4a's one (`ownership-presence.test.ts`): presence's consumer
    // and the queued user-open default, with dark cases run with the seams
    // wired. PR 3b-2b4b's one (`ownership-take-back.test.ts`): take-back and
    // the Solo-release check, with a dark case run with every seam wired.
    expect(filesMatching(/stubEnv\(\s*"TANDEM_OWNERSHIP",\s*""\s*\)/)).toEqual([
      // PR 4b: master's /api/channel-reply pinned dark (its describe), with
      // one flag-on case showing the permit is reached.
      "tests/server/chat-reply-ack.test.ts",
      // PR 3a: the launcher's spawn path, flag on, with a dark block.
      "tests/server/inbox-cursor.test.ts",
      "tests/server/launcher/owner-handle-spawn.test.ts",
      "tests/server/launcher/ownership-forward.test.ts",
      "tests/server/launcher/supervisor-presence.test.ts",
      // PR 3b-2c: the greeting by bound transport, flag on, with its two
      // dark (master's session-id) greeting blocks.
      "tests/server/launcher/supervisor-turn-delivery.test.ts",
      "tests/server/local-period.test.ts",
      "tests/server/mcp-context-seam.test.ts",
      "tests/server/mcp-write-precedence.test.ts",
      "tests/server/ownership-api-no-context.test.ts",
      "tests/server/ownership-change-notices.test.ts",
      // PR 4b: the /api/channel-reply permit, flag on, with a dark row.
      "tests/server/ownership-channel-reply.test.ts",
      "tests/server/ownership-chat-client-undo.test.ts",
      "tests/server/ownership-chat.test.ts",
      // PR 5a: the routes booted flag off, compared with an unknown path.
      "tests/server/ownership-control-route.test.ts",
      "tests/server/ownership-dark-enforcement.test.ts",
      "tests/server/ownership-default-rule.test.ts",
      "tests/server/ownership-delivery-rounds.test.ts",
      "tests/server/ownership-flag.test.ts",
      // PR 3b-2c: what the reply paths hand the greeting classifier, flag on
      // with dark rows.
      "tests/server/ownership-greeting.test.ts",
      "tests/server/ownership-handover.test.ts",
      "tests/server/ownership-inbox-scope.test.ts",
      // PR 5a-2: the message control flag on, with a dark row that turns it off.
      "tests/server/ownership-message-control.test.ts",
      // The mode-unknown observer: flag on, with a dark row that writes the
      // mode and swaps CTRL_ROOM flag off.
      "tests/server/ownership-mode-known.test.ts",
      "tests/server/ownership-notice-rule.test.ts",
      "tests/server/ownership-posts.test.ts",
      "tests/server/ownership-presence.test.ts",
      // PR 4a's one: the push stream's narrowing and the ownership-changed
      // nudge flag on, with dark rows (every stream gets every event byte for
      // byte; a lapse nudges nothing).
      "tests/server/ownership-push-narrowing.test.ts",
      "tests/server/ownership-records.test.ts",
      // PR 3b-2b5: the re-owe's round and the reopen round, flag on with a
      // dark row run with every seam wired.
      "tests/server/ownership-reowe-rounds.test.ts",
      "tests/server/ownership-take-back.test.ts",
      "tests/server/ownership-tool-modes.test.ts",
      "tests/server/ownership-wait-bound.test.ts",
      "tests/server/ownership-waiting-chat.test.ts",
      "tests/server/ownership-waiting.test.ts",
      // PR 3b-2d's one (`ownership-wake-frame.test.ts`): the ownership frame
      // flag on, with a dark row run with every seam wired.
      "tests/server/ownership-wake-frame.test.ts",
    ]);
  });

  it("the files that turn the flag ON for themselves are a reviewed set", () => {
    expect(filesMatching(/stubEnv\(\s*"TANDEM_OWNERSHIP",\s*"1"\s*\)/)).toEqual([
      // PR 4b: the permit's one flag-on case beside master's route.
      "tests/server/chat-reply-ack.test.ts",
      // PR 3a: the chain, and the launcher's spawn path (flag on, with a dark block).
      "tests/server/inbox-cursor.test.ts",
      "tests/server/launcher/owner-handle-chain.test.ts",
      "tests/server/launcher/owner-handle-spawn.test.ts",
      "tests/server/launcher/ownership-forward.test.ts",
      "tests/server/launcher/supervisor-presence.test.ts",
      // PR 3b-2c: the greeting by bound transport, flag on.
      "tests/server/launcher/supervisor-turn-delivery.test.ts",
      // The keyed-rounds suites PR: its live check of the delivery-round
      // wiring, flag on in `check` too (the rest of the file is unstubbed).
      "tests/server/license-armed-restricted.test.ts",
      "tests/server/local-period.test.ts",
      "tests/server/mcp-context-seam.test.ts",
      "tests/server/mcp-write-precedence.test.ts",
      "tests/server/ownership-api-no-context.test.ts",
      "tests/server/ownership-change-notices-http.test.ts",
      "tests/server/ownership-change-notices.test.ts",
      // PR 4b: the /api/channel-reply permit.
      "tests/server/ownership-channel-reply.test.ts",
      "tests/server/ownership-chat-client-undo.test.ts",
      "tests/server/ownership-chat.test.ts",
      "tests/server/ownership-claim-at-outcome.test.ts",
      "tests/server/ownership-claims-table.test.ts",
      "tests/server/ownership-control-route.test.ts",
      "tests/server/ownership-dark-enforcement.test.ts",
      "tests/server/ownership-default-rule.test.ts",
      "tests/server/ownership-delivery-rounds.test.ts",
      "tests/server/ownership-enforcement.test.ts",
      "tests/server/ownership-flag.test.ts",
      // PR 3b-2c: what the reply paths hand the greeting classifier, flag on
      // with dark rows.
      "tests/server/ownership-greeting.test.ts",
      "tests/server/ownership-handover.test.ts",
      "tests/server/ownership-inbox-scope.test.ts",
      // PR 5a-2: the message control.
      "tests/server/ownership-message-control.test.ts",
      "tests/server/ownership-mode-known.test.ts",
      "tests/server/ownership-notice-rule.test.ts",
      "tests/server/ownership-posts.test.ts",
      "tests/server/ownership-presence.test.ts",
      // PR 4a: the push stream's narrowing and the ownership-changed nudge.
      "tests/server/ownership-push-narrowing.test.ts",
      "tests/server/ownership-records.test.ts",
      // PR 3b-2b5: the re-owe's round and the reopen round, flag on with a
      // dark row run with every seam wired.
      "tests/server/ownership-reowe-rounds.test.ts",
      "tests/server/ownership-take-back.test.ts",
      "tests/server/ownership-tool-modes.test.ts",
      "tests/server/ownership-wait-bound.test.ts",
      "tests/server/ownership-waiting-chat.test.ts",
      // PR 3b-2b4c's measurement of the waiting cost: flag on throughout.
      "tests/server/ownership-waiting-cost.test.ts",
      "tests/server/ownership-waiting.test.ts",
      // PR 3b-2d: the ownership frame on /api/wake, flag on with a dark row.
      "tests/server/ownership-wake-frame.test.ts",
    ]);
  });

  it("no test writes the variable except through vi.stubEnv", () => {
    // An assignment, a bracket access, or a `delete` (which turns the flag off
    // for the rest of the file in the flag-on job, past every stubEnv pin).
    expect(
      filesMatching(
        /process\.env\.TANDEM_OWNERSHIP\s*=(?!=)|process\.env\[\s*["'`]TANDEM_OWNERSHIP|\bdelete\s+process\.env\.TANDEM_OWNERSHIP\b/,
      ),
    ).toEqual([]);
  });

  it("no test passes vi.stubEnv a key that is not a string literal", () => {
    // The stubEnv pins above read the key as a literal, so a stubEnv of `K` to ""
    // with `K` a constant (here or imported) would turn the flag off unseen.
    // No test needs a computed key today, so none is allowed: a new one names
    // its variable in place.
    expect(filesMatching(/\bstubEnv\(\s*(?!["'`])/)).toEqual([]);
  });
});
