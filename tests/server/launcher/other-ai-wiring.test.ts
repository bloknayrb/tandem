/**
 * "Not if another AI is on" (#2196) rests on one line in `src/server/index.ts`:
 * the supervisor's `otherAiAttached` seam defaults to `() => false`, because
 * the registry it reads lives in `mcp/server.ts`, which the supervisor must not
 * import. Without the wiring every behavioural test still passes — they inject
 * the seam — while production starts a second Claude beside the user's own.
 * So the wiring is pinned from source.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const INDEX = fs.readFileSync(
  path.join(import.meta.dirname, "../../../src/server/index.ts"),
  "utf8",
);

describe("index.ts wires the launcher's other-AI check", () => {
  it("passes the real registry check into the one createSupervisor call", () => {
    const calls = INDEX.match(/createSupervisor\(\{[\s\S]*?\}\);/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/\botherAiAttached: isOtherMcpClientLive,/);
  });

  it("imports it from mcp/server.js", () => {
    expect(INDEX).toMatch(
      /import \{[^}]*\bisOtherMcpClientLive\b[^}]*\} from "\.\/mcp\/server\.js";/,
    );
  });
});

describe("index.ts wires the one-time greeting (#2197)", () => {
  // Both default to "never" in the supervisor, so without this wiring every
  // behavioural test still passes while production never greets anyone.
  it("passes the real marker and the chat seam into createSupervisor", () => {
    const call = (INDEX.match(/createSupervisor\(\{[\s\S]*?\}\);/g) ?? [])[0] ?? "";
    expect(call).toMatch(/isOwed: \(\) => isGreetingOwed\(appData\)/);
    expect(call).toMatch(/markDone: \(\) => markGreeted\(appData, APP_VERSION\)/);
    expect(call).toMatch(/subscribeTandemReply: onTandemReply,/);
    // Solo, or an unreadable mode, holds the hello (Bryan, 2026-10-14).
    expect(call).toMatch(/greetingHeldBySolo: \(\) => readModeState\(\) !== "tandem",/);
  });

  // #2227: both default to "never tag", so without this wiring every
  // behavioural test still passes while production announces the hello as
  // "Claude replied" again.
  it("passes the greeting-reply classifier seam and the chat snapshot into createSupervisor", () => {
    const call = (INDEX.match(/createSupervisor\(\{[\s\S]*?\}\);/g) ?? [])[0] ?? "";
    expect(call).toMatch(/registerGreetingReplyClassifier: setGreetingReplyClassifier,/);
    expect(call).toMatch(/userChatSnapshot: snapshotUserChat,/);
    expect(INDEX).toMatch(
      /import \{[^}]*\bsetGreetingReplyClassifier\b[^}]*\bsnapshotUserChat\b[^}]*\} from "\.\/mcp\/greeting-reply\.js";/,
    );
  });

  it("arms the greeting at boot from the version check, before the launcher starts", () => {
    const arm = INDEX.indexOf("await armFirstRunGreeting(resolveAppDataDir(), {");
    expect(arm).toBeGreaterThan(-1);
    expect(INDEX.slice(arm, arm + 200)).toMatch(/firstInstall: versionChange === "first-install"/);
    expect(arm).toBeLessThan(INDEX.indexOf("await startLauncherSupervisor();"));
  });
});

describe("index.ts never moves the spawn cwd's confinement root (#1822)", () => {
  // `homeOverride` REPLACES the home the saved workingDirectory is confined to.
  // It is a test seam; a production caller passing it would silently move the
  // boundary, and every behavioural test (which passes it) would stay green.
  it("passes no homeOverride into the one createSupervisor call", () => {
    const call = (INDEX.match(/createSupervisor\(\{[\s\S]*?\}\);/g) ?? [])[0] ?? "";
    expect(call).not.toBe("");
    expect(call).not.toMatch(/homeOverride/);
  });

  it("is the only createSupervisor caller under src/", () => {
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|svelte)$/.test(entry.name)) {
          if (/\bcreateSupervisor\(\{/.test(fs.readFileSync(full, "utf8"))) callers.push(full);
        }
      }
    };
    walk(path.join(import.meta.dirname, "../../../src"));
    expect(
      callers.map((f) => path.relative(path.join(import.meta.dirname, "../../.."), f)),
    ).toEqual([path.join("src", "server", "index.ts")]);
  });
});

describe("mcp/server.ts wires the wizard Apply to startAfterSetup (#2197)", () => {
  const SERVER = fs.readFileSync(
    path.join(import.meta.dirname, "../../../src/server/mcp/server.ts"),
    "utf8",
  );
  it("the apply hook is the supervisor's startAfterSetup, not refreshConfigured", () => {
    expect(SERVER).toMatch(
      /onClaudeCodeApplied: launcher \? \(\) => launcher\.getSupervisor\(\)\?\.startAfterSetup\(\) : undefined,/,
    );
  });
});
