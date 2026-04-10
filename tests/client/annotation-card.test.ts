import { describe, expect, it } from "vitest";
import { parseSuggestion } from "../../src/client/panels/AnnotationCard.js";

describe("parseSuggestion", () => {
  it("parses valid suggestion with newText and reason", () => {
    const content = JSON.stringify({ newText: "fixed text", reason: "typo correction" });
    const result = parseSuggestion(content);
    expect(result).toEqual({ newText: "fixed text", reason: "typo correction" });
  });

  it("parses valid suggestion with newText only (no reason)", () => {
    const content = JSON.stringify({ newText: "replacement" });
    const result = parseSuggestion(content);
    expect(result).toEqual({ newText: "replacement", reason: "" });
  });

  it("returns null for non-JSON content", () => {
    expect(parseSuggestion("just plain text")).toBeNull();
  });

  it("returns null for JSON without newText field", () => {
    const content = JSON.stringify({ reason: "some reason" });
    expect(parseSuggestion(content)).toBeNull();
  });

  it("returns null for JSON with non-string newText", () => {
    const content = JSON.stringify({ newText: 42 });
    expect(parseSuggestion(content)).toBeNull();
  });

  it("handles empty string newText", () => {
    const content = JSON.stringify({ newText: "", reason: "delete this text" });
    const result = parseSuggestion(content);
    expect(result).toEqual({ newText: "", reason: "delete this text" });
  });

  it("defaults reason to empty string when reason is falsy", () => {
    const content = JSON.stringify({ newText: "abc", reason: "" });
    const result = parseSuggestion(content);
    expect(result).toEqual({ newText: "abc", reason: "" });
  });
});
