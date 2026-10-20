import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #2168: Tandem drives `tauri-plugin-notification` from its own app commands
 * (`src-tauri/src/notifications.rs`) and grants the plugin's JS API exactly one
 * command: `is_permission_granted`, which the plugin's injected init script
 * calls on every page load (ungranted, it is an unhandled rejection per load).
 *
 * Nothing else would notice a broader grant. Swapping in `notification:default`
 * compiles, passes every Rust and client test, and hands any script in the
 * WebView `notify`, `register_listener` and `remove_active`. So the grant set
 * is pinned here, across every capability file.
 */

const CAPABILITIES = join(import.meta.dirname, "..", "..", "src-tauri", "capabilities");

function notificationGrants(): string[] {
  return readdirSync(CAPABILITIES)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      const cap = JSON.parse(readFileSync(join(CAPABILITIES, name), "utf8")) as {
        permissions?: unknown[];
      };
      return (cap.permissions ?? [])
        .map((p) => (typeof p === "string" ? p : ((p as { identifier?: string }).identifier ?? "")))
        .filter((id) => id.startsWith("notification:"))
        .map((id) => `${name}: ${id}`);
    });
}

describe("notification plugin capability grant", () => {
  it("grants only is_permission_granted, and only to the desktop capability", () => {
    expect(notificationGrants()).toEqual([
      "desktop.json: notification:allow-is-permission-granted",
    ]);
  });
});
