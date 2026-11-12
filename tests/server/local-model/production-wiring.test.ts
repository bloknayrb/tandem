import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ANSWERING_CHANGED_NOTICE_KEY,
  DEFAULT_COLLABORATOR_DEPS,
} from "../../../src/server/local-model/collaborator.js";
import { answeringLocalModel } from "../../../src/server/local-model/config-source.js";
import { chatAnswerer, onChatAnswererChanged } from "../../../src/server/models/chat-answerer.js";
import {
  answeringWasAnnounced,
  baselineAdoptionPending,
  finishFirstLitStart,
  isFirstLitStart,
  recordBaselineAnswering,
  retryUnsavedRecord,
} from "../../../src/server/models/local-model-announced.js";

/**
 * Source pins for the local model's production wiring (#1123, #2404), in the
 * style of `tests/server/boot-order.test.ts`.
 *
 * Every seam here fails CLOSED when it is not wired — editing reads off, the
 * answering-changed notice is never raised — so a dropped line turns a feature
 * off without failing any test that injects its own dependencies. And the one
 * boot call must stay inside the dark gate: `src/server/index.ts` cannot be
 * imported by a test (it binds ports), so its shape is read from source.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "..", "..", "src", "server");

const read = (...parts: string[]) => fs.readFile(path.join(SRC, ...parts), "utf-8");

/**
 * The text between the `{` that ends `opener` and its matching `}`, found by
 * counting braces. Good enough for these blocks, which hold no brace inside a
 * string that is not balanced (a template literal's `${…}` balances itself).
 */
function blockAfter(src: string, opener: string): string {
  const at = src.indexOf(opener);
  if (at === -1) throw new Error(`not found in source: ${opener}`);
  // The opener must be unambiguous, or the pin could be reading another block.
  if (src.indexOf(opener, at + 1) !== -1) throw new Error(`found more than once: ${opener}`);
  const open = at + opener.length - 1;
  if (src[open] !== "{") throw new Error(`opener must end with "{": ${opener}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces after: ${opener}`);
}

