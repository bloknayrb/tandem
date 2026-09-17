/**
 * cr-2 (J2 review round 3): `formatRenameErrorMessage` decides whether a
 * rename failure's `errorCode` gets appended as a `" (CODE)"` parenthetical.
 * `routes/rename.ts` sends `errorCode` for EVERY rejection, but most of
 * `renameDocument`'s codes are semantic — the paired `message` is already a
 * complete, finished sentence for those, and the suffix belongs only on the
 * two producers that hand back an errno alongside a content-free generic
 * reason ("The document could not be renamed.").
 */

import { describe, expect, it } from "vitest";
import { formatRenameErrorMessage } from "../../../src/client/hooks/yjsSync.svelte";

describe("formatRenameErrorMessage", () => {
  it.each([
    ["ALREADY_EXISTS", "A file already exists at report.md."],
    ["EXTENSION_MISMATCH", "File extension must stay '.md' (renaming does not convert formats)."],
    ["NOT_FOUND", "Document not open"],
    ["READ_ONLY", "Read-only documents cannot be renamed."],
    ["NOT_RENAMABLE", "Only on-disk files can be renamed; scratchpads and uploads use Save As."],
    ["PATH_REJECTED", "The destination path was rejected."],
    ["RENAME_IN_PROGRESS", "A save is in progress; try again."],
    ["SAVE_IN_PROGRESS", "A save is in progress; try again."],
  ])("does not append the suffix for the semantic code %s", (error, message) => {
    expect(formatRenameErrorMessage({ error, message }, 409)).toBe(message);
  });

  it("does not append the suffix for the UNKNOWN fallback code", () => {
    expect(
      formatRenameErrorMessage(
        { error: "UNKNOWN", message: "The document could not be renamed." },
        500,
      ),
    ).toBe("The document could not be renamed.");
  });

  it("appends the suffix for a raw fs errno alongside the generic reason", () => {
    expect(
      formatRenameErrorMessage(
        { error: "EACCES", message: "The document could not be renamed." },
        500,
      ),
    ).toBe("The document could not be renamed. (EACCES)");
  });

  it("falls back to a status-coded message when the body has neither field", () => {
    expect(formatRenameErrorMessage({}, 500)).toBe("Rename failed (500).");
  });

  it("omits the suffix when no error code is present", () => {
    expect(formatRenameErrorMessage({ message: "Something went wrong." }, 500)).toBe(
      "Something went wrong.",
    );
  });
});
