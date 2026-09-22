import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { __test } from "../../src/client/sentry";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Client-side scrubbing for #921. `sentry.ts` only `import type`s
 * `@sentry/browser` at module top (the real SDK is dynamically imported inside
 * `initCrashReporting`), so this test loads without the optional dep installed.
 */
describe("client sentry scrub", () => {
  const { scrub, redactSecrets, redactPaths } = __test;

  it("redacts macOS user paths", () => {
    expect(redactPaths("/Users/alice/Documents/x.md")).toBe("/Users/[user]/Documents/x.md");
  });

  it("redacts Linux home paths", () => {
    expect(redactPaths("/home/bob/notes")).toBe("/home/[user]/notes");
  });

  it("redacts Windows user paths", () => {
    expect(redactPaths(String.raw`C:\Users\carol\AppData`)).toBe(
      String.raw`C:\Users\[user]\AppData`,
    );
  });

  it("redacts Anthropic API keys", () => {
    expect(redactSecrets("key sk-ant-api03-ABCdef123_xyz here")).toBe("key sk-ant-[redacted] here");
  });

  it("redacts bearer tokens", () => {
    expect(redactSecrets("Bearer abcdefghijkl0123456789")).toBe("Bearer [redacted]");
  });

  it("combined scrub handles path + secret in one string", () => {
    expect(scrub("/Users/dan/.env had sk-ant-api03-SECRETSECRET12")).toBe(
      "/Users/[user]/.env had sk-ant-[redacted]",
    );
  });

  it("leaves benign strings untouched", () => {
    expect(scrub("TypeError: cannot read property foo of undefined")).toBe(
      "TypeError: cannot read property foo of undefined",
    );
  });
});

/**
 * The `beforeSend` hook itself (#2023). Until this round the WebView shipped
 * `event.server_name` — the machine hostname, which nothing sets, so the SDK's
 * own default egressed — and every stack frame's absolute path, which in a
 * source-run or dev build sits under the user's home directory. The sidecar
 * hook has deleted both since #1823; this is the mirror.
 */
describe("client sentry beforeSend hook", () => {
  const { scrubEvent } = __test;
  type Event = Parameters<typeof scrubEvent>[0];

  it("deletes server_name", () => {
    const event = scrubEvent({ server_name: "bryans-laptop.local" } as Event);
    expect(event.server_name).toBeUndefined();
  });

  it("redacts both filename and abs_path on exception frames", () => {
    // Both fields, because Sentry's issue view shows `abs_path`: a fix that
    // scrubs only `filename` leaks the same string one field over.
    const event = scrubEvent({
      exception: {
        values: [
          {
            value: "boom",
            stacktrace: {
              frames: [
                { filename: "/Users/alice/app/src/x.ts", abs_path: "/Users/alice/app/src/x.ts" },
              ],
            },
          },
        ],
      },
    } as Event);

    const frame = event.exception?.values?.[0]?.stacktrace?.frames?.[0];
    expect(frame?.filename).toBe("/Users/[user]/app/src/x.ts");
    expect(frame?.abs_path).toBe("/Users/[user]/app/src/x.ts");
  });

  it("still scrubs the message, exception value and request, and drops request data", () => {
    // The pre-existing behaviour, so a rewrite that swaps the new loop in over
    // the old body fails here rather than shipping quietly.
    const event = scrubEvent({
      message: "opened /Users/alice/notes.md",
      exception: { values: [{ value: "ENOENT /home/bob/x" }] },
      request: { url: "http://localhost/api?token=sk-ant-api03-SECRETSECRET12", data: "body" },
    } as Event);

    expect(event.message).toBe("opened /Users/[user]/notes.md");
    expect(event.exception?.values?.[0]?.value).toBe("ENOENT /home/[user]/x");
    expect(event.request?.url).toBe("http://localhost/api?token=[redacted]");
    expect(event.request?.data).toBeUndefined();
  });

  it("tolerates an event with no exception, request or frames", () => {
    // Sentry DROPS an event whose hook throws, which would turn a privacy fix
    // into silent telemetry loss.
    expect(() => scrubEvent({} as Event)).not.toThrow();
    expect(() => scrubEvent({ exception: { values: [{ value: "boom" }] } } as Event)).not.toThrow();
  });

  it("is the hook Sentry.init actually receives", async () => {
    // Without this, every spec above passes against a fix that adds `scrubEvent`
    // and leaves the old inline arrow wired — the leak ships green.
    //
    // Scoped to the `Sentry.init({...})` CALL, not the whole file: `scrubEvent`'s
    // own docblock contains the literal string, so a file-wide regex stays green
    // with the hook unwired. Measured on the sidecar twin
    // (`tests/server/sentry-scrub.test.ts`), which this mirrors.
    const src = await fs.readFile(path.join(__dirname, "../../src/client/sentry.ts"), "utf-8");
    const start = src.indexOf("Sentry.init({");
    expect(start, "Sentry.init call must exist").toBeGreaterThan(-1);
    const initCall = src.slice(start, src.indexOf("\n    });", start));
    expect(initCall).toMatch(/beforeSend:\s*scrubEvent/);
  });
});