/** Line and block comments removed, so prose naming a call is not the call. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("blockAfter (the parser these pins stand on)", () => {
  it("returns the matched block, not text after it", () => {
    const src = "a(); if (FLAG) { b(); if (x) { c(); } d(); } e();";
    expect(blockAfter(src, "if (FLAG) {")).toBe(" b(); if (x) { c(); } d(); ");
  });

  it("refuses a missing or repeated opener", () => {
    expect(() => blockAfter("x", "if (FLAG) {")).toThrow(/not found/);
    expect(() => blockAfter("if (FLAG) {} if (FLAG) {}", "if (FLAG) {")).toThrow(/more than once/);
  });
});

describe("local-model production wiring (#1123, #2404)", () => {
  it("index.ts primes the editing setting INSIDE the BYO_MODELS_ENABLED block, beside the registry prime", async () => {
    const src = stripComments(await read("index.ts"));
    const gated = blockAfter(src, "if (BYO_MODELS_ENABLED) {");

    // Both primes are called inside the gate…
    expect(gated).toMatch(/await\s+primeModelStoreCache\(\)/);
    expect(count(gated, "primeLocalModelSettings()")).toBe(1);
    // …and the module is imported there too, lazily: a static import at the
    // top of index.ts is harmless today (the module touches no disk at import)
    // but the call must have nowhere else to come from.
    expect(gated).toMatch(
      /const\s*\{\s*primeLocalModelSettings\s*\}\s*=\s*await\s+import\(\s*"\.\/models\/local-model-settings\.js"\s*\)/,
    );

    // Why each mutation of index.ts fails here:
    //  - the call DELETED: it is no longer in `gated` → the count above is 0;
    //  - the call HOISTED out of the block (above or below it): the same count
    //    is 0, and were a copy left behind, the whole-file count below is 2;
    //  - the gate itself removed or renamed: `blockAfter` throws "not found".
    // A dark build must never open local-model-settings.json, so "called
    // somewhere in the file" is not the property — "called only in here" is.
    expect(count(src, "primeLocalModelSettings()")).toBe(1);
    expect(count(src, "primeLocalModelSettings")).toBe(2); // the import binding + the call

    // Primed before the collaborator is wired, so its first run reads the
    // saved setting rather than the module's initial "off".
    const gateAt = src.indexOf("if (BYO_MODELS_ENABLED) {");
    const startAt = src.indexOf("startLocalModelCollaborator()");
    expect(startAt).toBeGreaterThan(gateAt + gated.length);
  });

  // #1123 R1.4: the dark guard for who answers chat. `chatAnswerer()` reads
  // Claude until `primeChatAnswerer()` has run, and that call is the only disk
  // read of `chat-answerer.json` — so it must sit inside the flag's block, and
  // after the editing prime (which makes the first-lit-start decision before
  // anything could write the record). Its own `try`, so a failed registry
  // prime cannot leave the switch unprimed.
  it("index.ts primes who answers chat INSIDE the BYO_MODELS_ENABLED block, after the editing prime", async () => {
    const src = stripComments(await read("index.ts"));
    const gated = blockAfter(src, "if (BYO_MODELS_ENABLED) {");
    expect(count(gated, "primeChatAnswerer()")).toBe(1);
    expect(gated).toMatch(
      /const\s*\{\s*primeChatAnswerer\s*\}\s*=\s*await\s+import\(\s*"\.\/models\/chat-answerer\.js"\s*\)/,
    );
    expect(count(src, "primeChatAnswerer()")).toBe(1);
    expect(count(src, "primeChatAnswerer")).toBe(2);
    expect(gated.indexOf("primeChatAnswerer()")).toBeGreaterThan(
      gated.indexOf("primeLocalModelSettings()"),
    );
    // Not in the registry prime's `try`: a `catch` lies between the two.
    const between = gated.slice(
      gated.indexOf("primeModelStoreCache()"),
      gated.indexOf("primeChatAnswerer()"),
    );
    expect(between).toMatch(/\}\s*catch\s*\(/);
  });

  // Repo-wide: the prime is the switch's only disk read, so a call anywhere
  // else in src/ — even one that looks harmless — would read the file in a
  // dark build. The definition is the one other mention.
  it("primeChatAnswerer is called nowhere in src/ but index.ts's flag block", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const root = path.join(SRC, "..");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(path.join(dir, e.name))
          : /\.(ts|svelte)$/.test(e.name)
            ? [path.join(dir, e.name)]
            : [],
      );
    const callers = walk(root)
      .filter((f) => /\bprimeChatAnswerer\s*\(/.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => path.relative(root, f).replace(/\\/g, "/"))
      .sort();
    expect(callers).toEqual(["server/index.ts", "server/models/chat-answerer.ts"]);
    const own = stripComments(await read("models", "chat-answerer.ts"));
    expect(count(own, "primeChatAnswerer(")).toBe(1); // the definition only
  });

  // Critical Rule 2: the run state is written on the user's row with the
  // `mcp` origin, so the ctrl-chat observer skips it and it can wake nothing.
  it("writeLocalRun writes through withMcp, and only through it", async () => {
    const src = stripComments(await read("local-model", "collaborator.ts"));
    const body = blockAfter(src, '"generation">,\n): void {');
    expect(body).toMatch(/withMcp\(ctrlDoc,\s*\(\)\s*=>\s*chatMap\.set\(/);
    expect(count(body, "chatMap.set(")).toBe(1);
    expect(body).not.toMatch(/\.transact\(/);
  });

  it("index.ts hands localModelResolvesNow to startMcpServerHttp, and server.ts to the models routes", async () => {
    const index = stripComments(await read("index.ts"));
    expect(index).toMatch(/\{\s*localModelResolvesNow\s*\}\s*,?\s*\)/);
    expect(index).toMatch(
      /import\s*\{[^}]*\blocalModelResolvesNow\b[^}]*\}\s*from\s*"\.\/local-model\/collaborator\.js"/,
    );
    const server = stripComments(await read("mcp", "server.ts"));
    expect(server).toMatch(/localModelResolvesNow:\s*modelsWiring\?\.localModelResolvesNow/);
  });

  it("DEFAULT_COLLABORATOR_DEPS wires who answers chat and its change listener, by identity", () => {
    expect(DEFAULT_COLLABORATOR_DEPS.chatAnswerer).toBe(chatAnswerer);
    expect(DEFAULT_COLLABORATOR_DEPS.onChatAnswererChanged).toBe(onChatAnswererChanged);
  });

  it("startLocalModelCollaborator builds the collaborator with NO arguments", async () => {
    const src = stripComments(await read("local-model", "collaborator.ts"));
    const body = blockAfter(src, "export function startLocalModelCollaborator(): void {");

    // No arguments means the parameter default below is what production gets.
    // An argument here — even a spread of the defaults with one seam swapped —
    // is where a seam could be dropped without any test noticing.
    expect(body).toMatch(/singleton\s*=\s*createLocalModelCollaborator\(\s*\)\s*;/);
    expect(count(body, "createLocalModelCollaborator(")).toBe(1);
    expect(body).toMatch(/singleton\.start\(\)/);
    // The only construction in the module outside the factory's own definition.
    expect(count(src, "createLocalModelCollaborator(")).toBe(2);
  });

  it("createLocalModelCollaborator's parameter defaults to DEFAULT_COLLABORATOR_DEPS", async () => {
    const src = stripComments(await read("local-model", "collaborator.ts"));
    expect(src).toMatch(
      /export function createLocalModelCollaborator\(\s*deps:\s*CollaboratorDeps\s*=\s*DEFAULT_COLLABORATOR_DEPS,?\s*\)\s*\{/,
    );
  });

  it("DEFAULT_COLLABORATOR_DEPS wires `answering` to answeringLocalModel, by identity", () => {
    expect(DEFAULT_COLLABORATOR_DEPS.answering).toBe(answeringLocalModel);
  });

  // Round 3. Absent, the collaborator falls back to "the model found at
  // start-up is the baseline" — the silent restart this record exists to close.
  it("DEFAULT_COLLABORATOR_DEPS wires `announced` to the announced-record, `wasAnnounced` by identity", () => {
    expect(DEFAULT_COLLABORATOR_DEPS.announced).toBeDefined();
    expect(DEFAULT_COLLABORATOR_DEPS.announced?.wasAnnounced).toBe(answeringWasAnnounced);
    expect(typeof DEFAULT_COLLABORATOR_DEPS.announced?.announce).toBe("function");
  });

  it("the default `announce` records the fingerprint as the ANSWERING model, through announceLocalModelChange", async () => {
    const src = stripComments(await read("local-model", "collaborator.ts"));
    const body = blockAfter(src, "export const DEFAULT_COLLABORATOR_DEPS: CollaboratorDeps = {");
    expect(body).toMatch(/wasAnnounced:\s*answeringWasAnnounced\s*,/);
    expect(body).toMatch(
      /announceLocalModelChange\(\s*dedupKey\s*,\s*message\s*,\s*\{\s*answering:\s*fingerprint\s*\}\s*\)/,
    );
  });

  // Without the key, `recordAnsweringNone` clears the record but leaves the
  // pending replay: a window connecting later is sent a notice naming a model
  // that no longer answers, and that delivery records it as told. (The
  // behaviour is exercised in answering-announced-restart.test.ts.)
  it("the default `none` passes the answering notice's own replay key", async () => {
    const src = stripComments(await read("local-model", "collaborator.ts"));
    const body = blockAfter(src, "export const DEFAULT_COLLABORATOR_DEPS: CollaboratorDeps = {");
    expect(body).toMatch(
      /none:\s*\(\)\s*=>\s*recordAnsweringNone\(\s*ANSWERING_CHANGED_NOTICE_KEY\s*\)\s*,/,
    );
    expect(ANSWERING_CHANGED_NOTICE_KEY).toBe("local-model-answering-changed");
  });

  // #2404's fix: the members that make a change from Tandem's own window the
  // user's own (recorded, never announced), and the start-up check with its
  // first-lit-start baseline. Every one of them is OPTIONAL in
  // `CollaboratorDeps` and falls back to doing nothing (or to the old live
  // notice), so a dropped or no-op'd line here would change behaviour without
  // failing a single behavioural test that injects its own doubles.
  it("the default `announced` wires the own-window, baseline and start-up members to the record", async () => {
    const a = DEFAULT_COLLABORATOR_DEPS.announced;
    expect(a?.retry).toBe(retryUnsavedRecord);
    expect(a?.firstLitStart).toBe(isFirstLitStart);
    expect(a?.baseline).toBe(recordBaselineAnswering);
    expect(a?.finishStart).toBe(finishFirstLitStart);
    expect(typeof a?.setByUser).toBe("function");
    expect(typeof a?.startupMismatch).toBe("function");

    const src = stripComments(await read("local-model", "collaborator.ts"));
    const body = blockAfter(src, "export const DEFAULT_COLLABORATOR_DEPS: CollaboratorDeps = {");
    // The user's own change records the fingerprint as the ANSWERING model and
    // withdraws the pending live notice under the answering notice's own key.
    expect(body).toMatch(
      /setByUser:\s*\(fingerprint\)\s*=>\s*\{\s*recordSetByUser\(\s*\{\s*answering:\s*fingerprint\s*\}\s*,\s*ANSWERING_CHANGED_NOTICE_KEY\s*\)\s*;?\s*\}\s*,/,
    );
    expect(body).toMatch(
      /startupMismatch:\s*\(fingerprint\)\s*=>\s*\{\s*announceStartupMismatch\(\s*\{\s*answering:\s*fingerprint\s*\}\s*\)\s*;?\s*\}\s*,/,
    );
    expect(body).toMatch(/retry:\s*retryUnsavedRecord\s*,/);
    expect(body).toMatch(/firstLitStart:\s*isFirstLitStart\s*,/);
    expect(body).toMatch(/baseline:\s*recordBaselineAnswering\s*,/);
    expect(body).toMatch(/finishStart:\s*finishFirstLitStart\s*,/);
  });

  // Review of PR #2413, item 2: the first lit start says which model it
  // adopted, and says it again at a later start until one of Tandem's own
  // windows was sent it. Both members are optional and fall back to silence.
  it("the default `announced` wires the adopted-baseline notice to the record", async () => {
    const a = DEFAULT_COLLABORATOR_DEPS.announced;
    expect(a?.adoptionPending).toBe(baselineAdoptionPending);
    expect(typeof a?.adopted).toBe("function");

    const src = stripComments(await read("local-model", "collaborator.ts"));
    const body = blockAfter(src, "export const DEFAULT_COLLABORATOR_DEPS: CollaboratorDeps = {");
    expect(body).toMatch(/adoptionPending:\s*baselineAdoptionPending\s*,/);
    expect(body).toMatch(
      /adopted:\s*\(message\)\s*=>\s*\{\s*announceBaselineAdopted\(\s*message\s*\)\s*;?\s*\}\s*,/,
    );
    // And wire() really reaches them: at a first lit start right after the
    // baseline is recorded, and at a later start while the adoption is pending.
    const wire = blockAfter(src, "function wire(): void {");
    expect(wire).toMatch(
      /deps\.announced\.baseline\?\.\(fingerprint\);\s*deps\.announced\.adopted\?\.\(baselineAdoptedNotice\(lastAnswering\)\)/,
    );
    expect(wire).toMatch(/adoptionPending\?\.\(answeringFingerprint\(lastAnswering\)\)/);
  });

  // Both #2404 notices describe what was SAVED, so they fire in Solo and while
  // the licence refuses AI. Neither module that raises the editing-on notice
  // may consult the mode or the licence; the answering notice's path is pinned
  // behaviourally in collaborator.test.ts ("fires in Solo mode", "fires under
  // a licence refusal").
  it.each([
    ["models", "local-model-settings.ts"],
    ["models", "local-model-announced.ts"],
  ])("%s/%s imports neither the mode nor the licence", async (...parts) => {
    const src = stripComments(await read(...parts));
    expect(src).not.toMatch(/from\s+"[^"]*(license\/|\/mode\.js|ai-refusal)/);
    expect(src).not.toMatch(/readLiveMode|aiRefusal/);
  });
});
