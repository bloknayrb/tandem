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

  it("arms the greeting at boot from the version check, before the launcher starts", () => {
    const arm = INDEX.indexOf("await armFirstRunGreeting(resolveAppDataDir(), {");
    expect(arm).toBeGreaterThan(-1);
    expect(INDEX.slice(arm, arm + 200)).toMatch(/firstInstall: versionChange === "first-install"/);
    expect(arm).toBeLessThan(INDEX.indexOf("await startLauncherSupervisor();"));
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
