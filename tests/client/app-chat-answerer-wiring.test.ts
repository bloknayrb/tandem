/**
 * App's wiring of who answers chat (#1123 part B, review round 1 item 6; #2433
 * M1 and M2), pinned from source: nothing mounts App in tests (see
 * `cowork-ship-dark`; Ruling S-e). The store's triggers, the panel and the
 * pill are tested through their own entry points and props; this pins that
 * App calls each trigger with the store's values, so an App that never wired
 * one, or always passed `localPickup: null`, fails here.
 *
 * Every pin reads comment-stripped text (`tests/helpers/app-source.ts`: markup
 * comments, `/* *\/` blocks and whole-line `//`), and each is anchored to its
 * own call, derivation or mount, because some pinned text occurs more than
 * once (`aiOff: licenseStore.ui.aiOff` three times; `const doc = …` twice).
 *
 * **What a text pin cannot see** (the limits, honestly):
 * - arguments after an `effectContaining` marker (hence the explicit argument
 *   pins, and markers that end after the whole argument);
 * - text duplicated elsewhere in the file, where a pin is not anchored;
 * - a binding shadowed by a local of the same name;
 * - an unreachable call or mount: `if (false)`, an early `return` or `throw`,
 *   a condition around it;
 * - a value reassigned after the pinned line;
 * - pinned text inside a string;
 * - a trailing `//` comment on a code line (only whole-line ones are stripped);
 * - a later spread or duplicate attribute on the mount that overrides a pinned
 *   prop;
 * - `chatMount()` ends at the first `/>` after `kind="chat"`, so a
 *   self-closing child or an attribute containing `/>` cuts it short;
 * - `/*` inside a script string, which the block-comment strip treats as a
 *   comment.
 * There is no mount test of App (Ruling S-e): 129 imports and a live
 * Hocuspocus provider.
 */
import { describe, expect, it } from "vitest";
import { chatMount, readAppSource } from "../helpers/app-source";

const app = readAppSource();

/** The body of the `$effect(() => { … })` that contains `marker`, from the
 *  effect's start to the END of the marker (nothing after it is seen). */
function effectContaining(marker: string): string {
  const at = app.indexOf(marker);
  expect(at, `no ${marker} in App.svelte`).toBeGreaterThan(-1);
  const start = app.lastIndexOf("$effect(() => {", at);
  expect(start, `${marker} is not inside an $effect`).toBeGreaterThan(-1);
  return app.slice(start, at + marker.length);
}

