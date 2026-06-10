import { describe, expect, it } from "vitest";
import { nodeVersionError } from "../../src/cli/node-version";

describe("nodeVersionError", () => {
  it.each([
    {
      version: "v18.19.0",
      expectError: true,
      why: "old LTS — engines field only warns at install",
    },
    { version: "v20.11.1", expectError: true, why: "previous LTS, still widely installed" },
    { version: "v21.7.3", expectError: true, why: "odd-numbered release below the floor" },
    { version: "v22.0.0", expectError: false, why: "exact floor passes" },
    { version: "v24.13.1", expectError: false, why: "current LTS passes" },
    { version: "22.1.0", expectError: false, why: "missing v prefix still parses" },
    {
      version: "garbage",
      expectError: false,
      why: "unparseable fails open — clarify, never brick",
    },
    { version: "", expectError: false, why: "empty string fails open" },
  ])("$version → error=$expectError ($why)", ({ version, expectError }) => {
    const err = nodeVersionError(version);
    if (expectError) {
      expect(err).toContain(version);
      expect(err).toContain("nodejs.org");
    } else {
      expect(err).toBeNull();
    }
  });
});
