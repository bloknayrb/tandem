/**
 * App's wiring of who answers chat (#1123 part B, review round 1 item 6),
 * pinned from source: nothing mounts App in tests (see `cowork-ship-dark`).
 * The store's triggers, the panel and the pill are tested through their own
 * entry points and props; this pins that App calls each trigger and passes
 * the store's values, so an App that never wired one, or always passed
 * `localPickup: null`, fails here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(join(process.cwd(), "src/client/App.svelte"), "utf8")
  // Comments out, so a commented-out call cannot satisfy a pin.
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/<!--[\s\S]*?-->/g, "");

/** The body of the `$effect(() => { … })` that contains `marker`. */
function effectContaining(marker: string): string {
  const at = app.indexOf(marker);
  expect(at, `no ${marker} in App.svelte`).toBeGreaterThan(-1);
  const start = app.lastIndexOf("$effect(() => {", at);
  expect(start, `${marker} is not inside an $effect`).toBeGreaterThan(-1);
  return app.slice(start, at + marker.length);
}

describe("App wires who answers chat (R1.2, R5.5, R7, R8)", () => {
  it("each R1.2 trigger is called, behind the flag, and the store's reads are untracked", () => {
    for (const call of ["noteCtrlSynced(doc)", "noteHeld(held)", "observeChatForAnswerer({"]) {
      const effect = effectContaining(call);
      expect(effect, call).toContain("if (!BYO_MODELS_ENABLED) return;");
      expect(effect, call).toMatch(/untrack\(\(\) =>\s*\w+\(/);
    }
    expect(app).toMatch(
      /createNotifications\(\{\s*onStreamNotice: \(n\) => noteNotifyNotice\(n\.dedupKey\)/,
    );
    expect(app).toMatch(/if \(BYO_MODELS_ENABLED\) setChatAnswererToastSink\(/);
    expect(app).toMatch(/onNoticeRows: announceNoticeRows/);
    expect(app).toMatch(/onSent: \(message\) =>\s*noteChatSent\(message,/);
    // The notice announcement defers its writes and calls the store's trigger.
    const announce = app.slice(app.indexOf("function announceNoticeRows"));
    expect(announce.slice(0, 600)).toMatch(
      /queueMicrotask\(\(\) => \{[\s\S]*noteNoticeRowArrived\(\)/,
    );
  });

  it("the panel and the pill get the store's values, not constants", () => {
    expect(app).toMatch(/localPickup=\{localPickupInputs\}/);
    expect(app).toMatch(/localPeriod=\{localPeriodNow\}/);
    expect(app).toMatch(/noticeAnnouncement=\{chatNoticeAnnouncement\}/);
    expect(app).toMatch(/aiLocalChat=\{localChatSetting\}/);
    // Lit, the pickup inputs are the store's; dark, null.
    expect(app).toMatch(
      /const localPickupInputs = \$derived\(\s*BYO_MODELS_ENABLED\s*\?\s*\{\s*runGeneration: chatAnswerer\.runGeneration,\s*sentLocal: chatAnswerer\.sentLocal,/,
    );
    expect(app).toMatch(
      /localChatSettingFor\(chatAnswerer, aiReadiness\.launcherHeldForLocalModel\)/,
    );
  });

  it("the resume row and the send-time toast read the local period", () => {
    expect(app).toMatch(/createChatResume\([\s\S]{0,600}\(\) => localPeriodNow,\s*\)/);
    expect(app).toMatch(/localPeriod: localPeriodNow,/);
    expect(app).toMatch(/!\(via === "comment" && localPeriodNow\)/);
  });
});
