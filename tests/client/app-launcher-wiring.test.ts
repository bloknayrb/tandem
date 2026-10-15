/**
 * Source pins for App's launcher wiring (#2195) — the two facts no type and no
 * mounted test can catch:
 *
 *   1. The chat panel is mounted through `PanelSlot`, whose loose
 *      `[key: string]: any` union arm accepts a mount that forgets ChatPanel's
 *      required props. The Start / Turn off control would then never render,
 *      and nothing would say so.
 *   2. The no-agent send toast is built inside App, which no test mounts. Its
 *      action must go through `ctaHandler` (App's `aiCtaHandler`): a binary
 *      `action === "restart" ? … : …` sends the `start` CTA to the integration
 *      wizard (#1268's bug class).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP = readFileSync(join(import.meta.dirname, "../../src/client/App.svelte"), "utf8");

function chatMount(): string {
  const start = APP.indexOf('kind="chat"');
  expect(start, "App mounts a chat PanelSlot").toBeGreaterThan(-1);
  const end = APP.indexOf("/>", start);
  return APP.slice(start, end);
}

describe("App launcher wiring (#2195)", () => {
  it("the chat panel mount passes the Start / Turn off control and both handlers", () => {
    const mount = chatMount();
    expect(mount).toMatch(/tandemClaudeControl=\{tandemClaudeControl\}/);
    expect(mount).toMatch(/onStartClaude=\{startClaude\}/);
    expect(mount).toMatch(/onTurnOffClaude=\{turnOffClaude\}/);
  });

  it("the no-agent toast routes through ctaHandler, never a binary ternary", () => {
    expect(APP).toMatch(/onClick: aiCtaHandler\(AI_CTA\[cta\]\.action\)/);
    expect(APP).not.toMatch(/\.action === "restart" \?/);
  });

  it("the chat panel's Start is hidden while the licence refuses the AI (#1521)", () => {
    const ctl = APP.slice(APP.indexOf("const tandemClaudeControl = $derived"));
    expect(ctl.slice(0, ctl.indexOf(");\n"))).toMatch(/aiReadiness\.aiNotice === null &&/);
  });

  it("App's ctaHandler wiring maps start to the Start control", () => {
    const fn = APP.slice(APP.indexOf("function aiCtaHandler("));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toMatch(/start: startClaude,/);
  });
});

describe("App resume-row wiring (#2196)", () => {
  it("the chat panel mount passes the resume row and its remedy handler", () => {
    const mount = chatMount();
    expect(mount).toMatch(/tandemClaudeResume=\{chatResumeState\.view\}/);
    expect(mount).toMatch(/\{onResumeRemedy\}/);
  });

  it("a send notes the request BEFORE the addressed-ai dispatch whose toast reads it", () => {
    const send = APP.slice(APP.indexOf("function sendChatMessage("));
    const noted = send.indexOf("chatResumeState.noteSent();");
    const dispatched = send.indexOf('"tandem:addressed-ai"');
    expect(noted).toBeGreaterThan(-1);
    expect(dispatched).toBeGreaterThan(noted);
  });

  it("the no-agent toast stands aside for a chat that is starting Claude, and only for chat", () => {
    expect(APP).toMatch(/startingForMessage: viaKey === "chat" && chatResumeState\.pending,/);
  });

  it("the chat panel's Start hides beside the resume row, which carries its own remedy", () => {
    const ctl = APP.slice(APP.indexOf("const tandemClaudeControl = $derived"));
    expect(ctl.slice(0, ctl.indexOf(");\n"))).toMatch(/chatResumeState\.view === null/);
  });

  it("the remedy routes through ctaHandler", () => {
    expect(APP).toMatch(/aiCtaHandler\(AI_CTA\[remedy\]\.action\)\(\)/);
  });
});

describe("App greeting and done-screen wiring (#2197)", () => {
  it("the chat panel mount passes the greeting note and its handler", () => {
    const mount = chatMount();
    expect(mount).toMatch(/tandemClaudeGreetingLate=\{greetingAction\}/);
    expect(mount).toMatch(/\{onGreetingAction\}/);
  });

  it("the note's action comes from greetingNoteAction, fed every gate from readiness", () => {
    const d = APP.slice(APP.indexOf("const greetingAction = $derived"));
    const body = d.slice(0, d.indexOf("}),\n);"));
    expect(body).toMatch(/greetingNoteAction\(\{/);
    for (const field of [
      /greetingLate: aiReadiness\.greetingLate,/,
      /serverUnreachable: aiReadiness\.serverUnreachable,/,
      /aiOff: aiReadiness\.aiNotice !== null,/,
      /stoppedByChoice: aiReadiness\.launcherStandby !== null,/,
      /busy: aiReadiness\.launcherBusy,/,
      /running: aiReadiness\.launcherRunning,/,
      /remedy: aiReadiness\.launcherRemedy,/,
    ]) {
      expect(body).toMatch(field);
    }
    const h = APP.slice(APP.indexOf("function onGreetingAction("));
    expect(h.slice(0, h.indexOf("\n}\n"))).toMatch(
      /if \(action === "relaunch"\) restartClaude\(\);/,
    );
  });

  it("the wizard gets Tandem's Claude's live state for its done screen", () => {
    const w = APP.slice(APP.indexOf("<IntegrationWizardModal"));
    const tag = w.slice(0, w.indexOf("/>"));
    expect(tag).toMatch(/running: aiReadiness\.launcherRunning,/);
    expect(tag).toMatch(/remedy: aiReadiness\.launcherRemedy,/);
    expect(tag).toMatch(/standby: aiReadiness\.launcherStandby,/);
  });
});

describe("App v1.0 walkthrough wiring (#2198)", () => {
  /** A function body, from its declaration to the next top-level `}`. */
  function fn(name: string): string {
    const start = APP.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    return APP.slice(start, APP.indexOf("\n}\n", start));
  }

  it("auto-open goes through resolveWizardAutoOpen, fed the walkthrough and the session flag", () => {
    const d = APP.slice(APP.indexOf("const isAutoOpenFirstRun = $derived("));
    const body = d.slice(0, d.indexOf("}),\n);"));
    expect(body).toMatch(/resolveWizardAutoOpen\(\{/);
    expect(body).toMatch(/walkthrough: firstRun\.walkthrough,/);
    // Keyed on the server's launch, so a tab open across a restart gets it back
    // (the latch's own rules: `launch-latch.test.ts`).
    expect(body).toMatch(/closedThisSession: wizardClosedLatch\.active,/);
    expect(APP).toMatch(
      /const wizardClosedLatch = createLaunchLatch\(WIZARD_CLOSED_LAUNCH_KEY, \(\) => firstRun\.launchId\);/,
    );
    expect(body).toMatch(/dismissedForVersion,/);
  });

  it("closing the walkthrough ends it for the session only, never for the version", () => {
    const close = fn("closeIntegrationWizard");
    expect(close).toMatch(
      /if \(!firstRun\.walkthrough\) dismissForVersion\(firstRun\.serverVersion\);/,
    );
    expect(close).toMatch(/wizardClosedLatch\.mark\(\);/);
    // A successful Apply or Keep may have ended it on the server: re-read.
    expect(close).toMatch(/if \(firstRun\.walkthrough\) void firstRun\.refetch\(\);/);
  });

  it("Keep also dismisses the first-run rule, and the wizard gets both walkthrough props", () => {
    expect(fn("onWalkthroughKept")).toMatch(/dismissForVersion\(firstRun\.serverVersion\)/);
    const mount = APP.slice(APP.indexOf("<IntegrationWizardModal"));
    const props = mount.slice(0, mount.indexOf("/>"));
    expect(props).toMatch(/\{walkthroughVersion\}/);
    expect(props).toMatch(/\{onWalkthroughKept\}/);
  });

  it("the in-memory dismissal is set even when localStorage throws", () => {
    const dismiss = fn("dismissForVersion");
    expect(dismiss.indexOf("dismissedForVersion = version;")).toBeLessThan(
      dismiss.indexOf("localStorage.setItem"),
    );
  });

  it("another tab's close latches this tab's open wizard rather than unmounting it", () => {
    const start = APP.indexOf("const onStorage = (ev: StorageEvent) => {");
    const body = APP.slice(start, APP.indexOf("};", start));
    expect(body).toMatch(
      /\(ev\.key === WIZARD_DISMISSED_KEY \|\| ev\.key === WIZARD_CLOSED_LAUNCH_KEY\) &&\s*isAutoOpenFirstRun\s*\) \{\s*manuallyReopened = true;/,
    );
    expect(body.indexOf("manuallyReopened = true")).toBeLessThan(
      body.indexOf("wizardClosedLatch.onStorage(ev)"),
    );
  });
});
