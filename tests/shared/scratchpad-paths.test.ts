import { describe, expect, it } from "vitest";
import {
  isScratchpadPath,
  isUploadPath,
  SCRATCHPAD_PREFIX,
  scratchpadUuidFromPath,
} from "../../src/shared/paths";

describe("isScratchpadPath", () => {
  it("matches scratchpad synthetic paths", () => {
    expect(isScratchpadPath(`${SCRATCHPAD_PREFIX}abc-123/Scratchpad.md`)).toBe(true);
  });

  it("does not match non-scratchpad upload paths", () => {
    expect(isScratchpadPath("upload://file-xyz/doc.md")).toBe(false);
  });

  it("does not match real filesystem paths", () => {
    expect(isScratchpadPath("/home/user/notes.md")).toBe(false);
  });

  it("a scratchpad path is also an upload path", () => {
    const p = `${SCRATCHPAD_PREFIX}abc-123/Scratchpad.md`;
    expect(isUploadPath(p)).toBe(true);
  });
});

describe("scratchpadUuidFromPath", () => {
  it("extracts the uuid segment", () => {
    expect(scratchpadUuidFromPath(`${SCRATCHPAD_PREFIX}550e8400-e29b/Scratchpad.md`)).toBe(
      "550e8400-e29b",
    );
  });

  it("returns the uuid even without a trailing filename", () => {
    expect(scratchpadUuidFromPath(`${SCRATCHPAD_PREFIX}only-uuid`)).toBe("only-uuid");
  });

  it("returns null for non-scratchpad paths", () => {
    expect(scratchpadUuidFromPath("upload://file-xyz/doc.md")).toBeNull();
    expect(scratchpadUuidFromPath("/home/user/notes.md")).toBeNull();
  });

  it("returns null when the uuid segment is empty", () => {
    expect(scratchpadUuidFromPath(`${SCRATCHPAD_PREFIX}/Scratchpad.md`)).toBeNull();
  });

  it("distinct uuids never collide (so scratchpads don't overwrite each other)", () => {
    const a = scratchpadUuidFromPath(`${SCRATCHPAD_PREFIX}uuid-a/Scratchpad.md`);
    const b = scratchpadUuidFromPath(`${SCRATCHPAD_PREFIX}uuid-b/Scratchpad.md`);
    expect(a).not.toBe(b);
  });
});
