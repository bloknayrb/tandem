/**
 * Every registered Tandem tool sits on exactly one side of the launched
 * session's grant (#2286): pre-approved, or left to auto mode's classifier.
 *
 * A tool on neither list would silently fall to the classifier, which is the
 * safe default — but the choice is a security decision (a pre-approved tool
 * skips the classifier in a session nobody watches), so it is made here, by
 * whoever adds the tool, not by omission.
 */

import { describe, expect, it } from "vitest";
import {
  TANDEM_CLASSIFIER_GATED_TOOLS,
  TANDEM_PREAPPROVED_TOOLS,
} from "../../../src/shared/launcher/contract.js";
import { allMcpSource, registeredToolNames } from "../../helpers/mcp-source.js";

describe("launched-session allow rules cover every Tandem tool (#2286)", () => {
  const registered = registeredToolNames(allMcpSource());
  const preapproved = new Set<string>(TANDEM_PREAPPROVED_TOOLS);
  const gated = new Set<string>(TANDEM_CLASSIFIER_GATED_TOOLS);

  it("finds the registered tools", () => {
    expect(registered.size).toBeGreaterThanOrEqual(28);
  });

  it("classifies every registered tool", () => {
    const unclassified = [...registered].filter((t) => !preapproved.has(t) && !gated.has(t));
    expect(unclassified).toEqual([]);
  });

  it("puts no tool on both sides", () => {
    expect([...preapproved].filter((t) => gated.has(t))).toEqual([]);
  });

  it("lists no tool that is not registered", () => {
    expect([...preapproved, ...gated].filter((t) => !registered.has(t))).toEqual([]);
  });

  // An independent copy of the gated set: moving a tool from the gated list to
  // the pre-approved one keeps every test above green, so this is what makes
  // that move a visible edit here.
  it("keeps every file-reaching or destructive tool off the pre-approved list", () => {
    for (const tool of [
      "tandem_open",
      "tandem_edit",
      "tandem_appendContent",
      "tandem_editList",
      "tandem_save",
      "tandem_rename",
      "tandem_close",
      "tandem_convertToMarkdown",
      "tandem_applyChanges",
      "tandem_exportAnnotations",
      "tandem_restoreBackup",
      "tandem_removeAnnotation",
    ]) {
      expect(preapproved.has(tool)).toBe(false);
    }
  });
});
