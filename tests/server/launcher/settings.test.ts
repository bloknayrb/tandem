/**
 * `launcher-settings.json` (#2195): the read fails toward NOT starting Claude,
 * a newer file is read leniently and never overwritten, and writes merge a
 * partial patch.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
  launcherSettingsPath,
  readLauncherSettings,
  SettingsNewerError,
  updateLauncherSettings,
} from "../../../src/server/launcher/settings.js";
import {
  DEFAULT_LAUNCHER_SETTINGS,
  parseLauncherSettings,
  parseLauncherSettingsPatch,
} from "../../../src/shared/launcher/contract.js";

let base: string;
let errSpy: MockInstance<typeof console.error>;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "launcher-settings-")));
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
  vi.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

function write(raw: string): void {
  fs.writeFileSync(launcherSettingsPath(base), raw);
}

const ON_CLICK_FALLBACK = { ...DEFAULT_LAUNCHER_SETTINGS, startMode: "on-click" };

describe("readLauncherSettings", () => {
  it("no file: the shipped defaults (auto, always, 30) — today's behaviour, silently", async () => {
    expect(await readLauncherSettings(base)).toEqual({
      source: "default",
      settings: { startMode: "auto", lifetime: "always", idleMinutes: 30 },
    });
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("reads a valid file", async () => {
    write(JSON.stringify({ version: 1, startMode: "off", lifetime: "idle", idleMinutes: 45 }));
    expect(await readLauncherSettings(base)).toEqual({
      source: "file",
      newer: false,
      settings: { startMode: "off", lifetime: "idle", idleMinutes: 45 },
    });
  });

  it.each([
    ["truncated JSON", '{ "version": 1, "startMode": "of'],
    ["an array", "[]"],
    ["no version", JSON.stringify({ startMode: "auto", lifetime: "always", idleMinutes: 30 })],
    ["an unknown start mode", JSON.stringify({ version: 1, startMode: "sometimes" })],
  ])("%s falls back to on-click, never auto, and says so", async (_label, raw) => {
    write(raw);
    expect(await readLauncherSettings(base)).toEqual({
      source: "fallback",
      settings: ON_CLICK_FALLBACK,
    });
    expect(errSpy).toHaveBeenCalled();
  });

  it("a held file (EPERM, as antivirus produces on Windows) falls back to on-click", async () => {
    write(JSON.stringify({ version: 1, startMode: "auto", lifetime: "always", idleMinutes: 30 }));
    const eperm = Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    vi.spyOn(fs.promises, "readFile").mockRejectedValueOnce(eperm);
    expect(await readLauncherSettings(base)).toEqual({
      source: "fallback",
      settings: ON_CLICK_FALLBACK,
    });
  });

  it("something that is not a regular file is refused before it is read", async () => {
    fs.mkdirSync(launcherSettingsPath(base));
    expect((await readLauncherSettings(base)).source).toBe("fallback");
  });

  it("an oversized file is refused before it is read", async () => {
    write(`{"version":1,"startMode":"auto","pad":"${"x".repeat(5000)}"}`);
    expect((await readLauncherSettings(base)).source).toBe("fallback");
  });

  it("a newer file keeps the known fields it can validate, so a downgrade keeps the user's Off", async () => {
    write(
      JSON.stringify({
        version: 2,
        startMode: "off",
        lifetime: "forever-and-a-day",
        idleMinutes: 45,
        somethingNew: true,
      }),
    );
    expect(await readLauncherSettings(base)).toEqual({
      source: "file",
      newer: true,
      settings: { startMode: "off", lifetime: "always", idleMinutes: 45 },
    });
  });

  it("a newer file with a start mode this build doesn't know reads as on-click, still newer", async () => {
    write(JSON.stringify({ version: 2, startMode: "scheduled", lifetime: "idle" }));
    expect(await readLauncherSettings(base)).toEqual({
      source: "file",
      newer: true,
      settings: { startMode: "on-click", lifetime: "idle", idleMinutes: 30 },
    });
  });

  it("an out-of-range idle limit is defaulted, not trusted", async () => {
    write(JSON.stringify({ version: 1, startMode: "auto", lifetime: "idle", idleMinutes: 99999 }));
    expect((await readLauncherSettings(base)).settings.idleMinutes).toBe(30);
  });
});

describe("updateLauncherSettings", () => {
  it("merges a patch into the defaults when there is no file, and writes version 1", async () => {
    expect(await updateLauncherSettings(base, { startMode: "off" })).toEqual({
      startMode: "off",
      lifetime: "always",
      idleMinutes: 30,
    });
    expect(JSON.parse(fs.readFileSync(launcherSettingsPath(base), "utf8"))).toEqual({
      version: 1,
      startMode: "off",
      lifetime: "always",
      idleMinutes: 30,
    });
  });

  it("keeps the fields the patch does not name", async () => {
    write(JSON.stringify({ version: 1, startMode: "off", lifetime: "idle", idleMinutes: 10 }));
    expect(await updateLauncherSettings(base, { idleMinutes: 20 })).toEqual({
      startMode: "off",
      lifetime: "idle",
      idleMinutes: 20,
    });
  });

  it("serializes concurrent writers so neither update is lost", async () => {
    await Promise.all([
      updateLauncherSettings(base, { startMode: "off" }),
      updateLauncherSettings(base, { lifetime: "idle" }),
      updateLauncherSettings(base, { idleMinutes: 5 }),
    ]);
    expect((await readLauncherSettings(base)).settings).toEqual({
      startMode: "off",
      lifetime: "idle",
      idleMinutes: 5,
    });
  });

  it("an unreadable file merges onto the caller's last good settings, not the fallback", async () => {
    write("{ truncated");
    expect(
      await updateLauncherSettings(
        base,
        { idleMinutes: 5 },
        { startMode: "off", lifetime: "idle", idleMinutes: 10 },
      ),
    ).toEqual({ startMode: "off", lifetime: "idle", idleMinutes: 5 });
  });

  it("with nothing better to merge onto, an unreadable file merges onto the on-click fallback", async () => {
    write("{ truncated");
    expect((await updateLauncherSettings(base, { idleMinutes: 5 })).startMode).toBe("on-click");
  });

  it("refuses to overwrite a file a newer Tandem wrote", async () => {
    const raw = JSON.stringify({ version: 2, startMode: "off", somethingNew: true });
    write(raw);
    await expect(updateLauncherSettings(base, { startMode: "auto" })).rejects.toBeInstanceOf(
      SettingsNewerError,
    );
    expect(fs.readFileSync(launcherSettingsPath(base), "utf8")).toBe(raw);
  });

  it("refuses to overwrite a newer file whose start mode this build doesn't know", async () => {
    const raw = JSON.stringify({ version: 2, startMode: "scheduled", lifetime: "idle" });
    write(raw);
    await expect(updateLauncherSettings(base, { idleMinutes: 5 })).rejects.toBeInstanceOf(
      SettingsNewerError,
    );
    expect(fs.readFileSync(launcherSettingsPath(base), "utf8")).toBe(raw);
  });

  it("a file deleted mid-run merges onto the caller's last good settings, not the defaults", async () => {
    // No file: the defaults would save `auto` over an Off this process holds.
    expect(
      await updateLauncherSettings(
        base,
        { idleMinutes: 5 },
        { startMode: "off", lifetime: "idle", idleMinutes: 10 },
      ),
    ).toEqual({ startMode: "off", lifetime: "idle", idleMinutes: 5 });
  });

  it.skipIf(process.platform === "win32")("writes the file owner-only (0600)", async () => {
    await updateLauncherSettings(base, { startMode: "off" });
    expect(fs.statSync(launcherSettingsPath(base)).mode & 0o777).toBe(0o600);
  });
});

describe("parseLauncherSettingsPatch", () => {
  it("accepts any non-empty subset of valid fields", () => {
    expect(parseLauncherSettingsPatch({ startMode: "on-click" })).toEqual({
      ok: true,
      patch: { startMode: "on-click" },
    });
    expect(parseLauncherSettingsPatch({ lifetime: "idle", idleMinutes: 1440 })).toEqual({
      ok: true,
      patch: { lifetime: "idle", idleMinutes: 1440 },
    });
  });

  it.each([
    [undefined, "patch"],
    [{}, "patch"],
    [[], "patch"],
    [{ startMode: "sometimes" }, "startMode"],
    [{ idleMinutes: 0 }, "idleMinutes"],
    [{ idleMinutes: 1441 }, "idleMinutes"],
    [{ idleMinutes: 2.5 }, "idleMinutes"],
    [{ idleMinutes: "30" }, "idleMinutes"],
    [{ lifetime: "always", extra: 1 }, "extra"],
  ])("rejects %j at %s", (raw, field) => {
    expect(parseLauncherSettingsPatch(raw)).toEqual({ ok: false, field });
  });
});

describe("parseLauncherSettings", () => {
  it("accepts only a complete, valid settings object", () => {
    expect(parseLauncherSettings({ startMode: "off", lifetime: "idle", idleMinutes: 5 })).toEqual({
      startMode: "off",
      lifetime: "idle",
      idleMinutes: 5,
    });
    expect(parseLauncherSettings({ startMode: "off", lifetime: "idle" })).toBeNull();
    expect(parseLauncherSettings({ integrations: [] })).toBeNull();
    expect(parseLauncherSettings(null)).toBeNull();
  });
});