/** From `opener` to the first `closer` after it (exclusive). */
function sliceFrom(text: string, opener: string, closer: string, from = 0): string {
  const start = text.indexOf(opener, from);
  expect(start, `no ${opener}`).toBeGreaterThan(-1);
  const end = text.indexOf(closer, start + opener.length);
  expect(end, `${opener} is not closed by ${closer}`).toBeGreaterThan(-1);
  return text.slice(start, end + closer.length);
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("App wires who answers chat (R1.2, R5.5, R7, R8)", () => {
  it("each R1.2 trigger is called, behind the flag, and the store's reads are untracked", () => {
    for (const call of [
      "noteCtrlSynced(doc)",
      "noteHeld(held)",
      "observeChatForAnswerer({ doc, synced, messages })",
    ]) {
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

  it("each trigger is passed the live value, anchored to its own call (#2433 M2)", () => {
    // The `onSent` call's whole argument.
    const onSent = sliceFrom(app, "onSent: (message) =>", "}),");
    expect(onSent).toMatch(
      /noteChatSent\(message, \{\s*aiOff: licenseStore\.ui\.aiOff,\s*held: aiReadiness\.launcherHeldForLocalModel,?\s*\}\)/,
    );
    // The `noteHeld` effect.
    expect(effectContaining("noteHeld(held)")).toMatch(
      /const held = aiReadiness\.launcherHeldForLocalModel;/,
    );
    // Both `doc` effects, each from its own slice (the lines occur twice).
    for (const marker of [
      "noteCtrlSynced(doc)",
      "observeChatForAnswerer({ doc, synced, messages })",
    ]) {
      const effect = effectContaining(marker);
      expect(effect, marker).toMatch(/const doc = yjsSync\.bootstrapYdoc;/);
      expect(effect, marker).toMatch(/const synced = yjsSync\.ctrlInitialSyncComplete;/);
    }
    expect(effectContaining("observeChatForAnswerer({ doc, synced, messages })")).toMatch(
      /const messages = chatState\.messages;/,
    );
  });

  it("the local period's own derivation, whole", () => {
    expect(app).toMatch(
      /const localPeriodNow = \$derived\(\s*BYO_MODELS_ENABLED &&\s*\(chatAnswerer\.known\s*\?\s*chatAnswerer\.answerer === "local"\s*:\s*aiReadiness\.launcherHeldForLocalModel\),?\s*\);/,
    );
  });

  it("the panel and the pill get the store's values, not constants", () => {
    const mount = chatMount(app);
    expect(mount).toMatch(/localPickup=\{localPickupInputs\}/);
    expect(mount).toMatch(/localPeriod=\{localPeriodNow\}/);
    expect(mount).toMatch(/noticeAnnouncement=\{chatNoticeAnnouncement\}/);
    expect(app).toMatch(/aiLocalChat=\{localChatSetting\}/);
    // Lit, the pickup inputs are the store's, all four, inside their own
    // `$derived`; dark, null.
    const inputs = sliceFrom(app, "const localPickupInputs = $derived(", "\n);");
    expect(inputs).toMatch(
      /^const localPickupInputs = \$derived\(\s*BYO_MODELS_ENABLED\s*\?\s*\{\s*runGeneration: chatAnswerer\.runGeneration,\s*sentLocal: chatAnswerer\.sentLocal,\s*readKnownLocal: chatAnswerer\.known && chatAnswerer\.answerer === "local",\s*aiOff: licenseStore\.ui\.aiOff,?\s*\}\s*:\s*null,?\s*\);$/,
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

describe("the send-time toast waits for the send's own read (#2433 M1)", () => {
  const handler = sliceFrom(app, "const handleAddressedAi", "const onAddressedAi");

  it("the take is in the send's frame: after the fast path, before the probe, only for a chat", () => {
    const fastPath = handler.indexOf('!(via === "comment" && localPeriodNow)');
    expect(fastPath).toBeGreaterThan(-1);
    const fastReturn = handler.indexOf("return;", fastPath);
    const take = handler.search(/const sendRead = viaKey === "chat" \? takeSendRead\(\) : null;/);
    const probe = handler.indexOf("await aiReadiness.probeSession()");
    expect(fastReturn).toBeGreaterThan(fastPath);
    expect(take).toBeGreaterThan(fastReturn);
    expect(probe).toBeGreaterThan(take);
    expect(count(handler, "takeSendRead(")).toBe(1);
  });

  it("the settle is awaited after the probe, only inside the no-agent / no-push condition", () => {
    const probe = handler.indexOf("await aiReadiness.probeSession()");
    expect(handler).toMatch(
      /if \(\s*\(notice\?\.kind === "no-agent" \|\| notice\?\.kind === "no-push"\) &&\s*viaKey === "chat" &&\s*sendRead !== null\s*\) \{\s*const localPeriodAfterRead = await settleSendLocalPeriod\(sendRead\);/,
    );
    expect(handler.indexOf("await settleSendLocalPeriod(sendRead)")).toBeGreaterThan(probe);
    expect(count(handler, "settleSendLocalPeriod(")).toBe(1);
    // The probe and the settle are the only awaits: nothing else waits.
    expect(handler.match(/\bawait\b/g)?.length).toBe(2);
  });

  it("the second notice follows the settle and re-reads every input inside its own argument", () => {
    const settle = handler.indexOf("await settleSendLocalPeriod(sendRead)");
    const first = handler.indexOf("addressedAiNotice({");
    const second = handler.indexOf("addressedAiNotice({", first + 1);
    expect(first).toBeGreaterThan(-1);
    expect(count(handler, "addressedAiNotice({")).toBe(2);
    expect(second).toBeGreaterThan(settle);
    const firstArg = handler.slice(first, handler.indexOf("});", first));
    const secondArg = handler.slice(second, handler.indexOf("});", second));
    // The first call is today's, unmoved (its own `startingForMessage`).
    expect(firstArg).toMatch(/startingForMessage: viaKey === "chat" && chatResumeState\.pending,/);
    expect(firstArg).toMatch(/localPeriod: localPeriodNow,/);
    for (const input of [
      /soloMode: isSoloNow\(\),/,
      /serverUnreachable: aiReadiness\.serverUnreachable,/,
      /probeAnswered: probe\.answered,/,
      /sessionLive: probe\.sessionLive,/,
      /chip: aiReadiness\.chip,/,
      /pushDelivery: aiReadiness\.pushDelivery,/,
      /startingForMessage: viaKey === "chat" && chatResumeState\.pending,/,
      /localPeriod: localPeriodAfterRead,?/,
    ]) {
      expect(secondArg).toMatch(input);
    }
    expect(handler.slice(settle, second + "addressedAiNotice({".length)).toMatch(
      /notice = addressedAiNotice\(\{$/,
    );
  });
});
