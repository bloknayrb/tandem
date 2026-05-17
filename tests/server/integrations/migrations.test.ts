import { describe, expect, it } from "vitest";

import { migrateUp } from "../../../src/server/integrations/migrations.js";

describe("migrateUp", () => {
  it("is a no-op when from === to", () => {
    const input = { schemaVersion: 1, integrations: [] };
    expect(migrateUp(input, 1, 1)).toBe(input);
  });

  it("throws on a missing migration", () => {
    expect(() => migrateUp({}, 1, 2)).toThrow(/No migration registered from v1 to v2/);
  });

  it("throws when toVersion < fromVersion", () => {
    expect(() => migrateUp({}, 2, 1)).toThrow(/Cannot migrate down/);
  });

  it("throws on a missing migration mid-chain", () => {
    expect(() => migrateUp({}, 1, 5)).toThrow(/v1 to v2/);
  });
});
