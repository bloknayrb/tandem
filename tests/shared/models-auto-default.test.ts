import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { autoDefaultFor } from "../../src/shared/models/auto-default.js";
import type { ModelsEntry } from "../../src/shared/models/contract.js";

/**
 * The automatic-default rule (#1123): one definition, shared by the client's
 * Models store and the server's honour check.
 */
type E = Pick<ModelsEntry, "id" | "provider" | "enabled">;
const local = (id: string, enabled = true): E => ({ id, provider: "local-ollama", enabled });
const cloud = (
  id: string,
  enabled = true,
  provider: "anthropic" | "openai" | "gemini" = "anthropic",
): E => ({ id, provider, enabled });
const CLOUD_KINDS = ["anthropic", "openai", "gemini"] as const;

describe("autoDefaultFor", () => {
  describe("a default naming an entry is left alone", () => {
    it.each([
      ["a local entry", [local("a"), local("b")], "a"],
      ["a cloud entry", [cloud("c"), local("a")], "c"],
      ["a switched-off entry", [local("a", false), local("b")], "a"],
    ])("%s → null", (_name, entries, def) => {
      expect(autoDefaultFor(entries, def)).toBeNull();
    });
  });

  it("a dangling default with one enabled local gives that id", () => {
    expect(autoDefaultFor([local("a")], "ghost")).toBe("a");
  });

  it("no default with none, one, or two enabled locals gives null, the id, null", () => {
    expect(autoDefaultFor([], null)).toBeNull();
    expect(autoDefaultFor([local("a")], null)).toBe("a");
    expect(autoDefaultFor([local("a"), local("b")], null)).toBeNull();
  });

  it("an enabled cloud entry beside one enabled local gives the local id", () => {
    expect(autoDefaultFor([cloud("c"), local("a")], null)).toBe("a");
  });

  it("no default with enabled entries of all three cloud kinds gives null", () => {
    const clouds = CLOUD_KINDS.map((p) => cloud(`c-${p}`, true, p));
    expect(autoDefaultFor(clouds, null)).toBeNull();
  });

  it("all three cloud kinds enabled beside one enabled local gives the local id", () => {
    const clouds = CLOUD_KINDS.map((p) => cloud(`c-${p}`, true, p));
    expect(autoDefaultFor([...clouds, local("a")], null)).toBe("a");
    expect(autoDefaultFor([local("a"), ...clouds], null)).toBe("a");
  });

  it("a switched-off local alone gives null", () => {
    expect(autoDefaultFor([local("a", false)], null)).toBeNull();
  });

  it("every local provider counts, and a switched-off local beside an enabled one is not counted", () => {
    for (const provider of [
      "local-ollama",
      "local-llamacpp",
      "local-lmstudio",
      "local-other",
    ] as const) {
      expect(autoDefaultFor([{ id: "x", provider, enabled: true }], null)).toBe("x");
    }
    expect(autoDefaultFor([local("a", false), local("b")], null)).toBe("b");
  });
});

describe("the rule's module imports only the wire contract", () => {
  const src = fs
    .readFileSync(path.join(__dirname, "../../src/shared/models/auto-default.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("its only import or re-export is ./contract.js", () => {
    const specs = [...src.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(specs).toEqual(["./contract.js"]);
  });

  it("it has no dynamic import or require", () => {
    expect(src).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
  });
});
